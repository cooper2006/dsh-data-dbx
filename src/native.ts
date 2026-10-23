/**
 * The panel's self-built route to a database: its own vault and its own drivers.
 *
 * The access layer in `access.ts` answers one question — what can DBX do for
 * us — and every answer costs a running DBX. This module answers the other
 * half: what can the plugin do by itself. A connection stored in `vault.ts` is
 * opened directly through `drivers/registry.ts`, so the panel keeps listing,
 * querying, and describing connections with DBX closed.
 *
 * Both routes share one connection list. A selector that matches a vault entry
 * is served natively; a selector that does not falls through to the wrapped
 * DBX transport, which is why importing a DBX connection is optional rather
 * than required. When no transport is reachable the fall-through reports that
 * plainly instead of pretending the connection is gone.
 *
 * @module dsh-data-dbx/native
 */

import type {
  AccessCapabilities,
  AccessConnection,
  AccessMode,
  AccessNewConnection,
  AccessProvider,
  AccessQueryResult,
  AccessTable,
  DbxAccess,
} from './access.ts'
import { readCatalogConnections } from './catalog.ts'
import {
  availableDrivers,
  catalogEngines,
  defaultPortFor,
  defaultSchemaFor,
  dialectFor,
  isFileEngine,
  resolveDriver,
  supportsEngine,
} from './drivers/registry.ts'
import type { ColumnInfo, DriverConnection, QueryOutcome } from './drivers/types.ts'
import {
  addVaultConnection,
  listVault,
  masterKey,
  removeVaultConnection,
  toConnectSpec,
  updateVaultConnection,
  type VaultEntry,
  type VaultNewConnection,
} from './vault.ts'

/** One connection as the panel shows it, tagged with the route that owns it. */
export interface NativeConnection extends AccessConnection {
  /** `vault` when the plugin owns the row, `dbx` when DBX does. */
  source: 'vault' | 'dbx'
  /** Whether this plugin may edit or remove the row. */
  managed: boolean
  /** The SQL dialect the connection speaks, when a driver names one. */
  dialect: string | null
  /** Whether the row was copied out of DBX and may still need a password. */
  imported: boolean
  /** Whether the connection asks for TLS; only a vault row knows its own. */
  ssl?: boolean | undefined
}

/** One engine the connection form can offer, with what the fields need. */
export interface EngineDescriptor {
  /** The engine key the host matches on. */
  type: string
  /** The name the form shows. */
  label: string
  /** The port the form prefills. */
  port: number
  /** Whether the engine addresses a local file instead of a host. */
  file: boolean
  /** Whether the engine has a schema level the form can ask for. */
  schema: boolean
}

/** One column of one table, as the panel shows it. */
export type AccessColumn = ColumnInfo

/** What the native route needs to reach the other route and its own storage. */
export interface NativeRuntime {
  /** The DBX transport to fall through to. */
  dbx: AccessProvider
  /** The data directory holding the vault and `dbx.db`. */
  dataDir: string
  /** Default row cap for one executed statement. */
  maxRows: number
}

/** One executed statement, capped to the panel's row budget. */
function toResult(outcome: QueryOutcome, maxRows: number): AccessQueryResult {
  let rows = outcome.rows
  let truncated = outcome.truncated
  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows)
    truncated = true
  }
  return {
    columns: [...outcome.columns],
    rows: rows.map(row => row.map(cell => (cell === null ? 'NULL' : String(cell)))),
    rowCount: outcome.rowCount,
    affectedRows: outcome.affectedRows,
    truncated,
    resultId: outcome.resultId,
    messages: [...outcome.messages],
    text: outcome.text,
  }
}

/** Project one stored connection onto the panel's connection shape. */
function vaultView(entry: VaultEntry): NativeConnection {
  return {
    id: entry.id,
    name: entry.name,
    dbType: entry.dbType,
    host: entry.host,
    port: entry.port,
    database: entry.database,
    schema: entry.schema,
    groupPath: '',
    note: entry.note,
    source: 'vault',
    managed: true,
    dialect: dialectFor(entry.dbType),
    imported: entry.imported,
    ssl: entry.ssl,
  }
}

/** The identity used to decide whether a DBX row is already in the vault. */
function fingerprintOf(connection: { name: string; dbType: string; host: string; port: number }): string {
  return [connection.dbType.trim().toLowerCase(), connection.host.trim(), String(connection.port), connection.name.trim().toLowerCase()].join('::')
}

/** What one import copied, skipped, and left without a password. */
export interface ImportOutcome {
  /** Names of the connections now in the vault. */
  imported: string[]
  /** Names already present, matched by engine, host, port, and name. */
  skipped: string[]
  /** Imported names that need a password typed in before they can connect. */
  needsPassword: string[]
}

