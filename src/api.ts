/**
 * The host API behind the DBX panel.
 *
 * The panel in the browser is a thin view: it lists connections, creates
 * connections, and runs SQL. Every one of those actions travels through the
 * native access layer (`native.ts`), so this module owns three things and
 * nothing else:
 *
 *   * the exact `/api/dbx/*` routes the browser half calls,
 *   * the translation between the browser's JSON and the access vocabulary, and
 *   * the shaping of an answer into the JSON the grid can draw.
 *
 * It owns no driver and no credential: a self-built connection is opened by
 * the driver registry, a DBX connection is opened by DBX itself, and the
 * password never leaves the vault.
 *
 * @module dsh-data-dbx/api
 */

import type { Context } from '@deepseek-ai/cordis'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { importCatalogConnections, NativeAccessProvider } from './native.ts'
import { listVault, masterKey, toConnectSpec } from './vault.ts'

export {
  parseConnectionList,
  parseDatabaseList,
  parseMarkdownTable,
  parseQueryResult,
  parseTableList,
  splitMarkdownRow,
} from './parse.ts'

/** Exact routes the browser half calls. */
export const API_ROUTES = {
  /** `GET` — every configured DBX connection. */
  connections: '/api/dbx/connections',
  /** `POST` — remove one DBX connection. */
  removeConnection: '/api/dbx/connections/remove',
  /** `POST` — check that one connection answers. */
  testConnection: '/api/dbx/connections/test',
  /** `POST` — edit one self-built connection. */
  updateConnection: '/api/dbx/connections/update',
  /** `POST` — copy DBX catalog connections into the plugin's vault. */
  importConnections: '/api/dbx/connections/import',
  /** `POST` — execute one SQL statement. */
  query: '/api/dbx/query',
  /** `GET` — tables of one connection. */
  tables: '/api/dbx/tables',
  /** `GET` — columns of one table. */
  describe: '/api/dbx/describe',
  /** `GET` — databases of one connection. */
  databases: '/api/dbx/databases',
  /** `GET` — which DBX transport answered, and what it can do. */
  status: '/api/dbx/status',
} as const

/** Engines that address a local file instead of a host and a port. */
const FILE_ENGINES = new Set(['sqlite', 'duckdb'])

/** What every route answers with. */
interface ApiEnvelope {
  ok: boolean
  error?: string
  [key: string]: unknown
}

/** The runtime the routes need. */
export interface ApiRuntime {
  /** The native route plus the DBX transport it falls back to. */
  access: NativeAccessProvider
  /** The data directory holding the vault and `dbx.db`. */
  dataDir: string
  /** Default row cap for one executed statement. */
  maxRows: number
}

