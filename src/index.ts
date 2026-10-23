/**
 * dsh-data-dbx — DBX database connections, SQL execution, and cross-connection
 * federated queries as DeepSeek Harness tools.
 *
 * The plugin is two layers in one package. It is a thin, well-typed surface
 * over the DBX MCP server: it reads the connection catalog DBX already stores,
 * starts the federation-enabled `dbx-mcp` binary, and exposes four
 * model-facing tools. It also carries its own driver stack and encrypted
 * connection vault, so the browser panel can list, query, and describe a
 * self-built connection with no DBX running at all.
 *
 * @module dsh-data-dbx
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyDbxApi } from './api.ts'
import { AccessProvider } from './access.ts'
import { resolveDataDir } from './catalog.ts'
import { DEFAULT_MCP_COMMAND, resolveMcpCommand } from './command.ts'
import { resolveDbxDbPath } from './connections.ts'
import { DbxServerManager } from './manager.ts'
import { NativeAccessProvider } from './native.ts'
import { applyDbxTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'data-dbx'

/** Services required by the DBX tool suite. */
export const inject = ['tools']

/** Default executable: the federation-enabled DBX MCP server build. */
export { DEFAULT_MCP_COMMAND }

/** Default cooperative tool-call timeout budget (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000

/** Default cap on rows returned by one executed statement. */
export const DEFAULT_MAX_ROWS = 100

/** Plugin configuration. */
export interface Config {
  /**
   * Path to the DBX MCP server executable. Point this at a build made with
   * `cargo build -p dbx-mcp --features federation` to enable federated queries;
   * a default build still serves connection listing and single-connection SQL.
   */
  command?: string
  /** Extra arguments passed to the MCP server. */
  args?: string[]
  /**
   * DBX data directory holding `dbx.db`. Defaults to `DBX_DATA_DIR` when set,
   * otherwise the DBX desktop app's own platform data directory.
   */
  dataDir?: string
  /** Extra environment entries for the MCP server process. */
  env?: Record<string, string>
  /** Handshake budget for starting the server (ms). */
  startupTimeoutMs?: number
  /** Cooperative per-call timeout budget (ms). */
  timeoutMs?: number
  /** Upper bound on rows returned per statement. */
  maxRows?: number
}

export const Config: z<Config> = z.object({
  command: z.string().default(DEFAULT_MCP_COMMAND),
  args: z.array(String).default([]),
  dataDir: z.string(),
  env: z.dict(String).default({}),
  startupTimeoutMs: z.number().default(30_000),
  timeoutMs: z.number().default(DEFAULT_TOOL_TIMEOUT_MS),
  maxRows: z.number().default(DEFAULT_MAX_ROWS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured counts and timeouts must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`data-dbx: ${field} must be a positive integer`)
  }
}

/**
 * Register the DBX tools and own the MCP server process for this fiber.
 *
 * The server starts lazily on the first tool call, so loading the plugin never
 * blocks harness startup on a subprocess handshake. Disposal stops the server.
 *
 * @param ctx - the plugin context.
 * @param config - validated loader configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('startupTimeoutMs', resolved.startupTimeoutMs)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxRows', resolved.maxRows)

  const dataDir = resolved.dataDir !== undefined && resolved.dataDir.length > 0
    ? resolved.dataDir
    : undefined

  // The server resolves DBX storage through DBX_DATA_DIR; pass the resolved
  // directory explicitly so the catalog reader and the server agree on one store.
  const env: Record<string, string> = { ...resolved.env }
  if (dataDir !== undefined && env['DBX_DATA_DIR'] === undefined) env['DBX_DATA_DIR'] = dataDir

  // DBX ships the MCP server as a separate binary that is not on the PATH of a
  // desktop session, so resolve it here and report where it came from.
  const mcp = resolveMcpCommand({ command: resolved.command, env: process.env })
  if (mcp.source === 'default') {
    ctx.logger.warn(
      'data-dbx: could not find the DBX MCP server; set the "command" option, '
      + 'or the DBX_MCP_COMMAND environment variable, to the dbx-mcp executable',
    )
  } else {
    ctx.logger.debug(`data-dbx: DBX MCP server ${mcp.command} (${mcp.source})`)
  }

  const manager = new DbxServerManager({
    command: mcp.command,
    args: resolved.args,
    env,
    startupTimeoutMs: resolved.startupTimeoutMs,
    callTimeoutMs: resolved.timeoutMs,
  })

  // Resolve once at load so a misconfigured data directory surfaces in the log
  // rather than only on the first tool call.
  ctx.logger.debug(`data-dbx: DBX catalog at ${resolveDbxDbPath(dataDir)}`)

  applyDbxTools(ctx, {
    dataDir,
    manager,
    maxRows: resolved.maxRows,
    timeoutMs: resolved.timeoutMs,
  })

  // The DBX panel in the browser talks to these routes over the harness
  // connection service. The service is optional (a headless run has none), so
  // the routes live in a nested fiber that activates once the service appears;
  // the four tools above work either way.
  const panelDataDir = resolveDataDir(dataDir)
  ctx.inject(['connection'], (injected) => {
    applyDbxApi(injected, {
      access: new NativeAccessProvider({
        dbx: new AccessProvider({
          manager,
          dataDir: panelDataDir,
          maxRows: resolved.maxRows,
        }),
        dataDir: panelDataDir,
        maxRows: resolved.maxRows,
      }),
      dataDir: panelDataDir,
      maxRows: resolved.maxRows,
    })
  })

  // Stop the server when this plugin's fiber is disposed.
  ctx.effect(() => () => manager.dispose(), 'data-dbx.server')
}
