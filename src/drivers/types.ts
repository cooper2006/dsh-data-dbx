/**
 * The vocabulary every database driver in this plugin speaks.
 *
 * The panel needs the same six things from a database regardless of what that
 * database is: a connection, a statement, a result page, the databases, the
 * tables, and one table's columns. Each driver below maps its own client
 * library onto exactly that surface, so the layer above (the access layer and
 * the HTTP API) never learns which client answered.
 *
 * A driver also owns its dialect's name, because a statement that runs on
 * PostgreSQL is not necessarily the statement that runs on SQL Server: the
 * panel labels the editor with the dialect it is actually speaking.
 *
 * @module dsh-data-dbx/drivers/types
 */

/** One cell of a result row. Every driver normalises to this. */
export type Cell = string | number | boolean | null

/** What one executed statement produced. */
export interface QueryOutcome {
  /** Column headers, empty when the statement returned no rows. */
  columns: string[]
  /** Row cells, aligned with `columns`. */
  rows: Cell[][]
  /** Rows the statement reported. */
  rowCount: number
  /** Affected rows for a statement that returned no result set. */
  affectedRows: number | null
  /** Whether the driver stopped early because of the row cap. */
  truncated: boolean
  /** Opaque continuation token when the page was capped. */
  resultId: string | null
  /** Server notes appended by the driver (version, warnings, plan hints). */
  messages: string[]
  /** The raw answer, kept for the "raw" view. */
  text: string
}

/** One table or view. */
export interface TableInfo {
  /** Table name. */
  name: string
  /** `BASE TABLE`, `VIEW`, `COLLECTION`, `STREAM`, … as the engine names it. */
  tableType: string
}

/** One column of one table. */
export interface ColumnInfo {
  /** Column name. */
  name: string
  /** Engine type name, e.g. `text`, `bigint`. */
  dataType: string
  /** Whether the column accepts null. */
  nullable: boolean
  /** Default expression, when the engine records one. */
  defaultValue: string | null
  /** Whether the column is (part of) the primary key. */
  primaryKey: boolean
}

/** Everything a driver needs to open a connection. */
export interface ConnectSpec {
  /** The engine type the panel recorded, e.g. `postgres`. */
  dbType: string
  /** Host name, or the file path for a file engine. */
  host: string
  /** TCP port. */
  port: number
  /** User name, empty when the engine needs none. */
  username: string
  /** Password, empty when the engine needs none. */
  password: string
  /** Default database, schema, or keyspace. */
  database: string
  /**
   * Namespace inside the database, for engines that have one.
   *
   * PostgreSQL calls it a schema and resolves unqualified names through
   * `search_path`; MySQL has no such level (its schemas *are* databases), so a
   * driver that has no use for this reads it as an empty string.
   */
  schema: string
  /** Whether TLS is wanted. */
  ssl: boolean
  /** Driver-specific extras, e.g. `{ authSource: 'admin' }`. */
  options: Record<string, string>
}

/** One open connection to one database. */
export interface DriverConnection {
  /** The engine this connection speaks, e.g. `postgres`. */
  readonly kind: string
  /** Human name of the statement language, e.g. `PostgreSQL SQL`. */
  readonly dialect: string
  /** Whether the engine understands SQL statements. */
  readonly sql: boolean
  /**
   * Run one statement.
   *
   * @param sql - the statement, in the connection's dialect.
   * @param params - bound parameters, when the dialect supports them.
   * @returns the outcome.
   */
  query(sql: string, params?: readonly unknown[]): Promise<QueryOutcome>
  /** List the databases this connection can see. */
  listDatabases(): Promise<string[]>
  /**
   * Address a different database for the statements that follow.
   *
   * The panel has a database picker above the editor, and a statement has to
   * land in the database the user picked. SQL engines reach that one with a
   * qualified name, but MongoDB addresses a database through the client handle,
   * so the driver is told instead. A driver that cannot switch keeps its own
   * default, which is why the method is optional.
   *
   * @param database - the database the panel selected.
   */
  selectDatabase?(database: string): void
  /** List the tables of one database. */
  listTables(database?: string): Promise<TableInfo[]>
  /** List the columns of one table. */
  describeTable(name: string): Promise<ColumnInfo[]>
  /** Release the connection. */
  close(): Promise<void>
}

/** One engine's driver, as the registry hands it out. */
export interface Driver {
  /** The engine key, e.g. `postgres`. */
  readonly kind: string
  /** Human label, e.g. `PostgreSQL`. */
  readonly label: string
  /** Statement language name shown in the editor. */
  readonly dialect: string
  /** Whether the engine understands SQL. */
  readonly sql: boolean
  /** Port used when the connection does not name one. */
  readonly defaultPort: number
  /** Whether `host` addresses a file path rather than a host name. */
  readonly file: boolean
  /**
   * The npm package this driver needs, or null when it needs none.
   *
   * The registry reports an engine as unavailable when its package does not
   * resolve, so a checkout without the optional install still loads.
   */
  readonly package: string | null
  /** Connect to one database. */
  connect(spec: ConnectSpec): Promise<DriverConnection>
}

/**
 * A driver failed for a reason the panel should show verbatim.
 *
 * The message is what the user fixes (a wrong password, a refused port, a
 * missing file), so it is carried through the HTTP layer unchanged.
 */
export class DriverError extends Error {
  /** The engine that raised the failure. */
  readonly kind: string

  /**
   * @param kind - the engine key.
   * @param message - the reason, in one sentence.
   */
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'DriverError'
    this.kind = kind
  }
}

