/**
 * A minimal MCP stdio client for the DBX MCP server.
 *
 * The plugin owns no database driver, no credential decryption, and no query
 * engine: it starts `dbx-mcp`, speaks JSON-RPC over its stdin/stdout, and turns
 * each DBX tool into a callable function. Keeping the client here rather than
 * depending on a full MCP SDK keeps the plugin's dependency surface to what it
 * actually uses (initialize, tools/list, tools/call).
 *
 * @module dsh-data-dbx/mcp
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** MCP protocol revision this client speaks. */
const PROTOCOL_VERSION = '2025-06-18'

/** One MCP tool as the server describes it. */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
}

/** One content block returned by `tools/call`. */
interface McpContentBlock {
  type: string
  text?: string
}

/** Result of one `tools/call`. */
interface McpCallResult {
  content?: McpContentBlock[]
  isError?: boolean
}

/** Failure raised by the MCP transport or the server. */
export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

/** A live connection to one DBX MCP server process. */
export class DbxMcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  private nextId = 1
  private closed = false
  private stderrTail = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.onLine(line))

    // Keep a bounded stderr tail: DBX writes diagnostics there, and a startup
    // failure is otherwise invisible to the model.
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })
    child.on('exit', (code) => {
      this.closed = true
      const detail = this.stderrTail.trim().length > 0 ? `: ${this.stderrTail.trim()}` : ''
      const error = new McpError(`DBX MCP server exited with code ${code}${detail}`)
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    })
    // A process that cannot be spawned at all reports this on the child. Without
    // a listener Node turns it into an unhandled error event, which would take
    // the host down with it.
    child.on('error', (error) => {
      this.closed = true
      const failure = new McpError(`cannot run the DBX MCP server: ${error.message}`)
      for (const waiter of this.pending.values()) waiter.reject(failure)
      this.pending.clear()
    })
  }

  /**
   * Start a DBX MCP server and complete the MCP handshake.
   *
   * @param command - executable to spawn, e.g. the dbx-mcp binary.
   * @param args - extra arguments for the server.
   * @param env - environment entries merged over the process environment;
   *   `DBX_DATA_DIR` here is what points the server at a specific DBX store.
   * @param timeoutMs - how long the handshake may take.
   * @returns the connected client.
   * @throws {McpError} when the process cannot start or the handshake fails.
   */
  static async connect(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<DbxMcpClient> {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }) as ChildProcessWithoutNullStreams

    const client = new DbxMcpClient(child)
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-data-dbx', version: '0.1.0' },
    }, timeoutMs)
    client.notify('notifications/initialized', {})
    return client
  }

  /** Route one server line to the request waiting on its id. */
  private onLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(trimmed) as typeof message
    } catch {
      // Non-JSON output on stdout is a server bug, not a protocol message.
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = this.pending.get(message.id)
    if (waiter === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      waiter.reject(new McpError(message.error.message ?? 'unknown MCP error'))
    } else {
      waiter.resolve(message.result)
    }
  }

  /** Send one JSON-RPC request and await its response. */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpError('DBX MCP server is not running'))
    const id = this.nextId
    this.nextId += 1

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError(`DBX MCP request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })

      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return
        const waiter = this.pending.get(id)
        if (waiter === undefined) return
        this.pending.delete(id)
        clearTimeout(timer)
        waiter.reject(new McpError(`cannot write to the DBX MCP server: ${error.message}`))
      })
    })
  }

  /** Send a notification (no response expected). */
  private notify(method: string, params: unknown): void {
    if (this.closed) return
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * List the tools the DBX MCP server exposes.
   *
   * @param timeoutMs - how long to wait.
   * @returns the tool descriptors.
   */
  async listTools(timeoutMs: number): Promise<McpToolDescriptor[]> {
    const result = await this.request('tools/list', {}, timeoutMs) as { tools?: McpToolDescriptor[] }
    return result.tools ?? []
  }

  /**
   * Call one DBX tool.
   *
   * @param name - the tool name, e.g. `dbx_execute_query`.
   * @param args - the tool arguments.
   * @param timeoutMs - how long the call may take.
   * @returns the concatenated text content, plus whether the tool reported an error.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ text: string; isError: boolean }> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs) as McpCallResult
    const text = (result.content ?? [])
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text as string)
      .join('\n')
    return { text, isError: result.isError === true }
  }

  /** Stop the server process. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      // The process may already be gone; closing is best-effort by design.
    }
  }
}
