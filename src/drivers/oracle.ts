/**
 * Oracle driver, over the `oracledb` client.
 *
 * `oracledb` 6 or later runs in thin mode by default: it speaks Oracle's own
 * wire protocol from JavaScript, so the plugin opens an Oracle connection with
 * no Instant Client, no `tnsnames.ora` and no environment variable. That is the
 * whole reason this driver is worth having — DBX can only reach Oracle through
 * the thick client, and a machine without it cannot open the panel at all.
 *
 * Three things about Oracle shape this driver:
 *
 * - A connection names a *service*, not a database, so the connection form's
 *   database field becomes the service in the easy-connect string.
 * - The schema level is the user: unqualified names resolve in the connecting
 *   user's own schema, and the panel's picker is handed the list of users so it
 *   can switch. The switch is a session setting, so it is re-applied on every
 *   connection, the same way PostgreSQL's `search_path` is.
 * - Oracle has no "affected rows" for a query and no row cap of its own; the
 *   driver asks for one row beyond the page so it can tell the panel whether
 *   the page was cut, and commits, because a panel statement is one-shot and a
 *   rolled-back `UPDATE` would look like a successful one.
 *
 * @module dsh-data-dbx/drivers/oracle
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
type OracleRow = Record<string, unknown> | readonly unknown[]

/** One column description. */
interface OracleMetaData {
  name?: string
  dbTypeName?: string
}

/** What one statement returned. */
interface OracleResult {
  rows?: OracleRow[]
  metaData?: OracleMetaData[]
  rowsAffected?: number
}

/** One open connection. */
interface OracleConnection {
  execute(sql: string, binds?: unknown, options?: Record<string, unknown>): Promise<OracleResult>
  close(): Promise<void> | void
  break?(): Promise<void> | void
}

/** The `oracledb` surface this driver uses. */
interface OracleModule {
  getConnection(attributes: Record<string, unknown>): Promise<OracleConnection>
  OUT_FORMAT_OBJECT: number
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `oracledb`, reporting a missing package as an engine failure. */
function loadOracle(): OracleModule {
  try {
    return requireModule('oracledb') as OracleModule
  } catch (error) {
    throw new DriverError('oracle', `the "oracledb" package is not installed: ${errorText(error)}`)
  }
}

/** The port Oracle listens on by default. */
const DEFAULT_PORT = 1521

/** How many rows one page holds when the caller names no cap. */
const DEFAULT_PAGE = 500

/**
 * Quote an Oracle identifier so a name with a space or a quote survives.
 *
 * @param name - the identifier to quote.
 * @returns the quoted identifier.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Build the easy-connect string for one service.
 *
 * `host:port/service` is Oracle's own short form and needs no descriptor block;
 * TLS goes through the `tcps` protocol, which the client understands as a
 * scheme rather than as a separate attribute.
 *
 * @param spec - the connection.
 * @returns the connect string the client takes.
 */
function connectString(spec: ConnectSpec): string {
  const service = (spec.options['serviceName'] ?? spec.database).trim()
  const scheme = spec.ssl ? 'tcps://' : ''
  const address = `${scheme}${spec.host}:${spec.port}`
  return service.length > 0 ? `${address}/${service}` : address
}

/** One open Oracle session. */
class OracleSession implements DriverConnection {
  readonly kind = 'oracle'
  readonly dialect = 'Oracle SQL'
  readonly sql = true
  private readonly client: OracleConnection
  private readonly module: OracleModule
  private readonly schema: string
  private readonly service: string
  private readonly username: string
  private closed = false

  /**
   * @param client - the connected client.
   * @param module - the client package, for its constants.
   * @param schema - the schema unqualified names resolve in; empty means the
   *   connecting user's own.
   * @param service - the service the session is attached to, so the picker can
   *   tell a service name from a schema name.
   * @param username - the login user, whose own schema is the default one.
   */
  constructor(
    client: OracleConnection,
    module: OracleModule,
    schema: string,
    service: string,
    username: string,
  ) {
    this.client = client
    this.module = module
    this.schema = schema
    this.service = service
    this.username = username
  }