/**
 * Build the outcome of a statement that returned no result set.
 *
 * @param kind - the engine key.
 * @param affectedRows - rows the statement changed, when it reported them.
 * @param text - the raw answer, when the engine produced one.
 * @returns the outcome.
 */
export function statementOutcome(
  kind: string,
  affectedRows: number | null = null,
  text = '',
): QueryOutcome {
  return {
    columns: [],
    rows: [],
    rowCount: affectedRows ?? 0,
    affectedRows,
    truncated: false,
    resultId: null,
    messages: [],
    text: text.length > 0 ? text : `${kind}: statement executed`,
  }
}

/**
 * Build the outcome of a statement that returned rows.
 *
 * @param kind - the engine key.
 * @param columns - the column headers.
 * @param rows - the row cells.
 * @param truncated - whether the page was capped.
 * @param messages - engine notes.
 * @param text - the raw answer.
 * @returns the outcome.
 */
export function rowsOutcome(
  kind: string,
  columns: readonly string[],
  rows: readonly (readonly Cell[])[],
  truncated = false,
  messages: readonly string[] = [],
  text = '',
): QueryOutcome {
  return {
    columns: [...columns],
    rows: rows.map(row => [...row]),
    rowCount: rows.length,
    affectedRows: null,
    truncated,
    resultId: null,
    messages: [...messages],
    text: text.length > 0 ? text : `${kind}: ${rows.length} row(s)`,
  }
}

/** Render a result page as a markdown table, the way DBX does. */
export function renderTable(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  if (columns.length === 0) return ''
  const lines: string[] = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows) {
    lines.push(`| ${row.map(cell => formatCell(cell)).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** Render one cell for the markdown table. */
export function formatCell(cell: Cell): string {
  if (cell === null) return 'NULL'
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  return String(cell)
}

/** Normalise any driver value into a cell. */
/**
 * Turn any failure into a driver error of the engine's own kind.
 *
 * A missing package, a refused login and a rejected statement all have to reach
 * the panel as "this engine failed", so nothing the connection throws can
 * escape as an anonymous module error.
 *
 * @param kind - the engine the failure belongs to.
 * @param error - what was thrown.
 * @returns the error to throw.
 */
export function asDriverError(kind: string, error: unknown): DriverError {
  return error instanceof DriverError ? error : new DriverError(kind, errorText(error))
}

/**
 * Reach a driver package, reporting a missing one as this engine's failure.
 *
 * @param kind - the engine the package serves.
 * @param load - how to load the package.
 * @returns whatever the loader returned.
 */
export function loadModuleOr<T>(kind: string, load: () => T): T {
  try {
    return load()
  } catch (error) {
    throw asDriverError(kind, error)
  }
}

/**
 * Copy a row with lower-cased keys.
 *
 * Oracle and DM answer object-mode rows keyed by the column's own case, which
 * for an unquoted alias is upper case. Reading `row.column_name` off such a row
 * silently yields undefined, so a metadata row is normalised once rather than
 * guessed at twice per column.
 *
 * @param row - the row as the client returned it.
 * @returns the same values under lower-case keys.
 */
export function lowerKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) out[key.toLowerCase()] = value
  return out
}

export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** Normalise an array of driver values into cells. */
export function toRow(values: readonly unknown[]): Cell[] {
  return values.map(value => toCell(value))
}

/** Turn an unknown thrown value into one sentence. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Stop a driver client from taking the host down with an unhandled error.
 *
 * Every socket-based client (`mysql2`, `pg`, `mongodb`, `tedious`) is an
 * `EventEmitter` that reports a refused or dropped socket as an `error` event.
 * Node turns an `error` event with no listener into a fatal exception, and
 * inside the harness a fatal exception kills the whole application rather than
 * the one panel. So a driver attaches this listener the moment the client
 * exists, even before connecting, and reports the failure through the returned
 * promise instead. The listener stays quiet: the connect or query path already
 * raises the same failure as a `DriverError`, and a background reconnect is not
 * something the user needs to hear about twice.
 *
 * @param emitter - the client or connection to protect, when it is an emitter.
 */
export function ignoreAsyncErrors(emitter: unknown): void {
  const candidate = emitter as { on?: (event: string, listener: () => void) => unknown } | null
  if (typeof candidate?.on !== 'function') return
  candidate.on('error', () => undefined)
}

/**
 * Close a client whose connect attempt failed, without masking the real error.
 *
 * A half-open client keeps its socket and reconnect timers alive, so leaving it
 * behind is what turns one refused connection into a crash a few seconds later:
 * the client retries, emits `error` again, and by then no request is waiting to
 * catch it.
 *
 * @param client - the client to close, when it exposes a close/destroy/end.
 * @returns nothing; a failure while closing is ignored.
 */
export async function closeQuietly(client: unknown): Promise<void> {
  const candidate = client as {
    close?: () => unknown
    destroy?: () => unknown
    end?: () => unknown
  } | null
  if (candidate === null || candidate === undefined) return
  for (const method of ['close', 'destroy', 'end'] as const) {
    const close = candidate[method]
    if (typeof close !== 'function') continue
    try {
      await close.call(candidate)
    } catch {
      // The connection is already gone; there is nothing left to close.
    }
    return
  }
}

/** Whether an error means the connection was refused or never opened. */
export function isConnectionError(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  return text.includes('econnrefused')
    || text.includes('enotfound')
    || text.includes('etimedout')
    || text.includes('ehostunreach')
    || text.includes('connect')
    || text.includes('timeout')
}
