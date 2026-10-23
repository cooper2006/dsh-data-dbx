/**
 * MongoDB driver, over the `mongodb` client.
 *
 * MongoDB is not a SQL engine, so this driver speaks a small command language
 * instead of SQL. Every statement starts with a verb, so the panel's editor
 * accepts the commands a Mongo user already types:
 *
 *     find <collection> [<filter>] [<limit>]        documents as rows
 *     findOne <collection> [<filter>]               the first matching document
 *     count <collection> [<filter>]                 one row with the count
 *     distinct <collection> <field> [<filter>]      one row per distinct value
 *     aggregate <collection> <pipeline>             documents as rows
 *     explain <collection> [<filter>]               the winning plan, one row
 *
 *     insert <collection> <document|array>          one or many documents
 *     insertMany <collection> <array>               many documents
 *     update <collection> <filter> <update> [many]  one, or every match
 *     replace <collection> <filter> <document>      one whole document
 *     delete <collection> <filter> [many]           one, or every match
 *     create <collection> [<options>]               create a collection
 *     drop <collection>                             drop a collection
 *     dropDatabase                                  drop the current database
 *     createIndex <collection> <keys> [<options>]   create an index
 *     dropIndex <collection> <name>                 drop an index
 *
 *     collections | show collections | show tables  every collection as a row
 *     databases   | show dbs | show databases      every database as a row
 *     indexes <collection>                         every index as a row
 *     stats [<collection>]                         counters as metric/value rows
 *     ping                                         one row, ok: 1
 *     use <database>                               address a database once
 *
 * A document's fields become columns. Because documents in one collection may
 * hold different fields, the driver takes the union of the page's keys and
 * fills a missing key with null, which is what a user expects to see.
 *
 * Arguments are parsed by brace balance, not by whitespace, so a filter may
 * contain spaces: `find users { "age": { "$gt": 30 } }` is one statement with
 * three arguments. Values use plain JSON; ids read back as hex, so
 * `{"_id": {"$oid": "…"}}` and `{"_id": "…"}` both match by the same hex.
 *
 * @module dsh-data-dbx/drivers/mongodb
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
import {
  DriverError,
  closeQuietly,
  errorText,
  ignoreAsyncErrors,
  renderTable,
  rowsOutcome,
  statementOutcome,
} from './types.ts'

/** Documents read when a `find` does not name a limit. */
const DEFAULT_LIMIT = 50

/** Documents sampled for the schema view. */
const SCHEMA_SAMPLE = 50

/** A cursor the driver reads into an array. */
interface MongoCursor {
  limit(n: number): MongoCursor
  toArray(): Promise<unknown[]>
}

/** The `mongodb` collection surface this driver uses. */
interface MongoCollection {
  find(filter?: Record<string, unknown>): MongoCursor
  findOne(filter?: Record<string, unknown>): Promise<unknown>
  countDocuments(filter?: Record<string, unknown>): Promise<number>
  distinct(field: string, filter?: Record<string, unknown>): Promise<unknown[]>
  aggregate(pipeline: unknown[]): MongoCursor
  insertOne(document: Record<string, unknown>): Promise<{ insertedCount?: number; insertedId?: unknown }>
  insertMany(documents: Record<string, unknown>[]): Promise<{ insertedCount?: number }>
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<MongoWriteResult>
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<MongoWriteResult>
  replaceOne(filter: Record<string, unknown>, replacement: Record<string, unknown>): Promise<MongoWriteResult>
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount?: number }>
  createIndex(keys: Record<string, unknown>, options?: Record<string, unknown>): Promise<string>
  dropIndex(name: string): Promise<unknown>
  indexes(): Promise<Record<string, unknown>[]>
  drop(): Promise<unknown>
}

/** What an update or replace reported. */
interface MongoWriteResult {
  matchedCount?: number
  modifiedCount?: number
  upsertedCount?: number
  upsertedId?: unknown
}

/** A `mongodb` database handle. */
interface MongoDatabase {
  listCollections(): { toArray(): Promise<{ name: string; type?: string }[]> }
  collection(name: string): MongoCollection
  createCollection(name: string, options?: Record<string, unknown>): Promise<unknown>
  dropDatabase(): Promise<unknown>
  command(command: Record<string, unknown>): Promise<unknown>
}

