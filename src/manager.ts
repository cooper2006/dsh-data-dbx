/**
 * Managed lifecycle for the DBX MCP server process.
 *
 * The plugin starts one DBX MCP server per plugin instance, lazily on first
 * use, and reuses it for every call. A crashed server is transparently
 * replaced on the next call, so a DBX restart or an out-of-memory kill does not
 * require a harness restart. The process and its in-flight calls are released
 * when the plugin's fiber is disposed.
 *
 * @module dsh-data-dbx/manager
 */

import { DbxMcpClient, McpError } from './mcp.ts'
import type { McpToolDescriptor } from './mcp.ts'

/** Configuration the manager needs to launch and address one DBX MCP server. */
export interface ManagerOptions {
  /** Executable to spawn; the federation-enabled `dbx-mcp` build by default. */
  command: string
  /** Additional server arguments. */
  args: readonly string[]
  /** Extra environment entries for the server (e.g. `DBX_DATA_DIR`). */
  env: Readonly<Record<string, string>>
  /** Handshake budget in milliseconds. */
  startupTimeoutMs: number
  /** Per-call budget in milliseconds. */
  callTimeoutMs: number
}

/** The connected server plus the tools it advertised at handshake. */
export interface ConnectedServer {
  client: DbxMcpClient
  tools: readonly McpToolDescriptor[]
}

/**
 * Owns the DBX MCP server process for one plugin instance.
 *
 * A single in-flight connection promise serializes concurrent callers, so two
 * tools invoked in the same step share one server rather than racing to spawn
 * two.
 */
export class DbxServerManager {
  private readonly options: ManagerOptions
  private starting: Promise<ConnectedServer> | null = null
  private current: ConnectedServer | null = null

  constructor(options: ManagerOptions) {
    this.options = options
  }

  /**
   * Get a connected server, starting one when needed.
   *
   * @returns the live client and its tool descriptors.
   * @throws {McpError} when the server cannot be started.
   */
  async server(): Promise<ConnectedServer> {
    if (this.current !== null) return this.current
    if (this.starting !== null) return this.starting

    this.starting = (async () => {
      const client = await DbxMcpClient.connect(
        this.options.command,
        this.options.args,
        this.options.env,
        this.options.startupTimeoutMs,
      )
      const tools = await client.listTools(this.options.startupTimeoutMs)
      const connected: ConnectedServer = { client, tools }
      this.current = connected
      return connected
    })()

    try {
      return await this.starting
    } catch (error) {
      // A failed start must not be cached, or every later call inherits it.
      this.starting = null
      throw error instanceof McpError
        ? error
        : new McpError(`cannot start the DBX MCP server (${this.options.command}): ${String(error)}`)
    }
  }

  /**
   * Call one DBX tool, restarting the server once if it died underneath us.
   *
   * @param name - the DBX tool name.
   * @param args - tool arguments.
   * @returns the tool's text output and error flag.
   */
  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const connected = await this.server()
    try {
      return await connected.client.callTool(name, args, this.options.callTimeoutMs)
    } catch (error) {
      // A transport failure means the process is gone; drop it and retry once
      // against a fresh server so one crash does not fail the whole session.
      if (!(error instanceof McpError)) throw error
      this.current = null
      this.starting = null
      const restarted = await this.server()
      return await restarted.client.callTool(name, args, this.options.callTimeoutMs)
    }
  }

  /**
   * Whether the server currently exposes a given tool.
   *
   * @param name - the DBX tool name.
   * @returns true when the connected server advertised it.
   */
  async hasTool(name: string): Promise<boolean> {
    const connected = await this.server()
    return connected.tools.some(tool => tool.name === name)
  }

  /** Stop the server and release the process. Idempotent. */
  dispose(): void {
    this.current?.client.close()
    this.current = null
    this.starting = null
  }
}
