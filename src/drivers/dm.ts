/**
 * 达梦 (DM) driver, over the official `dmdb` client.
 *
 * `dmdb` is published by 达梦 (`dameng_database <ztn@dameng.com>`) and is pure
 * JavaScript — no native build, no client library, one dependency (`iconv-lite`)
 * that npm installs anyway. Its API follows `oracledb` on purpose, so this
 * driver reads the way the Oracle one does.
 *
 * Two things about DM8 shape it:
 *
 * - One server holds one database, and the namespaces inside it are schemas. So
 *   the connection form's database field *is* the schema, the picker lists
 *   schemas, and switching means `SET SCHEMA`.
 * - The dictionary views are Oracle-compatible (`ALL_TABLES`, `ALL_TAB_COLUMNS`,
 *   `ALL_CONSTRAINTS`, …), which is what the metadata queries below use. A DM
 *   build with the Oracle views switched off would report a clear error from
 *   those statements rather than silently listing nothing.
 *
 * @module dsh-data-dbx/drivers/dm
 */

import { createRequire } from 'node:module'

import type {
  ColumnInfo,
  ConnectSpec,
  Driver,
  DriverConnection,
  QueryOutcome,
  TableInfo,
} from './types.ts'
import {
  DriverError,
  asDriverError,
  closeQuietly,
  errorText,
  loadModuleOr,
  lowerKeys,
  rowsOutcome,
  statementOutcome,
  toCell,
} from './types.ts'

/** One row as the client returns it, before it becomes cells. */
type DmRow = Record<string, unknown> | readonly unknown[]

/** One column description. */
interface DmMetaData {
  name?: string
}

/** What one statement returned. */
interface DmResult {
  rows?: DmRow[]
  metaData?: DmMetaData | DmMetaData[]
  rowsAffected?: number
}

/** One open connection. */
interface DmConnection {
  execute(sql: string, binds?: unknown, options?: Record<string, unknown>): Promise<DmResult>
  close(): Promise<void> | void
}

/** The `dmdb` surface this driver uses. */
interface DmModule {
  getConnection(attributes: Record<string, unknown>): Promise<DmConnection>
  OUT_FORMAT_OBJECT: number
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `dmdb`, reporting a missing package as an engine failure. */
function loadDm(): DmModule {
  try {
    return requireModule('dmdb') as DmModule
  } catch (error) {
    throw new DriverError('dm', `the "dmdb" package is not installed: ${errorText(error)}`)
  }
}

/** The port DM listens on by default. */
const DEFAULT_PORT = 5236

/** How many rows one page holds when the caller names no cap. */
const DEFAULT_PAGE = 500

/**
 * Quote an identifier so a name with a space or a quote survives.
 *
 * @param name - the identifier to quote.
 * @returns the quoted identifier.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * The column names of one statement, whatever shape `metaData` arrived in.
 *
 * A single statement reports the column list itself; a batch reports a list per
 * statement, and the first entry belongs to the statement the panel ran.
 *
 * @param metaData - the answer's metadata, when it has any.
 * @returns the column names, in order.
 */
function columnsOf(metaData: DmResult['metaData']): string[] {
  if (metaData === undefined) return []
  const list: readonly (DmMetaData | DmMetaData[])[] = Array.isArray(metaData) ? metaData : [metaData]
  // A batch reports one column list per statement, so the first nested list
  // belongs to the statement the panel ran. A single statement reports the
  // column list itself, which is the flat entries.
  const nested = list.find((entry): entry is DmMetaData[] => Array.isArray(entry))
  const columns = nested ?? list.filter((entry): entry is DmMetaData => !Array.isArray(entry))
  return columns.map(column => column.name ?? '')
}

/**
 * Read one row of a metadata answer, in either of the shapes the client can
 * use.
 *
 * @param row - the row to read.
 * @returns the values by column name.
 */
function readColumn(row: DmRow): Record<string, unknown> {
  if (!Array.isArray(row)) return lowerKeys(row as Record<string, unknown>)
  const values = row as readonly unknown[]
  return {
    column_name: values[0],
    data_type: values[1],
    nullable: values[2],
    data_default: values[3],
    primary_key: values[4],
  }
}

/** One open DM session. */
class DmSession implements DriverConnection {
  readonly kind = 'dm'
  readonly dialect = 'DM SQL'
  readonly sql = true
  private readonly client: DmConnection
  private readonly module: DmModule
  private readonly schema: string
  private readonly username: string
  private closed = false

  /**
   * @param client - the connected client.
   * @param module - the client package, for its constants.
   * @param schema - the schema unqualified names resolve in; empty means the
   *   login user's own.
   * @param username - the login user, whose schema is the default one.
   */
  constructor(client: DmConnection, module: DmModule, schema: string, username: string) {
    this.client = client
    this.module = module
    this.schema = schema
    this.username = username
  }

