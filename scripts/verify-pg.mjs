// Round-13 self-check: the PostgreSQL driver's schema handling, without a server.
//
// A schema only shows up in two places — the session setting that makes
// unqualified names resolve, and the `information_schema` queries that list and
// describe tables — and both are invisible from the panel when they are wrong:
// a missing `search_path` looks like "table does not exist", and an unscoped
// metadata query looks like "this table has twice the columns it should".
//
// So the driver takes its `pg` module as a parameter and this script hands it a
// fake that records every statement. What is covered:
//   - the connection config the panel's fields produce, including TLS and the
//     Redshift marker;
//   - `search_path` being set on every session that names a schema, and not
//     being set when the schema is empty;
//   - the table list and the column view scoped to that schema, and the
//     connection's own database name counting as "this connection's schema";
//   - the registry's answer to "does this engine have a schema level?".
//
// Usage: node scripts/verify-pg.mjs

import { createPostgresDriver } from '../lib/drivers/postgres.js'
import { defaultSchemaFor, resolveDriver, supportsSchema } from '../lib/drivers/registry.js'

const failures = []
function check(condition, label) {
  if (condition) {
    console.log('  ok  ', label)
    return
  }
  failures.push(label)
  console.log('  FAIL', label)
}

/** One recorded statement. */
const statements = []

/** The fake `pg` client: it records what the driver asks and answers canned rows. */
class FakeClient {
  constructor(config) {
    this.config = config
    this.closed = false
    this.listeners = []
  }
  on(event, listener) {
    this.listeners.push([event, listener])
    return this
  }
  async connect() {}
  async query(text, values) {
    statements.push({ text, values })
    if (text.startsWith('SELECT set_config')) {
      return { rows: [{ set_config: values?.[1] ?? '' }], fields: [{ name: 'set_config' }], rowCount: 1, command: 'SELECT' }
    }
    if (text.includes('FROM pg_database')) {
      return {
        rows: [{ datname: 'app' }, { datname: 'reporting' }],
        fields: [{ name: 'datname' }],
        rowCount: 2,
        command: 'SELECT',
      }
    }
    if (text.includes('FROM information_schema.tables')) {
      return {
        rows: [{ table_name: 'users', table_type: 'BASE TABLE' }],
        fields: [{ name: 'table_name' }, { name: 'table_type' }],
        rowCount: 1,
        command: 'SELECT',
      }
    }
    if (text.includes('FROM information_schema.columns')) {
      return {
        rows: [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, primary_key: 1 }],
        fields: [{ name: 'column_name' }],
        rowCount: 1,
        command: 'SELECT',
      }
    }
    if (text === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], fields: [{ name: '?column?' }], rowCount: 1, command: 'SELECT' }
    }
    return { rows: [], fields: [], rowCount: 0, command: 'UPDATE' }
  }
  async end() {
    this.closed = true
  }
}

/** The fake `pg` module. */
const fakeModule = {
  Client: FakeClient,
}

const driver = createPostgresDriver(() => fakeModule)

/** A spec with every field the panel can set. */
function spec(overrides = {}) {
  return {
    dbType: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'ada',
    password: 'secret',
    database: 'app',
    schema: '',
    ssl: false,
    options: {},
    ...overrides,
  }
}

console.log('the connection config')
{
  statements.length = 0
  const connection = await driver.connect(spec({ schema: 'reporting' }))
  const client = /** @type {FakeClient} */ (connection.client)
  check(client.config.host === '127.0.0.1' && client.config.port === 5432, 'the host and port reach `pg`')
  check(client.config.user === 'ada' && client.config.password === 'secret', 'the user and password reach `pg`')
  check(client.config.database === 'app', 'the database reaches `pg`')
  check(client.config.ssl === undefined, 'no TLS means no TLS option')

  statements.length = 0
  const secured = await driver.connect(spec({ ssl: true }))
  check(
    /** @type {FakeClient} */ (secured.client).config.ssl?.rejectUnauthorized === false,
    'TLS asks `pg` to accept a self-signed certificate, as the form promises',
  )
  await secured.close()

  statements.length = 0
  const redshift = await driver.connect(spec({ dbType: 'redshift' }))
  check(
    /** @type {FakeClient} */ (redshift.client).config.application_name === 'dsh-data-dbx',
    'a Redshift connection is tagged with the plugin name',
  )
  await redshift.close()

  check(client.listeners.some(([event]) => event === 'error'), 'an error listener is attached before connecting')
  await connection.close()
  check(client.closed, 'close ends the client')
}

