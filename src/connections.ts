/**
 * DBX connection catalog: reads the connection list that the DBX desktop app
 * stores, and exposes safe (password-free) connection summaries plus the
 * selector resolution the query tools need.
 *
 * The plugin never reads, decrypts, or stores a database password. DBX keeps
 * secrets in its own `connection_secrets` table and resolves them internally;
 * this module reads only the non-secret `config_json` profile and delegates
 * every execution to the DBX MCP server, which owns credential handling.
 *
 * @module dsh-data-dbx/connections
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Non-secret connection profile as DBX persists it in `config_json`. */
export interface DbxConnectionProfile {
  /** Stable connection id (UUID) used by DBX MCP request selectors. */
  id: string
  /** Human-readable connection name. Federated SQL qualifies tables with this. */
  name: string
  /** DBX database type, e.g. `mysql`, `postgres`, `sqlite`. */
  dbType: string
  /** Driver profile label when DBX recorded one, e.g. `doris`. */
  driverProfile: string
  host: string
  port: number
  username: string
  /** Default database recorded on the profile; empty for some engines. */
  database: string
  /** Whether the connection may participate in federated queries. */
  federationEnabled: boolean
}

/** One connection summary safe to show the model: never carries a secret. */
export interface ConnectionSummary {
  id: string
  name: string
  dbType: string
  driverProfile: string
  host: string
  port: number
  username: string
  database: string
  federationEnabled: boolean
}

/** Structured failure raised while reading DBX's local catalog. */
export class DbxCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbxCatalogError'
  }
}

/**
 * Resolve the DBX storage database path the way the DBX desktop app does.
 *
 * Mirrors `crates/dbx-mcp/src/paths.rs`: an explicit `DBX_DATA_DIR` override
 * wins, otherwise the platform data directory plus `com.dbx.app`. Keeping the
 * same rule means the plugin and DBX MCP read the same store, so a connection
 * the user sees in DBX is the connection this plugin resolves.
 *
 * @param override - explicit data directory from plugin config, when set.
 * @returns absolute path to `dbx.db`.
 */
export function resolveDbxDbPath(override?: string): string {
  const fromEnv = process.env['DBX_DATA_DIR']
  const explicit = override ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined)
  if (explicit !== undefined) return join(explicit, 'dbx.db')

  // macOS: ~/Library/Application Support ; Linux: $XDG_DATA_HOME or ~/.local/share.
  const base = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : (process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'))
  return join(base, 'com.dbx.app', 'dbx.db')
}

/** Decode a SQLite varint (1-9 bytes, big-endian 7-bit groups). */
function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let i = offset
  for (let n = 0; n < 9; n += 1) {
    const byte = buf[i]
    if (byte === undefined) throw new DbxCatalogError('truncated SQLite varint')
    i += 1
    if (n === 8) {
      // The ninth byte contributes all eight of its bits.
      value = value * 256 + byte
      break
    }
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) break
  }
  return { value, next: i }
}

/** Read a big-endian signed integer of `size` bytes. */
function readIntBE(buf: Uint8Array, offset: number, size: number): number {
  let value = 0
  for (let i = 0; i < size; i += 1) value = value * 256 + (buf[offset + i] as number)
  // Serial types 1-6 carry two's-complement integers when their high bit is set.
  const bits = size * 8
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value
}

/**
 * Decode one SQLite record (a row's value array) from its serial-type header.
 *
 * @param buf - the whole file.
 * @param offset - byte offset of the record payload.
 * @param payloadEnd - exclusive end of the record's payload.
 * @returns the decoded values in column order.
 */
