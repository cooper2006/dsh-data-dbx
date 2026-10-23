/**
 * Write connections into DBX's own store.
 *
 * The panel has to add connections even when DBX's MCP server is not reachable:
 * a headless `dbx-mcp` cannot decrypt the catalog, and the desktop MCP server
 * is off by default. DBX reads its catalog from `dbx.db` on every request, so a
 * connection written there is a real DBX connection.
 *
 * Two rules from DBX's own storage code shape the writes:
 *
 * - `connections.config_json` never carries a password. DBX blanks it on save
 *   (`sanitized_connection_config`), and the password lives in
 *   `connection_secrets`.
 * - A `connection_secrets` row may hold a legacy plaintext `secret`. DBX reads
 *   it, and re-writes it encrypted on the next load, so the secret never stays
 *   in the clear longer than it takes DBX to look at the store.
 *
 * @module dsh-data-dbx/store
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDbxDbPath } from './connections.ts'

/** The engine types the panel offers, with the label DBX shows. */
const ENGINE_LABELS: Record<string, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  clickhouse: 'ClickHouse',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  redshift: 'Redshift',
  doris: 'Doris',
  starrocks: 'StarRocks',
  gaussdb: 'GaussDB',
  opengauss: 'openGauss',
  rqlite: 'rqlite',
  h2: 'H2',
  mongodb: 'MongoDB',
}

/** The default port of an engine, when the caller does not give one. */
const ENGINE_PORTS: Record<string, number> = {
  mysql: 3306,
  postgres: 5432,
  clickhouse: 8123,
  sqlserver: 1433,
  oracle: 1521,
  redshift: 5439,
  doris: 9030,
  starrocks: 9030,
  gaussdb: 5432,
  opengauss: 5432,
  rqlite: 4001,
  h2: 9092,
  mongodb: 27017,
}

/** The minimal `node:sqlite` surface this module uses. */
interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  close(): void
}

/** The connection the panel wants to store. */
export interface StoredConnection {
  name: string
  dbType: string
  host: string
  port?: number | undefined
  username?: string | undefined
  password?: string | undefined
  database?: string | undefined
  ssl?: boolean | undefined
  driverProfile?: string | undefined
}

/**
 * Open the DBX store for writing, when the runtime can.
 *
 * @param dbPath - absolute path to `dbx.db`.
 * @returns the open database, or null when `node:sqlite` is unavailable.
 */
async function openForWrite(dbPath: string): Promise<SqliteDatabase | null> {
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean; timeout?: number },
      ) => SqliteDatabase
    }
    if (typeof sqlite.DatabaseSync !== 'function') return null
    // The desktop app keeps the store open in WAL mode, so the write may have
    // to wait for its lock.
    const database = new sqlite.DatabaseSync(dbPath, { timeout: 5000 })
    try {
      database.exec('PRAGMA busy_timeout = 5000')
    } catch {
      // Older runtimes do not know this pragma; the timeout option covers it.
    }
    return database
  } catch {
    return null
  }
}

/**
 * Build the `config_json` blob DBX expects for a connection.
 *
 * DBX deserializes this blob with a hand-written reader: the eight fields
 * below are required, every other field has a default. Only fields whose type
 * is known are written, because a value of the wrong type makes DBX skip the
 * whole row.
 *
 * @param connection - the connection to store.
 * @param id - the id of the new connection.
 * @returns the stored profile.
 */
function buildProfile(connection: StoredConnection, id: string): Record<string, unknown> {
  const dbType = connection.dbType
  const port = connection.port ?? ENGINE_PORTS[dbType] ?? 0
  return {
    id,
    name: connection.name,
    note: '',
    db_type: dbType,
    driver_profile: connection.driverProfile ?? dbType,
    driver_label: ENGINE_LABELS[dbType] ?? dbType,
    host: connection.host,
    port,
    username: connection.username ?? '',
    // DBX keeps the password out of this blob.
    password: '',
    database: connection.database ?? null,
    show_system_schemas: false,
    ssl: connection.ssl ?? false,
    connect_timeout_secs: 10,
    query_timeout_secs: 60,
    idle_timeout_secs: 60,
    keepalive_interval_secs: 30,
    sysdba: false,
    save_password: true,
    read_only: false,
    federation_enabled: false,
  }
}

/**
 * Store a new connection in DBX's catalog.
 *
 * @param dataDir - the DBX data directory that holds `dbx.db`.
 * @param connection - the connection to store.
 * @returns the id of the new connection.
 */
export async function storeConnection(dataDir: string, connection: StoredConnection): Promise<string> {
  const dbPath = resolveDbxDbPath(dataDir)
  if (!existsSync(dbPath)) throw new Error(`the DBX store is missing: ${dbPath}`)

  const database = await openForWrite(dbPath)
  if (database === null) {
    throw new Error('this runtime has no sqlite support, so a connection cannot be stored')
  }

  const id = crypto.randomUUID()
  const profile = buildProfile(connection, id)
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare('INSERT OR REPLACE INTO connections (id, config_json) VALUES (?, ?)')
        .run(id, JSON.stringify(profile))
      const password = connection.password ?? ''
      if (password.length > 0) {
        // The legacy plaintext column: DBX reads it and encrypts it on its
        // next load of the store.
        database
          .prepare('INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, ?, ?, ?)')
          .run(id, 'password', password, '')
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    try {
      database.close()
    } catch {
      // Closing a handle can fail harmlessly.
    }
  }
  return id
}

/**
 * Remove a connection from DBX's catalog.
 *
 * @param dataDir - the DBX data directory that holds `dbx.db`.
 * @param id - the id of the connection to remove.
 * @returns whether a row was removed.
 */
export async function removeStoredConnection(dataDir: string, id: string): Promise<boolean> {
  const dbPath = resolveDbxDbPath(dataDir)
  if (!existsSync(dbPath)) throw new Error(`the DBX store is missing: ${dbPath}`)

  const database = await openForWrite(dbPath)
  if (database === null) {
    throw new Error('this runtime has no sqlite support, so a connection cannot be removed')
  }
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM connection_secrets WHERE connection_id = ?').run(id)
      const result = database.prepare('DELETE FROM connections WHERE id = ?').run(id) as { changes?: number }
      database.exec('COMMIT')
      return (result.changes ?? 0) > 0
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  } finally {
    try {
      database.close()
    } catch {
      // Closing a handle can fail harmlessly.
    }
  }
}

/**
 * The path of the DBX store inside a data directory.
 *
 * @param dataDir - the DBX data directory.
 * @returns the path of `dbx.db`.
 */
export function storePath(dataDir: string): string {
  return join(dataDir, 'dbx.db')
}
