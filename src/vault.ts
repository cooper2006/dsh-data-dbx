/**
 * The plugin's own connection vault.
 *
 * DBX keeps its passwords in its own encrypted store, behind a keychain entry
 * only the DBX desktop binary can read. That store is not accessible to this
 * plugin, so a connection the panel creates itself has to carry its own
 * password. This module is that store: a small JSON file next to the plugin,
 * with every password encrypted at rest under a master key the plugin itself
 * generates.
 *
 * The master key never leaves the plugin's data directory. It is generated on
 * first use with `chmod 0600` (or `chmod 600`), and the vault is the only
 * thing that reads it, so a connection's password is only ever plaintext in
 * the one process that is running the query.
 *
 * The shape mirrors `src/store.ts` on purpose: the panel wants the same
 * connection fields whether the connection lives in DBX's catalog or in this
 * vault, and `VaultEntry` is the intersection.
 *
 * @module dsh-data-dbx/vault
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'

import type { ConnectSpec } from './drivers/types.ts'

/** Where the vault and its key live inside a plugin data directory. */
export const VAULT_DIR = 'data-dbx'

/** One stored connection, with the password encrypted at rest. */
export interface VaultEntry {
  /** Stable id, used by every API call that names a connection. */
  id: string
  /** Human name, shown in the panel's sidebar. */
  name: string
  /** Engine key, e.g. `postgres`. */
  dbType: string
  /** Host name, or the file path for a file engine. */
  host: string
  /** TCP port, 0 for a file engine. */
  port: number
  /** User name, empty when the engine needs none. */
  username: string
  /** Default database, empty when the engine has none. */
  database: string
  /**
   * Namespace inside the database, for engines that have one.
   *
   * PostgreSQL only: the schema unqualified names resolve in. Empty means the
   * server default, so a vault written before this field existed still loads.
   */
  schema: string
  /** Whether TLS is wanted. */
  ssl: boolean
  /** Driver profile label, when DBX recorded one. */
  driverProfile: string
  /** Note the panel recorded when the connection was added. */
  note: string
  /** Encrypted password, as `aes256gcm.iv.ciphertext.tag` (all base64). */
  passwordEnc: string
  /** Whether the entry was imported from DBX's catalog. */
  imported: boolean
}

/** The body the panel sends when creating a connection. */
export interface VaultNewConnection {
  name: string
  dbType: string
  host: string
  port?: number | undefined
  username?: string | undefined
  password?: string | undefined
  database?: string | undefined
  schema?: string | undefined
  ssl?: boolean | undefined
  driverProfile?: string | undefined
  note?: string | undefined
  /** Whether the entry is being copied out of DBX's catalog. */
  imported?: boolean | undefined
}

/** The on-disk shape of the vault file. */
interface VaultFile {
  version: 1
  connections: VaultEntry[]
}

/** The on-disk shape of the vault key file. */
interface KeyFile {
  /** The key bytes, base64-encoded. */
  key: string
}

/** A failure that names the vault and the reason. */
export class VaultError extends Error {
  /**
   * @param message - the reason, in one sentence.
   */
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

/** The AES-256-GCM key size in bytes. */
const KEY_SIZE = 32

/** The GCM nonce size in bytes: 12 is the standard length for GCM. */
const IV_SIZE = 12

/** The GCM authentication tag size in bytes. */
const TAG_SIZE = 16

/** The base64 prefix the encrypted password carries. */
const CIPHER_PREFIX = 'aes256gcm'

/**
 * Resolve the vault file path inside a plugin data directory.
 *
 * @param dataDir - the plugin's data directory.
 * @returns the path of the vault file.
 */
export function vaultPath(dataDir: string): string {
  return join(dataDir, VAULT_DIR, 'connections.json')
}

/**
 * Resolve the master key file path inside a plugin data directory.
 *
 * @param dataDir - the plugin's data directory.
 * @returns the path of the key file.
 */
export function keyPath(dataDir: string): string {
  return join(dataDir, VAULT_DIR, 'master.key')
}

/**
 * Load the master key, generating it when it is missing.
 *
 * @param dataDir - the plugin's data directory.
 * @returns the 32 raw key bytes.
 */
function loadKey(dataDir: string): Buffer {
  const path = keyPath(dataDir)
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as KeyFile
    return Buffer.from(raw.key, 'base64')
  }
  const key = randomBytes(KEY_SIZE)
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  writeFileSync(path, JSON.stringify({ key: key.toString('base64') }, null, 2), { mode: 0o600 })
  // A file created by another user or umask must not carry wider permissions.
  try {
    chmodSync(path, 0o600)
  } catch {
    // A platform or sandbox that forbids chmod still gets the best it can.
  }
  return key
}

