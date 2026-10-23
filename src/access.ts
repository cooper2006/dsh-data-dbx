/**
 * One access layer over the three ways to reach a live DBX.
 *
 * DBX keeps its connections and their secrets encrypted with a key that lives
 * in the macOS keychain. Only the DBX desktop process holds that key, so the
 * ways to reach a real catalog are, in order of power:
 *
 *   1. the desktop's own MCP HTTP server (`dbx_add_connection` and the rest
 *      of the DBX MCP tool set, running inside the desktop process),
 *   2. a headless `dbx-mcp` that can read the key itself,
 *   3. the desktop's MCP bridge, which answers queries against the desktop's
 *      decrypted connections but cannot create connections.
 *
 * This module picks the first one that answers and reports what it can do, so
 * the panel can offer exactly the actions the current transport supports.
 *
 * @module dsh-data-dbx/access
 */

import type { DbxServerManager } from './manager.ts'
import { DbxBridgeClient } from './bridge.ts'
import { DbxHttpMcpClient } from './http-mcp.ts'
import { resolveDesktopMcpEndpoint } from './settings.ts'
import { readCatalogConnections } from './catalog.ts'
import { removeStoredConnection, storeConnection } from './store.ts'
import {
  parseConnectionList,
  parseDatabaseList,
  parseQueryResult,
  parseTableList,
  type ParsedConnection,
  type ParsedQueryResult,
  type ParsedTable,
} from './parse.ts'

/** How the panel currently reaches DBX. */
export type AccessMode = 'native' | 'desktop-mcp' | 'stdio-mcp' | 'bridge' | 'catalog' | 'none'

/** The actions the current transport supports. */
export interface AccessCapabilities {
  /** Connections can be listed. */
  list: boolean
  /** Connections can be created. */
  add: boolean
  /** Connections can be removed. */
  remove: boolean
  /** SQL can be executed. */
  query: boolean
  /** Tables can be listed. */
  tables: boolean
  /** Databases can be listed. */
  databases: boolean
}

/** One connection as the panel shows it. */
export type AccessConnection = ParsedConnection

/** One table or view as the panel shows it. */
export type AccessTable = ParsedTable

/** The parsed outcome of one executed statement. */
export type AccessQueryResult = ParsedQueryResult

/** The body of a "create connection" request. */
export interface AccessNewConnection {
  name: string
  dbType: string
  host: string
  port?: number | undefined
  username?: string | undefined
  password?: string | undefined
  database?: string | undefined
  /**
   * Namespace inside the database, for engines that have one.
   *
   * Only the plugin's own storage keeps this: DBX's connection profile has no
   * schema field, so the DBX transports ignore it.
   */
  schema?: string | undefined
  ssl?: boolean | undefined
  driverProfile?: string | undefined
}

/** What the panel needs from a DBX. */
export interface DbxAccess {
  /** Which transport answered. */
  mode: AccessMode
  /** What that transport can do. */
  capabilities: AccessCapabilities
  /** A short description of the transport, for the panel's status line. */
  source: string
  /** Every configured connection. */
  listConnections(): Promise<AccessConnection[]>
  /** Create one connection. */
  addConnection(connection: AccessNewConnection): Promise<{ id: string; message: string }>
  /** Remove one connection. */
  removeConnection(selector: { id?: string | undefined; name?: string | undefined }): Promise<string>
  /** Execute one statement. */
  query(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
    database?: string | undefined
    sql: string
    maxRows: number
  }): Promise<AccessQueryResult>
  /** List the tables of one connection. */
  listTables(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
    database?: string | undefined
  }): Promise<AccessTable[]>
  /** List the databases of one connection. */
  listDatabases(input: {
    connectionId?: string | undefined
    connectionName?: string | undefined
  }): Promise<string[]>
}