function parseRecord(buf: Uint8Array, offset: number, payloadEnd: number): (string | number | null)[] {
  const headerStart = offset
  const header = readVarint(buf, offset)
  const headerEnd = headerStart + header.value
  if (headerEnd > payloadEnd) throw new DbxCatalogError('SQLite record header overruns its payload')

  const serialTypes: number[] = []
  let cursor = header.next
  while (cursor < headerEnd) {
    const st = readVarint(buf, cursor)
    serialTypes.push(st.value)
    cursor = st.next
  }

  let body = headerEnd
  const values: (string | number | null)[] = []
  for (const st of serialTypes) {
    if (st === 0) { values.push(null); continue }
    if (st >= 1 && st <= 6) {
      const size = [0, 1, 2, 3, 4, 6, 8][st] as number
      values.push(readIntBE(buf, body, size))
      body += size
      continue
    }
    if (st === 7) { values.push(null); body += 8; continue }
    if (st === 8) { values.push(0); continue }
    if (st === 9) { values.push(1); continue }
    if (st === 10 || st === 11) throw new DbxCatalogError('SQLite reserved serial type')
    // Even serial types >= 12 are BLOBs (size-12)/2; odd ones are TEXT (size-13)/2.
    const isText = st % 2 === 1
    const size = Math.floor((st - (isText ? 13 : 12)) / 2)
    if (isText) values.push(new TextDecoder().decode(buf.subarray(body, body + size)))
    else values.push(size)
    body += size
  }
  if (body > payloadEnd) throw new DbxCatalogError('SQLite record body overruns its payload')
  return values
}

/**
 * Reassemble one cell's payload, following the overflow chain when the row is
 * too large for its leaf page.
 *
 * @param bytes - the whole file.
 * @param pageSize - usable page size from the file header.
 * @param payloadOffset - byte offset of the payload (or of its local head).
 * @param payloadSize - total payload size declared by the cell.
 * @param localSize - bytes stored on the leaf page itself.
 * @returns the complete payload bytes.
 */
function readPayload(
  bytes: Uint8Array,
  pageSize: number,
  payloadOffset: number,
  payloadSize: number,
  localSize: number,
): Uint8Array {
  if (localSize >= payloadSize) return bytes.subarray(payloadOffset, payloadOffset + payloadSize)

  const out = new Uint8Array(payloadSize)
  out.set(bytes.subarray(payloadOffset, payloadOffset + localSize), 0)
  let written = localSize
  const usable = pageSize - 4
  let next = ((bytes[payloadOffset + localSize] as number) * 256)
    + (bytes[payloadOffset + localSize + 1] as number)

  while (next !== 0 && written < payloadSize) {
    const base = (next - 1) * pageSize
    next = ((bytes[base] as number) * 256) + (bytes[base + 1] as number)
    const chunk = Math.min(usable, payloadSize - written)
    out.set(bytes.subarray(base + 4, base + 4 + chunk), written)
    written += chunk
  }
  if (written < payloadSize) throw new DbxCatalogError('SQLite overflow chain ended early')
  return out
}

/**
 * Read a 4-byte big-endian page number.
 *
 * Interior table pages store child page numbers as 4-byte big-endian values,
 * unlike the 2-byte cell offsets in the cell pointer array.
 *
 * @param buf - the whole file.
 * @param offset - byte offset of the page number.
 * @returns the page number.
 */
function readPageNumber(buf: Uint8Array, offset: number): number {
  return ((buf[offset] as number) * 2 ** 24)
    + ((buf[offset + 1] as number) * 2 ** 16)
    + ((buf[offset + 2] as number) * 256)
    + (buf[offset + 3] as number)
}

/** Minimum cell payload that fits entirely on a leaf page. */
function localPayloadSize(payloadSize: number, usable: number): number {
  const maxLocal = usable - 35
  if (payloadSize <= maxLocal) return payloadSize
  const minLocal = Math.floor((usable - 12) * 32 / 255) - 23
  return minLocal + ((payloadSize - minLocal) % (usable - 4))
}

/**
 * Walk one table B-tree and decode every row it holds.
 *
 * Traversal starts at the table's root page (read from `sqlite_master`) so it
 * follows interior pages correctly, and descends overflow chains for rows that
 * exceed a page. Page 1 is special: its B-tree header begins after the 100-byte
 * file header, so the caller passes that offset.
 *
 * @param bytes - the whole file.
 * @param pageSize - page size from the file header.
 * @param rootPage - the table's root page number.
 * @returns every decoded row, each as its column values.
 */
