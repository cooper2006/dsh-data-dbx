// Round-10 self-check: the plugin's own driver stack and its vault.
//
// The point of this round is that the panel works with DBX closed, so this
// script runs with no DBX at all: it imports connections out of a seeded DBX
// catalog, then opens a real SQLite file through the driver registry, runs
// statements, lists tables, describes one, caps a result, and edits and
// removes rows. It also checks the two properties that make the vault safe:
// the password never lands on disk in plaintext, and a DBX connection is still
// reachable through the wrapped transport.
//
// Usage: node scripts/verify-native.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { storeConnection } from '../lib/store.js'
import { importCatalogConnections, NativeAccess, NativeAccessProvider } from '../lib/native.js'
import { listVault, toConnectSpec } from '../lib/vault.js'
import { masterKey } from '../lib/vault.js'

const failures = []
function check(condition, label) {
  if (condition) {
    console.log('  ok  ', label)
    return
  }
  failures.push(label)
  console.log('  FAIL', label)
}

const dataDir = mkdtempSync(join(tmpdir(), 'dbx-native-'))

// The shape DBX creates for its own catalog.
const { DatabaseSync } = await import('node:sqlite')
const seed = new DatabaseSync(join(dataDir, 'dbx.db'))
seed.exec(`
  CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
  CREATE TABLE connection_secrets (
    connection_id TEXT NOT NULL,
    key TEXT NOT NULL,
    secret TEXT NOT NULL,
    secret_enc TEXT,
    PRIMARY KEY (connection_id, key)
  );
`)
seed.close()

const sqlitePath = join(dataDir, 'sample.db')
writeFileSync(sqlitePath, '')

const catalogSqliteId = await storeConnection(dataDir, {
  name: 'local-demo',
  dbType: 'sqlite',
  host: sqlitePath,
  port: 0,
  username: '',
  password: '',
  database: '',
})
await storeConnection(dataDir, {
  name: 'remote-demo',
  dbType: 'postgres',
  // A port nothing listens on, so the only failure below is the missing secret.
  host: '127.0.0.1',
  port: 1,
  username: 'u',
  password: 'p',
  database: 'app',
})

console.log('import from the DBX catalog')
const imported = await importCatalogConnections(dataDir, { all: true })
check(imported.imported.length === 2, 'both catalog connections were copied')
check(imported.needsPassword.join(',') === 'remote-demo', 'the network engine is reported as needing a password')
const again = await importCatalogConnections(dataDir, { all: true })
check(again.imported.length === 0 && again.skipped.length === 2, 'a second import skips what is already there')

// DBX is closed: all that answers is the catalog, which can list what it has
// but cannot run a statement. Every query below has to be served by the plugin.
const catalogRows = [
  { id: catalogSqliteId, name: 'local-demo', dbType: 'sqlite', host: sqlitePath, port: 0, database: '', groupPath: '', note: '' },
  { id: 'catalog-remote', name: 'remote-demo', dbType: 'postgres', host: '127.0.0.1', port: 1, database: 'app', groupPath: '', note: '' },
]
const catalogOnly = {
  mode: 'catalog',
  source: 'the DBX catalog, nothing running',
  capabilities: { list: true, add: false, remove: true, query: false, tables: false, databases: true },
  async listConnections() { return catalogRows },
  async addConnection() { throw new Error('catalog mode cannot add') },
  async removeConnection() { return 'removed from the catalog' },
  async query() { throw new Error('running SQL needs a live DBX: start the DBX desktop app, or enable its MCP server') },
  async listTables() { throw new Error('running SQL needs a live DBX') },
  async listDatabases() { return ['app'] },
}
const offline = {
  async get() { return catalogOnly },
  async refresh() { return catalogOnly },
}
const provider = new NativeAccessProvider({ dbx: offline, dataDir, maxRows: 100 })
const access = await provider.get()

console.log('the panel answers without DBX')
check(access.mode === 'native', 'the route reports itself as native')
check(access.capabilities.query === true, 'querying is offered because the vault has a driver')
check(access.capabilities.add === true, 'creating is offered')
check(access.vaultCount === 2, 'both imported rows are in the vault')

const listed = await access.listConnections()
check(listed.length === 2, 'the list holds both connections')
check(listed.every(connection => connection.source === 'vault'), 'every row is owned by the plugin')
check(listed.every(connection => connection.managed === true), 'every row is editable')
// DBX still lists the same two connections; they must not appear twice.
check(listed.filter(connection => connection.source === 'dbx').length === 0, 'an imported row is not listed twice')
const local = listed.find(connection => connection.name === 'local-demo')
if (local === undefined) throw new Error('the imported sqlite connection is missing')
check(typeof local.dialect === 'string' && local.dialect.length > 0, `the dialect is named (${local.dialect})`)