/** The runtime the access layer needs. */
export interface AccessRuntime {
  /** Manager owning the headless DBX MCP server process. */
  manager: DbxServerManager
  /** The DBX data directory that holds `dbx.db` and the desktop's port files. */
  dataDir: string
  /** Default row cap for one executed statement. */
  maxRows: number
}

/** Capabilities of a transport that can talk to the full DBX MCP tool set. */
const FULL_MCP: AccessCapabilities = {
  list: true,
  add: true,
  remove: true,
  query: true,
  tables: true,
  databases: true,
}

/**
 * Capabilities of the desktop bridge: it answers queries, and the panel writes
 * the connection catalog itself.
 */
const BRIDGE_MCP: AccessCapabilities = {
  list: true,
  add: true,
  remove: true,
  query: true,
  tables: true,
  databases: true,
}

/**
 * Capabilities of the catalog alone: the connection list and the catalog
 * itself are readable and writable without a running DBX, but no statement can
 * be executed.
 */
const CATALOG_ONLY: AccessCapabilities = {
  list: true,
  add: true,
  remove: true,
  query: false,
  tables: false,
  databases: true,
}

/** Capabilities when nothing answers. */
const NO_MCP: AccessCapabilities = {
  list: false,
  add: false,
  remove: false,
  query: false,
  tables: false,
  databases: false,
}

/** The DBX MCP tool set, reached through the desktop's HTTP server or a headless server. */
interface McpToolSet {
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  close(): void
}

/** Build an access layer over any DBX MCP tool set. */
function mcpAccess(toolSet: McpToolSet, mode: AccessMode, source: string): DbxAccess {
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await toolSet.call(name, args)
    if (result.isError) throw new Error(result.text.replace(/^Error \[[^\]]+\]:\s*/, '').trim())
    return result.text
  }
  return {
    mode,
    capabilities: FULL_MCP,
    source,
    async listConnections() {
      return parseConnectionList(await call('dbx_list_connections', {}))
    },
    async addConnection(connection) {
      const args: Record<string, unknown> = {
        name: connection.name,
        db_type: connection.dbType,
        host: connection.host,
        username: connection.username ?? '',
        password: connection.password ?? '',
        ssl: connection.ssl === true,
      }
      if (typeof connection.port === 'number' && Number.isFinite(connection.port) && connection.port > 0) {
        args['port'] = Math.trunc(connection.port)
      }
      if (typeof connection.database === 'string' && connection.database.trim().length > 0) {
        args['database'] = connection.database.trim()
      }
      if (typeof connection.driverProfile === 'string' && connection.driverProfile.trim().length > 0) {
        args['driver_profile'] = connection.driverProfile.trim()
      }
      const text = await call('dbx_add_connection', args)
      const added = /added \(id: ([^)]+)\)/.exec(text)
      return { id: added === null ? '' : (added[1] as string).trim(), message: text }
    },
    async removeConnection(selector) {
      const args: Record<string, unknown> = {}
      if (typeof selector.id === 'string' && selector.id.length > 0) args['connection_id'] = selector.id
      else if (typeof selector.name === 'string' && selector.name.length > 0) args['connection_name'] = selector.name
      return await call('dbx_remove_connection', args)
    },
    async query(input) {
      const args: Record<string, unknown> = { sql: input.sql, max_rows: input.maxRows }
      if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
        args['connection_id'] = input.connectionId
      } else if (typeof input.connectionName === 'string' && input.connectionName.length > 0) {
        args['connection_name'] = input.connectionName
      }
      if (typeof input.database === 'string' && input.database.trim().length > 0) {
        args['database'] = input.database.trim()
      }
      return parseQueryResult(await call('dbx_execute_query', args))
    },
    async listTables(input) {
      const args: Record<string, unknown> = {}
      if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
        args['connection_id'] = input.connectionId
      } else if (typeof input.connectionName === 'string' && input.connectionName.length > 0) {
        args['connection_name'] = input.connectionName
      }
      if (typeof input.database === 'string' && input.database.trim().length > 0) {
        args['database'] = input.database.trim()
      }
      return parseTableList(await call('dbx_list_tables', args))
    },
    async listDatabases(input) {
      const args: Record<string, unknown> = {}
      if (typeof input.connectionId === 'string' && input.connectionId.length > 0) {
        args['connection_id'] = input.connectionId
      } else if (typeof input.connectionName === 'string' && input.connectionName.length > 0) {
        args['connection_name'] = input.connectionName
      }
      return parseDatabaseList(await call('dbx_list_databases', args))
    },
  }
}

