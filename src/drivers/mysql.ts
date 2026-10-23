/**
 * MySQL-family driver, over the `mysql2` client.
 *
 * `mysql2` speaks the MySQL wire protocol, which is also what MariaDB, Doris,
 * StarRocks, TiDB, OceanBase and PolarDB speak, so one driver serves every one
 * of those products. The connection is created per call rather than pooled: a
 * panel query is a one-shot action, and pooling would hold idle sockets open
 * between clicks for no benefit.
 *
 * @module dsh-data-dbx/drivers/mysql
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

/** The `mysql2` surface this driver uses. */
interface MysqlConnection {
  query(text: string, values?: readonly unknown[]): Promise<[MysqlResult, unknown]>
  end(): Promise<void>
}

/** A `mysql2` result. */
interface MysqlResult {
  rows?: unknown[]
  fields?: { name: string }[]
  affectedRows?: number
  warningCount?: number
}

/** The `mysql2` constructor surface this driver uses. */
interface MysqlModule {
  createConnection(config: Record<string, unknown>): Promise<MysqlConnection> | MysqlConnection
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `mysql2`, reporting a missing package as an engine failure. */
function loadMysql(): MysqlModule {
  try {
    return requireModule('mysql2') as MysqlModule
  } catch (error) {
    throw new DriverError('mysql', `the "mysql2" package is not installed: ${errorText(error)}`)
  }
}

/** Build the `mysql2` connection config from the panel's spec. */
function mysqlConfig(spec: ConnectSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: spec.database.length > 0 ? spec.database : undefined,
    connectTimeout: 10_000,
    // The panel sends one statement at a time, so multiple statements would
    // only widen what a typo can do.
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  }
  if (spec.ssl) config['ssl'] = { rejectUnauthorized: false }
  return config
}

/** One open MySQL-family connection. */
class MysqlDriverConnection implements DriverConnection {
  readonly kind = 'mysql'
  readonly dialect = 'MySQL SQL'
  readonly sql = true
  private readonly connection: MysqlConnection
  private closed = false

  /**
   * @param connection - the connected `mysql2` connection.
   */
  constructor(connection: MysqlConnection) {
    this.connection = connection
  }

  /** @inheritdoc */
  async query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const [result] = await this.connection.query(sql, params === undefined ? [] : params)
    const columns = (result.fields ?? []).map(field => field.name)
    const rows = (result.rows ?? []).map(row => columns.map(name => toCell((row as Record<string, unknown>)[name])))
    if (columns.length === 0) {
      const affected = typeof result.affectedRows === 'number' ? result.affectedRows : null
      return statementOutcome('mysql', affected)
    }
    const warnings = typeof result.warningCount === 'number' && result.warningCount > 0
      ? [`${result.warningCount} warning(s)`]
      : []
    return rowsOutcome('mysql', columns, rows, false, warnings, renderTable(columns, rows))
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    const [result] = await this.connection.query('SHOW DATABASES')
    const names: string[] = []
    for (const row of result.rows ?? []) {
      for (const value of Object.values(row as Record<string, unknown>)) {
        if (typeof value === 'string') names.push(value)
      }
    }
    return names
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    const scope = database === undefined || database.length === 0
      ? 'DATABASE()'
      : '?'
    const [result] = await this.connection.query(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables `
      + `WHERE table_schema = ${scope} ORDER BY table_name`,
      database === undefined || database.length === 0 ? [] : [database],
    )
    return (result.rows ?? []).map(row => {
      const values = row as Record<string, unknown>
      return {
        name: String(values['name'] ?? ''),
        tableType: String(values['type'] ?? 'BASE TABLE'),
      }
    })
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const [result] = await this.connection.query(
      `SELECT column_name AS name, column_type AS data_type, is_nullable, column_default, column_key `
      + `FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? `
      + `ORDER BY ordinal_position`,
      [name],
    )
    return (result.rows ?? []).map(row => {
      const values = row as Record<string, unknown>
      return {
        name: String(values['name'] ?? ''),
        dataType: String(values['data_type'] ?? ''),
        nullable: String(values['is_nullable'] ?? 'NO') === 'YES',
        defaultValue: values['column_default'] === null || values['column_default'] === undefined
          ? null
          : String(values['column_default']),
        primaryKey: String(values['column_key'] ?? '') === 'PRI',
      }
    })
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.connection.end()
    } catch {
      // Ending a connection that already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the MySQL-family driver.
 *
 * @returns the driver.
 */
export function createMysqlDriver(): Driver {
  return {
    kind: 'mysql',
    label: 'MySQL',
    dialect: 'MySQL SQL',
    sql: true,
    defaultPort: 3306,
    file: false,
    package: 'mysql2',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const mysql = loadMysql()
      let connection: MysqlConnection
      try {
        connection = await mysql.createConnection(mysqlConfig(spec))
      } catch (error) {
        throw new DriverError('mysql', errorText(error))
      }
      // `mysql2` reports a handshake failure as an `error` event as well as a
      // rejection; the event has no listener of its own and would end the
      // process. Listen first, then prove the socket by running a statement, so
      // the panel gets an ordinary driver error instead of a dead host.
      ignoreAsyncErrors(connection)
      try {
        await connection.query('SELECT 1')
      } catch (error) {
        await closeQuietly(connection)
        throw new DriverError('mysql', errorText(error))
      }
      return new MysqlDriverConnection(connection)
    },
  }
}