/** The `mongodb` client surface this driver uses. */
interface MongoClient {
  connect(): Promise<void>
  db(name?: string): MongoDatabase
  close(): Promise<void>
}

/** The `mongodb` module surface this driver uses. */
export interface MongoModule {
  MongoClient: new (url: string, options?: Record<string, unknown>) => MongoClient
}

/** Lazily-created `require`, so the driver package stays optional. */
const requireModule = createRequire(import.meta.url)

/** Load `mongodb`, reporting a missing package as an engine failure. */
function loadMongodb(): MongoModule {
  try {
    return requireModule('mongodb') as unknown as MongoModule
  } catch (error) {
    throw new DriverError('mongodb', `the "mongodb" package is not installed: ${errorText(error)}`)
  }
}

/** Whether a parsed token is an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * Build the connection URL from the panel's spec.
 *
 * TLS is a URI option, not a scheme: `mongodb+srv://` means "look the hosts up
 * in DNS", it forbids an explicit port, and it is not the way to ask for TLS.
 * Mapping the panel's SSL checkbox onto that scheme made every SSL connection
 * fail before it left the process, so it maps onto `tls=true` instead. A host
 * that already carries a scheme is passed through, which is how a user pastes
 * an Atlas seed string.
 *
 * @param spec - the connection as the panel stored it.
 * @returns the URL.
 * @throws DriverError when the host is empty.
 */
export function mongoUrl(spec: ConnectSpec): string {
  const raw = spec.host.trim()
  if (raw.length === 0) throw new DriverError('mongodb', 'a MongoDB connection needs a host')
  const seeded = raw.includes('://')
  const scheme = seeded ? (raw.split('://')[0] as string) : 'mongodb'
  const hosts = (seeded ? raw.slice(raw.indexOf('://') + 3) : raw)
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
  if (hosts.length === 0) throw new DriverError('mongodb', 'a MongoDB connection needs a host')
  const addresses = scheme === 'mongodb+srv'
    ? hosts.map(address => (address.includes(':') ? (address.split(':')[0] as string) : address))
    : hosts.map(address => (address.includes(':') || spec.port <= 0 ? address : `${address}:${spec.port}`))
  const credentials = spec.username.length > 0
    ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(spec.password)}@`
    : ''
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(spec.options)) {
    if (key.trim().length > 0 && value.trim().length > 0) query.set(key.trim(), value.trim())
  }
  if (spec.ssl && !query.has('tls')) query.set('tls', 'true')
  // A user created in one database cannot authenticate against another: without
  // this the driver authenticates against `admin` and reports a wrong password.
  if (spec.username.length > 0 && !query.has('authSource')) {
    query.set('authSource', spec.database.trim().length > 0 ? spec.database.trim() : 'admin')
  }
  const suffix = query.toString()
  return `${scheme}://${credentials}${addresses.join(',')}${suffix.length > 0 ? `?${suffix}` : ''}`
}

/**
 * Skip one balanced `{…}` or `[…]` argument.
 *
 * @param text - the statement.
 * @param start - index of the opening bracket.
 * @returns the index just past the closing bracket.
 * @throws DriverError when the brackets or quotes do not balance.
 */
function skipBalanced(text: string, start: number): number {
  const opening = text[start] as string
  const closing = opening === '{' ? '}' : ']'
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (quoted) {
      if (char === '\\') index += 1
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === opening) depth += 1
    else if (char === closing) {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new DriverError(
    'mongodb',
    `unbalanced JSON: the argument starting with "${opening}" never closes. Check the braces and quotes.`,
  )
}

/**
 * Split one statement into its command and its arguments.
 *
 * Arguments are split by brace balance rather than by whitespace, so a filter
 * or a pipeline may be written with spaces inside it.
 *
 * @param statement - the statement as typed.
 * @returns the verb, lowercased, and the arguments.
 */
export function splitMongoStatement(statement: string): { verb: string; args: string[] } {
  const text = statement.trim()
  let index = 0
  while (index < text.length && !/\s/.test(text[index] as string)) index += 1
  const verb = text.slice(0, index).toLowerCase()
  const args: string[] = []
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] as string)) index += 1
    if (index >= text.length) break
    const char = text[index] as string
    if (char === '{' || char === '[') {
      const start = index
      index = skipBalanced(text, index)
      args.push(text.slice(start, index))
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      const start = index + 1
      let end = start
      while (end < text.length) {
        const at = text[end] as string
        if (at === '\\') {
          end += 2
          continue
        }
        if (at === quote) break
        end += 1
      }
      if (end >= text.length) {
        throw new DriverError('mongodb', `unbalanced quotes: the argument starting with ${quote} never closes`)
      }
      args.push(text.slice(start, end))
      index = end + 1
      continue
    }
    const start = index
    while (index < text.length && !/\s/.test(text[index] as string)) index += 1
    args.push(text.slice(start, index))
  }
  return { verb, args }
}