/** Build an access layer over the headless DBX MCP server process. */
function stdioAccess(runtime: AccessRuntime): DbxAccess {
  return mcpAccess(
    {
      call: (name, args) => runtime.manager.call(name, args),
      close: () => {
        /* the manager owns the process lifetime */
      },
    },
    'stdio-mcp',
    'dbx-mcp',
  )
}

/**
 * Build an access layer over the desktop's MCP bridge.
 *
 * The bridge answers queries against the desktop's decrypted connections, so
 * the panel can run SQL without any key. It has no route for the connection
 * catalog, so the connections are read from the DBX store itself, and a new
 * connection is written to that store and the desktop is asked to reload.
 *
 * @param runtime - the runtime the access layer needs.
 * @param bridge - the connected bridge client.
 * @returns the access layer.
 */
function bridgeAccess(runtime: AccessRuntime, bridge: DbxBridgeClient): DbxAccess {
  const nameOf = async (connectionId: string | undefined, connectionName: string | undefined): Promise<string> => {
    if (typeof connectionName === 'string' && connectionName.length > 0) return connectionName
    const connections = await readCatalogConnections(runtime.dataDir)
    const found = connections.find(connection => connection.id === connectionId)
    if (found === undefined) throw new Error('the bridge needs a connection name')
    return found.name
  }
  return {
    mode: 'bridge',
    capabilities: BRIDGE_MCP,
    source: 'DBX desktop bridge',
    async listConnections() {
      const connections = await readCatalogConnections(runtime.dataDir)
      return connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        dbType: connection.dbType,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        // DBX's profile has no schema field, so a row read from its catalog
        // has no namespace to report.
        schema: '',
        groupPath: '',
        note: '',
      }))
    },
    async addConnection(connection) {
      const id = await storeConnection(runtime.dataDir, {
        name: connection.name,
        dbType: connection.dbType,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        database: connection.database,
        ssl: connection.ssl,
        driverProfile: connection.driverProfile,
      })
      await bridge.reloadConnections()
      return { id, message: `Connection "${connection.name}" added (id: ${id}).` }
    },
    async removeConnection(selector) {
      const connections = await readCatalogConnections(runtime.dataDir)
      const found = connections.find(connection => {
        if (typeof selector.id === 'string' && selector.id.length > 0) return connection.id === selector.id
        if (typeof selector.name === 'string' && selector.name.length > 0) return connection.name === selector.name
        return false
      })
      if (found === undefined) throw new Error('no such connection in the DBX catalog')
      const removed = await removeStoredConnection(runtime.dataDir, found.id)
      if (!removed) throw new Error('the connection was already gone from the DBX catalog')
      await bridge.reloadConnections()
      return `Connection "${found.name}" (id: ${found.id}) removed.`
    },
    async query(input) {
      const result = await bridge.executeQuery({
        connectionName: await nameOf(input.connectionId, input.connectionName),
        database: input.database,
        sql: input.sql,
      })
      const columns = result.columns ?? []
      const rows = (result.rows ?? []).map(row => row.map(cell => (cell === null || cell === undefined ? 'NULL' : String(cell))))
      return {
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: typeof result.affectedRows === 'number' ? result.affectedRows : null,
        truncated: result.truncated === true,
        resultId: null,
        messages: result.message ? [result.message] : [],
        text: JSON.stringify({ columns, rows }, null, 2),
      }
    },
    async listTables(input) {
      const tables = await bridge.listTables({
        connectionName: await nameOf(input.connectionId, input.connectionName),
        database: input.database,
      })
      return tables.map(table => ({ name: table.name, tableType: table.tableType }))
    },
    async listDatabases(input) {
      const connections = await readCatalogConnections(runtime.dataDir)
      const found = connections.find(connection => connection.id === input.connectionId)
      if (found === undefined) return []
      if (found.visibleDatabases.length > 0) return found.visibleDatabases
      return found.database.length === 0 ? [] : [found.database]
    },
  }
}