console.log('a real SQLite file over the driver stack')
await access.query({
  connectionId: local.id,
  sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)',
  maxRows: 100,
})
await access.query({
  connectionId: local.id,
  sql: "INSERT INTO users (name, age) VALUES ('ada', 36), ('linus', 55)",
  maxRows: 100,
})
const rows = await access.query({
  connectionId: local.id,
  sql: 'SELECT id, name, age FROM users ORDER BY id',
  maxRows: 100,
})
check(rows.columns.join(',') === 'id,name,age', 'the columns are the table columns')
check(rows.rows.length === 2, 'both rows came back')
check(rows.rows[0].join(',') === '1,ada,36', 'the first row is right')

await access.query({ connectionId: local.id, sql: "INSERT INTO users (name) VALUES ('nullish')", maxRows: 100 })
const nullish = await access.query({
  connectionId: local.id,
  sql: "SELECT age FROM users WHERE name = 'nullish'",
  maxRows: 100,
})
check(nullish.rows[0][0] === 'NULL', 'a null cell is drawn as NULL')

const capped = await access.query({ connectionId: local.id, sql: 'SELECT id FROM users ORDER BY id', maxRows: 1 })
check(capped.rows.length === 1, 'the row cap is applied')
check(capped.truncated === true, 'a capped answer says it was truncated')

const tables = await access.listTables({ connectionId: local.id })
check(tables.some(table => table.name === 'users'), 'the table is listed')
const columns = await access.describeTable({ connectionId: local.id, table: 'users' })
check(columns.length === 3, 'the table has three columns')
check(columns[0].name === 'id' && columns[0].primaryKey === true, 'the primary key is described')
check(columns[1].nullable === false, 'a NOT NULL column is described as required')
const databases = await access.listDatabases({ connectionId: local.id })
check(databases.length > 0, `the databases are listed (${databases.join(',')})`)

console.log('a stale DBX id is served by the vault row it was imported into')
const twin = await access.query({ connectionId: catalogSqliteId, sql: 'SELECT 1 AS one', maxRows: 10 })
check(twin.rows[0][0] === '1', 'the catalog id reached the self-built driver')

console.log('an imported row without a password says so')
let missingSecret = ''
try {
  await access.query({ connectionId: 'catalog-remote', sql: 'SELECT 1', maxRows: 10 })
} catch (error) {
  missingSecret = error instanceof Error ? error.message : String(error)
}
check(/imported from DBX/.test(missingSecret), 'the missing secret is named, not left as an auth failure')
check(/press Edit/.test(missingSecret), 'the message says how to fix it')

console.log('a DBX connection is refused describe, not guessed at')
let refused = false
try {
  await access.describeTable({ connectionId: 'conn-missing', table: 'users' })
} catch (error) {
  refused = /self-built/.test(error instanceof Error ? error.message : String(error))
}
check(refused, 'describe on an unknown connection explains why it is unavailable')

console.log('the vault keeps the secret off disk')
const secret = await access.addConnection({
  name: 'secret-demo',
  dbType: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'u',
  password: 'secret-value',
  database: 'app',
  schema: 'reporting',
})
const vaultFile = readFileSync(join(dataDir, 'data-dbx', 'connections.json'), 'utf8')
check(!vaultFile.includes('secret-value'), 'the password is not in the vault file')
check(vaultFile.includes('aes256gcm.'), 'the password is stored as a self-describing ciphertext')
check(secret.id.length > 0, 'the new connection has an id')
const stored = listVault(dataDir).find(entry => entry.id === secret.id)
check(stored?.schema === 'reporting', 'the schema is written to the vault')
// The vault is only useful if the driver receives it: this is the value the
// PostgreSQL driver turns into `search_path` on every session it opens.
check(
  stored === undefined ? false : toConnectSpec(stored, masterKey(dataDir)).schema === 'reporting',
  'the schema reaches the driver spec',
)

console.log('the engine catalog says which engines have a schema')
const schemaEngines = access.engineCatalog
check(
  schemaEngines.some(engine => engine.type === 'postgres' && engine.schema === true),
  'postgres asks for a schema',
)
check(
  schemaEngines.every(engine => typeof engine.schema === 'boolean'),
  'every engine says whether it has one',
)
check(
  schemaEngines.filter(engine => engine.schema).every(engine => engine.type !== 'mysql' && engine.type !== 'sqlite'),
  'mysql and sqlite are not offered one',
)

