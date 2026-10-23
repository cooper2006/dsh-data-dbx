/**
 * PostgreSQL driver, over the `pg` client.
 *
 * `pg` speaks the PostgreSQL wire protocol directly, so the driver needs no
 * helper layer: it hands the statement to the client and turns the answer into
 * the plugin's outcome shape. The connection is per-call rather than pooled,
 * because a panel query is a one-shot action the user triggered; pooling would
 * hold idle sockets open between clicks for no benefit.
 *
 * A PostgreSQL database holds schemas, and a panel connection may name one:
 * the driver sets `search_path` on every session it opens, so an unqualified
 * `SELECT * FROM users` resolves the way the person writing it expects. The
 * table list and the column view are scoped to the same schema.
 *
 * @module dsh-data-dbx/drivers/postgres
 */

import { createRequire } from 'node:module'

import type {
  ColumnInfo,
  ConnectSpec,
  Driver,
  DriverConnection,
  QueryOutcome,
  TableInfo,
} from './types.ts'
import {
  DriverError,
  closeQuietly,
  errorText,
  ignoreAsyncErrors,
  renderTable,
  rowsOutcome,
  statementOutcome,
  toCell,
} from './types.ts'

/** The `pg` surface this driver uses. */
interface PgClient {
  connect(): Promise<void>
  query(text: string, values?: readonly unknown[]): Promise<PgResult>
  end(): Promise<void>
}

/** A `pg` result. */
interface PgResult {
  rows?: unknown[]
  fields?: { name: string }[]
  rowCount?: number | null
  command?: string
}

/** The `pg` constructor surface this driver uses. */
interface PgModule {
  Client: new (config: Record<string, unknown>) => PgClient
}

/** Whether the `pg` package is present. */
function loadPg(): PgModule {
  // A `require` keeps the driver optional: the plugin still loads when the
  // package is missing, and only this engine stops working.
  try {
    return requireModule('pg') as PgModule
  } catch (error) {
    throw new DriverError('postgres', `the "pg" package is not installed: ${errorText(error)}`)
  }
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Build the `pg` connection config from the panel's spec. */
function pgConfig(spec: ConnectSpec): Record<string, unknown> {
  const config: Record<string, unknown> = {
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: spec.database,
  }
  if (spec.ssl) config['ssl'] = { rejectUnauthorized: false }
  if (spec.dbType === 'redshift') config['application_name'] = 'dsh-data-dbx'
  return config
}

/** One open PostgreSQL connection. */
class PostgresConnection implements DriverConnection {
  readonly kind = 'postgres'
  readonly dialect = 'PostgreSQL SQL'
  readonly sql = true
  private readonly client: PgClient
  private readonly schema: string
  private readonly database: string
  private closed = false

  /**
   * @param client - the connected `pg` client.
   * @param schema - the namespace unqualified names resolve in; empty for the
   *   server default (`public`, unless the role has its own `search_path`).
   * @param database - the database the session is attached to, so the table
   *   picker can tell its own database name from a schema name.
   */
  constructor(client: PgClient, schema: string, database: string) {
    this.client = client
    this.schema = schema
    this.database = database
  }

  /** @inheritdoc */
  async query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const result = await this.client.query(sql, params === undefined ? [] : params)
    const fields = result.fields ?? []
    const columns = fields.map(field => field.name)
    const rows = (result.rows ?? []).map(row => columns.map(name => toCell((row as Record<string, unknown>)[name])))
    if (columns.length === 0) {
      const affected = result.rowCount ?? null
      return statementOutcome('postgres', affected, result.command ?? '')
    }
    return rowsOutcome('postgres', columns, rows, false, [], renderTable(columns, rows))
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    const result = await this.client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
    )
    return (result.rows ?? []).map(row => String((row as Record<string, unknown>)['datname'] ?? ''))
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    // The panel's picker may hand over a database name; a PostgreSQL database
    // list is not a namespace list, so a name equal to the connection's own
    // database means "this connection's schema" rather than a schema of that
    // name, which would list nothing.
    const wanted = (database ?? '').trim()
    const schema = wanted.length === 0 || wanted === this.database
      ? this.schemaOrDefault()
      : wanted
    const result = await this.client.query(
      `SELECT table_name, table_type FROM information_schema.tables `
      + `WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    )
    return (result.rows ?? []).map(row => ({
      name: String((row as Record<string, unknown>)['table_name'] ?? ''),
      tableType: String((row as Record<string, unknown>)['table_type'] ?? 'BASE TABLE'),
    }))
  }

  /** The schema to scope metadata queries to. */
  private schemaOrDefault(): string {
    return this.schema.length > 0 ? this.schema : 'public'
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const result = await this.client.query(
      `SELECT column_name, data_type, is_nullable, column_default, `
      + `(SELECT count(*) FROM information_schema.table_constraints tc `
      + `  JOIN information_schema.key_column_usage kcu `
      + `    ON tc.constraint_name = kcu.constraint_name `
      + `   AND tc.table_schema = kcu.table_schema `
      + ` WHERE tc.table_schema = c.table_schema AND tc.table_name = c.table_name `
      + `   AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = c.column_name) > 0 AS primary_key `
      + `FROM information_schema.columns c WHERE c.table_name = $1 AND c.table_schema = $2 `
      + `ORDER BY ordinal_position`,
      [name, this.schemaOrDefault()],
    )
    return (result.rows ?? []).map(row => {
      const values = row as Record<string, unknown>
      return {
        name: String(values['column_name'] ?? ''),
        dataType: String(values['data_type'] ?? ''),
        nullable: String(values['is_nullable'] ?? 'NO') === 'YES',
        defaultValue: values['column_default'] === null || values['column_default'] === undefined
          ? null
          : String(values['column_default']),
        primaryKey: values['primary_key'] === true || values['primary_key'] === 1,
      }
    })
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.end()
    } catch {
      // Ending a client that already dropped can fail harmlessly.
    }
  }
}

/**
 * Point the session's `search_path` at one schema.
 *
 * `set_config` takes the value as a plain string, so a schema whose name needs
 * quoting (`My Schema`) works without the driver building an identifier. It is
 * a session setting: every call opens its own connection, so the driver must
 * set it on every one of them, not once per panel connection.
 *
 * @param client - the connected client.
 * @param schema - the schema to resolve unqualified names in; empty does nothing.
 */
async function applySearchPath(client: PgClient, schema: string): Promise<void> {
  if (schema.length === 0) return
  await client.query('SELECT set_config($1, $2, false)', ['search_path', schema])
}

/**
 * Create the PostgreSQL driver.
 *
 * @param loadModule - how to reach the `pg` package; the self-check hands in a
 *   fake so the driver can be tested without a server.
 * @returns the driver.
 */
export function createPostgresDriver(loadModule: () => PgModule = loadPg): Driver {
  return {
    kind: 'postgres',
    label: 'PostgreSQL',
    dialect: 'PostgreSQL SQL',
    sql: true,
    defaultPort: 5432,
    file: false,
    package: 'pg',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const { Client } = loadModule()
      const client = new Client(pgConfig(spec))
      // `pg` emits `error` on the client when the socket dies, including while
      // the connect attempt is still pending; without a listener that event is
      // a fatal exception for the whole host, not just this panel.
      ignoreAsyncErrors(client)
      const schema = spec.schema.trim()
      try {
        await client.connect()
        await applySearchPath(client, schema)
      } catch (error) {
        await closeQuietly(client)
        throw new DriverError('postgres', errorText(error))
      }
      return new PostgresConnection(client, schema, spec.database)
    },
  }
}