/**
 * Build an access layer over the DBX catalog alone.
 *
 * The catalog is a plain SQLite file, so the panel can still show the
 * connections and add or remove them while DBX is closed. Running a statement
 * needs a live DBX, so those actions report what to do instead.
 *
 * @param runtime - the runtime the access layer needs.
 * @returns the access layer.
 */
function catalogAccess(runtime: AccessRuntime): DbxAccess {
  const live = async (): Promise<never> => {
    throw new Error('running SQL needs a live DBX: start the DBX desktop app, or enable its MCP server')
  }
  return {
    mode: 'catalog',
    capabilities: CATALOG_ONLY,
    source: 'DBX catalog (no running DBX)',
    async listConnections() {
      const connections = await readCatalogConnections(runtime.dataDir)
      return connections.map(connection => ({
        id: connection.id,
        name: connection.name,
        dbType: connection.dbType,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        // DBX's profile has no schema field, so a row read from its catalog
        // has no namespace to report.
        schema: '',
        groupPath: '',
        note: '',
      }))
    },
    async addConnection(connection) {
      const id = await storeConnection(runtime.dataDir, {
        name: connection.name,
        dbType: connection.dbType,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        database: connection.database,
        ssl: connection.ssl,
        driverProfile: connection.driverProfile,
      })
      return { id, message: `Connection "${connection.name}" added (id: ${id}).` }
    },
    async removeConnection(selector) {
      const connections = await readCatalogConnections(runtime.dataDir)
      const found = connections.find(connection => {
        if (typeof selector.id === 'string' && selector.id.length > 0) return connection.id === selector.id
        if (typeof selector.name === 'string' && selector.name.length > 0) return connection.name === selector.name
        return false
      })
      if (found === undefined) throw new Error('no such connection in the DBX catalog')
      const removed = await removeStoredConnection(runtime.dataDir, found.id)
      if (!removed) throw new Error('the connection was already gone from the DBX catalog')
      return `Connection "${found.name}" (id: ${found.id}) removed.`
    },
    async query() {
      return await live()
    },
    async listTables() {
      return await live()
    },
    async listDatabases(input) {
      const connections = await readCatalogConnections(runtime.dataDir)
      const found = connections.find(connection => connection.id === input.connectionId)
      if (found === undefined) return []
      if (found.visibleDatabases.length > 0) return found.visibleDatabases
      return found.database.length === 0 ? [] : [found.database]
    },
  }
}

/** An access layer over nothing: every action fails with one clear message. */
function noAccess(): DbxAccess {
  const fail = async (): Promise<never> => {
    throw new Error('no DBX transport answered')
  }
  return {
    mode: 'none',
    capabilities: NO_MCP,
    source: 'no DBX transport answered',
    async listConnections() {
      return await fail()
    },
    async addConnection() {
      return await fail()
    },
    async removeConnection() {
      return await fail()
    },
    async query() {
      return await fail()
    },
    async listTables() {
      return await fail()
    },
    async listDatabases() {
      return await fail()
    },
  }
}

/**
 * An access layer that reports one failure to every action.
 *
 * @param failure - the failure that kept every transport from answering.
 * @returns the access layer.
 */