console.log('search_path')
{
  statements.length = 0
  const connection = await driver.connect(spec({ schema: 'reporting' }))
  const setPath = statements.find(statement => statement.text.startsWith('SELECT set_config'))
  check(setPath !== undefined, 'a named schema sets search_path on the session')
  check(setPath.values[0] === 'search_path' && setPath.values[1] === 'reporting', 'search_path is set to that schema')
  check(setPath.text.includes('$1') && setPath.text.includes('$2'), 'the schema is bound, never spliced into the statement')
  await connection.close()

  statements.length = 0
  const plain = await driver.connect(spec({ schema: '' }))
  check(
    !statements.some(statement => statement.text.startsWith('SELECT set_config')),
    'an empty schema leaves the session default alone',
  )
  await plain.close()

  // A schema whose name needs quoting must still arrive intact: `set_config`
  // takes the value as text, so no identifier quoting is involved.
  statements.length = 0
  const spaced = await driver.connect(spec({ schema: 'My Schema' }))
  const spacedSet = statements.find(statement => statement.text.startsWith('SELECT set_config'))
  check(spacedSet?.values[1] === 'My Schema', 'a schema with a space reaches the server unchanged')
  await spaced.close()

  // Whitespace around the field value is the form's problem, not the server's.
  statements.length = 0
  const padded = await driver.connect(spec({ schema: '  analytics  ' }))
  const paddedSet = statements.find(statement => statement.text.startsWith('SELECT set_config'))
  check(paddedSet?.values[1] === 'analytics', 'the field value is trimmed')
  await padded.close()
}

console.log('the table list')
{
  const connection = await driver.connect(spec({ schema: 'reporting' }))

  statements.length = 0
  await connection.listTables()
  const bySchema = statements.find(statement => statement.text.includes('information_schema.tables'))
  check(bySchema.values[0] === 'reporting', 'no argument means the connection schema')
  check(bySchema.text.includes('table_schema = $1'), 'the list is scoped by schema')

  statements.length = 0
  await connection.listTables('audit')
  check(
    statements.find(statement => statement.text.includes('information_schema.tables')).values[0] === 'audit',
    'an explicit schema overrides the connection one',
  )

  // The picker above the editor lists databases, and its default value is the
  // connection's own database. Sending that name through as a schema would
  // list nothing at all, which is what the panel used to show for PostgreSQL.
  statements.length = 0
  await connection.listTables('app')
  check(
    statements.find(statement => statement.text.includes('information_schema.tables')).values[0] === 'reporting',
    "the connection's own database name means the connection schema",
  )

  statements.length = 0
  const tables = await connection.listTables()
  check(tables.length === 1 && tables[0].name === 'users', 'each row becomes a table')
  check(tables[0].tableType === 'BASE TABLE', 'the table type is carried through')

  statements.length = 0
  const bare = await driver.connect(spec({ schema: '' }))
  await bare.listTables()
  check(
    statements.find(statement => statement.text.includes('information_schema.tables')).values[0] === 'public',
    'no schema anywhere falls back to public',
  )
  await bare.close()
  await connection.close()
}

console.log('the column view')
{
  const connection = await driver.connect(spec({ schema: 'reporting' }))
  statements.length = 0
  const columns = await connection.describeTable('users')
  const statement = statements.find(entry => entry.text.includes('information_schema.columns'))
  check(statement.values[0] === 'users' && statement.values[1] === 'reporting', 'the column query is scoped to the schema')
  check(columns.length === 1 && columns[0].name === 'id', 'a column is read')
  check(columns[0].primaryKey === true, 'the primary key is detected')
  check(columns[0].nullable === false, 'a NOT NULL column is marked')
  await connection.close()
}

console.log('statements')
{
  const connection = await driver.connect(spec({ schema: 'reporting' }))
  const rows = await connection.query('SELECT 1')
  check(rows.columns.join() === '?column?', 'a result set becomes columns')
  // A cell keeps its own type until the panel turns it into text, so a number
  // arrives as a number rather than as its string form.
  check(rows.rows[0][0] === 1, 'a result set becomes rows')
  const updated = await connection.query('UPDATE users SET name = $1', ['ada'])
  check(updated.affectedRows === 0 && updated.columns.length === 0, 'a statement with no rows reports affected rows')
  const databases = await connection.listDatabases()
  check(databases.join() === 'app,reporting', 'the database list is read')
  await connection.close()
}

console.log('the registry')
{
  for (const engine of ['postgres', 'postgresql', 'pgsql', 'pg', 'redshift', 'gaussdb', 'opengauss', 'greengage']) {
    check(supportsSchema(engine), `${engine} has a schema level`)
  }
  for (const engine of ['mysql', 'mariadb', 'doris', 'clickhouse', 'sqlite', 'mongodb', 'redis', 'dm']) {
    check(!supportsSchema(engine), `${engine} has no schema level`)
  }
  // Oracle has one, but its default is the login user rather than a name the
  // form can prefill; that is why it is asserted here and not read as ''.
  check(supportsSchema('oracle'), 'oracle has a schema level')
  check(defaultSchemaFor('oracle') === '', 'oracle has no schema name to prefill')
  check(supportsSchema('PostgreSQL'), 'the engine name is matched case-insensitively')
  check(supportsSchema(' nope ') === false, 'an unknown engine has no schema level')
  check(defaultSchemaFor('postgres') === 'public', 'the default schema is public')
  check(defaultSchemaFor('mysql') === '', 'an engine without one has no default schema')

  const resolved = resolveDriver('postgres')
  check(resolved !== null && resolved.defaultPort === 5432 && resolved.sql === true, 'the registry finds the driver')
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\npostgres: the schema reaches the session, the table list and the column view')