/**
 * The plugin's master key for one data directory.
 *
 * The key is generated on first use, so reading it is also what provisions the
 * vault. The driver layer needs it to open a stored connection, and it is the
 * only caller that ever sees it.
 *
 * @param dataDir - the plugin's data directory.
 * @returns the 32 raw key bytes.
 */
export function masterKey(dataDir: string): Buffer {
  return loadKey(dataDir)
}

/**
 * Encrypt one password for storage.
 *
 * The ciphertext carries its own nonce and tag, so one encrypted password is
 * self-describing and two connections never share a nonce. GCM requires the
 * same nonce the encryption used to come back out, so it is stored rather than
 * re-derived.
 *
 * @param key - the 32-byte master key.
 * @param plaintext - the password to encrypt.
 * @returns the encrypted form, or an empty string when the password is empty.
 */
function encrypt(key: Buffer, plaintext: string): string {
  if (plaintext.length === 0) return ''
  const iv = randomBytes(IV_SIZE)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${CIPHER_PREFIX}.${iv.toString('base64')}.${ciphertext.toString('base64')}.${tag.toString('base64')}`
}

/**
 * Decrypt one stored password.
 *
 * The stored form is `prefix.iv.ciphertext.tag`, all base64, so the nonce that
 * encrypted the password is recovered exactly as it was written.
 *
 * @param key - the 32-byte master key.
 * @param ciphertext - the encrypted form, or an empty string.
 * @returns the password, or an empty string when the ciphertext is empty.
 */
function decrypt(key: Buffer, ciphertext: string): string {
  if (ciphertext.length === 0) return ''
  const parts = ciphertext.split('.')
  if (parts.length !== 4 || parts[0] !== CIPHER_PREFIX) {
    throw new VaultError('this vault holds a password in a shape this plugin cannot read')
  }
  const iv = Buffer.from(parts[1] as string, 'base64')
  const data = Buffer.from(parts[2] as string, 'base64')
  const tag = Buffer.from(parts[3] as string, 'base64')
  if (iv.length !== IV_SIZE || tag.length !== TAG_SIZE) {
    throw new VaultError('this vault holds a truncated password')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // The authentication tag above is what makes the read honest: a wrong key,
  // a moved key file, or a hand-edited vault fails here rather than returning
  // a plausible-looking password.
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    throw new VaultError(
      'this password cannot be decrypted with the vault key: the master key file was replaced, or the vault was copied from another machine — set the password again to fix it',
    )
  }
}

/** Read the vault file, tolerating a missing one. */
function readFile(dataDir: string): VaultFile {
  const path = vaultPath(dataDir)
  if (!existsSync(path)) return { version: 1, connections: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VaultFile
    if (parsed.version !== 1) throw new VaultError('this vault file has an unreadable version')
    // A vault written before a field existed carries no value for it; filling
    // the default here keeps every reader from having to repeat the check.
    return {
      version: 1,
      connections: Array.isArray(parsed.connections)
        ? parsed.connections.map(entry => ({ ...entry, schema: typeof entry.schema === 'string' ? entry.schema : '' }))
        : [],
    }
  } catch (error) {
    if (error instanceof VaultError) throw error
    throw new VaultError(`the vault at ${path} is not readable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write the vault file atomically, so a crash cannot leave a half-written one. */
function writeFile(dataDir: string, file: VaultFile): void {
  const path = vaultPath(dataDir)
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(file, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Turn one vault entry into the spec a driver needs.
 *
 * @param entry - the stored connection.
 * @param key - the master key.
 * @returns the driver-ready spec.
 */
export function toConnectSpec(entry: VaultEntry, key: Buffer): ConnectSpec {
  return {
    dbType: entry.dbType,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    password: decrypt(key, entry.passwordEnc),
    database: entry.database,
    schema: entry.schema,
    ssl: entry.ssl,
    options: {},
  }
}

/**
 * List every connection in the vault.
 *
 * The password is not returned: the panel shows the name, host and database,
 * and the plugin encrypts the password back only when a statement runs.
 *
 * @param dataDir - the plugin's data directory.
 * @returns the connections, in vault order.
 */
export function listVault(dataDir: string): VaultEntry[] {
  return readFile(dataDir).connections
}

/**
 * Add one connection to the vault.
 *
 * @param dataDir - the plugin's data directory.
 * @param connection - the connection to add.
 * @returns the stored entry.
 */
export function addVaultConnection(dataDir: string, connection: VaultNewConnection): VaultEntry {
  const key = loadKey(dataDir)
  const file = readFile(dataDir)
  const entry: VaultEntry = {
    id: randomUUID(),
    name: connection.name.trim(),
    dbType: connection.dbType.trim(),
    host: connection.host.trim(),
    port: connection.port ?? 0,
    username: connection.username ?? '',
    database: connection.database ?? '',
    schema: (connection.schema ?? '').trim(),
    ssl: connection.ssl ?? false,
    driverProfile: connection.driverProfile ?? connection.dbType.trim(),
    note: connection.note ?? '',
    passwordEnc: encrypt(key, connection.password ?? ''),
    imported: connection.imported === true,
  }
  file.connections.push(entry)
  writeFile(dataDir, file)
  return entry
}

/**
 * Replace one vault entry, keeping its id.
 *
 * Used when the user edits a connection: the password field is rewritten
 * only when the caller sends a new one, so an edit that leaves it blank
 * does not clear the stored password.
 *
 * @param dataDir - the plugin's data directory.
 * @param id - the id of the connection to update.
 * @param connection - the new fields.
 * @returns the updated entry, or null when the id is unknown.
 */
export function updateVaultConnection(
  dataDir: string,
  id: string,
  connection: VaultNewConnection,
): VaultEntry | null {
  const key = loadKey(dataDir)
  const file = readFile(dataDir)
  const entry = file.connections.find(entry => entry.id === id)
  if (entry === undefined) return null

  entry.name = connection.name.trim()
  entry.dbType = connection.dbType.trim()
  entry.host = connection.host.trim()
  entry.port = connection.port ?? entry.port
  entry.username = connection.username ?? entry.username
  entry.database = connection.database ?? entry.database
  entry.schema = connection.schema === undefined ? entry.schema : connection.schema.trim()
  entry.ssl = connection.ssl ?? entry.ssl
  entry.driverProfile = connection.driverProfile ?? entry.driverProfile
  entry.note = connection.note ?? entry.note
  if (connection.password !== undefined) entry.passwordEnc = encrypt(key, connection.password)
  writeFile(dataDir, file)
  return entry
}

/**
 * Remove one connection from the vault.
 *
 * @param dataDir - the plugin's data directory.
 * @param id - the id of the connection to remove.
 * @returns whether a row was removed.
 */
export function removeVaultConnection(dataDir: string, id: string): boolean {
  const file = readFile(dataDir)
  const next = file.connections.filter(entry => entry.id !== id)
  if (next.length === file.connections.length) return false
  writeFile(dataDir, { version: 1, connections: next })
  return true
}

/**
 * Find one connection by id or by name.
 *
 * @param entries - the vault.
 * @param selector - an id or a name.
 * @returns the matching entry.
 * @throws when nothing matches, so the caller can surface the known names.
 */
export function resolveVaultEntry(entries: readonly VaultEntry[], selector: string): VaultEntry {
  const wanted = selector.trim()
  const exact = entries.find(entry => entry.id === wanted) ?? entries.find(entry => entry.name === wanted)
  if (exact !== undefined) return exact
  const ci = entries.find(entry => entry.name.toLowerCase() === wanted.toLowerCase())
  if (ci !== undefined) return ci
  const known = entries.map(entry => `${entry.name} (${entry.id})`).join(', ')
  throw new Error(`unknown connection '${selector}'. Known connections: ${known || '(none)'}`)
}

/**
 * Read one vault entry by selector.
 *
 * @param dataDir - the plugin's data directory.
 * @param selector - an id or a name.
 * @returns the matching entry.
 */
export function getVaultEntry(dataDir: string, selector: string): VaultEntry {
  return resolveVaultEntry(readFile(dataDir).connections, selector)
}

/**
 * Re-encrypt every password with a new key.
 *
 * Used when the key is rotated: every encrypted password is decrypted with
 * the old key and written back with the new one.
 *
 * @param dataDir - the plugin's data directory.
 * @param oldKey - the current master key.
 * @param newKey - the replacement master key.
 * @returns nothing.
 */
export function reencryptAll(dataDir: string, oldKey: Buffer, newKey: Buffer): void {
  const file = readFile(dataDir)
  for (const entry of file.connections) {
    const plaintext = decrypt(oldKey, entry.passwordEnc)
    entry.passwordEnc = encrypt(newKey, plaintext)
  }
  writeFile(dataDir, file)
}

/**
 * The SHA-256 of a key, for diagnostics.
 *
 * @param key - the key bytes.
 * @returns the hex digest.
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Verify that two bytes are equal, without leaking their values.
 *
 * Used to compare a read-back key against the one in memory.
 *
 * @param left - the first byte array.
 * @param right - the second byte array.
 * @returns whether they are equal.
 */
export function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Remove the vault and its key, so the plugin starts clean.
 *
 * Used by a "reset" action in the panel. The caller is expected to have
 * confirmed the action first.
 *
 * @param dataDir - the plugin's data directory.
 * @returns nothing.
 */
export function resetVault(dataDir: string): void {
  const directory = join(dataDir, VAULT_DIR)
  rmSync(directory, { recursive: true, force: true })
}
