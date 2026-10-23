// Round-trip check of the panel API against a copy of the real DBX catalog.
//
// The copy lives in a temp directory, so the user's own DBX catalog is never
// written. The script lists, adds, lists again, removes and finally lists a
// third time through the same access layer the panel routes use.
//
// Usage: node scripts/verify-roundtrip.mjs [source-data-dir]

import { mkdtempSync, rmSync } from 'node:fs'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

const { AccessProvider } = await import('../lib/access.js')
const { resolveDataDir } = await import('../lib/catalog.js')
const { DbxServerManager } = await import('../lib/manager.js')

const source = process.argv[2] ?? join(homedir(), 'Library/Application Support/com.dbx.app')
const dataDir = mkdtempSync(join(tmpdir(), 'dbx-roundtrip-'))
for (const suffix of ['', '-wal', '-shm']) {
  const file = join(source, `dbx.db${suffix}`)
  if (existsSync(file)) copyFileSync(file, join(dataDir, `dbx.db${suffix}`))
}
console.log('catalog copy:', dataDir)

const manager = new DbxServerManager({
  command: 'dbx-mcp',
  args: [],
  env: { ...process.env, DBX_DATA_DIR: dataDir },
  startupTimeoutMs: 5_000,
  callTimeoutMs: 10_000,
})

const provider = new AccessProvider({ manager, dataDir, maxRows: 100 })
const access = await provider.get()
console.log('mode:', access.mode)
console.log('capabilities:', access.capabilities)

const before = await access.listConnections()
console.log('before:', before.map((connection) => connection.name))

const added = await access.addConnection({
  name: 'panel-roundtrip-test',
  dbType: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'rt',
  password: 'rt-secret',
  database: 'rt_db',
})
console.log('added:', added)

const after = await access.listConnections()
console.log('after:', after.map((connection) => connection.name))
console.log('found:', JSON.stringify(after.find((connection) => connection.name === 'panel-roundtrip-test')))
console.log('databases:', await access.listDatabases({ connectionId: added.id }))

console.log('removed:', await access.removeConnection({ id: added.id, name: '' }))
console.log('final:', (await access.listConnections()).map((connection) => connection.name))

try {
  await access.query({ connectionId: added.id, sql: 'select 1', maxRows: 1 })
  console.log('query: unexpectedly succeeded')
} catch (error) {
  console.log('query failed as expected:', error instanceof Error ? error.message : error)
}

await manager.dispose()
rmSync(dataDir, { recursive: true, force: true })