function failedAccess(failure: Error): DbxAccess {
  const fail = async (): Promise<never> => {
    throw failure
  }
  return {
    mode: 'none',
    capabilities: NO_MCP,
    source: failure.message,
    async listConnections() {
      return await fail()
    },
    async addConnection() {
      return await fail()
    },
    async removeConnection() {
      return await fail()
    },
    async query() {
      return await fail()
    },
    async listTables() {
      return await fail()
    },
    async listDatabases() {
      return await fail()
    },
  }
}

/**
 * Resolve the transport the panel should use.
 *
 * The desktop's own MCP HTTP server is preferred: it holds the keychain key,
 * so it can create connections and use the stored secrets. The headless
 * server comes next, and the desktop bridge is the last resort: it answers
 * queries only.
 *
 * @param runtime - the runtime the access layer needs.
 * @returns the access layer.
 */
export async function resolveAccess(runtime: AccessRuntime): Promise<DbxAccess> {
  const endpoint = await resolveDesktopMcpEndpoint(runtime.dataDir)
  if (endpoint !== null) {
    try {
      const client = await DbxHttpMcpClient.connect(endpoint.url, endpoint.token, 10_000)
      const access = mcpAccess(
        {
          call: (name, args) => client.callTool(name, args, 120_000),
          close: () => {
            client.close()
          },
        },
        'desktop-mcp',
        `DBX desktop MCP server (${endpoint.url})`,
      )
      // The transport is only useful when it can read the catalog: a desktop
      // server that answers but cannot decrypt the store is not worth using.
      await access.listConnections()
      return access
    } catch {
      // The desktop MCP server was configured but did not answer; fall through
      // to the transports that do not need it.
    }
  }

  let stdioFailure: Error | null = null
  try {
    const server = await runtime.manager.server()
    if (server !== undefined) {
      const access = stdioAccess(runtime)
      try {
        await access.listConnections()
        return access
      } catch (error) {
        // The headless server starts but cannot decrypt the catalog, because the
        // keychain refuses a headless read. The desktop bridge can still run
        // SQL, so it is tried next; the failure is kept for the report.
        stdioFailure = error instanceof Error ? error : new Error(String(error))
      }
    }
  } catch (error) {
    /* the headless server cannot run; fall through to the bridge */
    stdioFailure = error instanceof Error ? error : new Error(String(error))
  }

  const bridge = await DbxBridgeClient.connect(runtime.dataDir)
  if (bridge !== null) return bridgeAccess(runtime, bridge)

  // No live DBX answered. The catalog on disk is still readable and writable,
  // so the panel can show the connections and manage them; only running a
  // statement needs a live DBX.
  try {
    const connections = await readCatalogConnections(runtime.dataDir)
    if (connections.length > 0) return catalogAccess(runtime)
  } catch {
    /* no readable catalog either */
  }

  // Nothing answered. Report the headless failure, since it names the real
  // reason (an unreadable key, a missing binary) better than a bare refusal.
  return stdioFailure === null ? noAccess() : failedAccess(stdioFailure)
}

/**
 * The panel's view of DBX, resolved once and reused.
 *
 * Resolving a transport costs a connection attempt, so the answer is cached.
 * The cache is dropped when the panel asks for a refresh — that is how the
 * panel picks up a DBX desktop MCP server the user has just enabled.
 */
export class AccessProvider {
  private readonly runtime: AccessRuntime
  private current: DbxAccess | null = null
  private pending: Promise<DbxAccess> | null = null

  /**
   * @param runtime - the runtime the access layer needs.
   */
  constructor(runtime: AccessRuntime) {
    this.runtime = runtime
  }

  /**
   * The transport to use, resolving it on first use.
   *
   * @returns the access layer.
   */
  async get(): Promise<DbxAccess> {
    if (this.current !== null) return this.current
    if (this.pending === null) {
      this.pending = resolveAccess(this.runtime)
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
   * Drop the cached transport and resolve it again.
   *
   * @returns the newly resolved access layer.
   */
  async refresh(): Promise<DbxAccess> {
    this.current = null
    this.pending = null
    return await this.get()
  }
}
