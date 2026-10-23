/**
 * Redis driver, over the `redis` client.
 *
 * Redis is not a SQL engine either, so this driver speaks a command language
 * that is Redis's own: whatever the user types is sent as a command. The verbs
 * the panel offers in its hints are the ones a user actually runs:
 *
 *     KEYS <pattern>      every key matching a glob
 *     TYPE <key>          the key's type
 *     GET <key>           a string value
 *     HGETALL <key>       a hash as rows
 *     LRANGE <key> 0 -1   a list as rows
 *     SMEMBERS <key>      a set as rows
 *     ZRANGE <key> 0 -1 WITHSCORES   a sorted set as rows
 *     INFO                 server counters
 *     DBSIZE               the key count
 *
 * A command's reply becomes the result: an array of strings becomes rows, a
 * plain string becomes one cell, and a number becomes one row with one cell.
 *
 * @module dsh-data-dbx/drivers/redis
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
import { DriverError, closeQuietly, errorText, ignoreAsyncErrors, renderTable, rowsOutcome, toCell } from './types.ts'

/** The `redis` client surface this driver uses. */
interface RedisClient {
  connect(): Promise<void>
  sendCommand(args: readonly string[]): Promise<unknown>
  quit(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** The `redis` module surface this driver uses. */
interface RedisModule {
  createClient(options: Record<string, unknown>): RedisClient
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `redis`, reporting a missing package as an engine failure. */
function loadRedis(): RedisModule {
  try {
    return requireModule('redis') as unknown as RedisModule
  } catch (error) {
    throw new DriverError('redis', `the "redis" package is not installed: ${errorText(error)}`)
  }
}

/** Build the `redis` client options from the panel's spec. */
function redisOptions(spec: ConnectSpec): Record<string, unknown> {
  const options: Record<string, unknown> = {
    socket: {
      host: spec.host,
      port: spec.port,
      // The panel's own budget: a dead Redis must not hang the editor.
      connectTimeout: 10_000,
      reconnectStrategy: false,
    },
    database: 0,
  }
  if (spec.username.length > 0) options['username'] = spec.username
  if (spec.password.length > 0) options['password'] = spec.password
  if (spec.ssl) options['socket'] = { ...(options['socket'] as Record<string, unknown>), tls: true }
  return options
}

/** Turn one Redis reply into a result page. */
function replyToOutcome(reply: unknown): QueryOutcome {
  if (Array.isArray(reply)) {
    // An array of pairs (HGETALL, ZRANGE WITHSCORES) becomes two columns;
    // a flat array of strings becomes one column.
    if (reply.length > 0 && reply.every(entry => Array.isArray(entry))) {
      const columns = ['field', 'value']
      const rows: Cell[][] = (reply as unknown[][]).map(pair => [toCell(pair[0]), toCell(pair[1])])
      return rowsOutcome('redis', columns, rows, false, [], renderTable(columns, rows))
    }
    const columns = ['value']
    const rows: Cell[][] = reply.map(entry => [toCell(entry)])
    return rowsOutcome('redis', columns, rows, false, [], renderTable(columns, rows))
  }
  if (reply === null || reply === undefined) {
    const columns = ['value']
    const rows: Cell[][] = [['(nil)']]
    return rowsOutcome('redis', columns, rows, false, [], renderTable(columns, rows))
  }
  if (typeof reply === 'number') {
    const columns = ['value']
    const rows: Cell[][] = [[reply]]
    return rowsOutcome('redis', columns, rows, false, [], renderTable(columns, rows))
  }
  // A status or bulk string: split on newlines so a multi-line answer still
  // renders as one row per line.
  const lines = String(reply).split('\n')
  const columns = ['value']
  const rows: Cell[][] = lines.map(line => [line])
  return rowsOutcome('redis', columns, rows, false, [], renderTable(columns, rows))
}

/** One open Redis connection. */
class RedisConnection implements DriverConnection {
  readonly kind = 'redis'
  readonly dialect = 'Redis commands'
  readonly sql = false
  private readonly client: RedisClient
  private closed = false

  /**
   * @param client - the connected `redis` client.
   */
  constructor(client: RedisClient) {
    this.client = client
  }

  /** @inheritdoc */
  async query(sql: string): Promise<QueryOutcome> {
    const args = sql.trim().split(/\s+/).filter(part => part.length > 0)
    if (args.length === 0) throw new DriverError('redis', 'the command is empty')
    const reply = await this.client.sendCommand(args)
    return replyToOutcome(reply)
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    // Redis numbers its databases; the count comes from the server's config.
    const answer = await this.client.sendCommand(['CONFIG', 'GET', 'databases'])
    const count = Array.isArray(answer) && typeof answer[1] === 'string' ? Number(answer[1]) : 16
    return Array.from({ length: Number.isFinite(count) ? count : 16 }, (_, index) => String(index))
  }

  /** @inheritdoc */
  async listTables(): Promise<TableInfo[]> {
    // Redis has no tables. The keys are the closest thing, so they are listed
    // as the "tables" of a Redis connection, with the key's type as its type.
    const keys = await this.client.sendCommand(['SCAN', '0', 'COUNT', '500'])
    if (!Array.isArray(keys) || keys.length < 2 || !Array.isArray(keys[1])) return []
    const tables: TableInfo[] = []
    for (const key of keys[1] as unknown[]) {
      const name = String(key)
      const type = await this.client.sendCommand(['TYPE', name])
      tables.push({ name, tableType: String(type ?? 'string') })
      if (tables.length >= 500) break
    }
    return tables
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const type = String(await this.client.sendCommand(['TYPE', name]))
    if (type === 'hash') {
      const entries = await this.client.sendCommand(['HGETALL', name])
      if (!Array.isArray(entries)) return []
      const columns: ColumnInfo[] = []
      for (let i = 0; i + 1 < entries.length; i += 2) {
        columns.push({
          name: String(entries[i]),
          dataType: 'hash field',
          nullable: true,
          defaultValue: null,
          primaryKey: false,
        })
      }
      return columns
    }
    return [{
      name,
      dataType: type,
      nullable: true,
      defaultValue: null,
      primaryKey: true,
    }]
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.client.quit()
    } catch {
      // Quitting a client that already dropped can fail harmlessly.
    }
  }
}

/**
 * Create the Redis driver.
 *
 * @returns the driver.
 */
export function createRedisDriver(): Driver {
  return {
    kind: 'redis',
    label: 'Redis',
    dialect: 'Redis commands',
    sql: false,
    defaultPort: 6379,
    file: false,
    package: 'redis',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const { createClient } = loadRedis()
      const client = createClient(redisOptions(spec))
      // The client emits errors asynchronously; one unhandled error event
      // would take the host process down, so every error is swallowed here
      // and the connection reports it on the next command instead.
      ignoreAsyncErrors(client)
      try {
        await client.connect()
      } catch (error) {
        await closeQuietly(client)
        throw new DriverError('redis', errorText(error))
      }
      return new RedisConnection(client)
    },
  }
}
