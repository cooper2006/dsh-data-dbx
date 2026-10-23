/**
 * SQL Server driver, over the `tedious` client.
 *
 * `tedious` speaks the TDS protocol. Its connection and request objects are
 * event-driven rather than promise-returning, so this driver wraps each
 * request in a promise that settles on the `requestCompleted` event, which
 * keeps the interface the rest of the plugin sees identical to the other
 * drivers'.
 *
 * @module dsh-data-dbx/drivers/sqlserver
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
  closeQuietly,
  errorText,
  ignoreAsyncErrors,
  renderTable,
  rowsOutcome,
  statementOutcome,
  toCell,
} from './types.ts'

/** The `tedious` surface this driver uses. */
interface TediousModule {
  Connection: new (config: Record<string, unknown>) => TediousConnection
  Request: new (sql: string, callback: (error: unknown, rowCount?: number, rows?: unknown[]) => void) => TediousRequest
  TYPES: { NVarChar: unknown }
}

/** A `tedious` connection. */
interface TediousConnection {
  connect(): void
  close(): void
  on(event: string, listener: (...args: unknown[]) => void): void
  execSql(request: TediousRequest): void
}

/** A `tedious` request. */
interface TediousRequest {
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** One row as `tedious` hands it back. */
interface TediousRow {
  [column: string]: { value: unknown }
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `tedious`, reporting a missing package as an engine failure. */
function loadTedious(): TediousModule {
  try {
    return requireModule('tedious') as unknown as TediousModule
  } catch (error) {
    throw new DriverError('sqlserver', `the "tedious" package is not installed: ${errorText(error)}`)
  }
}

/** Build the `tedious` connection config from the panel's spec. */
function tediousConfig(spec: ConnectSpec): Record<string, unknown> {
  return {
    server: spec.host,
    authentication: {
      type: 'default',
      options: {
        userName: spec.username,
        password: spec.password,
      },
    },
    options: {
      port: spec.port,
      database: spec.database.length > 0 ? spec.database : 'master',
      trustServerCertificate: !spec.ssl,
      encrypt: spec.ssl,
      connectTimeout: 10_000,
      requestTimeout: 60_000,
      rowCollectionOnRequestCompletion: true,
    },
  }
}

/** Open a `tedious` connection, settling once it is usable. */
function connectTedious(connection: TediousConnection): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    connection.on('connect', (error: unknown) => {
      if (settled) return
      settled = true
      if (error instanceof Error) reject(error)
      else resolve()
    })
    connection.on('error', (error: unknown) => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    connection.connect()
  })
}

/** One open SQL Server connection. */
class SqlServerConnection implements DriverConnection {
  readonly kind = 'sqlserver'
  readonly dialect = 'Transact-SQL'
  readonly sql = true
  private readonly tedious: TediousModule
  private readonly connection: TediousConnection
  private closed = false

  /**
   * @param tedious - the loaded `tedious` module.
   * @param connection - the connected `tedious` connection.
   */
  constructor(tedious: TediousModule, connection: TediousConnection) {
    this.tedious = tedious
    this.connection = connection
  }

  /**
   * Run one statement and collect every row it produced.
   *
   * @param sql - the statement to run.
   * @returns the rows and the reported row count.
   */
  private async run(sql: string): Promise<{ rows: TediousRow[]; rowCount: number }> {
    const rows: TediousRow[] = []
    let rowCount = 0
    await new Promise<void>((resolve, reject) => {
      const request = new this.tedious.Request(sql, (error: unknown, count?: number) => {
        if (error instanceof Error) reject(error)
        else {
          rowCount = count ?? 0
          resolve()
        }
      })
      request.on('row', (columns: unknown) => {
        rows.push(columns as TediousRow)
      })
      request.on('error', (error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)))
      })
      this.connection.execSql(request)
    })
    return { rows, rowCount }
  }

  /** @inheritdoc */
  async query(sql: string): Promise<QueryOutcome> {
    const { rows, rowCount } = await this.run(sql)
    if (rows.length === 0) {
      return statementOutcome('sqlserver', rowCount)
    }
    const columns = Object.keys(rows[0] as TediousRow)
    const cells = rows.map(row => columns.map(name => toCell((row as TediousRow)[name]?.value)))
    return rowsOutcome('sqlserver', columns, cells, false, [], renderTable(columns, cells))
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    const { rows } = await this.run('SELECT name FROM sys.databases ORDER BY name')
    return rows.map(row => String(row['name']?.value ?? ''))
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    const scope = database === undefined || database.length === 0 ? 'DB_NAME()' : `'${database.replace(/'/g, "''")}'`
    const { rows } = await this.run(
      `SELECT s.name AS schema_name, t.name AS table_name, `
      + `CASE t.type WHEN 'U' THEN 'BASE TABLE' WHEN 'V' THEN 'VIEW' ELSE t.type_desc END AS table_type `
      + `FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id `
      + `UNION ALL SELECT s.name, v.name, 'VIEW' FROM sys.views v JOIN sys.schemas s ON s.schema_id = v.schema_id `
      + `WHERE DB_NAME(${scope}) = DB_NAME() ORDER BY table_name`,
    )
    return rows.map(row => ({
      name: String(row['table_name']?.value ?? ''),
      tableType: String(row['table_type']?.value ?? 'BASE TABLE'),
    }))
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const safe = name.replace(/'/g, "''")
    const { rows } = await this.run(
      `SELECT c.name AS column_name, ty.name AS data_type, c.is_nullable, `
      + `OBJECT_DEFINITION(c.default_object_id) AS column_default, `
      + `CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS primary_key `
      + `FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id `
      + `LEFT JOIN (SELECT ic.column_id, ic.object_id FROM sys.indexes i `
      + `  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id `
      + `  WHERE i.is_primary_key = 1) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id `
      + `WHERE c.object_id = OBJECT_ID('${safe}') ORDER BY c.column_id`,
    )
    return rows.map(row => ({
      name: String(row['column_name']?.value ?? ''),
      dataType: String(row['data_type']?.value ?? ''),
      nullable: row['is_nullable']?.value === true,
      defaultValue: row['column_default']?.value === null || row['column_default']?.value === undefined
        ? null
        : String(row['column_default']?.value),
      primaryKey: row['primary_key']?.value === 1 || row['primary_key']?.value === true,
    }))
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.connection.close()
    } catch {
      // Closing a connection that already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the SQL Server driver.
 *
 * @returns the driver.
 */
export function createSqlServerDriver(): Driver {
  return {
    kind: 'sqlserver',
    label: 'SQL Server',
    dialect: 'Transact-SQL',
    sql: true,
    defaultPort: 1433,
    file: false,
    package: 'tedious',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const tedious = loadTedious()
      const connection = new tedious.Connection(tediousConfig(spec))
      // `tedious` keeps emitting `error` after the handshake settles (a dropped
      // socket, a login timeout), so the listener must outlive `connectTedious`.
      ignoreAsyncErrors(connection)
      try {
        await connectTedious(connection)
      } catch (error) {
        await closeQuietly(connection)
        throw new DriverError('sqlserver', errorText(error))
      }
      return new SqlServerConnection(tedious, connection)
    },
  }
}
