// End-to-end check of the DBX panel host API against a real DBX MCP server.
//
// The MCP server is the prebuilt DBX release binary, pointed at a writable
// copy of the DBX catalog so the check never touches the real store.
//
// Usage: node scripts/verify-panel.mjs [dbx-mcp-binary]

import { mkdtempSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DbxMcpClient } from '../lib/mcp.js'
import {
  parseConnectionList,
  parseDatabaseList,
  parseQueryResult,
  parseTableList,
} from '../lib/api.js'

const FLAGS = process.argv.slice(2)
const BINARY = FLAGS.find(argument => !argument.startsWith('--'))
  ?? '/Users/cooper/Github/dbx_fed/dbx/packages/mcp-server/node_modules/@dbx-app/mcp-darwin-arm64/bin/dbx-mcp'
const SOURCE = join(process.env.HOME ?? '', 'Library/Application Support/com.dbx.app/dbx.db')

const dataDir = mkdtempSync(join(tmpdir(), 'dbx-panel-'))
if (!process.argv.includes('--fresh')) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${SOURCE}${suffix}`
    if (existsSync(file)) copyFileSync(file, join(dataDir, `dbx.db${suffix}`))
  }
}
console.log('catalog copy:', dataDir)

const client = await DbxMcpClient.connect(BINARY, [], { DBX_DATA_DIR: dataDir }, 30_000)
const tools = await client.listTools(30_000)
console.log('tools:', tools.length, tools.map(tool => tool.name).join(', '))

const call = async (name, args) => {
  const result = await client.callTool(name, args, 60_000)
  console.log(`\n--- ${name} ${JSON.stringify(args)} -> isError=${result.isError}`)
  console.log(result.text)
  return result
}

const list = await call('dbx_list_connections', {})
const connections = parseConnectionList(list.text)
console.log('parsed connections:', connections)

const added = await call('dbx_add_connection', {
  name: 'panel-demo',
  db_type: 'sqlite',
  host: join(dataDir, 'demo.db'),
  username: '',
  password: '',
  ssl: false,
})
const id = /added \(id: ([^)]+)\)/.exec(added.text)?.[1] ?? ''

// Seed the SQLite file with node:sqlite so the check does not depend on
// DBX's high-risk SQL policy (DDL is blocked by default).
const { DatabaseSync } = await import('node:sqlite')
const seed = new DatabaseSync(join(dataDir, 'demo.db'))
seed.exec('CREATE TABLE demo (id INTEGER, label TEXT)')
seed.exec("INSERT INTO demo (id, label) VALUES (1, 'first'), (2, NULL)")
seed.close()

const select = await call('dbx_execute_query', { connection_id: id, sql: 'SELECT id, label FROM demo ORDER BY id' })
console.log('parsed result:', parseQueryResult(select.text))

const update = await call('dbx_execute_query', { connection_id: id, sql: "UPDATE demo SET label = 'updated' WHERE id = 1" })
console.log('parsed update:', parseQueryResult(update.text))

const listed = await call('dbx_list_connections', {})
console.log('parsed connections after add:', parseConnectionList(listed.text))

const tables = await call('dbx_list_tables', { connection_id: id })
console.log('parsed tables:', parseTableList(tables.text))

const databases = await call('dbx_list_databases', { connection_id: id })
console.log('parsed databases:', parseDatabaseList(databases.text))

const removed = await call('dbx_remove_connection', { connection_id: id })
console.log('removed:', removed.text)

client.close()
rmSync(dataDir, { recursive: true, force: true })
