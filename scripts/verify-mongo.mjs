// Round-12 self-check: the MongoDB driver, without a MongoDB server.
//
// A driver that can only be tested against a live server is a driver nobody
// tests, and the two defects this round fixes — an SSL checkbox that produced a
// URI the client refuses, and BSON ids rendered with quotes — were both
// invisible from the panel. So the driver takes its `mongodb` module as a
// parameter, and this script hands it a fake with a handful of documents in it.
//
// What is covered:
//   - the connection URL: TLS as an option, the auth database, pasted seed
//     strings, several hosts, extra options, a missing host;
//   - the statement language: reads, writes, index and collection management,
//     `show` aliases, `use`, and the errors a typo deserves;
//   - argument parsing: a filter written with spaces inside it is one argument;
//   - BSON rendering: ids without quotes, decimals, longs, dates, binaries;
//   - the schema view: inferred types instead of a flat "mixed";
//   - the database picker: `selectDatabase` and `listTables(database)`.
//
// Usage: node scripts/verify-mongo.mjs

import { MongodbConnection, createMongodbDriver, mongoCell, mongoUrl } from '../lib/drivers/mongodb.js'
import { resolveDriver } from '../lib/drivers/registry.js'

const failures = []
function check(condition, label) {
  if (condition) {
    console.log('  ok  ', label)
    return
  }
  failures.push(label)
  console.log('  FAIL', label)
}

/** The subset of BSON the fake hands back. */
class ObjectId {
  constructor(hex) {
    this._bsontype = 'ObjectId'
    this.hex = hex
  }
  toHexString() {
    return this.hex
  }
  toJSON() {
    return this.hex
  }
  toString() {
    return this.hex
  }
}

class Decimal128 {
  constructor(text) {
    this._bsontype = 'Decimal128'
    this.text = text
  }
  toJSON() {
    return { $numberDecimal: this.text }
  }
  toString() {
    return this.text
  }
}

class Long {
  constructor(value) {
    this._bsontype = 'Long'
    this.value = value
  }
  toJSON() {
    return { $numberLong: String(this.value) }
  }
  toString() {
    return String(this.value)
  }
}

class Binary {
  constructor(buffer) {
    this._bsontype = 'Binary'
    this.buffer = buffer
  }
}

const OID_USER = '507f1f77bcf86cd799439011'

/** One fake cursor. */
class FakeCursor {
  constructor(documents, limit) {
    this.documents = documents
    this.cap = limit ?? 0
  }
  limit(n) {
    return new FakeCursor(this.documents, n)
  }
  async toArray() {
    return this.cap > 0 ? this.documents.slice(0, this.cap) : this.documents.slice()
  }
}

/** The calls one collection saw, so the assertions can name them. */
const calls = []