/**
 * Copy DBX catalog connections into the plugin's vault.
 *
 * DBX encrypts its passwords with its own key, so an import carries every
 * field except the secret. File engines need no secret, which makes them
 * usable immediately; a network engine is listed and reported as needing a
 * password, which the panel's edit form can then supply.
 *
 * @param dataDir - the data directory holding the vault and `dbx.db`.
 * @param options - which catalog rows to import.
 * @returns what happened, by name.
 */
export async function importCatalogConnections(
  dataDir: string,
  options: { ids?: readonly string[] | undefined; all?: boolean | undefined },
): Promise<ImportOutcome> {
  const catalog = await readCatalogConnections(dataDir)
  const known = new Set(listVault(dataDir).map(fingerprintOf))
  const wanted = options.all === true
    ? catalog
    : catalog.filter(connection => options.ids?.includes(connection.id) === true)
  const imported: string[] = []
  const skipped: string[] = []
  const needsPassword: string[] = []
  for (const connection of wanted) {
    const fingerprint = fingerprintOf(connection)
    if (known.has(fingerprint)) {
      skipped.push(connection.name)
      continue
    }
    const entry = addVaultConnection(dataDir, {
      name: connection.name,
      dbType: connection.dbType,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: '',
      database: connection.database,
      // DBX's profile carries no schema, so an import starts from the engine's
      // default and the panel's edit form can set one afterwards.
      schema: defaultSchemaFor(connection.dbType),
      ssl: false,
      driverProfile: connection.dbType,
      note: 'imported from DBX',
      imported: true,
    })
    known.add(fingerprint)
    imported.push(entry.name)
    if (!isFileEngine(connection.dbType)) needsPassword.push(entry.name)
  }
  return { imported, skipped, needsPassword }
}

/** How the panel reaches a database through this plugin. */
export class NativeAccess implements DbxAccess {
  /** The panel is on its own drivers. */
  readonly mode: AccessMode = 'native'

  /** What the panel can do: the vault always lists, DBX adds what it can. */
  readonly capabilities: AccessCapabilities

  /** A short description for the panel's status line. */
  readonly source: string

  /** Engines the plugin can open without DBX. */
  readonly engines: string[]

  /** The same engines with the label and port the connection form needs. */
  readonly engineCatalog: EngineDescriptor[]

  /** Connections the plugin itself stores. */
  readonly vaultCount: number

  private readonly runtime: NativeRuntime

  /**
   * @param runtime - the vault, the fall-through transport, and the row cap.
   * @param dbx - the transport resolved at load, for the status line only.
   */
  constructor(runtime: NativeRuntime, dbx: DbxAccess | null) {
    this.runtime = runtime
    const entries = listVault(runtime.dataDir)
    const drivers = availableDrivers()
    // The form offers the protocol family too, so `engines` must name every
    // catalog type: the panel treats an engine missing from this list as one
    // only DBX can serve and routes the row away from the self-built vault.
    const catalog = catalogEngines()
    this.engines = catalog.map(entry => entry.type)
    this.engineCatalog = catalog.map(entry => ({
      type: entry.type,
      label: entry.label,
      port: entry.port,
      file: entry.file,
      schema: entry.schema,
    }))
    this.vaultCount = entries.length
    const selfBuilt = entries.some(entry => resolveDriver(entry.dbType) !== null)
    this.capabilities = {
      list: true,
      add: true,
      remove: true,
      query: selfBuilt || dbx !== null && dbx.capabilities.query,
      tables: selfBuilt || dbx !== null && dbx.capabilities.tables,
      databases: selfBuilt || dbx !== null && dbx.capabilities.databases,
    }
    const parts = [`self-built drivers (${drivers.length} drivers, ${catalog.length} engines, ${entries.length} saved)`]
    if (dbx !== null) parts.push(`DBX: ${dbx.source}`)
    this.source = parts.join(' · ')
  }

  /** The DBX transport, when one answers right now. */
  private async dbxTransport(): Promise<DbxAccess | null> {
    try {
      const access = await this.runtime.dbx.get()
      return access.mode === 'none' ? null : access
    } catch {
      return null
    }
  }

  /** The DBX transport, or a refusal that says what is missing. */
  private async requireDbx(): Promise<DbxAccess> {
    const access = await this.dbxTransport()
    if (access === null) {
      throw new Error(
        'this connection is not in the self-built vault, and no DBX transport is reachable: '
        + 'add it through the plugin, or start DBX',
      )
    }
    return access
  }

  /** The vault entry a selector names, when the plugin owns it. */
  private findEntry(id: string | undefined, name: string | undefined): VaultEntry | null {
    const entries = listVault(this.runtime.dataDir)
    const wantedId = (id ?? '').trim()
    if (wantedId.length > 0) {
      const byId = entries.find(entry => entry.id === wantedId)
      if (byId !== undefined) return byId
    }
    const wanted = ((name ?? '').trim().length > 0 ? (name ?? '') : wantedId).trim().toLowerCase()
    if (wanted.length === 0) return null
    return entries.find(entry => entry.name.trim().toLowerCase() === wanted) ?? null
  }