/**
 * Parse one JSON argument, naming the command it belonged to.
 *
 * @param raw - the argument text.
 * @param verb - the command, for the error message.
 * @returns the parsed value.
 */
function parseJson(raw: string, verb: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    return JSON.parse(trimmed) as unknown
  } catch (error) {
    throw new DriverError('mongodb', `${verb}: ${errorText(error)}`)
  }
}

/** Parse an argument that must be an object. */
function parseObject(raw: string | undefined, verb: string): Record<string, unknown> {
  if (raw === undefined) return {}
  const parsed = parseJson(raw, verb)
  if (!isRecord(parsed)) throw new DriverError('mongodb', `${verb}: expected a JSON object, e.g. {"name":"value"}`)
  return parsed
}

/** The collection name of one command. */
function requireName(raw: string | undefined, verb: string): string {
  const name = (raw ?? '').trim()
  if (name.length === 0) throw new DriverError('mongodb', `${verb} needs a collection name`)
  return name
}

/**
 * A type name for the schema view.
 *
 * @param value - one sampled value.
 * @returns `string`, `objectId`, `array`, …
 */
export function mongoTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  if (Buffer.isBuffer(value)) return 'binary'
  const bsontype = (value as { _bsontype?: unknown })._bsontype
  if (typeof bsontype === 'string') {
    switch (bsontype) {
      case 'ObjectId':
        return 'objectId'
      case 'Decimal128':
      case 'Long':
      case 'Int32':
      case 'Double':
        return 'number'
      case 'Binary':
        return 'binary'
      case 'Timestamp':
        return 'timestamp'
      case 'BSONRegExp':
        return 'regex'
      case 'Code':
        return 'code'
      default:
        return bsontype.toLowerCase()
    }
  }
  return typeof value
}

/**
 * Render a nested document or array, flattening BSON wrappers.
 *
 * @param value - the value to render.
 * @returns compact JSON.
 */
function stringifyMongo(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== 'object' || item === null) return item
      const record = item as Record<string, unknown>
      const oid = record['$oid']
      if (typeof oid === 'string') return oid
      const decimal = record['$numberDecimal']
      if (typeof decimal === 'string') return decimal
      const long = record['$numberLong']
      if (typeof long === 'string') return long
      const int = record['$numberInt']
      if (typeof int === 'string') return Number(int)
      const double = record['$numberDouble']
      if (typeof double === 'string') return Number(double)
      const date = record['$date']
      if (typeof date === 'string') return date
      if (typeof record['$binary'] === 'object') return '<binary>'
      return item
    })
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Turn one BSON value into a cell.
 *
 * `toCell` (which the SQL drivers use) leans on `JSON.stringify`, and BSON ids
 * serialise to a quoted hex string while `Decimal128`, `Long` and `Binary`
 * serialise to their internal `$`-prefixed shape. Those are the values a Mongo
 * user reads most often, so they get their natural text: a bare hex id, the
 * decimal's own digits, an ISO timestamp.
 *
 * @param value - one document field.
 * @returns the cell.
 */
export function mongoCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
  const typed = value as {
    _bsontype?: unknown
    toHexString?: () => string
    high?: unknown
    pattern?: unknown
    code?: unknown
    buffer?: unknown
  }
  switch (typed._bsontype) {
    case 'ObjectId':
      return typeof typed.toHexString === 'function' ? typed.toHexString() : String(value)
    case 'Decimal128':
    case 'Long':
      return String(value)
    case 'Int32':
    case 'Double':
      return Number(value)
    case 'Binary':
      return Buffer.isBuffer(typed.buffer) ? `0x${typed.buffer.toString('hex')}` : '<binary>'
    case 'Timestamp':
      return typeof typed.high === 'number' ? new Date(typed.high * 1000).toISOString() : String(value)
    case 'BSONRegExp':
      return typeof typed.pattern === 'string' ? typed.pattern : String(value)
    case 'Code':
      return typeof typed.code === 'string' ? typed.code : String(value)
    default:
      return stringifyMongo(value)
  }
}

