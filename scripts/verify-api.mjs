// Check the host API routes without a running harness.
//
// The routes are registered on the harness connection service; this script
// provides a fake service, drives every route against a fake DBX MCP server,
// and asserts what the browser half receives.
//
// The fake manager answers the same tool calls the real DBX MCP server answers,
// so the access layer, the parsers, and the routes are all exercised.
//
// Usage: node scripts/verify-api.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Canned DBX answers, one per tool the panel uses. */
const ANSWERS = {
  dbx_list_connections: [
    '| ID | Name | Group Path | Type | Host | Port | Database | Note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| conn-1 | demo | team | postgres | 127.0.0.1 | 5432 | app | a note |',
  ].join('\n'),
  dbx_add_connection: 'Connection "demo" added (id: conn-2).',
  dbx_remove_connection: 'Connection "demo" (id: conn-2) removed.',
  dbx_execute_query: [
    '| id | label |',
    '|---|---|',
    '| 1 | first |',
    '| 2 | NULL |',
    '(2 rows, 4ms)',
  ].join('\n'),
  dbx_list_tables: '- users (BASE TABLE)\n- orders (VIEW)',
  dbx_list_databases: '- app\n- reporting',
}

/** The fake connection service: it records the registered routes. */
const routes = new Map()
const ctx = {
  logger: { warn() {}, debug() {} },
  connection: {
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`route already registered: ${route.path}`)
        routes.set(route.path, route)
      },
    },
  },
}

/** The fake manager: it answers from the canned table and records the calls. */
const calls = []
const manager = {
  async server() {
    return { name: 'fake-dbx-mcp' }
  },
  async call(name, args) {
    calls.push({ name, args })
    const text = ANSWERS[name]
    if (text === undefined) throw new Error(`unexpected tool call: ${name}`)
    return { text, isError: false }
  },
  async hasTool() {
    return true
  },
  async dispose() {},
}

const { AccessProvider } = await import('../lib/access.js')
const { applyDbxApi, API_ROUTES } = await import('../lib/api.js')
const { NativeAccessProvider } = await import('../lib/native.js')

// An empty data directory: there is no desktop MCP server and no bridge there,
// so the access layer falls back to the headless server, which is the fake.
const dataDir = mkdtempSync(join(tmpdir(), 'dbx-verify-'))
applyDbxApi(ctx, {
  access: new NativeAccessProvider({
    dbx: new AccessProvider({ manager, dataDir, maxRows: 100 }),
    dataDir,
    maxRows: 100,
  }),
  dataDir,
  maxRows: 100,
})

/** Drive one route and parse its JSON answer. */
async function request(path, init) {
  const route = routes.get(new URL(`http://dsh.test${path}`).pathname)
  if (route === undefined) throw new Error(`no route registered for ${path}`)
  const response = await route.fetch(new Request(`http://dsh.test${path}`, init))
  const body = await response.json()
  return { status: response.status, body }
}

const status = await request(API_ROUTES.status)
if (status.status !== 200) throw new Error(`the status route failed: ${status.status}`)
if (status.body.mode !== 'native') throw new Error(`the route was not reported: ${status.body.mode}`)
if (status.body.capabilities.add !== true) throw new Error('the capabilities were not reported')
if (!Array.isArray(status.body.engines) || status.body.engines.length === 0) {
  throw new Error('the self-built engines were not reported')
}
// The connection form is built from this catalog: it needs a label and a port
// per engine, otherwise it falls back to the first engine in its own list and
// silently changes the engine of the row it is editing.
if (!Array.isArray(status.body.engineCatalog) || status.body.engineCatalog.length === 0) {
  throw new Error('the engine catalog the connection form needs was not reported')
}
for (const engine of status.body.engineCatalog) {
  if (typeof engine.type !== 'string' || typeof engine.label !== 'string') {
    throw new Error(`an engine descriptor is incomplete: ${JSON.stringify(engine)}`)
  }
  if (typeof engine.port !== 'number' || typeof engine.file !== 'boolean') {
    throw new Error(`an engine descriptor has no usable port: ${JSON.stringify(engine)}`)
  }
  // The form shows the schema field for exactly the engines that have one, so
  // the flag has to be there and has to be right.
  if (typeof engine.schema !== 'boolean') {
    throw new Error(`an engine descriptor does not say whether it has a schema: ${JSON.stringify(engine)}`)
  }
}
const postgresEngine = status.body.engineCatalog.find(engine => engine.type === 'postgres')
if (postgresEngine === undefined || postgresEngine.schema !== true) {
  throw new Error('postgres must be offered a schema field')
}
const mysqlEngine = status.body.engineCatalog.find(engine => engine.type === 'mysql')
if (mysqlEngine === undefined || mysqlEngine.schema !== false) {
  throw new Error('mysql must not be offered a schema field')
}
if (status.body.vaultCount !== 0) throw new Error('an empty vault was not reported')

