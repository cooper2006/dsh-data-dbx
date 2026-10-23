/**
 * Discovery of the DBX desktop app's MCP HTTP server.
 *
 * The desktop app can expose MCP over loopback HTTP
 * (`DBX Settings → MCP → MCP HTTP server`). The endpoint and its bearer
 * token both live in the DBX data directory, so the plugin can find them
 * without any configuration.
 *
 * @module dsh-data-dbx/settings
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readAppSettings } from './connections.ts'

/** Where the desktop app's MCP HTTP server listens. */
export interface DesktopMcpEndpoint {
  /** Full MCP endpoint URL, e.g. `http://127.0.0.1:5225/mcp`. */
  url: string
  /** Bearer token the desktop app published next to its data directory. */
  token: string
}

/** The `mcp_http_server_settings` object the desktop app persists. */
interface McpHttpServerSettings {
  enabled?: boolean
  host?: string
  port?: number
  path?: string
}

/**
 * Find the desktop app's MCP HTTP server, when it is enabled.
 *
 * @param dataDir - the DBX data directory.
 * @returns the endpoint and token, or `null` when the server is off.
 */
export async function resolveDesktopMcpEndpoint(dataDir: string): Promise<DesktopMcpEndpoint | null> {
  const settings = await readAppSettings(join(dataDir, 'dbx.db'))
  const raw = settings['mcp_http_server_settings']
  if (typeof raw !== 'object' || raw === null) return null
  const config = raw as McpHttpServerSettings
  if (config.enabled !== true) return null

  const host = typeof config.host === 'string' && config.host.length > 0 ? config.host : '127.0.0.1'
  const port = typeof config.port === 'number' && config.port > 0 ? config.port : 5225
  const path = typeof config.path === 'string' && config.path.length > 0 ? config.path : '/mcp'

  let token: string
  try {
    token = (await readFile(join(dataDir, 'mcp-http-token'), 'utf8')).trim()
  } catch {
    return null
  }
  if (token.length === 0) return null

  const authority = host.includes(':') ? `[${host}]` : host
  return { url: `http://${authority}:${port}${path.startsWith('/') ? path : `/${path}`}`, token }
}
