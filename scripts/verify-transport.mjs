// Report which DBX transport the panel would use on this machine.
//
// The access layer tries the desktop MCP server, then the headless server,
// then the desktop bridge. This script resolves it against the real DBX
// installation and prints the mode, the source, and what it can do.
//
// Usage: node scripts/verify-transport.mjs [dbx-data-dir]

import { DbxServerManager } from '../lib/manager.js'
import { AccessProvider, resolveAccess } from '../lib/access.js'
import { resolveDataDir } from '../lib/catalog.js'
import { resolveMcpCommand } from '../lib/command.js'

const dataDir = resolveDataDir(process.argv[2])
console.log('data dir:', dataDir)

const command = resolveMcpCommand({ command: process.env.DBX_MCP_COMMAND, env: process.env })
console.log('mcp command:', command.command, `(${command.source})`)

const manager = new DbxServerManager({
  command: command.command,
  args: [],
  env: { ...process.env, DBX_DATA_DIR: dataDir },
  startupTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
})

const runtime = { manager, dataDir, maxRows: 100 }
const access = await resolveAccess(runtime)
console.log('mode:', access.mode)
console.log('source:', access.source)
console.log('capabilities:', access.capabilities)

try {
  const connections = await access.listConnections()
  console.log('connections:', connections)
} catch (error) {
  console.log('listing failed:', error instanceof Error ? error.message : error)
}

await manager.dispose()