const listed = await request(API_ROUTES.connections)
if (listed.status !== 200) throw new Error(`listing failed: ${listed.status}`)
if (listed.body.connections.length !== 1) throw new Error('the connection list was not parsed')
if (listed.body.connections[0].name !== 'demo') throw new Error('the connection name was not parsed')
if (listed.body.connections[0].port !== 5432) throw new Error('the connection port was not parsed')

// An engine the plugin has a driver for is stored in its own vault: no DBX
// call is made, and the answer carries a vault id rather than a DBX id.
const selfBuilt = await request(API_ROUTES.connections, {
  method: 'POST',
  body: JSON.stringify({
    name: 'panel-pg',
    dbType: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'user',
    password: 'secret',
    database: 'app',
    schema: 'reporting',
  }),
})
if (selfBuilt.status !== 200) throw new Error(`creating failed: ${selfBuilt.status}`)
if (selfBuilt.body.id === 'conn-2') throw new Error('a supported engine was handed to DBX')
if (!/self-built/.test(selfBuilt.body.message)) throw new Error('the answer does not say where the row went')
if (calls.some(call => call.name === 'dbx_add_connection')) {
  throw new Error('a self-built connection must not reach DBX')
}
const afterSelfBuilt = await request(API_ROUTES.connections)
if (afterSelfBuilt.body.connections.length !== 2) throw new Error('the self-built row is not listed')
const vaultRow = afterSelfBuilt.body.connections.find(connection => connection.source === 'vault')
if (vaultRow === undefined) throw new Error('the self-built row is not tagged as such')
if (vaultRow.managed !== true) throw new Error('the self-built row is not editable')
// The schema is what makes `SELECT * FROM users` find the right table on a
// server where `public` is empty, so it has to survive the round trip.
if (vaultRow.schema !== 'reporting') throw new Error(`the schema was not kept: ${JSON.stringify(vaultRow.schema)}`)
// Editing a connection is how a schema gets fixed after the fact, and an empty
// value is how it gets cleared back to the engine's default: a form that could
// only set it would trap anyone who typed one by mistake.
const editedSchema = await request(API_ROUTES.updateConnection, {
  method: 'POST',
  body: JSON.stringify({
    connectionId: vaultRow.id,
    name: 'panel-pg',
    dbType: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
    schema: 'analytics',
  }),
})
if (editedSchema.status !== 200) throw new Error(`editing failed: ${editedSchema.status}`)
const afterEdit = await request(API_ROUTES.connections)
const editedRow = afterEdit.body.connections.find(connection => connection.id === vaultRow.id)
if (editedRow === undefined || editedRow.schema !== 'analytics') {
  throw new Error(`the edited schema was not stored: ${JSON.stringify(editedRow?.schema)}`)
}
if (editedRow.database !== 'app') throw new Error('editing the schema dropped the database')

const clearedSchema = await request(API_ROUTES.updateConnection, {
  method: 'POST',
  body: JSON.stringify({
    connectionId: vaultRow.id,
    name: 'panel-pg',
    dbType: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
    schema: '',
  }),
})
if (clearedSchema.status !== 200) throw new Error(`clearing the schema failed: ${clearedSchema.status}`)
const afterClear = await request(API_ROUTES.connections)
const clearedRow = afterClear.body.connections.find(connection => connection.id === vaultRow.id)
if (clearedRow === undefined || clearedRow.schema !== '') {
  throw new Error(`an empty schema must clear the field: ${JSON.stringify(clearedRow?.schema)}`)
}

