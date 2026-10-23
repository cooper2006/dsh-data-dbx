// Round-trip check for the DBX store writer.
//
// The writer talks to the DBX catalog directly, so this checks that a
// connection written by the panel is readable again and that DBX's own rules
// for the catalog are respected: the config blob carries no password and the
// password lives in the secrets table.
//
// Usage: node scripts/verify-store.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCatalogConnections } from '../lib/catalog.js'
import { removeStoredConnection, storeConnection } from '../lib/store.js'

const dataDir = mkdtempSync(join(tmpdir(), 'dbx-store-'))

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

const id = await storeConnection(dataDir, {
  name: 'panel-demo',
  dbType: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'demo',
  password: 'secret-value',
  database: 'demo_db',
})
console.log('stored id:', id)

const connections = await readCatalogConnections(dataDir)
const stored = connections.find(connection => connection.id === id)
if (stored === undefined) throw new Error('the stored connection is not readable')
console.log('read back:', stored)

if (stored.name !== 'panel-demo') throw new Error('name mismatch')
if (stored.dbType !== 'postgres') throw new Error('db type mismatch')
if (stored.port !== 5432) throw new Error('port mismatch')
if (stored.username !== 'demo') throw new Error('username mismatch')
if (stored.database !== 'demo_db') throw new Error('database mismatch')

// The catalog blob must never carry the password, and the secrets table must
// hold it in the legacy plaintext column that DBX re-encrypts on the next read.
const database = new DatabaseSync(join(dataDir, 'dbx.db'), { readOnly: true })
const row = database.prepare('SELECT config_json FROM connections WHERE id = ?').get(id)
const secret = database.prepare('SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = ?').get(id)
database.close()

const config = JSON.parse(String(row['config_json']))
if (typeof config['password'] === 'string' && config['password'].length > 0) {
  throw new Error('the config blob must not carry the password')
}
if (String(secret['secret']) !== 'secret-value') throw new Error('the password is missing from the secrets table')
if (String(secret['secret_enc'] ?? '') !== '') throw new Error('the secret must be written in the legacy plaintext column')
console.log('config blob has no password, secret stored in the secrets table')

const removed = await removeStoredConnection(dataDir, id)
if (!removed) throw new Error('the connection was not removed')
const after = await readCatalogConnections(dataDir)
if (after.some(connection => connection.id === id)) throw new Error('the connection is still there')
console.log('removed:', id)

rmSync(dataDir, { recursive: true, force: true })
console.log('OK')
