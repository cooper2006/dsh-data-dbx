// Prove that a database that is down cannot take the host down with it.
//
// Every socket driver reports a refused connection twice: once as a rejected
// promise, which the panel catches, and once as an `error` event on the client.
// Node turns an `error` event with no listener into a fatal exception, and
// inside the harness a fatal exception ends the whole application. That is how
// a MongoDB connection pointed at a closed port closed the editor itself.
//
// This script spawns one child per engine, points it at a port nothing listens
// on, and asserts the child survives long enough for the failure to surface and
// then exits cleanly. A regression shows up here as a non-zero exit and the
// stack trace of the uncaught event.
//
// Usage: node scripts/verify-isolation.mjs

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(join(root, 'package.json'))

/** The engines whose client talks over a socket, and the package behind it. */
const ENGINES = [
  { type: 'mysql', package: 'mysql2' },
  { type: 'postgres', package: 'pg' },
  { type: 'mongodb', package: 'mongodb' },
  { type: 'redis', package: 'redis' },
  { type: 'sqlserver', package: 'tedious' },
  { type: 'clickhouse', package: '@clickhouse/client' },
]

const failures = []
/**
 * Record one assertion.
 *
 * @param condition - whether it held.
 * @param label - what was checked.
 */
function check(condition, label) {
  if (condition) {
    console.log('  ok  ', label)
    return
  }
  failures.push(label)
  console.log('  FAIL', label)
}

/** Whether a driver package is installed, which decides the engines tested. */
function installed(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

/**
 * A port nothing listens on: bind it, read it, let it go.
 *
 * @returns the port number.
 */
async function closedPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * The child: run the panel's own read path against a dead port, expect the
 * rejection, then wait for any late event to arrive before exiting.
 *
 * The access layer is what the panel calls, so this is the real path: open the
 * driver, run a statement, close it again — and then sit still, which is when
 * the unhandled socket event used to arrive and end the host.
 *
 * @param engine - the engine to try.
 * @param port - the dead port.
 * @returns the program text.
 */
function childProgram(engine, port) {
  return `
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NativeAccess } from ${JSON.stringify(join(root, 'lib/native.js'))}
import { addVaultConnection } from ${JSON.stringify(join(root, 'lib/vault.js'))}

const dataDir = mkdtempSync(join(tmpdir(), 'dbx-isolation-'))
const entry = addVaultConnection(dataDir, {
  name: 'dead-${engine.type}',
  dbType: ${JSON.stringify(engine.type)},
  host: '127.0.0.1',
  port: ${port},
  username: '',
  password: '',
  database: '',
  ssl: false,
  driverProfile: ${JSON.stringify(engine.type)},
  note: '',
  imported: false,
})

const access = new NativeAccess({
  dbx: {
    get: async () => ({
      mode: 'none',
      source: 'none',
      engines: [],
      vaultCount: 0,
      capabilities: { list: false, add: false, remove: false, query: false, tables: false, databases: false },
      listConnections: async () => [],
      addConnection: async () => { throw new Error('no DBX') },
      removeConnection: async () => { throw new Error('no DBX') },
      query: async () => { throw new Error('no DBX') },
      listTables: async () => { throw new Error('no DBX') },
      listDatabases: async () => { throw new Error('no DBX') },
    }),
  },
  dataDir,
  maxRows: 10,
}, null)

let reported = 0
// The two reads the panel makes on its own: the statement, and the database
// list it loads as soon as a connection is selected.
for (const run of [
  () => access.query({ connectionId: entry.id, sql: 'SELECT 1', maxRows: 10 }),
  () => access.listDatabases({ connectionId: entry.id }),
]) {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) reported += 1
  }
}
// A refused connection keeps monitors, retries and sockets alive for a moment.
// This is the window in which the unhandled event used to arrive, so the test
// has to sit through it rather than exit as soon as the promise settles.
await new Promise(resolve => setTimeout(resolve, 1500))
process.exit(reported === 2 ? 0 : 1)
`
}

for (const engine of ENGINES) {
  if (!installed(engine.package)) {
    console.log('  skip', `${engine.type}: the "${engine.package}" package is not installed`)
    continue
  }
  const port = await closedPort()
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childProgram(engine, port)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  const stderr = result.stderr ?? ''
  check(
    result.status === 0,
    `${engine.type}: a refused connection ends in a rejected promise, not a dead process`,
  )
  check(
    !/uncaught|unhandled 'error'|UnhandledPromiseRejection/i.test(stderr),
    `${engine.type}: nothing reached the process as an uncaught event`,
  )
  if (result.status !== 0) {
    console.log(stderr.split('\n').slice(0, 8).join('\n'))
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} isolation check(s) failed`)
  process.exit(1)
}
console.log('\nisolation: a database that is down is reported, never fatal')
