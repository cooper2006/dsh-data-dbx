/**
 * The model-facing DBX tools: connection discovery, SQL execution, and
 * cross-connection federated queries.
 *
 * These tools own schemas, validation, output shaping, and prompt guidance.
 * They do not own drivers, credentials, or query planning — every statement is
 * executed by the DBX MCP server, which owns those concerns.
 *
 * @module dsh-data-dbx/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DbxCatalogError, readConnections, resolveConnection, resolveDbxDbPath, toSummary } from './connections.ts'
import type { DbxConnectionProfile } from './connections.ts'
import type { DbxServerManager } from './manager.ts'

/** Tool names contributed by this plugin. */
export const TOOL_NAMES = {
  listConnections: 'dbx_list_connections',
  executeQuery: 'dbx_execute_query',
  federatedQuery: 'dbx_federated_query',
  federationStatus: 'dbx_federation_status',
} as const

/** Where the connection catalog and execution server are configured. */
export interface ToolRuntime {
  /** Resolved DBX data directory override, when the deployment set one. */
  dataDir: string | undefined
  /** Manager owning the DBX MCP server process. */
  manager: DbxServerManager
  /** Default row cap for executed statements. */
  maxRows: number
  /** Cooperative per-tool timeout budget in milliseconds. */
  timeoutMs: number
}

/**
 * Read the DBX catalog, converting any storage failure into a model-readable
 * message that names the path the plugin tried.
 *
 * @param dataDir - the configured data-directory override.
 * @returns the connection profiles.
 * @throws {Error} with an actionable message.
 */
async function loadCatalog(dataDir: string | undefined): Promise<DbxConnectionProfile[]> {
  const path = resolveDbxDbPath(dataDir)
  try {
    return await readConnections(path)
  } catch (error) {
    if (error instanceof DbxCatalogError) {
      throw new Error(
        `${error.message}. Set the plugin's dataDir option (or DBX_DATA_DIR) to the directory `
        + `holding dbx.db, or start the DBX desktop app once so it creates its storage.`,
      )
    }
    throw error
  }
}

/** Render a table's rows as the markdown table DBX already returns. */
function renderText(text: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: text.length > 0 ? text : '(no output)' }]
}

/**
 * Register the DBX tools on the harness tool registry.
 *
 * @param ctx - the plugin context; `tools` is injected by the caller.
 * @param runtime - catalog location, server manager, and limits.
 */
export function applyDbxTools(ctx: Context, runtime: ToolRuntime): void {
  const { manager } = runtime

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.listConnections,
    description:
      'List the database connections configured in the DBX desktop app, with their ids, names, '
      + 'engine types, endpoints, and whether each one may take part in federated queries. '
      + 'Call this first: both other DBX tools address connections by the id or name returned here.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                dbType: { type: 'string', required: true },
                driverProfile: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                username: { type: 'string', required: true },
                database: { type: 'string', required: true },
                federationEnabled: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.connections.length === 0) {
          return renderText('No DBX connections are configured. Create one in the DBX desktop app first.')
        }
        const lines = value.connections.map((c) => {
          const endpoint = c.dbType === 'sqlite' ? c.host : `${c.host}:${c.port}`
          const fed = c.federationEnabled ? 'federation: enabled' : 'federation: disabled'
          return `- ${c.name} (${c.id}) — ${c.driverProfile || c.dbType} at ${endpoint}, database ${c.database || '(default)'}, ${fed}`
        })
        return renderText(`DBX connections:\n${lines.join('\n')}`)
      },
    },
    timeoutMs: runtime.timeoutMs,
    isConcurrencySafe: () => true,
    async execute() {
      const profiles = await loadCatalog(runtime.dataDir)
      return { connections: profiles.map(toSummary) }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.executeQuery,
    description:
      'Execute one SQL statement against a DBX connection and return the rows as a markdown table. '
      + 'Address the connection by the id or name from dbx_list_connections. '
      + 'For a query that joins tables across two or more connections, use dbx_federated_query instead.',
    parameters: {
      connection: {
        type: 'string',
        required: true,
        description: 'Connection id or name, as returned by dbx_list_connections.',
      },
      sql: { type: 'string', required: true, description: 'The SQL statement to execute.' },
      database: {
        type: 'string',
        description: 'Database to run against; defaults to the connection\'s own database.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string', required: true },
          sql: { type: 'string', required: true },
          result: { type: 'string', required: true },
          isError: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        if (value.isError) return renderText(`DBX error on ${value.connection}:\n\n${value.result}`)
        return renderText(value.result)
      },
    },
    timeoutMs: runtime.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const profiles = await loadCatalog(runtime.dataDir)
      const profile = resolveConnection(profiles, args.connection)
      const callArgs: Record<string, unknown> = {
        connection_id: profile.id,
        sql: args.sql,
        max_rows: runtime.maxRows,
      }
      if (args.database !== undefined && args.database.length > 0) callArgs['database'] = args.database

      const { text, isError } = await manager.call('dbx_execute_query', callArgs)
      return { connection: profile.name, sql: args.sql, result: text, isError }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.federatedQuery,
    description:
      'Run one read-only SQL query that joins tables from two or more DBX connections in a single '
      + 'statement, executed by DBX\'s DataFusion federation engine. Qualify each table as '
      + '<connectionName>.<schema>.<table>, using the connection NAME (not its id) as the first part. '
      + 'Every referenced connection must have federation enabled; check with dbx_federation_status. '
      + 'Federated queries are read-only.',
    parameters: {
      sql: {
        type: 'string',
        required: true,
        description:
          'Federated SQL. Qualify every table as <connectionName>.<schema>.<table>, e.g. '
          + '"SELECT * FROM pglocal.public.customer c JOIN mysqlocal.tpcds.store_sales s ON c.id = s.customer_id".',
      },
      database: {
        type: 'string',
        description: 'Database used to resolve the statement; defaults to the first connection\'s database.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sql: { type: 'string', required: true },
          result: { type: 'string', required: true },
          isError: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        if (value.isError) return renderText(`Federated query failed:\n\n${value.result}`)
        return renderText(value.result)
      },
    },
    timeoutMs: runtime.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const profiles = await loadCatalog(runtime.dataDir)
      // Federated SQL is qualified by connection name, so the statement needs a
      // connection to route through; prefer one that can federate.
      const anchor = profiles.find(p => p.federationEnabled) ?? profiles[0]
      if (anchor === undefined) {
        return {
          sql: args.sql,
          result: 'No DBX connections are configured; there is nothing to federate.',
          isError: true,
        }
      }

      const callArgs: Record<string, unknown> = {
        connection_id: anchor.id,
        sql: args.sql,
        // `require` turns a silent direct-connection fallback into an explicit
        // error, so a federated query never quietly degrades to one engine.
        federation_mode: 'require',
        max_rows: runtime.maxRows,
      }
      const database = args.database ?? (anchor.database.length > 0 ? anchor.database : undefined)
      if (database !== undefined) callArgs['database'] = database

      const { text, isError } = await manager.call('dbx_execute_query', callArgs)
      return { sql: args.sql, result: text, isError }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_NAMES.federationStatus,
    description:
      'Probe DBX federation readiness across all connections: which connections have federation '
      + 'enabled, which engines have a DataFusion adapter, and whether the federation engine is '
      + 'available at all. Call this before writing a federated query to confirm it can run.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          isError: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderText(value.status),
    },
    timeoutMs: runtime.timeoutMs,
    isConcurrencySafe: () => true,
    async execute() {
      const { text, isError } = await manager.call('dbx_federation_status', {})
      return { status: text, isError }
    },
  }))
}