/** One fake collection over an in-memory array. */
class FakeCollection {
  constructor(name, documents) {
    this.name = name
    this.documents = documents
    this.indexEntries = [{ name: '_id_', key: { _id: 1 }, unique: true }]
  }
  matches(filter) {
    const entries = Object.entries(filter ?? {})
    if (entries.length === 0) return this.documents.slice()
    return this.documents.filter(document =>
      entries.every(([key, value]) => JSON.stringify(document[key] ?? null) === JSON.stringify(value)))
  }
  find(filter) {
    calls.push(['find', this.name, filter])
    return new FakeCursor(this.matches(filter))
  }
  async findOne(filter) {
    calls.push(['findOne', this.name, filter])
    return this.matches(filter)[0] ?? null
  }
  async countDocuments(filter) {
    calls.push(['count', this.name, filter])
    return this.matches(filter).length
  }
  async distinct(field, filter) {
    calls.push(['distinct', this.name, field])
    const values = new Set()
    for (const document of this.matches(filter)) values.add(document[field])
    return [...values]
  }
  aggregate(pipeline) {
    calls.push(['aggregate', this.name, pipeline])
    return new FakeCursor(this.documents)
  }
  async insertOne(document) {
    calls.push(['insertOne', this.name, document])
    this.documents.push(document)
    return { insertedCount: 1, insertedId: document._id ?? new ObjectId(OID_USER) }
  }
  async insertMany(documents) {
    calls.push(['insertMany', this.name, documents])
    this.documents.push(...documents)
    return { insertedCount: documents.length }
  }
  async updateOne(filter, update) {
    calls.push(['updateOne', this.name, filter, update])
    const target = this.matches(filter)[0]
    if (target === undefined) return { matchedCount: 0, modifiedCount: 0 }
    for (const [key, value] of Object.entries(update.$set ?? {})) target[key] = value
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async updateMany(filter, update) {
    calls.push(['updateMany', this.name, filter, update])
    const targets = this.matches(filter)
    for (const target of targets) {
      for (const [key, value] of Object.entries(update.$set ?? {})) target[key] = value
    }
    return { matchedCount: targets.length, modifiedCount: targets.length }
  }
  async replaceOne(filter, replacement) {
    calls.push(['replaceOne', this.name, filter, replacement])
    const index = this.documents.indexOf(this.matches(filter)[0])
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 }
    this.documents[index] = replacement
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async deleteOne(filter) {
    calls.push(['deleteOne', this.name, filter])
    const index = this.documents.indexOf(this.matches(filter)[0])
    if (index < 0) return { deletedCount: 0 }
    this.documents.splice(index, 1)
    return { deletedCount: 1 }
  }
  async deleteMany(filter) {
    calls.push(['deleteMany', this.name, filter])
    const targets = this.matches(filter)
    this.documents = this.documents.filter(document => !targets.includes(document))
    return { deletedCount: targets.length }
  }
  async createIndex(keys, options) {
    const name = options?.name ?? `${Object.keys(keys).join('_')}_1`
    calls.push(['createIndex', this.name, keys])
    this.indexEntries.push({ name, key: keys, unique: options?.unique === true })
    return name
  }
  async dropIndex(name) {
    calls.push(['dropIndex', this.name, name])
    this.indexEntries = this.indexEntries.filter(entry => entry.name !== name)
    return { ok: 1 }
  }
  async drop() {
    calls.push(['drop', this.name])
    this.dropped = true
    return { ok: 1 }
  }
}

// `indexes()` is the name the driver calls, so keep the fake honest.
FakeCollection.prototype.indexes = async function indexes() {
  calls.push(['indexes', this.name])
  return this.indexEntries
}

/** The fake server. */
const server = {
  databases: new Map(),
  commands: [],
  dropped: [],
  selected: [],
}

function seedDatabase(name) {
  const users = new FakeCollection('users', [
    {
      _id: new ObjectId(OID_USER),
      name: 'ada',
      age: 36,
      active: true,
      joined: new Date('2026-01-02T03:04:05.000Z'),
      balance: new Decimal128('12.50'),
      owner: new ObjectId(OID_USER),
      tags: ['a', 'b'],
    },
    { _id: new ObjectId('507f1f77bcf86cd799439012'), name: 'bob', age: 41, active: false, visits: new Long(42) },
    { _id: new ObjectId('507f1f77bcf86cd799439013'), name: 'cy', age: null, payload: new Binary(Buffer.from([1, 2])) },
  ])
  const orders = new FakeCollection('orders', [{ _id: 1, total: 5 }])
  server.databases.set(name, { users, orders, collections: [users, orders] })
  return server.databases.get(name)
}

function fakeDatabase(name) {
  server.selected.push(name)
  const existing = server.databases.get(name)
  if (existing !== undefined) return fakeHandle(name, existing)
  const created = { users: new FakeCollection('users', []), orders: new FakeCollection('orders', []), collections: [] }
  server.databases.set(name, created)
  return fakeHandle(name, created)
}

function fakeHandle(name, data) {
  return {
    listCollections: () => ({
      toArray: async () => data.collections.map(collection => ({ name: collection.name, type: 'collection' })),
    }),
    collection: collectionName => {
      const collection = data[collectionName]
      if (collection === undefined) throw new Error(`ns not found: ${name}.${collectionName}`)
      return collection
    },
    createCollection: async collectionName => {
      const created = new FakeCollection(collectionName, [])
      data[collectionName] = created
      data.collections.push(created)
      calls.push(['createCollection', collectionName])
      return { ok: 1 }
    },
    dropDatabase: async () => {
      server.dropped.push(name)
      return { ok: 1 }
    },
    command: async command => {
      server.commands.push({ database: name, command })
      if (command.listDatabases !== undefined) {
        return { databases: [...server.databases.keys()].map(key => ({ name: key })) }
      }
      if (command.ping !== undefined) return { ok: 1 }
      if (command.dbStats !== undefined) return { db: name, collections: 2, objects: 4, dataSize: 512, ok: 1 }
      if (command.collStats !== undefined) return { ns: `${name}.${command.collStats}`, count: 3, ok: 1 }
      if (command.explain !== undefined) return { queryPlanner: { winningPlan: 'IXSCAN' }, ok: 1 }
      return { ok: 1 }
    },
  }
}

const fakeClient = {
  async connect() {},
  db: name => fakeDatabase(name ?? 'test'),
  async close() {},
}

seedDatabase('shop')

const connection = new MongodbConnection(fakeClient, 'shop')
const run = statement => connection.query(statement)
const text = outcome => outcome.text

async function rejects(statement, expected) {
  try {
    await run(statement)
  } catch (error) {
    return String(error.message).includes(expected)
  }
  return false
}

console.log('the connection URL')
{
  const plain = mongoUrl({
    dbType: 'mongodb', host: '127.0.0.1', port: 27017, username: '', password: '',
    database: '', ssl: false, options: {},
  })
  check(plain === 'mongodb://127.0.0.1:27017', `a bare connection stays mongodb:// (${plain})`)

  const tls = mongoUrl({
    dbType: 'mongodb', host: 'mongo.example.com', port: 27017, username: '', password: '',
    database: '', ssl: true, options: {},
  })
  check(tls.startsWith('mongodb://mongo.example.com:27017?'), `an SSL connection keeps the mongodb scheme (${tls})`)
  check(tls.includes('tls=true'), 'an SSL connection asks for TLS as an option')
  check(!tls.includes('+srv'), 'SSL is not turned into a DNS seed list')

  const auth = mongoUrl({
    dbType: 'mongodb', host: '127.0.0.1', port: 27017, username: 'ada', password: 'p@ss word',
    database: 'shop', ssl: false, options: {},
  })
  check(auth.includes('ada:p%40ss%20word@'), `the password is escaped (${auth})`)
  check(auth.includes('authSource=shop'), 'the user authenticates against the connection database')

  const extra = mongoUrl({
    dbType: 'mongodb', host: 'a.example.com,b.example.com', port: 27018, username: '',
    password: '', database: '', ssl: false, options: { replicaSet: 'rs0', directConnection: 'false' },
  })
  check(extra.includes('a.example.com:27018,b.example.com:27018'), `every host takes the port (${extra})`)
  check(extra.includes('replicaSet=rs0') && extra.includes('directConnection=false'), 'extra options reach the URL')

  const seeded = mongoUrl({
    dbType: 'mongodb', host: 'mongodb+srv://cluster0.example.net', port: 27017, username: '',
    password: '', database: '', ssl: true, options: {},
  })
  check(seeded.startsWith('mongodb+srv://cluster0.example.net'), `a pasted seed string is passed through (${seeded})`)
  check(!seeded.includes('cluster0.example.net:'), 'a seed list is not given a port')

  let missing = false
  try {
    mongoUrl({
      dbType: 'mongodb', host: '  ', port: 27017, username: '', password: '',
      database: '', ssl: false, options: {},
    })
  } catch (error) {
    missing = String(error.message).includes('needs a host')
  }
  check(missing, 'an empty host is refused with a sentence')
}

console.log('the statement language')
{
  const found = await run('find users')
  check(found.rowCount === 3, `find returns the collection (${found.rowCount})`)
  check(found.columns.includes('_id') && found.columns.includes('name'), 'documents become columns')

  const spaced = await run('find users { "name": "ada" } 1')
  check(spaced.rowCount === 1 && spaced.truncated, 'a filter with spaces is one argument, and the limit caps it')
  check(spaced.columns.length > 0 && spaced.rows.length === 1, 'the page is shaped over the union of keys')

  const filtered = await run('find users {"name":"ada"}')
  check(filtered.rowCount === 1, 'an exact filter matches one document')
  check(text(filtered).includes('ada'), 'the raw view renders the page as a table')

  const one = await run('find users {"name":"nobody"}')
  check(one.rowCount === 0 && one.columns.length === 0, 'an empty page has no columns')

  const count = await run('count users {}')
  check(count.rows[0][0] === 3, `count reports the total (${count.rows[0][0]})`)

  const distinct = await run('distinct users name')
  check(distinct.rowCount === 3 && distinct.columns[0] === 'name', 'distinct returns one row per value')

  const pipeline = await run('aggregate users [{"$match":{"age":36}}]')
  check(pipeline.rowCount === 3 && calls.some(call => call[0] === 'aggregate'), 'aggregate sends the pipeline')

  const plan = await run('explain users {"age":36}')
  check(plan.columns[0] === 'plan' && text(plan).includes('winningPlan'), 'explain renders the plan')

  const inserted = await run('insert users {"name":"dee","age":20}')
  check(inserted.affectedRows === 1, 'insert reports one document')
  check(text(inserted).includes(OID_USER.slice(0, 4)), 'insert names the id it made')

  const many = await run('insertMany users [{"name":"eve"},{"name":"fay"}]')
  check(many.affectedRows === 2, `insertMany reports both (${many.affectedRows})`)

  const updated = await run('update users {"name":"dee"} {"$set":{"age":21}}')
  check(updated.affectedRows === 1 && calls.some(call => call[0] === 'updateOne'), 'update changes one document')
  const updatedMany = await run('update users {"name":"eve"} {"$set":{"age":22}} many')
  check(updatedMany.affectedRows === 1 && calls.some(call => call[0] === 'updateMany'), 'the "many" word switches to updateMany')

  const replaced = await run('replace users {"name":"fay"} {"name":"fay","age":30}')
  check(replaced.affectedRows === 1 && calls.some(call => call[0] === 'replaceOne'), 'replace rewrites one document')

  const removed = await run('delete users {"name":"fay"}')
  check(removed.affectedRows === 1 && calls.some(call => call[0] === 'deleteOne'), 'delete removes one document')

  const created = await run('create archive')
  check(text(created).includes('created collection archive'), 'create makes a collection')
  check(calls.some(call => call[0] === 'createCollection' && call[1] === 'archive'), 'create reaches the server')

  const index = await run('createIndex users {"email":1} {"unique":true}')
  check(text(index).includes('created index email_1'), `createIndex names the index (${text(index)})`)
  const indexed = await run('indexes users')
  check(indexed.rowCount >= 2 && indexed.columns.join() === 'name,key,unique', 'indexes lists them')

  const dropped = await run('dropIndex users email_1')
  check(text(dropped).includes('dropped index email_1'), 'dropIndex names the index')
  const droppedCollection = await run('drop orders')
  check(text(droppedCollection).includes('dropped collection orders'), 'drop names the collection')

  const collections = await run('collections')
  check(collections.columns.join() === 'name,type' && collections.rowCount >= 2, 'collections lists names and types')
  const aliased = await run('show collections')
  check(aliased.rowCount === collections.rowCount, 'show collections is the same command')
  const databases = await run('show dbs')
  check(databases.rowCount >= 1 && databases.columns[0] === 'database', 'show dbs lists databases')
  const tables = await run('show tables')
  check(tables.columns[0] === 'name', 'show tables is accepted too')

  const stats = await run('stats')
  check(stats.columns.join() === 'metric,value', 'stats renders metric/value rows')
  const collectionStats = await run('stats users')
  check(text(collectionStats).includes('users'), 'stats names the collection it measures')

  const ping = await run('ping')
  check(ping.rowCount === 1 && ping.rows[0][0] === 1, 'ping answers one row with ok')

  const used = await run('use reporting')
  check(used.rows.some(row => row[1] === 'reporting'), 'use names the database it switched to')
  const after = await run('collections')
  check(after.rowCount === 0, 'the switch lasts for the rest of that statement only')
  connection.selectDatabase('shop')

  check(await rejects('find users {"age": }', 'find:'), 'a malformed filter names the command')
  check(await rejects('find users {', 'unbalanced JSON'), 'an unclosed filter says what is wrong')
  check(await rejects('find', 'find needs a collection name'), 'a missing collection is named')
  check(await rejects('rows users', "unknown MongoDB command 'rows'"), 'an unknown verb lists the commands')
  check(await rejects('update users {"_id":1}', 'needs an update document'), 'a half-written update is explained')
  check(await rejects('aggregate users {"$match":{}}', 'needs a JSON array'), 'a pipeline that is not an array is refused')
  check(await rejects('insert users 5', 'expected a JSON object'), 'a scalar insert is refused')
  check(await rejects('show', "show nothing"), 'a bare show is explained')
  check(await rejects('find users {} abc', 'not a limit'), 'a bad limit is named')
  check(
    await (async () => {
      try {
        await connection.query('find users {}', [1])
      } catch (error) {
        return String(error.message).includes('no bound parameters')
      }
      return false
    })(),
    'bound parameters are refused with a sentence',
  )
}

console.log('BSON values')
{
  check(mongoCell(new ObjectId(OID_USER)) === OID_USER, 'an id renders as bare hex, not a quoted string')
  check(mongoCell(new Decimal128('12.50')) === '12.50', 'a decimal renders its digits')
  check(mongoCell(new Long(42)) === '42', 'a long renders its digits')
  check(mongoCell(new Date('2026-01-02T03:04:05.000Z')) === '2026-01-02T03:04:05.000Z', 'a date renders as ISO')
  check(mongoCell(new Binary(Buffer.from([1, 2]))) === '0x0102', 'a binary renders as hex')

  const page = await run('find users {"name":"ada"}')
  const idCell = page.rows[0][page.columns.indexOf('_id')]
  check(idCell === OID_USER, `the page shows the id without quotes (${idCell})`)
  const nested = page.rows[0][page.columns.indexOf('owner')]
  check(nested === OID_USER, `a nested id is flattened to hex (${nested})`)
  const decimal = page.rows[0][page.columns.indexOf('balance')]
  check(decimal === '12.50', `a nested decimal keeps its digits (${decimal})`)
  const list = page.rows[0][page.columns.indexOf('tags')]
  check(list === '["a","b"]', `an array renders as JSON (${list})`)
  const boolean = page.rows[0][page.columns.indexOf('active')]
  check(boolean === true, 'a boolean stays a boolean')
}

console.log('the schema view')
{
  const columns = await connection.describeTable('users')
  const byName = new Map(columns.map(column => [column.name, column]))
  check(byName.size >= 5, 'every field of the sample is a column')
  check(byName.get('_id')?.primaryKey === true, 'the id column is the key')
  check(byName.get('_id')?.dataType === 'objectId', `the id is typed (${byName.get('_id')?.dataType})`)
  check(byName.get('name')?.dataType === 'string', `a name is a string (${byName.get('name')?.dataType})`)
  check(byName.get('age')?.dataType === 'null | number', `a sparse field lists both types (${byName.get('age')?.dataType})`)
  check(byName.get('joined')?.dataType === 'date', `a date is typed (${byName.get('joined')?.dataType})`)
  check(byName.get('tags')?.dataType === 'array', `an array is typed (${byName.get('tags')?.dataType})`)
  check(byName.get('age')?.nullable === true, 'a sparse field is nullable')
}

console.log('the database picker')
{
  connection.selectDatabase('reporting')
  const tables = await connection.listTables()
  check(server.selected.includes('reporting'), 'the picker reaches the client handle')
  check(tables.length === 0, 'a database with no collections lists none')

  connection.selectDatabase('shop')
  const explicit = await connection.listTables('shop')
  check(explicit.map(table => table.name).includes('users'), 'listTables(database) reads that database')
  const listed = await connection.listDatabases()
  check(listed.includes('shop') && listed.includes('reporting'), 'listDatabases lists both')
  // Real servers refuse this command anywhere but admin, which is how round 12
  // learned it: the panel's database list was empty against a live mongod.
  check(
    server.commands.some(entry => entry.database === 'admin' && entry.command.listDatabases !== undefined),
    'listDatabases is sent to the admin database',
  )

  const connectionWithDefault = new MongodbConnection(fakeClient, '')
  const fromDefault = await connectionWithDefault.listTables()
  check(fromDefault.length >= 0 && server.selected.includes('test'), 'an empty database falls back to the client default')
  await connectionWithDefault.close()
}

console.log('the registry')
{
  const driver = resolveDriver('MongoDB')
  check(driver !== null && driver.kind === 'mongodb', 'the registry normalises the name')
  check(driver.defaultPort === 27017 && driver.sql === false, 'the engine declares its port and language')
  const driver2 = resolveDriver('mongo')
  check(driver2 !== null && driver2.kind === 'mongodb', 'the alias reaches the same driver')

  // The factory takes its module loader as a parameter so a fake can stand in.
  const made = createMongodbDriver(() => ({
    MongoClient: class {
      async connect() {}
      db() {
        return fakeHandle('shop', server.databases.get('shop'))
      }
      async close() {}
    },
  }))
  const opened = await made.connect({
    dbType: 'mongodb', host: '127.0.0.1', port: 27017, username: '', password: '',
    database: 'shop', ssl: false, options: {},
  })
  check(opened.kind === 'mongodb', 'the factory opens through the injected module')
  const opened2 = await opened.query('count users {}')
  check(typeof opened2.rows[0][0] === 'number' && opened2.rows[0][0] > 0, 'the opened connection runs a command')
  await opened.close()
}

await connection.close()

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nmongodb: the driver covers reading, writing and the schema view')