/** Answer with a JSON body and a status code. */
function json(body: ApiEnvelope, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Read one JSON request body, tolerating an empty one. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Read one query-string parameter. */
function param(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  return value === null ? '' : value.trim()
}

/**
 * List every configured DBX connection.
 *
 * @param runtime - the access layer and limits.
 * @returns the response.
 */
export async function handleListConnections(runtime: ApiRuntime): Promise<Response> {
  const access = await runtime.access.get()
  const connections = await access.listConnections()
  return json({ ok: true, connections })
}

/**
 * Report which route answered and what it supports.
 *
 * The panel shows this, so the user can see whether the panel can create
 * connections before they try, and which engines it opens itself.
 *
 * @param runtime - the access layer and limits.
 * @returns the response.
 */
export async function handleStatus(runtime: ApiRuntime): Promise<Response> {
  const access = await runtime.access.get()
  return json({
    ok: true,
    mode: access.mode,
    source: access.source,
    capabilities: access.capabilities,
    engines: access.engines,
    engineCatalog: access.engineCatalog,
    vaultCount: access.vaultCount,
  })
}

/** The body the browser sends when creating a connection. */
export interface CreateConnectionBody {
  name?: string | undefined
  dbType?: string | undefined
  host?: string | undefined
  port?: number | undefined
  username?: string | undefined
  password?: string | undefined
  database?: string | undefined
  /** Namespace inside the database, for engines that have one. */
  schema?: string | undefined
  ssl?: boolean | undefined
  driverProfile?: string | undefined
}

/** The body the browser sends when editing a connection. */
export interface UpdateConnectionBody extends CreateConnectionBody {
  connectionId?: string | undefined
}

/**
 * Create one DBX connection.
 *
 * The password is forwarded to DBX and never stored by this plugin: DBX keeps
 * it in its own encrypted secret store.
 *
 * @param runtime - the access layer and limits.
 * @param body - the connection to create.
 * @returns the response.
 */
export async function handleCreateConnection(runtime: ApiRuntime, body: CreateConnectionBody): Promise<Response> {
  const name = (body.name ?? '').trim()
  const dbType = (body.dbType ?? '').trim()
  const host = (body.host ?? '').trim()
  if (name.length === 0) return json({ ok: false, error: 'the connection needs a name' }, 400)
  if (dbType.length === 0) return json({ ok: false, error: 'the connection needs a database type' }, 400)
  if (host.length === 0) return json({ ok: false, error: 'the connection needs a host (a file path for file engines)' }, 400)

  ensureLocalFile(dbType, host)

  const access = await runtime.access.get()
  const added = await access.addConnection({
    name,
    dbType,
    host,
    port: body.port,
    username: body.username,
    password: body.password,
    database: body.database,
    schema: body.schema,
    ssl: body.ssl,
    driverProfile: body.driverProfile,
  })
  return json({ ok: true, id: added.id, message: added.message })
}

/**
 * Check that one connection answers.
 *
 * DBX has no dedicated "test connection" tool, so the check runs the smallest
 * possible statement against the connection and reports what DBX answered.
 *
 * @param runtime - the access layer and limits.
 * @param body - the connection to check.
 * @returns the response.
 */
export async function handleTestConnection(
  runtime: ApiRuntime,
  body: { connectionId?: string | undefined; connectionName?: string | undefined },
): Promise<Response> {
  const connectionId = (body.connectionId ?? '').trim()
  const connectionName = (body.connectionName ?? '').trim()
  if (connectionId.length === 0 && connectionName.length === 0) {
    return json({ ok: false, error: 'the connection to test needs an id or a name' }, 400)
  }
  const access = await runtime.access.get()
  const result = await access.query({
    connectionId,
    connectionName,
    sql: 'SELECT 1',
    maxRows: 1,
  })
  return json({ ok: true, message: result.text })
}

/**
 * Create the file a file engine addresses, when it is missing.
 *
 * DBX opens a SQLite or DuckDB file in place and refuses to create one, so a
 * fresh connection to a new file needs the file to exist first. The file is
 * empty, which is a valid empty database for both engines.
 *
 * @param dbType - the DBX engine type.
 * @param host - the file path the connection addresses.
 * @returns nothing; a failure is reported by the caller.
 */
function ensureLocalFile(dbType: string, host: string): void {
  if (!FILE_ENGINES.has(dbType)) return
  if (host.length === 0 || existsSync(host)) return
  const directory = dirname(host)
  if (directory.length > 0 && directory !== '.') mkdirSync(directory, { recursive: true })
  closeSync(openSync(host, 'a'))
}

/**
 * Remove one DBX connection.
 *
 * @param runtime - the access layer and limits.
 * @param body - the connection to remove.
 * @returns the response.
 */
export async function handleRemoveConnection(
  runtime: ApiRuntime,
  body: { connectionId?: string | undefined; connectionName?: string | undefined },
): Promise<Response> {
  const connectionId = (body.connectionId ?? '').trim()
  const connectionName = (body.connectionName ?? '').trim()
  if (connectionId.length === 0 && connectionName.length === 0) {
    return json({ ok: false, error: 'the connection to remove needs an id or a name' }, 400)
  }
  const access = await runtime.access.get()
  const message = await access.removeConnection({ id: connectionId, name: connectionName })
  return json({ ok: true, message })
}

/**
 * Execute one SQL statement against one connection.
 *
 * @param runtime - the access layer and limits.
 * @param body - the statement and its target.
 * @returns the response.
 */
export async function handleQuery(
  runtime: ApiRuntime,
  body: { connectionId?: string | undefined; sql?: string | undefined; database?: string | undefined; maxRows?: number | undefined },
): Promise<Response> {
  const connectionId = (body.connectionId ?? '').trim()
  const sql = (body.sql ?? '').trim()
  if (connectionId.length === 0) return json({ ok: false, error: 'the statement needs a connection' }, 400)
  if (sql.length === 0) return json({ ok: false, error: 'the statement is empty' }, 400)

  const maxRows = typeof body.maxRows === 'number' && Number.isFinite(body.maxRows) && body.maxRows > 0
    ? Math.trunc(body.maxRows)
    : runtime.maxRows
  const access = await runtime.access.get()
  const result = await access.query({
    connectionId,
    database: body.database,
    sql,
    maxRows,
  })
  return json({ ok: true, result })
}

/**
 * List the tables and views of one connection.
 *
 * @param runtime - the access layer and limits.
 * @param connectionId - the connection to inspect.
 * @param database - the database to inspect, when the connection has several.
 * @returns the response.
 */
export async function handleListTables(
  runtime: ApiRuntime,
  connectionId: string,
  database?: string,
): Promise<Response> {
  if (connectionId.length === 0) return json({ ok: false, error: 'the connection id is missing' }, 400)
  const access = await runtime.access.get()
  const tables = await access.listTables({ connectionId, database })
  return json({ ok: true, tables })
}

/**
 * List the databases of one connection.
 *
 * @param runtime - the access layer and limits.
 * @param connectionId - the connection to inspect.
 * @returns the response.
 */
export async function handleListDatabases(runtime: ApiRuntime, connectionId: string): Promise<Response> {
  if (connectionId.length === 0) return json({ ok: false, error: 'the connection id is missing' }, 400)
  const access = await runtime.access.get()
  const databases = await access.listDatabases({ connectionId })
  return json({ ok: true, databases })
}

/**
 * Edit one self-built connection.
 *
 * The vault stores an encrypted password, so an edit that leaves the password
 * field empty keeps the stored one instead of wiping it: an imported
 * connection is edited for its name and host long before its secret.
 *
 * @param runtime - the access layer and limits.
 * @param body - the connection and its new fields.
 * @returns the response.
 */
export async function handleUpdateConnection(runtime: ApiRuntime, body: UpdateConnectionBody): Promise<Response> {
  const connectionId = (body.connectionId ?? '').trim()
  const name = (body.name ?? '').trim()
  const dbType = (body.dbType ?? '').trim()
  const host = (body.host ?? '').trim()
  if (connectionId.length === 0) return json({ ok: false, error: 'the connection to edit needs an id' }, 400)
  if (name.length === 0) return json({ ok: false, error: 'the connection needs a name' }, 400)
  if (dbType.length === 0) return json({ ok: false, error: 'the connection needs a database type' }, 400)
  if (host.length === 0) return json({ ok: false, error: 'the connection needs a host (a file path for file engines)' }, 400)

  ensureLocalFile(dbType, host)

  const existing = listVault(runtime.dataDir).find(entry => entry.id === connectionId)
  const typedPassword = body.password
  const password = typedPassword !== undefined && typedPassword.length > 0
    ? typedPassword
    : existing === undefined
      ? ''
      : toConnectSpec(existing, masterKey(runtime.dataDir)).password

  const access = await runtime.access.get()
  const entry = await access.updateConnection(connectionId, {
    name,
    dbType,
    host,
    port: body.port,
    username: body.username,
    password,
    database: body.database,
    schema: body.schema,
    ssl: body.ssl,
    driverProfile: body.driverProfile,
    note: existing?.note ?? '',
    imported: existing?.imported ?? false,
  })
  return json({ ok: true, id: entry.id, message: `self-built connection "${entry.name}" updated` })
}

/**
 * Copy DBX catalog connections into the plugin's vault.
 *
 * @param runtime - the access layer and limits.
 * @param body - which connections to copy.
 * @returns the response.
 */
export async function handleImportConnections(
  runtime: ApiRuntime,
  body: { ids?: readonly string[] | undefined; all?: boolean | undefined },
): Promise<Response> {
  const outcome = await importCatalogConnections(runtime.dataDir, body)
  if (outcome.imported.length === 0 && outcome.skipped.length === 0) {
    return json({ ok: false, error: 'the DBX catalog has no connection to import' }, 404)
  }
  const parts: string[] = []
  if (outcome.imported.length > 0) parts.push(`imported ${outcome.imported.length}`)
  if (outcome.skipped.length > 0) parts.push(`skipped ${outcome.skipped.length} already present`)
  if (outcome.needsPassword.length > 0) parts.push(`${outcome.needsPassword.length} need a password`)
  return json({ ok: true, message: parts.join(', '), ...outcome })
}

/**
 * Describe one table of one connection.
 *
 * @param runtime - the access layer and limits.
 * @param connectionId - the connection to inspect.
 * @param table - the table to describe.
 * @returns the response.
 */
export async function handleDescribeTable(
  runtime: ApiRuntime,
  connectionId: string,
  table: string,
): Promise<Response> {
  if (connectionId.length === 0) return json({ ok: false, error: 'the connection id is missing' }, 400)
  if (table.length === 0) return json({ ok: false, error: 'the table name is missing' }, 400)
  const access = await runtime.access.get()
  const columns = await access.describeTable({ connectionId, table })
  return json({ ok: true, columns })
}

/**
 * Register the DBX panel API on the harness connection service.
 *
 * The routes are exact paths under `/api`, and every answer is JSON. The
 * browser half calls them with a same-origin `fetch`, so the harness session
 * cookie authenticates the call.
 *
 * @param ctx - the plugin context; `connection` is injected by the caller.
 * @param runtime - the access layer and limits.
 */
export function applyDbxApi(ctx: Context, runtime: ApiRuntime): void {
  const connection = (ctx as unknown as {
    connection?: {
      fetch: {
        register: (route: {
          path: string
          methods: string[]
          requestBody: 'buffered'
          fetch: (request: Request) => Promise<Response> | Response
        }) => unknown
      }
    }
  }).connection
  if (connection === undefined) {
    ctx.logger.warn('data-dbx: no connection service; the DBX panel API is not registered')
    return
  }

  const register = (path: string, methods: string[], handler: (request: Request) => Promise<Response>): void => {
    connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request: Request) => {
        try {
          return await handler(request)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return json({ ok: false, error: message }, 500)
        }
      },
    })
  }

  register(API_ROUTES.connections, ['GET', 'POST'], async (request) => {
    if (request.method === 'POST') {
      const body = await readJson(request)
      return handleCreateConnection(runtime, {
        name: typeof body['name'] === 'string' ? body['name'] : undefined,
        dbType: typeof body['dbType'] === 'string' ? body['dbType'] : undefined,
        host: typeof body['host'] === 'string' ? body['host'] : undefined,
        port: typeof body['port'] === 'number' ? body['port'] : undefined,
        username: typeof body['username'] === 'string' ? body['username'] : undefined,
        password: typeof body['password'] === 'string' ? body['password'] : undefined,
        database: typeof body['database'] === 'string' ? body['database'] : undefined,
        schema: typeof body['schema'] === 'string' ? body['schema'] : undefined,
        ssl: body['ssl'] === true,
        driverProfile: typeof body['driverProfile'] === 'string' ? body['driverProfile'] : undefined,
      })
    }
    return handleListConnections(runtime)
  })
  register(API_ROUTES.removeConnection, ['POST'], async (request) => {
    const body = await readJson(request)
    return handleRemoveConnection(runtime, {
      connectionId: typeof body['connectionId'] === 'string' ? body['connectionId'] : undefined,
      connectionName: typeof body['connectionName'] === 'string' ? body['connectionName'] : undefined,
    })
  })
  register(API_ROUTES.testConnection, ['POST'], async (request) => {
    const body = await readJson(request)
    return handleTestConnection(runtime, {
      connectionId: typeof body['connectionId'] === 'string' ? body['connectionId'] : undefined,
      connectionName: typeof body['connectionName'] === 'string' ? body['connectionName'] : undefined,
    })
  })
  register(API_ROUTES.importConnections, ['POST'], async (request) => {
    const body = await readJson(request)
    const ids = Array.isArray(body['ids'])
      ? body['ids'].filter((value): value is string => typeof value === 'string')
      : undefined
    return handleImportConnections(runtime, {
      ids,
      all: body['all'] === true,
    })
  })
  register(API_ROUTES.describe, ['GET'], async (request) => {
    const url = new URL(request.url)
    return handleDescribeTable(runtime, param(url, 'connectionId'), param(url, 'table'))
  })
  register(API_ROUTES.updateConnection, ['POST'], async (request) => {
    const body = await readJson(request)
    return handleUpdateConnection(runtime, {
      connectionId: typeof body['connectionId'] === 'string' ? body['connectionId'] : undefined,
      name: typeof body['name'] === 'string' ? body['name'] : undefined,
      dbType: typeof body['dbType'] === 'string' ? body['dbType'] : undefined,
      host: typeof body['host'] === 'string' ? body['host'] : undefined,
      port: typeof body['port'] === 'number' ? body['port'] : undefined,
      username: typeof body['username'] === 'string' ? body['username'] : undefined,
      password: typeof body['password'] === 'string' ? body['password'] : undefined,
      database: typeof body['database'] === 'string' ? body['database'] : undefined,
      schema: typeof body['schema'] === 'string' ? body['schema'] : undefined,
      ssl: body['ssl'] === true,
      driverProfile: typeof body['driverProfile'] === 'string' ? body['driverProfile'] : undefined,
    })
  })
  register(API_ROUTES.query, ['POST'], async (request) => {
    const body = await readJson(request)
    return handleQuery(runtime, {
      connectionId: typeof body['connectionId'] === 'string' ? body['connectionId'] : undefined,
      sql: typeof body['sql'] === 'string' ? body['sql'] : undefined,
      database: typeof body['database'] === 'string' ? body['database'] : undefined,
      maxRows: typeof body['maxRows'] === 'number' ? body['maxRows'] : undefined,
    })
  })
  register(API_ROUTES.tables, ['GET'], async (request) => {
    const url = new URL(request.url)
    return handleListTables(runtime, param(url, 'connectionId'), param(url, 'database'))
  })
  register(API_ROUTES.databases, ['GET'], async (request) => {
    const url = new URL(request.url)
    return handleListDatabases(runtime, param(url, 'connectionId'))
  })
  register(API_ROUTES.status, ['GET'], async () => {
    return handleStatus(runtime)
  })
}