function walkTable(
  bytes: Uint8Array,
  pageSize: number,
  rootPage: number,
): (string | number | null)[][] {
  const rows: (string | number | null)[][] = []
  const seen = new Set<number>()

  const visit = (pageNo: number): void => {
    if (pageNo === 0 || seen.has(pageNo)) return
    seen.add(pageNo)
    const base = (pageNo - 1) * pageSize
    if (base >= bytes.length) return
    // Page 1 carries the 100-byte database header before its B-tree header.
    const header = pageNo === 1 ? base + 100 : base
    const type = bytes[header]

    // 0x05 = interior table page: descend into each child. An interior cell
    // starts with a 4-byte big-endian left-child page number followed by the
    // separator key; the header's rightmost pointer is 4 bytes as well.
    if (type === 0x05) {
      const count = ((bytes[header + 3] as number) * 256) + (bytes[header + 4] as number)
      for (let i = 0; i < count; i += 1) {
        const cell = ((bytes[header + 12 + i * 2] as number) * 256) + (bytes[header + 13 + i * 2] as number)
        visit(readPageNumber(bytes, base + cell))
      }
      visit(readPageNumber(bytes, header + 8))
      return
    }

    // 0x0d = leaf table page: decode each cell.
    if (type !== 0x0d) return
    const count = ((bytes[header + 3] as number) * 256) + (bytes[header + 4] as number)
    for (let i = 0; i < count; i += 1) {
      const cell = ((bytes[header + 8 + i * 2] as number) * 256) + (bytes[header + 9 + i * 2] as number)
      try {
        // A leaf table cell is: payload-length varint, rowid varint, payload.
        const plen = readVarint(bytes, base + cell)
        const rowid = readVarint(bytes, plen.next)
        const payload = readPayload(
          bytes,
          pageSize,
          rowid.next,
          plen.value,
          localPayloadSize(plen.value, pageSize),
        )
        rows.push(parseRecord(payload, 0, payload.length))
      } catch {
        // One undecodable cell must not discard the rest of the catalog.
      }
    }
  }

  visit(rootPage)
  return rows
}

/**
 * Read the root page of one table from `sqlite_master`.
 *
 * @param bytes - the whole file.
 * @param pageSize - page size from the file header.
 * @param tableName - the table to look up.
 * @returns the root page number, or 0 when the table is absent.
 */
function findRootPage(bytes: Uint8Array, pageSize: number, tableName: string): number {
  // sqlite_master's own root is page 1; its columns are
  // (type, name, tbl_name, rootpage, sql).
  for (const values of walkTable(bytes, pageSize, 1)) {
    if (values[0] === 'table' && values[1] === tableName && typeof values[3] === 'number') {
      return values[3]
    }
  }
  return 0
}

/**
 * Read every row of one table from a DBX storage database.
 *
 * @param dbPath - absolute path to `dbx.db`.
 * @param tableName - the table to read.
 * @returns the decoded rows, each as its column values.
 * @throws {DbxCatalogError} when the file is missing, is not a SQLite database,
 *   or has no such table.
 */
async function readTableRows(
  dbPath: string,
  tableName: string,
): Promise<(string | number | null)[][]> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(dbPath))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DbxCatalogError(`cannot read the DBX storage database at ${dbPath}: ${reason}`)
  }

  const magic = String.fromCharCode(...bytes.subarray(0, 15))
  if (magic !== 'SQLite format 3') {
    throw new DbxCatalogError(`${dbPath} is not a SQLite database`)
  }

  const rawPageSize = ((bytes[16] as number) * 256) + (bytes[17] as number)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  const rootPage = findRootPage(bytes, pageSize, tableName)
  if (rootPage === 0) {
    throw new DbxCatalogError(`${dbPath} has no '${tableName}' table; is this a DBX storage database?`)
  }
  return walkTable(bytes, pageSize, rootPage)
}