  /** @inheritdoc */
  async query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const result = await this.client.execute(sql, params === undefined ? {} : params, {
      outFormat: this.module.OUT_FORMAT_OBJECT,
      autoCommit: true,
      maxRows: DEFAULT_PAGE + 1,
    })
    const metaData = result.metaData ?? []
    const columns = metaData.map(column => column.name ?? '')
    const raw = result.rows ?? []
    if (columns.length === 0) {
      return statementOutcome('oracle', result.rowsAffected ?? null)
    }
    // Oracle returns the page as objects keyed by the column's own case, which
    // is upper case for an unquoted identifier; the cells are read back in the
    // order the metadata gave, so the header and the row cannot drift apart.
    const rows = raw.map(row => {
      if (Array.isArray(row)) return (row as readonly unknown[]).map(value => toCell(value))
      const values = row as Record<string, unknown>
      return columns.map(name => toCell(values[name]))
    })
    const truncated = rows.length > DEFAULT_PAGE
    return rowsOutcome('oracle', columns, truncated ? rows.slice(0, DEFAULT_PAGE) : rows, truncated)
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    // Oracle has no database list: what a person switches is the schema, which
    // Oracle spells as a user. The picker therefore lists users.
    const result = await this.client.execute(
      'SELECT username FROM all_users ORDER BY username',
      {},
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
      + ' SELECT table_name, \'TABLE\' AS table_type FROM all_tables WHERE owner = :1'
      + ' UNION ALL'
      + ' SELECT view_name AS table_name, \'VIEW\' AS table_type FROM all_views WHERE owner = :1'
      + ') ORDER BY table_name',
      [owner],
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
    const owner = this.ownerFor(undefined)
    const result = await this.client.execute(
      'SELECT c.column_name, c.data_type, c.nullable, c.data_default,'
      + ' CASE WHEN EXISTS ('
      + '  SELECT 1 FROM all_constraints con'
      + '   JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name'
      + '  WHERE con.owner = c.owner AND con.table_name = c.table_name'
      + '   AND con.constraint_type = \'P\' AND cc.column_name = c.column_name'
      + ' ) THEN 1 ELSE 0 END AS primary_key'
      + ' FROM all_tab_columns c'
      + ' WHERE c.owner = :1 AND c.table_name = :2'
      + ' ORDER BY c.column_id',
      [owner, name],
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
   * The picker may hand over a service name (the connection's own database
   * field) rather than a schema; that name would list nothing, so it means
   * "whatever schema this connection was opened with".
   *
   * @param database - the name the picker sent, when it sent one.
   * @returns the owner to query.
   */
  private ownerFor(database: string | undefined): string {
    const wanted = (database ?? '').trim()
    if (wanted.length > 0 && wanted !== this.service) return wanted.toUpperCase()
    if (this.schema.length > 0) return this.schema.toUpperCase()
    return this.username.length > 0 ? this.username.toUpperCase() : this.service
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
 * Read one row of a metadata answer, in either of the shapes the client can
 * use.
 *
 * @param row - the row to read.
 * @returns the values by column name.
 */
function readColumn(row: OracleRow): Record<string, unknown> {
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

/**
 * Create the Oracle driver.
 *
 * @param loadModule - how to reach the `oracledb` package; the self-check hands
 *   in a fake so the driver can be tested without a server.
 * @returns the driver.
 */
export function createOracleDriver(loadModule: () => OracleModule = loadOracle): Driver {
  return {
    kind: 'oracle',
    label: 'Oracle',
    dialect: 'Oracle SQL',
    sql: true,
    defaultPort: DEFAULT_PORT,
    file: false,
    package: 'oracledb',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const schema = spec.schema.trim()
      const service = (spec.options['serviceName'] ?? spec.database).trim()
      // Loading answers as this engine too: a checkout without the package must
      // fail the connection, not escape as a bare module error.
      const module = loadModuleOr('oracle', loadModule)
      let client: OracleConnection | null = null
      try {
        client = await module.getConnection({
          user: spec.username,
          password: spec.password,
          connectString: connectString(spec),
        })
        // The switch is a session setting, so every connection re-applies it;
        // without it an unqualified name would resolve in the login schema even
        // though the panel says otherwise.
        if (schema.length > 0) {
          await client.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${quoteIdentifier(schema)}`)
        }
      } catch (error) {
        await closeQuietly(client)
        throw asDriverError('oracle', error)
      }
      return new OracleSession(client, module, schema, service, spec.username)
    },
  }
}
