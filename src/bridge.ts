/**
 * Client for the DBX desktop app's MCP bridge.
 *
 * The desktop app runs a small HTTP server (`src-tauri/src/commands/mcp_bridge.rs`)
 * and writes its port to `<data dir>/mcp-bridge-port`. The bridge answers
 * queries for the connections the desktop already knows, and — unlike a
 * headless `dbx-mcp` process — it never needs the catalog's encryption key,
 * because it lives inside the desktop process.
 *
 * The bridge cannot create connections; that stays an MCP operation. It is
 * used as the fallback path so the panel can still run SQL against the user's
 * real DBX connections.
 *
 * @module dsh-data-dbx/bridge
 */

import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'

/** One result set row, as the bridge reports it. */
export type BridgeRow = (string | number | boolean | null)[]

/** The bridge's answer to an execute-query request. */
export interface BridgeQueryResult {
  columns: string[]
  rows: BridgeRow[]
  affectedRows: number
  truncated: boolean
  executionTimeMs: number
  message: string
}

/** One table entry, as the bridge reports it. */
export interface BridgeTable {
  name: string
  tableType: string
}

/**
 * Keep one bridge cell inside the value types the grid can draw.
 *
 * @param value - the raw JSON value the bridge sent.
 * @returns the cell as text, a number, a boolean, or null.
 */
function toBridgeCell(value: unknown): BridgeRow[number] {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

/** Structured failure raised when the bridge refuses or misbehaves. */
export class DbxBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbxBridgeError'
  }
}

/**
 * Read the bridge port the DBX desktop app published.
 *
 * @param dataDir - the DBX data directory.
 * @returns the port number, or 0 when the desktop app is not running.
 */
export async function resolveBridgePort(dataDir: string): Promise<number> {
  try {
    const raw = await readFile(join(dataDir, 'mcp-bridge-port'), 'utf8')
    const port = Number.parseInt(raw.trim(), 10)
    return Number.isSafeInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

/**
 * Check that something is actually listening on the bridge port.
 *
 * The port file outlives the desktop app, so a stale file would otherwise
 * make the panel report a working transport that answers nothing.
 *
 * @param port - the port the desktop app published.
 * @param timeoutMs - how long to wait for the connection.
 * @returns true when the port accepts a connection.
 */
async function probeBridgePort(port: number, timeoutMs = 1_500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (reachable: boolean) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** A connected bridge client. */
export class DbxBridgeClient {
  private readonly baseUrl: string

  private constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  /**
   * Connect to the bridge the running DBX desktop app published.
   *
   * @param dataDir - the DBX data directory.
   * @returns the client, or `null` when the desktop app is not running.
   */
  static async connect(dataDir: string): Promise<DbxBridgeClient | null> {
    const port = await resolveBridgePort(dataDir)
    if (port === 0) return null
    if (!await probeBridgePort(port)) return null
    return new DbxBridgeClient(`http://127.0.0.1:${port}`)
  }

  /**
   * Run one SQL statement through the desktop app.
   *
   * @param request - the statement and the connection to run it against.
   * @param timeoutMs - how long the query may take.
   * @returns the result set.
   */
  async executeQuery(
    request: { connectionName: string; connectionId?: string | undefined; database?: string | undefined; sql: string },
    timeoutMs = 60_000,
  ): Promise<BridgeQueryResult> {
    const payload = await this.post('/data/execute-query', {
      connection_name: request.connectionName,
      connection_id: request.connectionId,
      database: request.database,
      sql: request.sql,
    }, timeoutMs)

    const record = payload as Record<string, unknown>
    const columns = Array.isArray(record['columns'])
      ? (record['columns'] as unknown[]).map(column => String(column))
      : []
    const rows = Array.isArray(record['rows'])
      ? (record['rows'] as unknown[]).map(row => (Array.isArray(row) ? row.map(cell => toBridgeCell(cell)) : [toBridgeCell(row)]))
      : []
    return {
      columns,
      rows,
      affectedRows: typeof record['affected_rows'] === 'number' ? record['affected_rows'] : rows.length,
      truncated: record['truncated'] === true,
      executionTimeMs: typeof record['execution_time_ms'] === 'number' ? record['execution_time_ms'] : 0,
      message: typeof record['message'] === 'string' ? record['message'] : '',
    }
  }

  /**
   * List the tables of one database.
   *
   * @param request - the connection and database to inspect.
   * @param timeoutMs - how long the listing may take.
   * @returns the tables the bridge reported.
   */
  async listTables(
    request: { connectionName: string; connectionId?: string | undefined; database?: string | undefined },
    timeoutMs = 60_000,
  ): Promise<BridgeTable[]> {
    const payload = await this.post('/data/list-tables', {
      connection_name: request.connectionName,
      connection_id: request.connectionId,
      database: request.database,
    }, timeoutMs)
    const list = Array.isArray(payload) ? payload : []
    return list.map(entry => {
      const record = entry as Record<string, unknown>
      return {
        name: typeof record['name'] === 'string' ? record['name'] : String(record['name'] ?? ''),
        tableType: typeof record['table_type'] === 'string' ? record['table_type'] : '',
      }
    })
  }

  /**
   * Ask the desktop app to read its connections from disk again.
   *
   * The bridge answers with the plain text `ok`, so the body is not parsed.
   */
  async reloadConnections(timeoutMs = 10_000): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/reload-connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DbxBridgeError(`cannot reach the DBX desktop bridge at ${this.baseUrl}: ${reason}`)
    }
    if (!response.ok) {
      throw new DbxBridgeError(`the DBX desktop bridge answered ${response.status}`)
    }
    await response.text()
  }

  /**
   * Send one request to the bridge.
   *
   * The bridge only accepts loopback hosts, JSON bodies and no `Origin`
   * header, which is exactly what a Node `fetch` produces.
   */
  private async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DbxBridgeError(`cannot reach the DBX desktop bridge at ${this.baseUrl}: ${reason}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new DbxBridgeError(`the DBX desktop bridge answered ${response.status}: ${text.slice(0, 400)}`)
    }
    if (text.trim().length === 0) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DbxBridgeError('the DBX desktop bridge answered with a malformed JSON body')
    }
  }
}