  /**
   * Find the vault entry a request means, following an imported twin.
   *
   * A panel that was rendered before an import still holds the DBX id of a
   * connection the vault now owns. Rather than fail with "no DBX transport",
   * the DBX id is translated to the row with the same identity, which the
   * plugin can serve itself.
   *
   * @param connectionId - the id the caller sent.
   * @param connectionName - the name the caller sent.
   * @returns the vault entry, or null when the request really is DBX's.
   */
  private async findEntryOrTwin(
    connectionId: string | undefined,
    connectionName: string | undefined,
  ): Promise<VaultEntry | null> {
    const direct = this.findEntry(connectionId, connectionName)
    if (direct !== null) return direct
    const id = (connectionId ?? '').trim()
    if (id.length === 0) return null
    const dbx = await this.dbxTransport()
    if (dbx === null) return null
    try {
      const row = (await dbx.listConnections()).find(connection => connection.id === id)
      if (row === undefined) return null
      const fingerprint = fingerprintOf(row)
      return listVault(this.runtime.dataDir).find(entry => fingerprintOf(entry) === fingerprint) ?? null
    } catch {
      return null
    }
  }

  /** Open one vault connection through its driver. */
  private async open(entry: VaultEntry): Promise<DriverConnection> {
    const driver = resolveDriver(entry.dbType)
    if (driver === null) {
      throw new Error(
        `the plugin has no driver for "${entry.dbType}"; it can open: ${this.engines.join(', ')}`,
      )
    }
    try {
      return await driver.connect(toConnectSpec(entry, masterKey(this.runtime.dataDir)))
    } catch (error) {
      // DBX keeps its own passwords, so an imported connection starts without
      // one. Say that instead of leaving a bare authentication failure, which
      // reads like a wrong password the user never typed.
      if (entry.imported && entry.passwordEnc.length === 0) {
        const cause = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${cause}\n`
          + `"${entry.name}" was imported from DBX, which keeps its password to itself, so this copy has none yet: `
          + 'select it in the panel, press Edit, type the password, and save.',
        )
      }
      throw error
    }
  }

  /** @inheritdoc */
  async listConnections(): Promise<AccessConnection[]> {
    const entries = listVault(this.runtime.dataDir)
    const views: NativeConnection[] = entries.map(vaultView)
    // A DBX row that was imported is the same connection twice. The vault copy
    // supersedes it: it is the one that can actually be queried with DBX closed,
    // and showing both invites picking the one that cannot.
    const owned = new Set(entries.map(fingerprintOf))
    const dbx = await this.dbxTransport()
    if (dbx !== null) {
      try {
        for (const connection of await dbx.listConnections()) {
          if (owned.has(fingerprintOf(connection))) continue
          views.push({
            ...connection,
            source: 'dbx',
            managed: false,
            dialect: dialectFor(connection.dbType),
            imported: false,
          })
        }
      } catch {
        // The DBX half is unreachable; the vault still lists on its own.
      }
    }
    return views
  }

  /** @inheritdoc */
  async addConnection(connection: AccessNewConnection): Promise<{ id: string; message: string }> {
    if (supportsEngine(connection.dbType)) {
      const entry = addVaultConnection(this.runtime.dataDir, {
        name: connection.name,
        dbType: connection.dbType,
        host: connection.host,
        port: connection.port ?? defaultPortFor(connection.dbType),
        username: connection.username ?? '',
        password: connection.password ?? '',
        database: connection.database ?? '',
        schema: connection.schema ?? '',
        ssl: connection.ssl === true,
        driverProfile: connection.driverProfile ?? connection.dbType,
        note: '',
      })
      return {
        id: entry.id,
        message: `self-built connection "${entry.name}" saved (id: ${entry.id}); `
          + `the plugin opens it with its own ${dialectFor(entry.dbType) ?? entry.dbType} driver`,
      }
    }
    const dbx = await this.requireDbx()
    return await dbx.addConnection(connection)
  }

  /**
   * Edit one self-built connection.
   *
   * @param id - the vault entry to rewrite.
   * @param connection - the new field values.
   * @returns the stored entry.
   */
  async updateConnection(id: string, connection: VaultNewConnection): Promise<VaultEntry> {
    const entry = this.findEntry(id, undefined)
    if (entry === null) {
      throw new Error(`no self-built connection has the id "${id}"`)
    }
    const updated = updateVaultConnection(this.runtime.dataDir, entry.id, connection)
    if (updated === null) {
      throw new Error(`no self-built connection has the id "${id}"`)
    }
    return updated
  }

  /** @inheritdoc */
  async removeConnection(selector: { id?: string | undefined; name?: string | undefined }): Promise<string> {
    const entry = this.findEntry(selector.id, selector.name)
    if (entry !== null) {
      if (removeVaultConnection(this.runtime.dataDir, entry.id)) {
        return `self-built connection "${entry.name}" removed`
      }
      throw new Error(`the vault refused to remove "${entry.name}"`)
    }
    const dbx = await this.requireDbx()
    return await dbx.removeConnection(selector)
  }

  /** @inheritdoc */
  async query(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
    database?: string | undefined
    sql: string
    maxRows: number
  }): Promise<AccessQueryResult> {
    const entry = await this.findEntryOrTwin(input.connectionId, input.connectionName)
    if (entry === null) {
      const dbx = await this.requireDbx()
      return await dbx.query(input)
    }
    const connection = await this.open(entry)
    try {
      // The picker above the editor chooses a database; a document store can
      // only honour it by being told, since a statement has no name to qualify.
      const database = (input.database ?? '').trim()
      if (database.length > 0 && connection.selectDatabase !== undefined) {
        connection.selectDatabase(database)
      }
      return toResult(await connection.query(input.sql), input.maxRows)
    } finally {
      await connection.close()
    }
  }

  /** @inheritdoc */
  async listTables(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
    database?: string | undefined
  }): Promise<AccessTable[]> {
    const entry = await this.findEntryOrTwin(input.connectionId, input.connectionName)
    if (entry === null) {
      const dbx = await this.requireDbx()
      return await dbx.listTables(input)
    }
    const connection = await this.open(entry)
    try {
      const database = (input.database ?? '').trim()
      const tables = await connection.listTables(
        database.length > 0 ? database : entry.database.length > 0 ? entry.database : undefined,
      )
      return tables.map(table => ({ name: table.name, tableType: table.tableType }))
    } finally {
      await connection.close()
    }
  }

  /** @inheritdoc */
  async listDatabases(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
  }): Promise<string[]> {
    const entry = await this.findEntryOrTwin(input.connectionId, input.connectionName)
    if (entry === null) {
      const dbx = await this.requireDbx()
      return await dbx.listDatabases(input)
    }
    const connection = await this.open(entry)
    try {
      return await connection.listDatabases()
    } finally {
      await connection.close()
    }
  }

  /**
   * Describe one table of one connection.
   *
   * Only a self-built connection has a driver that can answer this: the DBX
   * transport exposes no structure call, so a DBX connection is told to run
   * its own `DESCRIBE` instead of being given a wrong answer.
   *
   * @param input - the connection and the table.
   * @returns the columns, in table order.
   */
  async describeTable(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
    table: string
  }): Promise<AccessColumn[]> {
    const entry = await this.findEntryOrTwin(input.connectionId, input.connectionName)
    if (entry === null) {
      throw new Error(
        'table structure is available for self-built connections only: '
        + 'this connection lives in DBX, whose transport has no describe call',
      )
    }
    const table = input.table.trim()
    if (table.length === 0) {
      throw new Error('the table to describe is missing')
    }
    const connection = await this.open(entry)
    try {
      return await connection.describeTable(table)
    } finally {
      await connection.close()
    }
  }
}

/**
 * The panel's access layer, resolved once and reused.
 *
 * Resolving DBX costs a probe, so the pair (native route + DBX transport) is
 * cached; `refresh` is how the panel picks up a DBX desktop MCP server the
 * user has just enabled.
 */
export class NativeAccessProvider {
  private readonly runtime: NativeRuntime
  private current: NativeAccess | null = null
  private pending: Promise<NativeAccess> | null = null

  /**
   * @param runtime - the vault, the fall-through transport, and the row cap.
   */
  constructor(runtime: NativeRuntime) {
    this.runtime = runtime
  }

  /**
   * The access layer to use, resolving it on first use.
   *
   * @returns the access layer.
   */
  async get(): Promise<NativeAccess> {
    if (this.current !== null) return this.current
    if (this.pending === null) {
      this.pending = this.resolve()
        .then((access) => {
          this.current = access
          this.pending = null
          return access
        })
        .catch((error: unknown) => {
          this.pending = null
          throw error
        })
    }
    return await this.pending
  }

  /**
   * Drop the cached answer and resolve it again.
   *
   * @returns the newly resolved access layer.
   */
  async refresh(): Promise<NativeAccess> {
    this.current = null
    this.pending = null
    return await this.get()
  }

  /** Probe DBX once and pair it with the vault. */
  private async resolve(): Promise<NativeAccess> {
    let dbx: DbxAccess | null = null
    try {
      const access = await this.runtime.dbx.refresh()
      dbx = access.mode === 'none' ? null : access
    } catch {
      dbx = null
    }
    return new NativeAccess(this.runtime, dbx)
  }
}