console.log('editing and removing a self-built row')
const edited = await access.updateConnection(local.id, {
  name: 'local-renamed',
  dbType: 'sqlite',
  host: sqlitePath,
  port: 0,
  username: '',
  password: '',
  database: '',
})
check(edited.name === 'local-renamed', 'the name was rewritten')
check(listVault(dataDir).some(entry => entry.name === 'local-renamed'), 'the vault holds the new name')
const removed = await access.removeConnection({ id: secret.id })
check(/secret-demo/.test(removed), 'the removed row is named in the answer')
check(!listVault(dataDir).some(entry => entry.name === 'secret-demo'), 'the row is gone from the vault')

console.log('an edit keeps the engine and the port the row was stored with')
const mongo = await access.addConnection({
  name: 'mongo-nl99',
  dbType: 'mongodb',
  host: '127.0.0.1',
  port: 27018,
  username: '',
  password: '',
  database: 'app',
})
// The panel sends no port when the field is left alone. A `NaN` port once
// reached the vault as "absent" and the row started pointing at 27017, a
// server that has nothing to do with it.
const mongoEdited = await access.updateConnection(mongo.id, {
  name: 'mongo-nl99',
  dbType: 'mongodb',
  host: '127.0.0.1',
  port: undefined,
  username: undefined,
  password: undefined,
  database: undefined,
  ssl: undefined,
})
check(mongoEdited.port === 27018, 'an edit without a port keeps the stored port')
check(mongoEdited.dbType === 'mongodb', 'an edit keeps the stored engine')
const catalog = access.engineCatalog
check(
  catalog.some(engine => engine.type === 'mongodb' && engine.port === 27017),
  'the status names the form defaults a MongoDB row needs',
)
check(
  catalog.every(engine => typeof engine.label === 'string' && engine.label.length > 0),
  'every catalog engine carries a label',
)
check(
  catalog.some(engine => engine.type === 'redis'),
  'engines without a row in the panel list are still offered',
)

console.log('a replaced master key is reported, not guessed at')
const rotated = await access.addConnection({
  name: 'rotated-key',
  dbType: 'sqlite',
  host: sqlitePath,
  port: 0,
  username: '',
  password: 'another-secret',
  database: '',
})
// Overwriting the key is exactly what somebody copying a vault to a new
// machine does. The read must say so instead of handing the driver garbage.
writeFileSync(join(dataDir, 'data-dbx', 'master.key'), JSON.stringify({ key: Buffer.alloc(32, 9).toString('base64') }))
let keyMessage = ''
try {
  await access.query({ connectionId: rotated.id, sql: 'SELECT 1', maxRows: 10 })
} catch (error) {
  keyMessage = error instanceof Error ? error.message : String(error)
}
check(/vault key/.test(keyMessage), `a replaced key is explained (${keyMessage.slice(0, 60)}…)`)

console.log('the DBX route still answers when it is the only owner')
const fakeDbx = {
  mode: 'bridge',
  source: 'fake bridge',
  capabilities: { list: true, add: true, remove: true, query: true, tables: true, databases: true },
  async listConnections() {
    return [{ id: 'conn-1', name: 'dbx-demo', dbType: 'postgres', host: 'h', port: 5432, database: 'd', groupPath: '', note: '' }]
  },
  async addConnection() { return { id: 'conn-2', message: 'added through DBX' } },
  async removeConnection(selector) { return `removed ${selector.id ?? selector.name} through DBX` },
  async query() {
    return { columns: ['x'], rows: [['7']], rowCount: 1, affectedRows: null, truncated: false, resultId: null, messages: [], text: '| x |' }
  },
  async listTables() { return [{ name: 't', tableType: 'BASE TABLE' }] },
  async listDatabases() { return ['d'] },
}
const bridgedProvider = {
  async get() { return fakeDbx },
  async refresh() { return fakeDbx },
}
const bridged = new NativeAccess({ dbx: bridgedProvider, dataDir, maxRows: 100 }, fakeDbx)

const mixed = await bridged.listConnections()
check(mixed.some(connection => connection.source === 'dbx'), 'the DBX row is listed next to the vault rows')
check(mixed.some(connection => connection.source === 'dbx' && connection.managed === false), 'a DBX row is not editable')
const viaDbx = await bridged.query({ connectionId: 'conn-1', sql: 'SELECT 1', maxRows: 100 })
check(viaDbx.rows[0][0] === '7', 'an unknown id falls through to DBX')
// Snowflake has no driver here, so it must be stored by DBX instead.
const delegated = await bridged.addConnection({ name: 'sf', dbType: 'snowflake', host: 'h', port: 443 })
check(delegated.id === 'conn-2', 'an engine with no driver is stored in DBX')
const selfBuilt = await bridged.addConnection({ name: 'native-pg', dbType: 'postgres', host: 'h', port: 5432, password: 'pw' })
check(selfBuilt.id !== 'conn-2', 'an engine with a driver is stored in the vault')

rmSync(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nOK: the self-built route works with DBX closed')
