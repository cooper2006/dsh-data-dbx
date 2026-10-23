/**
 * SQLite driver, over the runtime's own `node:sqlite`.
 *
 * `node:sqlite` ships with Node 22.5 and later, so this driver needs no
 * package and no native build — the same property that makes the plugin safe
 * to install. It is opened lazily and read-write, because a panel query may be
 * an `INSERT` as easily as a `SELECT`.
 *
 * A file engine has no host, no port and no database name: the connection's
 * `host` field carries the path to the file. `listDatabases` therefore reports
 * the attached databases, which is the closest thing SQLite has.
 *
 * @module dsh-data-dbx/drivers/sqlite
 */

import { existsSync } from 'node:fs'

import type {
  Cell,
  ColumnInfo,
  ConnectSpec,
  Driver,
  DriverConnection,
  QueryOutcome,
  TableInfo,
} from './types.ts'
import { DriverError, errorText, renderTable, rowsOutcome, statementOutcome, toCell } from './types.ts'

/** The `node:sqlite` statement surface this driver uses. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

/** The `node:sqlite` database surface this driver uses. */
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  close(): void
}

/** The `node:sqlite` module surface this driver uses. */
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase
}

/** Whether `node:sqlite` is available. */
async function loadSqlite(): Promise<SqliteModule> {
  try {
    const loaded = (await import('node:sqlite')) as unknown as SqliteModule
    if (typeof loaded.DatabaseSync !== 'function') {
      throw new Error('this runtime has no DatabaseSync')
    }
    return loaded
  } catch (error) {
    throw new DriverError('sqlite', `this runtime has no built-in sqlite: ${errorText(error)}`)
  }
}

/** The SQLite type name for one column, as `PRAGMA table_info` reports it. */
function sqliteType(raw: unknown): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : 'blob'
}

/** One open SQLite database. */
class SqliteConnection implements DriverConnection {
  readonly kind = 'sqlite'
  readonly dialect = 'SQLite SQL'
  readonly sql = true
  private readonly database: SqliteDatabase
  private closed = false

  /**
   * @param database - the open database.
   */
  constructor(database: SqliteDatabase) {
    this.database = database
  }

  /** @inheritdoc */
  async query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const statement = this.database.prepare(sql)
    const bound = params === undefined ? [] : [...params]
    const trimmed = sql.trim().toUpperCase()
    const returnsRows = trimmed.startsWith('SELECT')
      || trimmed.startsWith('WITH')
      || trimmed.startsWith('PRAGMA')
      || trimmed.startsWith('EXPLAIN')
      || trimmed.startsWith('VALUES')

    if (!returnsRows) {
      // `run` reports the affected row count; `changes` is what SQLite calls it.
      const outcome = statement.run(...bound) as { changes?: number; lastInsertRowid?: number | bigint }
      const affected = typeof outcome.changes === 'number' ? outcome.changes : null
      return statementOutcome('sqlite', affected)
    }

    const raw = statement.all(...bound) as Record<string, unknown>[]
    const columns = raw.length > 0 ? Object.keys(raw[0] as Record<string, unknown>) : []
    const rows: Cell[][] = raw.map(row => columns.map(name => toCell(row[name])))
    return rowsOutcome('sqlite', columns, rows, false, [], renderTable(columns, rows))
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    const raw = this.database.prepare('PRAGMA database_list').all() as Record<string, unknown>[]
    return raw
      .map(entry => String(entry['name'] ?? ''))
      .filter(name => name.length > 0 && name !== 'temp')
  }

  /** @inheritdoc */
  async listTables(): Promise<TableInfo[]> {
    const raw = this.database.prepare(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') `
      + `AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Record<string, unknown>[]
    return raw.map(entry => ({
      name: String(entry['name'] ?? ''),
      tableType: String(entry['type'] ?? 'table') === 'view' ? 'VIEW' : 'BASE TABLE',
    }))
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const safe = name.replace(/"/g, '""')
    const raw = this.database.prepare(`PRAGMA table_info("${safe}")`).all() as Record<string, unknown>[]
    return raw.map(entry => ({
      name: String(entry['name'] ?? ''),
      dataType: sqliteType(entry['type']),
      nullable: entry['notnull'] === 0 || entry['notnull'] === false,
      defaultValue: entry['dflt_value'] === null || entry['dflt_value'] === undefined
        ? null
        : String(entry['dflt_value']),
      primaryKey: entry['pk'] === 1 || entry['pk'] === true,
    }))
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } catch {
      // Closing a handle that already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the SQLite driver.
 *
 * @returns the driver.
 */
export function createSqliteDriver(): Driver {
  return {
    kind: 'sqlite',
    label: 'SQLite',
    dialect: 'SQLite SQL',
    sql: true,
    defaultPort: 0,
    file: true,
    // `node:sqlite` ships with Node itself, so this engine has no package.
    package: null,
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const path = spec.host
      if (path.length === 0) {
        throw new DriverError('sqlite', 'a SQLite connection needs the path to its database file')
      }
      if (!existsSync(path)) {
        throw new DriverError('sqlite', `no such SQLite database: ${path}`)
      }
      const sqlite = await loadSqlite()
      let database: SqliteDatabase
      try {
        database = new sqlite.DatabaseSync(path, { timeout: 5000 })
      } catch (error) {
        throw new DriverError('sqlite', errorText(error))
      }
      return new SqliteConnection(database)
    },
  }
}
