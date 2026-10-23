/**
 * A minimal MCP client for the DBX desktop's HTTP MCP server.
 *
 * The DBX desktop app can host an MCP server over HTTP
 * (`DBX Settings → MCP → MCP HTTP server`, loopback by default). That server
 * runs *inside* the desktop process, so it owns the OS keychain key that the
 * catalog's encrypted secrets need. A headless `dbx-mcp` process cannot read
 * that key, which is why this transport exists: when the desktop server is
 * enabled, the panel talks to it and can therefore create connections and run
 * SQL against the user's real DBX catalog.
 *
 * Only the three calls the plugin needs are implemented: initialize,
 * tools/list and tools/call.
 *
 * @module dsh-data-dbx/http-mcp
 */

import type { McpToolDescriptor } from './mcp.ts'
import { McpError } from './mcp.ts'

/** MCP protocol revision this client speaks. */
const PROTOCOL_VERSION = '2025-06-18'

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

/** A live MCP session over HTTP. */
export class DbxHttpMcpClient {
  private readonly url: string
  private readonly token: string
  private sessionId: string | null = null
  private nextId = 1

  private constructor(url: string, token: string) {
    this.url = url
    this.token = token
  }

  /**
   * Open an MCP session over HTTP.
   *
   * @param url - the MCP endpoint, e.g. `http://127.0.0.1:5225/mcp`.
   * @param token - the bearer token DBX writes next to its data directory.
   * @param timeoutMs - how long the handshake may take.
   * @returns the connected client.
   * @throws {McpError} when the endpoint cannot be reached or refuses the token.
   */
  static async connect(url: string, token: string, timeoutMs: number): Promise<DbxHttpMcpClient> {
    const client = new DbxHttpMcpClient(url, token)
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-data-dbx', version: '0.1.0' },
    }, timeoutMs)
    await client.notify('notifications/initialized', {})
    return client
  }

  /**
   * Send one JSON-RPC request and read its answer.
   *
   * The server may answer with JSON or with a server-sent event stream; both
   * shapes carry the same JSON-RPC payload.
   */
  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    }
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId

    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new McpError(`cannot reach the DBX MCP HTTP server at ${this.url}: ${reason}`)
    }

    const session = response.headers.get('mcp-session-id')
    if (session !== null && session.length > 0) this.sessionId = session

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new McpError(`the DBX MCP HTTP server answered ${response.status}: ${body.slice(0, 400)}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const payload = contentType.includes('text/event-stream')
      ? parseEventStream(await response.text())
      : await response.text()

    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(payload) as typeof message
    } catch {
      throw new McpError('the DBX MCP HTTP server answered with a malformed JSON-RPC payload')
    }
    if (message.error !== undefined) {
      throw new McpError(message.error.message ?? 'unknown MCP error')
    }
    return message.result
  }

  /** Send one notification; the server answers with 202 and no body. */
  private async notify(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
    }
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId
    try {
      await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // A refused notification does not invalidate the session.
    }
  }

  /**
   * List the tools the server exposes.
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

  /** Release the session. The desktop server keeps running. */
  close(): void {
    this.sessionId = null
  }
}

/**
 * Read the JSON-RPC payload out of a server-sent event stream.
 *
 * @param body - the raw response body.
 * @returns the first `data:` payload in the stream.
 */
function parseEventStream(body: string): string {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0) continue
    if (payload === '[DONE]') continue
    return payload
  }
  throw new McpError('the DBX MCP HTTP server sent an empty event stream')
}