// Leaving the field out of an edit keeps what the vault holds, so a form that
// does not know about schemas cannot wipe one by sending a partial body.
const untouched = await request(API_ROUTES.updateConnection, {
  method: 'POST',
  body: JSON.stringify({
    connectionId: vaultRow.id,
    name: 'panel-pg',
    dbType: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'app',
  }),
})
if (untouched.status !== 200) throw new Error(`editing failed: ${untouched.status}`)
const afterUntouched = await request(API_ROUTES.connections)
const untouchedRow = afterUntouched.body.connections.find(connection => connection.id === vaultRow.id)
if (untouchedRow === undefined || untouchedRow.schema !== '') {
  throw new Error('a body without a schema must keep the stored one')
}

const dbxRow = afterSelfBuilt.body.connections.find(connection => connection.source === 'dbx')
if (dbxRow === undefined || dbxRow.managed !== false) throw new Error('the DBX row is not tagged as not editable')

// An engine with no driver still goes to DBX, password and all. Snowflake is the
// example: DBX ships a provider for it, this plugin has no driver.
const created = await request(API_ROUTES.connections, {
  method: 'POST',
  body: JSON.stringify({
    name: 'demo-snowflake',
    dbType: 'snowflake',
    host: '127.0.0.1',
    port: 443,
    username: 'user',
    password: 'secret',
    database: 'app',
  }),
})
if (created.status !== 200) throw new Error(`creating failed: ${created.status}`)
if (created.body.id !== 'conn-2') throw new Error('the new connection id was not read')
const addCall = calls.find(call => call.name === 'dbx_add_connection')
if (addCall.args.password !== 'secret') throw new Error('the password was not forwarded to DBX')
if (addCall.args.db_type !== 'snowflake') throw new Error('the engine was not mapped to DBX')

const queried = await request(API_ROUTES.query, {
  method: 'POST',
  body: JSON.stringify({ connectionId: 'conn-1', sql: 'SELECT id, label FROM users' }),
})
if (queried.status !== 200) throw new Error(`the query failed: ${queried.status}`)
if (queried.body.result.columns.join(',') !== 'id,label') throw new Error('the columns were not parsed')
if (queried.body.result.rows.length !== 2) throw new Error('the rows were not parsed')
if (queried.body.result.rowCount !== 2) throw new Error('the row count was not parsed')

const tables = await request(`${API_ROUTES.tables}?connectionId=conn-1`)
if (tables.body.tables.length !== 2) throw new Error('the tables were not parsed')
if (tables.body.tables[1].tableType !== 'VIEW') throw new Error('the table type was not parsed')

const databases = await request(`${API_ROUTES.databases}?connectionId=conn-1`)
if (databases.body.databases.join(',') !== 'app,reporting') throw new Error('the databases were not parsed')

const removed = await request(API_ROUTES.removeConnection, {
  method: 'POST',
  body: JSON.stringify({ connectionId: 'conn-2' }),
})
if (removed.status !== 200) throw new Error(`removing failed: ${removed.status}`)

const tested = await request(API_ROUTES.testConnection, {
  method: 'POST',
  body: JSON.stringify({ connectionId: 'conn-1' }),
})
if (tested.status !== 200) throw new Error(`testing failed: ${tested.status}`)
const testCall = calls.find(call => call.name === 'dbx_execute_query' && call.args.sql === 'SELECT 1')
if (testCall === undefined) throw new Error('the test did not run a statement')

// Table structure is a self-built feature; asking about a DBX row must say so.
const described = await request(`${API_ROUTES.describe}?connectionId=conn-1&table=users`)
if (described.status !== 500) throw new Error(`describing a DBX row answered ${described.status}`)
if (!/self-built/.test(String(described.body.error))) {
  throw new Error('describing a DBX row does not explain itself')
}

// An empty DBX catalog has nothing to import.
const imported = await request(API_ROUTES.importConnections, {
  method: 'POST',
  body: JSON.stringify({ all: true }),
})
if (imported.status !== 404) throw new Error(`importing from an empty catalog answered ${imported.status}`)

// A missing field must be answered with a readable error, not a crash.
const invalid = await request(API_ROUTES.query, {
  method: 'POST',
  body: JSON.stringify({ sql: 'SELECT 1' }),
})
if (invalid.status !== 400) throw new Error(`a bad request answered ${invalid.status}`)
if (typeof invalid.body.error !== 'string') throw new Error('the bad request has no error message')

console.log('host api ok:', {
  routes: [...routes.keys()],
  mode: status.body.mode,
  calls: calls.map(call => call.name),
})
