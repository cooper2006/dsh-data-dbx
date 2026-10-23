/**
 * ClickHouse driver, over the `@clickhouse/client` HTTP client.
 *
 * ClickHouse's HTTP interface takes a statement and answers with a tab- or
 * JSON-separated payload; the official client wraps that and gives back rows
 * as objects. The driver asks for JSON so the column names come back from the
 * server rather than being inferred from the first row.
 *
 * @module dsh-data-dbx/drivers/clickhouse
 */

import { createRequire } from 'node:module'

import type {
  Cell,
  ColumnInfo,
  ConnectSpec,
  Driver,
  DriverConnection,
  QueryOutcome,
  TableInfo,
} from './types.ts'
import { DriverError, errorText, renderTable, rowsOutcome, statementOutcome, toCell } from './types.ts'

/** The `@clickhouse/client` surface this driver uses. */
interface ClickhouseClient {
  query(params: { query: string; format?: string }): Promise<{ json: () => Promise<unknown> }>
  command(params: { query: string }): Promise<unknown>
  close(): Promise<void>
}

/** The `@clickhouse/client` module surface this driver uses. */
interface ClickhouseModule {
  createClient(config: Record<string, unknown>): ClickhouseClient
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `@clickhouse/client`, reporting a missing package as an engine failure. */
function loadClickhouse(): ClickhouseModule {
  try {
    return requireModule('@clickhouse/client') as unknown as ClickhouseModule
  } catch (error) {
    throw new DriverError('clickhouse', `the "@clickhouse/client" package is not installed: ${errorText(error)}`)
  }
}

/** Build the ClickHouse client config from the panel's spec. */
function clickhouseConfig(spec: ConnectSpec): Record<string, unknown> {
  const url = `http${spec.ssl ? 's' : ''}://${spec.host}:${spec.port}`
  const config: Record<string, unknown> = {
    url,
    database: spec.database.length > 0 ? spec.database : 'default',
    request_timeout: 60_000,
  }
  if (spec.username.length > 0) config['username'] = spec.username
  if (spec.password.length > 0) config['password'] = spec.password
  return config
}

/** One open ClickHouse connection. */
class ClickhouseConnection implements DriverConnection {
  readonly kind = 'clickhouse'
  readonly dialect = 'ClickHouse SQL'
  readonly sql = true
  private readonly client: ClickhouseClient
  private closed = false

  /**
   * @param client - the connected ClickHouse client.
   */
  constructor(client: ClickhouseClient) {
    this.client = client
  }

  /** @inheritdoc */
  async query(sql: string): Promise<QueryOutcome> {
    const answer = await this.client.query({ query: sql, format: 'JSON' })
    const payload = await answer.json()
    const data = (payload ?? {}) as { data?: Record<string, unknown>[]; rows?: number }
    const rows = data.data ?? []
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []
    const cells: Cell[][] = rows.map(row => columns.map(name => toCell((row as Record<string, unknown>)[name])))
    if (columns.length === 0) {
      return statementOutcome('clickhouse', typeof data.rows === 'number' ? data.rows : null)
    }
    return rowsOutcome('clickhouse', columns, cells, false, [], renderTable(columns, cells))
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    const answer = await this.client.query({
      query: 'SELECT name FROM system.databases ORDER BY name',
      format: 'JSON',
    })
    const payload = (await answer.json()) as { data?: { name: string }[] }
    return (payload.data ?? []).map(row => String(row.name))
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    const scope = database === undefined || database.length === 0 ? 'currentDatabase()' : `'${database.replace(/'/g, "''")}'`
    const answer = await this.client.query({
      query: `SELECT name, engine FROM system.tables WHERE database = ${scope} ORDER BY name`,
      format: 'JSON',
    })
    const payload = (await answer.json()) as { data?: { name: string; engine: string }[] }
    return (payload.data ?? []).map(row => ({
      name: String(row.name),
      tableType: row.engine === 'View' || row.engine === 'MaterializedView' ? 'VIEW' : 'BASE TABLE',
    }))
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const scope = name.includes('.') ? name : `currentDatabase()."${name.replace(/"/g, '""')}"`
    const answer = await this.client.query({
      query: `SELECT name, type, default_kind, default_expression, is_in_primary_key `
        + `FROM system.columns WHERE table = '${scope.replace(/'/g, "''")}' ORDER BY position`,
      format: 'JSON',
    })
    const payload = (await answer.json()) as {
      data?: { name: string; type: string; default_kind: string; default_expression: string; is_in_primary_key: number }[]
    }
    return (payload.data ?? []).map(row => ({
      name: String(row.name),
      dataType: String(row.type),
      nullable: !String(row.type).startsWith('Nullable'),
      defaultValue: row.default_kind === 'DEFAULT' ? String(row.default_expression) : null,
      primaryKey: Number(row.is_in_primary_key) === 1,
    }))
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.close()
    } catch {
      // Closing a client that already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the ClickHouse driver.
 *
 * @returns the driver.
 */
export function createClickhouseDriver(): Driver {
  return {
    kind: 'clickhouse',
    label: 'ClickHouse',
    dialect: 'ClickHouse SQL',
    sql: true,
    defaultPort: 8123,
    file: false,
    package: '@clickhouse/client',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const { createClient } = loadClickhouse()
      let client: ClickhouseClient
      try {
        client = createClient(clickhouseConfig(spec))
      } catch (error) {
        throw new DriverError('clickhouse', errorText(error))
      }
      // A ClickHouse client opens lazily, so prove the connection now rather
      // than letting the panel report the failure on the first statement.
      try {
        await client.query({ query: 'SELECT 1', format: 'JSON' }).then(answer => answer.json())
      } catch (error) {
        throw new DriverError('clickhouse', errorText(error))
      }
      return new ClickhouseConnection(client)
    },
  }
}