/**
 * Project one stored DBX profile into the safe summary the tools expose.
 *
 * @param profile - parsed `config_json`.
 * @returns the password-free summary.
 */
export function toSummary(profile: DbxConnectionProfile): ConnectionSummary {
  return {
    id: profile.id,
    name: profile.name,
    dbType: profile.dbType,
    driverProfile: profile.driverProfile,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    database: profile.database,
    federationEnabled: profile.federationEnabled,
  }
}

/**
 * Read DBX's connection catalog from its local storage.
 *
 * @param dbPath - absolute path to `dbx.db`, from {@link resolveDbxDbPath}.
 * @returns every readable connection profile, in storage order.
 * @throws {DbxCatalogError} when the file is missing, is not a SQLite database,
 *   or has no `connections` table, so the tool can name the path it tried.
 */
export async function readConnections(dbPath: string): Promise<DbxConnectionProfile[]> {
  const rows = await readTableRows(dbPath, 'connections')
  const profiles: DbxConnectionProfile[] = []
  for (const values of rows) {
    // Rows are (id, config_json); anything else sharing the walk is skipped.
    if (values.length !== 2 || typeof values[0] !== 'string' || typeof values[1] !== 'string') continue
    try {
      const raw = JSON.parse(values[1]) as Record<string, unknown>
      profiles.push({
        id: values[0],
        name: typeof raw['name'] === 'string' ? raw['name'] : values[0],
        dbType: typeof raw['db_type'] === 'string' ? raw['db_type'] : '',
        driverProfile: typeof raw['driver_profile'] === 'string' ? raw['driver_profile'] : '',
        host: typeof raw['host'] === 'string' ? raw['host'] : '',
        port: typeof raw['port'] === 'number' ? raw['port'] : 0,
        username: typeof raw['username'] === 'string' ? raw['username'] : '',
        database: typeof raw['database'] === 'string' ? raw['database'] : '',
        federationEnabled: raw['federation_enabled'] === true,
      })
    } catch {
      // A malformed profile must not hide the rest of the catalog.
    }
  }
  return profiles
}

/**
 * Read the DBX desktop app's own settings.
 *
 * The desktop app stores them in the single-row `app_settings` table; the
 * plugin only looks at the MCP HTTP server's settings, which decide whether
 * the desktop can serve MCP over loopback HTTP.
 *
 * @param dbPath - absolute path to `dbx.db`.
 * @returns the parsed settings object, or an empty object when unavailable.
 */
export async function readAppSettings(dbPath: string): Promise<Record<string, unknown>> {
  let rows: (string | number | null)[][]
  try {
    rows = await readTableRows(dbPath, 'app_settings')
  } catch {
    return {}
  }
  for (const values of rows) {
    const json = values.find(value => typeof value === 'string' && value.startsWith('{'))
    if (typeof json !== 'string') continue
    try {
      const parsed = JSON.parse(json) as unknown
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // Unreadable settings simply mean the MCP HTTP server stays unknown.
    }
  }
  return {}
}

/**
 * Find one connection by id or by name.
 *
 * Accepts both because the two DBX surfaces address connections differently:
 * MCP requests use the id, while federated SQL qualifies tables with the name.
 *
 * @param profiles - the catalog.
 * @param selector - an id or a name.
 * @returns the matching profile.
 * @throws when nothing matches, so the caller can surface the known names.
 */
export function resolveConnection(
  profiles: readonly DbxConnectionProfile[],
  selector: string,
): DbxConnectionProfile {
  const wanted = selector.trim()
  const exact = profiles.find(p => p.id === wanted) ?? profiles.find(p => p.name === wanted)
  if (exact !== undefined) return exact
  const ci = profiles.find(p => p.name.toLowerCase() === wanted.toLowerCase())
  if (ci !== undefined) return ci
  const known = profiles.map(p => `${p.name} (${p.id})`).join(', ')
  throw new Error(`unknown DBX connection '${selector}'. Known connections: ${known || '(none)'}`)
}