/** The union of the keys the page's documents hold. */
function documentColumns(documents: readonly unknown[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const document of documents) {
    if (!isRecord(document)) continue
    for (const key of Object.keys(document)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  return columns
}

/** Turn documents into rows over one column set. */
function documentRows(documents: readonly unknown[], columns: readonly string[]): Cell[][] {
  return documents.map(document => columns.map(name => mongoCell(isRecord(document) ? document[name] : null)))
}

/** Render rows of one column set as the outcome. */
function table(columns: readonly string[], rows: readonly (readonly Cell[])[], truncated = false): QueryOutcome {
  return rowsOutcome('mongodb', columns, rows, truncated, [], renderTable(columns, rows))
}

/** Render a single-cell answer, e.g. a winning plan. */
function single(title: string, value: unknown): QueryOutcome {
  const cell = mongoCell(value)
  return table([title], [[cell]])
}

/** Render metric/value rows. */
function metrics(entries: readonly (readonly [string, unknown])[]): QueryOutcome {
  const rows: Cell[][] = entries.map(([name, value]) => [name, mongoCell(value)])
  return table(['metric', 'value'], rows)
}

/** The count an insert, update or delete reported. */
function written(result: MongoWriteResult & { insertedCount?: number; deletedCount?: number }): number {
  const counts = [
    result.insertedCount,
    result.modifiedCount,
    result.matchedCount,
    result.deletedCount,
    result.upsertedCount,
  ]
  for (const count of counts) {
    if (typeof count === 'number') return count
  }
  return 0
}

/** One open MongoDB connection. */
export class MongodbConnection implements DriverConnection {
  readonly kind = 'mongodb'
  readonly dialect = 'MongoDB commands'
  readonly sql = false
  private readonly client: MongoClient
  private database: string
  private closed = false

  /**
   * @param client - the connected `mongodb` client.
   * @param database - the database the commands address, empty for the default.
   */
  constructor(client: MongoClient, database: string) {
    this.client = client
    this.database = database.trim()
  }

  /** The database the commands address. */
  private db(): MongoDatabase {
    return this.client.db(this.database.length > 0 ? this.database : undefined)
  }

  /** The database a command addresses, honouring a `use` in the same statement. */
  private dbNamed(name: string): MongoDatabase {
    const trimmed = name.trim()
    return this.client.db(trimmed.length > 0 ? trimmed : undefined)
  }

  /** @inheritdoc */
  selectDatabase(database: string): void {
    const trimmed = database.trim()
    if (trimmed.length > 0) this.database = trimmed
  }

  /** @inheritdoc */
  async query(statement: string, params?: readonly unknown[]): Promise<QueryOutcome> {
    const { verb, args } = splitMongoStatement(statement)
    if (params !== undefined && params.length > 0) {
      throw new DriverError('mongodb', `${verb}: MongoDB commands take no bound parameters; write the values in the JSON`)
    }
    if (verb.length === 0) {
      throw new DriverError('mongodb', `empty statement. Known commands: ${KNOWN_COMMANDS}`)
    }

    switch (verb) {
      case 'find': {
        const name = requireName(args[0], 'find')
        const filter = parseObject(args[1], 'find')
        const limit = this.limitOf(args[2], 'find')
        const documents = await this.db().collection(name).find(filter).limit(limit).toArray()
        const columns = documentColumns(documents)
        const rows = documentRows(documents, columns)
        return rowsOutcome('mongodb', columns, rows, limit > 0 && documents.length >= limit, [], renderTable(columns, rows))
      }
      case 'findone': {
        const name = requireName(args[0], 'findOne')
        const filter = parseObject(args[1], 'findOne')
        const document = await this.db().collection(name).findOne(filter)
        const documents = document === null || document === undefined ? [] : [document]
        const columns = documentColumns(documents)
        return table(columns, documentRows(documents, columns))
      }
      case 'count':
      case 'countdocuments': {
        const name = requireName(args[0], verb)
        const filter = parseObject(args[1], verb)
        const total = await this.db().collection(name).countDocuments(filter)
        return table(['count'], [[total]])
      }
      case 'distinct': {
        const name = requireName(args[0], 'distinct')
        const field = (args[1] ?? '').trim()
        if (field.length === 0) throw new DriverError('mongodb', 'distinct needs a field name, e.g. distinct users country')
        const filter = parseObject(args[2], 'distinct')
        const values = await this.db().collection(name).distinct(field, filter)
        return table([field], values.map(value => [mongoCell(value)]))
      }
      case 'aggregate': {
        const name = requireName(args[0], 'aggregate')
        const pipeline = parseJson(args.slice(1).join(' '), 'aggregate')
        if (!Array.isArray(pipeline)) {
          throw new DriverError('mongodb', 'aggregate needs a JSON array, e.g. aggregate users [{"$group":{"_id":"$country"}}]')
        }
        const documents = await this.db().collection(name).aggregate(pipeline).toArray()
        const columns = documentColumns(documents)
        return table(columns, documentRows(documents, columns))
      }
      case 'explain': {
        const name = requireName(args[0], 'explain')
        const filter = parseObject(args[1], 'explain')
        const answer = await this.db().command({
          explain: { find: name, filter },
          verbosity: 'executionStats',
        })
        return single('plan', answer)
      }
      case 'insert':
      case 'insertone': {
        const name = requireName(args[0], verb)
        const parsed = parseJson(args[1] ?? '', verb)
        const collection = this.db().collection(name)
        if (Array.isArray(parsed)) {
          const documents = parsed.filter(isRecord)
          if (documents.length !== parsed.length) {
            throw new DriverError('mongodb', `${verb}: every element of the array must be a JSON object`)
          }
          if (documents.length === 0) throw new DriverError('mongodb', `${verb}: no document to insert`)
          const result = await collection.insertMany(documents)
          const total = result.insertedCount ?? documents.length
          return statementOutcome('mongodb', total, `mongodb: inserted ${total} document(s) into ${name}`)
        }
        if (!isRecord(parsed)) throw new DriverError('mongodb', `${verb}: expected a JSON object, e.g. {"name":"value"}`)
        const result = await collection.insertOne(parsed)
        const total = result.insertedCount ?? 1
        const id = mongoCell(result.insertedId)
        return statementOutcome(
          'mongodb',
          total,
          `mongodb: inserted ${total} document(s) into ${name}${id === null ? '' : ` (_id: ${String(id)})`}`,
        )
      }
      case 'insertmany': {
        const name = requireName(args[0], 'insertMany')
        const parsed = parseJson(args[1] ?? '', 'insertMany')
        if (!Array.isArray(parsed)) throw new DriverError('mongodb', 'insertMany needs a JSON array of documents')
        const documents = parsed.filter(isRecord)
        if (documents.length !== parsed.length) {
          throw new DriverError('mongodb', 'insertMany: every element of the array must be a JSON object')
        }
        if (documents.length === 0) throw new DriverError('mongodb', 'insertMany: no document to insert')
        const result = await this.db().collection(name).insertMany(documents)
        const total = result.insertedCount ?? documents.length
        return statementOutcome('mongodb', total, `mongodb: inserted ${total} document(s) into ${name}`)
      }
      case 'update':
      case 'updateone':
      case 'updatemany': {
        const name = requireName(args[0], verb)
        const filter = parseObject(args[1], verb)
        const update = parseObject(args[2], verb)
        if (args[2] === undefined) {
          throw new DriverError('mongodb', `${verb} needs an update document, e.g. update ${name} {"_id":1} {"$set":{"a":1}}`)
        }
        const many = verb === 'updatemany' || (args[3] ?? '').toLowerCase() === 'many'
        const collection = this.db().collection(name)
        const result = many ? await collection.updateMany(filter, update) : await collection.updateOne(filter, update)
        const total = written(result)
        return statementOutcome(
          'mongodb',
          total,
          `mongodb: ${many ? 'updateMany' : 'updateOne'} changed ${total} document(s) in ${name}`,
        )
      }
      case 'replace':
      case 'replaceone': {
        const name = requireName(args[0], verb)
        const filter = parseObject(args[1], verb)
        if (args[2] === undefined) {
          throw new DriverError('mongodb', `${verb} needs the replacement document`)
        }
        const replacement = parseObject(args[2], verb)
        const result = await this.db().collection(name).replaceOne(filter, replacement)
        const total = written(result)
        return statementOutcome('mongodb', total, `mongodb: replaced ${total} document(s) in ${name}`)
      }
      case 'delete':
      case 'deleteone':
      case 'deletemany': {
        const name = requireName(args[0], verb)
        const filter = parseObject(args[1], verb)
        const many = verb === 'deletemany' || (args[2] ?? '').toLowerCase() === 'many'
        const collection = this.db().collection(name)
        const result = many ? await collection.deleteMany(filter) : await collection.deleteOne(filter)
        const total = result.deletedCount ?? 0
        return statementOutcome(
          'mongodb',
          total,
          `mongodb: ${many ? 'deleteMany' : 'deleteOne'} removed ${total} document(s) from ${name}`,
        )
      }
      case 'create':
      case 'createcollection': {
        const name = requireName(args[0], verb)
        const options = parseObject(args[1], verb)
        await this.db().createCollection(name, options)
        return statementOutcome('mongodb', null, `mongodb: created collection ${name}`)
      }
      case 'drop': {
        const name = requireName(args[0], 'drop')
        await this.db().collection(name).drop()
        return statementOutcome('mongodb', null, `mongodb: dropped collection ${name}`)
      }
      case 'dropdatabase': {
        await this.db().dropDatabase()
        return statementOutcome('mongodb', null, `mongodb: dropped database ${this.database.length > 0 ? this.database : 'default'}`)
      }
      case 'createindex': {
        const name = requireName(args[0], 'createIndex')
        if (args[1] === undefined) {
          throw new DriverError('mongodb', 'createIndex needs the index keys, e.g. createIndex users {"email":1}')
        }
        const keys = parseObject(args[1], 'createIndex')
        const options = parseObject(args[2], 'createIndex')
        const created = await this.db().collection(name).createIndex(keys, options)
        return statementOutcome('mongodb', null, `mongodb: created index ${created} on ${name}`)
      }
      case 'dropindex': {
        const name = requireName(args[0], 'dropIndex')
        const index = (args[1] ?? '').trim()
        if (index.length === 0) throw new DriverError('mongodb', 'dropIndex needs an index name')
        await this.db().collection(name).dropIndex(index)
        return statementOutcome('mongodb', null, `mongodb: dropped index ${index} on ${name}`)
      }
      case 'indexes':
      case 'getindexes': {
        const name = requireName(args[0], verb)
        const entries = await this.db().collection(name).indexes()
        const rows: Cell[][] = entries.map(entry => [
          mongoCell(entry['name']),
          mongoCell(entry['key']),
          entry['unique'] === true ? 'yes' : 'no',
        ])
        return table(['name', 'key', 'unique'], rows)
      }
      case 'collections':
      case 'tables': {
        const entries = await this.db().listCollections().toArray()
        const rows: Cell[][] = entries.map(entry => [entry.name, entry.type ?? 'collection'])
        return table(['name', 'type'], rows)
      }
      case 'databases': {
        return table(['database'], (await this.databaseNames()).map(name => [name]))
      }
      case 'show': {
        const what = (args[0] ?? '').trim().toLowerCase()
        if (what === 'collections' || what === 'tables') {
          const entries = await this.db().listCollections().toArray()
          return table(['name', 'type'], entries.map(entry => [entry.name, entry.type ?? 'collection']))
        }
        if (what === 'dbs' || what === 'databases') {
          return table(['database'], (await this.databaseNames()).map(name => [name]))
        }
        throw new DriverError('mongodb', `show ${what.length > 0 ? `'${what}'` : 'nothing'}: try show collections or show dbs`)
      }
      case 'stats': {
        const name = args[0]
        const answer = await this.db().command(name === undefined ? { dbStats: 1 } : { collStats: name })
        const record = isRecord(answer) ? answer : {}
        const entries: (readonly [string, unknown])[] = [
          ['database', this.database.length > 0 ? this.database : '(default)'],
          ...(name === undefined ? [] : [['collection', name] as const]),
        ]
        for (const [key, value] of Object.entries(record)) {
          if (key === 'ok' || key === 'db' || key === 'ns') continue
          entries.push([key, value])
        }
        return metrics(entries)
      }
      case 'ping': {
        const answer = await this.db().command({ ping: 1 })
        const record = isRecord(answer) ? answer : {}
        return table(['ok'], [[mongoCell(record['ok'] ?? 1)]])
      }
      case 'use': {
        const target = (args[0] ?? '').trim()
        if (target.length === 0) throw new DriverError('mongodb', 'use needs a database name')
        this.database = target
        // The panel opens one connection per statement, so this only governs the
        // statements that follow inside this one; the picker is the lasting way.
        return metrics([
          ['database', target],
          ['note', 'the panel opens one connection per statement: pick the database in the panel to keep it'],
        ])
      }
      default:
        throw new DriverError('mongodb', `unknown MongoDB command '${verb}'. Known commands: ${KNOWN_COMMANDS}`)
    }
  }

  /** Read an optional limit argument. */
  private limitOf(raw: string | undefined, verb: string): number {
    if (raw === undefined) return DEFAULT_LIMIT
    const limit = Number(raw)
    if (!Number.isFinite(limit) || limit < 0) {
      throw new DriverError('mongodb', `${verb}: "${raw}" is not a limit; give a whole number of documents, or 0 for all`)
    }
    return Math.trunc(limit)
  }

  /** The databases the server lists. */
  private async databaseNames(): Promise<string[]> {
    // `listDatabases` is an admin command: sent against the connection's own
    // database it answers "may only be run against the admin database".
    const answer = await this.client.db('admin').command({ listDatabases: 1, nameOnly: true })
    const databases = (answer as { databases?: { name: string }[] }).databases ?? []
    return databases.map(entry => entry.name)
  }

  /** @inheritdoc */
  async listDatabases(): Promise<string[]> {
    return await this.databaseNames()
  }

  /** @inheritdoc */
  async listTables(database?: string): Promise<TableInfo[]> {
    const handle = database === undefined || database.trim().length === 0 ? this.db() : this.dbNamed(database)
    const entries = await handle.listCollections().toArray()
    return entries.map(entry => ({
      name: entry.name,
      tableType: entry.type === 'view' ? 'VIEW' : 'COLLECTION',
    }))
  }

  /** @inheritdoc */
  async describeTable(name: string): Promise<ColumnInfo[]> {
    const documents = await this.db().collection(name).find({}).limit(SCHEMA_SAMPLE).toArray()
    const columns = documentColumns(documents)
    return columns.map(column => {
      const types = new Set<string>()
      let present = 0
      for (const document of documents) {
        if (!isRecord(document) || !(column in document)) continue
        present += 1
        types.add(mongoTypeName(document[column]))
      }
      const dataType = types.size === 0 ? 'unknown' : [...types].sort().join(' | ')
      return {
        name: column,
        dataType,
        nullable: present < documents.length || types.has('null'),
        defaultValue: null,
        primaryKey: column === '_id',
      }
    })
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

/** The commands the error message lists. */
const KNOWN_COMMANDS = [
  'find', 'findOne', 'count', 'distinct', 'aggregate', 'explain',
  'insert', 'insertMany', 'update', 'replace', 'delete',
  'create', 'drop', 'dropDatabase', 'createIndex', 'dropIndex',
  'collections', 'databases', 'indexes', 'stats', 'ping', 'use',
  'show collections', 'show dbs',
].join(', ')

/**
 * Create the MongoDB driver.
 *
 * @param load - how to obtain the `mongodb` module; the self-check passes a fake.
 * @returns the driver.
 */
export function createMongodbDriver(load: () => MongoModule = loadMongodb): Driver {
  return {
    kind: 'mongodb',
    label: 'MongoDB',
    dialect: 'MongoDB commands',
    sql: false,
    defaultPort: 27017,
    file: false,
    package: 'mongodb',
    async connect(spec: ConnectSpec): Promise<DriverConnection> {
      const { MongoClient } = load()
      const client = new MongoClient(mongoUrl(spec), { serverSelectionTimeoutMS: 10_000 })
      // The client runs background monitors (SDAM) that emit `error` whenever a
      // server is unreachable, before and after `connect()` settles. Unhandled,
      // that event is fatal for the whole harness, so listen before connecting
      // and close the client when the attempt fails to stop the monitors.
      ignoreAsyncErrors(client)
      try {
        await client.connect()
      } catch (error) {
        await closeQuietly(client)
        throw new DriverError('mongodb', errorText(error))
      }
      return new MongodbConnection(client, spec.database)
    },
  }
}