  /** @inheritdoc */
  async query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const result = await this.client.execute(sql, params === undefined ? [] : params, {
      outFormat: this.module.OUT_FORMAT_OBJECT,
      autoCommit: true,
      maxRows: DEFAULT_PAGE + 1,
    })
    const columns = columnsOf(result.metaData)
    const raw = result.rows ?? []
    if (columns.length === 0) {
      return statementOutcome('dm', result.rowsAffected ?? null)
    }
    const rows = raw.map(row => {
      if (Array.isArray(row)) return (row as readonly unknown[]).map(value => toCell(value))
      const values = row as Record<string, unknown>
      return columns.map(name => toCell(values[name] ?? values[name.toUpperCase()] ?? values[name.toLowerCase()]))
    })
    const truncated = rows.length > DEFAULT_PAGE
    return rowsOutcome('dm', columns, truncated ? rows.slice(0, DEFAULT_PAGE) : rows, truncated)
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    // A DM server holds one database; the namespaces a person switches between
    // are schemas, so the picker lists schemas.
    const result = await this.client.execute(
      'SELECT username FROM all_users ORDER BY username',
      [],
      { outFormat: this.module.OUT_FORMAT_OBJECT },
    )
    return (result.rows ?? []).map(row => {
      const values = row as Record<string, unknown>
      return String(values['USERNAME'] ?? values['username'] ?? '')
    }).filter(name => name.length > 0)
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    const owner = this.ownerFor(database)
    const result = await this.client.execute(
      'SELECT table_name, table_type FROM ('
      + ' SELECT table_name, \'TABLE\' AS table_type FROM all_tables WHERE owner = ?'
      + ' UNION ALL'
      + ' SELECT view_name AS table_name, \'VIEW\' AS table_type FROM all_views WHERE owner = ?'
      + ') ORDER BY table_name',
      [owner, owner],
      { outFormat: this.module.OUT_FORMAT_OBJECT },
    )
    return (result.rows ?? []).map(row => {
      const values = row as Record<string, unknown>
      return {
        name: String(values['TABLE_NAME'] ?? values['table_name'] ?? ''),
        tableType: String(values['TABLE_TYPE'] ?? values['table_type'] ?? 'TABLE'),
      }
    }).filter(table => table.name.length > 0)
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const result = await this.client.execute(
      'SELECT c.column_name, c.data_type, c.nullable, c.data_default,'
      + ' CASE WHEN EXISTS ('
      + '  SELECT 1 FROM all_constraints con'
      + '   JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name'
      + '  WHERE con.owner = c.owner AND con.table_name = c.table_name'
      + '   AND con.constraint_type = \'P\' AND cc.column_name = c.column_name'
      + ' ) THEN 1 ELSE 0 END AS primary_key'
      + ' FROM all_tab_columns c'
      + ' WHERE c.owner = ? AND c.table_name = ?'
      + ' ORDER BY c.column_id',
      [this.ownerFor(undefined), name],
      { outFormat: this.module.OUT_FORMAT_OBJECT },
    )
    return (result.rows ?? []).map(row => {
      const values = readColumn(row)
      return {
        name: String(values['column_name'] ?? ''),
        dataType: String(values['data_type'] ?? ''),
        nullable: String(values['nullable'] ?? 'N') === 'Y',
        defaultValue: values['data_default'] === null || values['data_default'] === undefined
          ? null
          : String(values['data_default']).trim(),
        primaryKey: Number(values['primary_key'] ?? 0) > 0,
      }
    })
  }

  /**
   * The schema to scope metadata queries to.
   *
   * @param database - the name the picker sent, when it sent one.
   * @returns the owner to query.
   */
  private ownerFor(database: string | undefined): string {
    const wanted = (database ?? '').trim()
    if (wanted.length > 0) return wanted.toUpperCase()
    if (this.schema.length > 0) return this.schema.toUpperCase()
    return this.username.length > 0 ? this.username.toUpperCase() : ''
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.close()
    } catch {
      // Closing a session the server already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the 达梦 driver.
 *
 * @param loadModule - how to reach the `dmdb` package; the self-check hands in a
 *   fake so the driver can be tested without a server.
 * @returns the driver.
 */
export function createDmDriver(loadModule: () => DmModule = loadDm): Driver {
  return {
    kind: 'dm',
    label: '达梦 DM8',
    dialect: 'DM SQL',
    sql: true,
    defaultPort: DEFAULT_PORT,
    file: false,
    package: 'dmdb',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const schema = (spec.schema.trim().length > 0 ? spec.schema : spec.database).trim()
      // Loading answers as this engine too: a checkout without the package must
      // fail the connection, not escape as a bare module error.
      const module = loadModuleOr('dm', loadModule)
      let client: DmConnection | null = null
      try {
        client = await module.getConnection({
          user: spec.username,
          password: spec.password,
          // DM's connection string is an address; the database name has no
          // place in it, which is why the schema is applied as a statement.
          connectString: `${spec.host}:${spec.port}`,
        })
        if (schema.length > 0) {
          await client.execute(`SET SCHEMA ${quoteIdentifier(schema)}`)
        }
      } catch (error) {
        await closeQuietly(client)
        throw asDriverError('dm', error)
      }
      return new DmSession(client, module, schema, spec.username)
    },
  }
}
