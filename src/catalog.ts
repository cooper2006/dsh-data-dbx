/**
 * Read the DBX connection catalog straight from DBX's own store.
 *
 * The panel needs the connection list even when no DBX transport can decrypt
 * the catalog: DBX's desktop app keeps `dbx.db` in WAL mode, so a reader that
 * only parses the main database file misses every connection committed after
 * the last checkpoint. `node:sqlite` replays the write-ahead log for us, so it
 * is used when the runtime offers it, with the hand-rolled reader as fallback.
 *
 * Only non-secret profile fields are read. Passwords stay in DBX's own
 * `connection_secrets` table and are never touched here.
 *
 * @module dsh-data-dbx/catalog
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readConnections, resolveDbxDbPath, type DbxConnectionProfile } from './connections.ts'

/** One connection as the panel shows it. */
export interface CatalogConnection {
  id: string
  name: string
  dbType: string
  host: string
  port: number
  username: string
  database: string
  visibleDatabases: string[]
}

/** The minimal `node:sqlite` surface this module uses. */
interface SqliteStatement {
  all(): unknown[]
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  close(): void
}

/**
 * Open the DBX store with `node:sqlite`, when the runtime has it.
 *
 * @param dbPath - absolute path to `dbx.db`.
 * @returns the open database, or null when `node:sqlite` is unavailable.
 */
async function openWithNodeSqlite(dbPath: string): Promise<SqliteDatabase | null> {
  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
    }
    if (typeof sqlite.DatabaseSync !== 'function') return null
    const database = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    return database
  } catch {
    // Older runtimes have no `node:sqlite`; the hand-rolled reader takes over.
    return null
  }
}

/**
 * Project one stored profile into the shape the panel shows.
 *
 * @param id - the connection id from the store.
 * @param configJson - the stored `config_json` blob.
 * @returns the connection, or null when the row is not a profile.
 */
function toCatalogConnection(id: string, configJson: string): CatalogConnection | null {
  try {
    const raw = JSON.parse(configJson) as Record<string, unknown>
    const name = typeof raw['name'] === 'string' ? raw['name'] : id
    const visible = raw['visible_databases']
    return {
      id,
      name,
      dbType: typeof raw['db_type'] === 'string' ? raw['db_type'] : '',
      host: typeof raw['host'] === 'string' ? raw['host'] : '',
      port: typeof raw['port'] === 'number' ? raw['port'] : 0,
      username: typeof raw['username'] === 'string' ? raw['username'] : '',
      database: typeof raw['database'] === 'string' ? raw['database'] : '',
      visibleDatabases: Array.isArray(visible)
        ? visible.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return null
  }
}

/**
 * Read every connection from the DBX store.
 *
 * @param dataDir - the DBX data directory that holds `dbx.db`.
 * @returns the connections, in storage order.
 */
export async function readCatalogConnections(dataDir: string): Promise<CatalogConnection[]> {
  const dbPath = resolveDbxDbPath(dataDir)
  if (!existsSync(dbPath)) return []

  const database = await openWithNodeSqlite(dbPath)
  if (database !== null) {
    try {
      const rows = database.prepare('SELECT id, config_json FROM connections').all()
      const connections: CatalogConnection[] = []
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue
        const values = row as Record<string, unknown>
        const id = values['id']
        const config = values['config_json']
        if (typeof id !== 'string' || typeof config !== 'string') continue
        const connection = toCatalogConnection(id, config)
        if (connection !== null) connections.push(connection)
      }
      return connections
    } catch {
      // Fall back to the hand-rolled reader below.
    } finally {
      try {
        database.close()
      } catch {
        // Closing a read-only handle can fail harmlessly.
      }
    }
  }

  const profiles: DbxConnectionProfile[] = await readConnections(dbPath)
  return profiles.map(profile => ({
    id: profile.id,
    name: profile.name,
    dbType: profile.dbType,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.database,
    visibleDatabases: [],
  }))
}

/**
 * Resolve the DBX data directory that holds the store and the desktop's files.
 *
 * @param override - explicit data directory from plugin config, when set.
 * @returns the data directory.
 */
export function resolveDataDir(override?: string): string {
  const fromEnv = process.env['DBX_DATA_DIR']
  const explicit = override ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
  if (explicit !== undefined) return explicit
  const dbPath = resolveDbxDbPath()
  return join(dbPath, '..')
}
