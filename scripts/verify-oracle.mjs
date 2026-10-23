// Round-14 self-check: the Oracle driver, without an Oracle server.
//
// Oracle is the one engine so far whose *database* and *schema* are different
// things: connecting addresses a service, while an unqualified table name
// resolves in a schema — the login user's, unless the session switches. Getting
// that split wrong is invisible in the panel: the connection succeeds, then
// every table looks missing.
//
// The driver takes its `oracledb` module as a parameter and this script hands it
// a fake that records every statement and answers canned rows. What is covered:
//   - the easy-connect string the panel's fields produce, including TLS and the
//     `serviceName` override;
//   - `ALTER SESSION SET CURRENT_SCHEMA` being issued on every session that
//     names a schema, and not being issued when the schema is empty;
//   - rows being read back in metadata order, so the header cannot drift from
//     the cells, whether the client answers objects or arrays;
//   - the 500-row page and its truncation marker;
//   - the user list standing in for the database list, and the metadata queries
//     scoping to the connection's own schema when the picker sends its service
//     name;
//   - the registry's answers for the engines this round added.
//
// Usage: node scripts/verify-oracle.mjs

import { createOracleDriver } from '../lib/drivers/oracle.js'
import { formatCell } from '../lib/drivers/types.js'
import {
  availableDrivers,
  catalogEngines,
  defaultPortFor,
  resolveDriver,
  supportsSchema,
} from '../lib/drivers/registry.js'

const failures = []
function check(condition, label) {
  if (condition) {
    console.log('  ok  ', label)
    return
  }
  failures.push(label)
  console.log('  FAIL', label)
}

/** Every statement the fake client was asked to run, in order. */
const statements = []

/** Every config the fake module was handed by `getConnection`. */
const configs = []

/** The answer the next `execute` of a non-metadata statement gives, when set. */
let nextAnswer = { rows: [], metaData: [] }

/** The fake `oracledb` connection. */
class FakeConnection {
  async execute(sql, binds, options) {
    statements.push({ sql, binds, options })
    if (sql.startsWith('ALTER SESSION')) return { rows: [], metaData: [] }
    if (sql.includes('FROM all_users')) {
      return {
        rows: [{ USERNAME: 'PANWEI' }, { USERNAME: 'SYS' }],
        metaData: [{ name: 'USERNAME' }],
      }
    }
    if (sql.includes('FROM all_tables')) {
      return {
        rows: [
          { TABLE_NAME: 'ORDERS', TABLE_TYPE: 'TABLE' },
          { TABLE_NAME: 'ORDER_VIEW', TABLE_TYPE: 'VIEW' },
        ],
        metaData: [{ name: 'TABLE_NAME' }, { name: 'TABLE_TYPE' }],
      }
    }
    if (sql.includes('FROM all_tab_columns')) {
      return {
        rows: [
          {
            COLUMN_NAME: 'ID',
            DATA_TYPE: 'NUMBER',
            NULLABLE: 'N',
            DATA_DEFAULT: null,
            PRIMARY_KEY: 1,
          },
          {
            COLUMN_NAME: 'NOTE',
            DATA_TYPE: 'VARCHAR2(50)',
            NULLABLE: 'Y',
            DATA_DEFAULT: '  0  ',
            PRIMARY_KEY: 0,
          },
        ],
        metaData: [
          { name: 'COLUMN_NAME' },
          { name: 'DATA_TYPE' },
          { name: 'NULLABLE' },
          { name: 'DATA_DEFAULT' },
          { name: 'PRIMARY_KEY' },
        ],
      }
    }
    return nextAnswer
  }

  async close() {}
}

/** The fake module, with the surface the driver reads. */
const fakeModule = {
  OUT_FORMAT_OBJECT: 4002,
  async getConnection(config) {
    configs.push(config)
    return new FakeConnection()
  },
}

/** Build the spec the panel's form would produce. */
function spec(overrides) {
  return {
    dbType: 'oracle',
    host: 'oracle.example.com',
    port: 1521,
    username: 'panwei',
    password: 'secret',
    database: 'ORCLPDB1',
    schema: '',
    ssl: false,
    options: {},
    ...overrides,
  }
}

/** Reset the recording and build a driver that loads the fake module. */
function load() {
  statements.length = 0
  configs.length = 0
  nextAnswer = { rows: [], metaData: [] }
  return createOracleDriver(() => fakeModule)
}

console.log('oracle driver')

{
  const driver = load()
  check(driver.kind === 'oracle', 'kind is oracle')
  check(driver.label === 'Oracle', 'label is Oracle')
  check(driver.dialect === 'Oracle SQL', 'dialect is Oracle SQL')
  check(driver.defaultPort === 1521, 'default port is 1521')
  check(driver.file === false, 'oracle is not a file engine')
  check(driver.package === 'oracledb', 'package is oracledb')
  check(driver.sql === true, 'oracle accepts SQL')
}

console.log('oracle connect string')

{
  const driver = load()
  await driver.connect(spec({}))
  check(configs[0]?.connectString === 'oracle.example.com:1521/ORCLPDB1', 'service becomes host:port/service')
  check(configs[0]?.user === 'panwei', 'the login user is passed through')
  check(configs[0]?.password === 'secret', 'the password is passed through')
}

{
  const driver = load()
  await driver.connect(spec({ ssl: true }))
  check(configs[0]?.connectString === 'tcps://oracle.example.com:1521/ORCLPDB1', 'TLS switches the scheme to tcps')
}

{
  const driver = load()
  await driver.connect(spec({ database: 'IGNORED', options: { serviceName: 'SALES' } }))
  check(configs[0]?.connectString === 'oracle.example.com:1521/SALES', 'serviceName overrides the database field')
}

{
  const driver = load()
  await driver.connect(spec({ database: '' }))
  check(configs[0]?.connectString === 'oracle.example.com:1521', 'no service leaves the bare address')
}

console.log('oracle session schema')

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const alter = statements.find(statement => statement.sql.startsWith('ALTER SESSION'))
  check(alter !== undefined, 'a session with a schema switches it')
  check(alter?.sql === 'ALTER SESSION SET CURRENT_SCHEMA = "HR"', 'the schema is quoted into the statement')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({}))
  const alter = statements.find(statement => statement.sql.startsWith('ALTER SESSION'))
  check(alter === undefined, 'an empty schema issues no switch')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'a"b' }))
  const alter = statements.find(statement => statement.sql.startsWith('ALTER SESSION'))
  check(alter?.sql === 'ALTER SESSION SET CURRENT_SCHEMA = "a""b"', 'a quote in the schema is doubled')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  await connection.query('SELECT 1 FROM dual')
  const queried = statements.at(-1)
  check(queried?.sql === 'SELECT 1 FROM dual', 'the statement reaches the client verbatim')
  check(queried?.options?.outFormat === 4002, 'rows are asked for as objects')
  check(queried?.options?.autoCommit === true, 'the session commits like the panel expects')
  check(queried?.options?.maxRows === 501, 'one row past the page proves truncation')
  await connection.close()
}

console.log('oracle rows')

{
  const driver = load()
  nextAnswer = {
    rows: [
      { ID: 1, NAME: 'first' },
      { ID: 2, NAME: 'second' },
    ],
    metaData: [{ name: 'ID' }, { name: 'NAME' }],
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT id, name FROM t')
  check(outcome.columns.join(',') === 'ID,NAME', 'columns come from the metadata, in order')
  check(outcome.rows.length === 2, 'both rows come back')
  check(outcome.rows[0]?.join('|') === '1|first', 'cells are read in metadata order')
  check(outcome.rowCount === 2, 'rowCount counts the rows')
  check(outcome.truncated === false, 'a small answer is not truncated')
  await connection.close()
}

{
  const driver = load()
  nextAnswer = {
    // The client may answer positional arrays too; the metadata still decides
    // the header, so the two must line up.
    rows: [[10, null]],
    metaData: [{ name: 'ID' }, { name: 'NOTE' }],
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT id, note FROM t')
  const cells = outcome.rows[0] ?? []
  check(formatCell(cells[1]) === 'NULL', 'a null cell renders as NULL')
  await connection.close()
}

{
  const driver = load()
  const many = Array.from({ length: 501 }, (_unused, index) => ({ N: index }))
  nextAnswer = { rows: many, metaData: [{ name: 'N' }] }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT n FROM big')
  check(outcome.truncated === true, 'a full page plus one reports truncation')
  check(outcome.rows.length === 500, 'only the page is kept')
  await connection.close()
}

{
  const driver = load()
  nextAnswer = { rows: [], metaData: [], rowsAffected: 7 }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query("UPDATE t SET x = 1")
  check(outcome.columns.length === 0, 'an answer with no columns is a statement')
  check(outcome.affectedRows === 7, 'the affected count is reported')
  check(outcome.rows.length === 0, 'a statement keeps no rows')
  await connection.close()
}

console.log('oracle metadata')

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const databases = await connection.listDatabases()
  check(databases.join(',') === 'PANWEI,SYS', 'the user list doubles as the schema list')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const tables = await connection.listTables()
  check(tables.length === 2, 'both tables and views are listed')
  check(tables[0]?.name === 'ORDERS', 'a table name is read back')
  check(tables[1]?.tableType === 'VIEW', 'a view keeps its type')
  const query = statements.at(-1)
  check(query?.binds?.[0] === 'HR', 'the schema scopes the table list')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  await connection.listTables('SALES')
  const query = statements.at(-1)
  check(query?.binds?.[0] === 'SALES', 'a named schema scopes the table list')
  await connection.close()
}

{
  const driver = load()
  // The picker sends the connection's own database (a service name) back; that
  // is not a schema, so the session's schema has to win.
  const connection = await driver.connect(spec({ schema: 'HR' }))
  await connection.listTables('ORCLPDB1')
  const query = statements.at(-1)
  check(query?.binds?.[0] === 'HR', 'the service name falls back to the session schema')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const columns = await connection.describeTable('ORDERS')
  check(columns.length === 2, 'both columns are described')
  check(columns[0]?.name === 'ID', 'a column name is read back')
  check(columns[0]?.primaryKey === true, 'a primary key is recognised')
  check(columns[1]?.nullable === true, 'a nullable column is recognised')
  check(columns[0]?.defaultValue === null, 'a null default stays null')
  check(columns[1]?.defaultValue === '0', 'a default is trimmed')
  const query = statements.at(-1)
  check(query?.binds?.[0] === 'HR', 'the schema scopes the column view')
  check(query?.binds?.[1] === 'ORDERS', 'the table name scopes the column view')
  await connection.close()
}

console.log('oracle failure')

{
  const brokenModule = {
    OUT_FORMAT_OBJECT: 4002,
    async getConnection() {
      throw new Error('ORA-01017: invalid username/password')
    },
  }
  const driver = createOracleDriver(() => brokenModule)
  let thrown = null
  try {
    await driver.connect(spec({}))
  } catch (error) {
    thrown = error
  }
  check(thrown !== null, 'a failed connect throws')
  check(thrown?.kind === 'oracle', 'the error names the engine')
  check(String(thrown?.message).includes('ORA-01017'), 'the server message survives')
}

{
  const driver = createOracleDriver(() => {
    throw new Error('Cannot find module \'oracledb\'')
  })
  let thrown = null
  try {
    await driver.connect(spec({}))
  } catch (error) {
    thrown = error
  }
  check(thrown?.kind === 'oracle', 'a missing package is an engine error')
  check(String(thrown?.message).includes('oracledb'), 'the message names the package')
}

console.log('registry (round 14)')

{
  check(resolveDriver('oracle')?.kind === 'oracle', 'oracle resolves to the oracle driver')
  check(resolveDriver('dm')?.kind === 'dm', 'dm resolves to the dm driver')
  check(resolveDriver('dameng')?.kind === 'dm', 'dameng is an alias for dm')
  check(resolveDriver('dm8')?.kind === 'dm', 'dm8 is an alias for dm')
  check(resolveDriver('kingbase')?.kind === 'postgres', 'KingbaseES rides the PostgreSQL driver')
  check(resolveDriver('highgo')?.kind === 'postgres', 'HighGo rides the PostgreSQL driver')
  check(resolveDriver('gbase8a')?.kind === 'mysql', 'GBase 8a rides the MySQL driver')
  check(resolveDriver('oceanbase')?.kind === 'mysql', 'OceanBase rides the MySQL driver')
  check(resolveDriver('nonsense') === null, 'an unknown engine resolves to nothing')

  check(defaultPortFor('oracle') === 1521, 'oracle defaults to 1521')
  check(defaultPortFor('dm') === 5236, 'dm defaults to 5236')
  check(defaultPortFor('dm8') === 5236, 'dm8 defaults to 5236')
  check(defaultPortFor('redshift') === 5439, 'Redshift keeps its own port')
  check(defaultPortFor('kingbase') === 54321, 'KingbaseES prefills 54321')
  check(defaultPortFor('highgo') === 5866, 'HighGo prefills 5866')
  check(defaultPortFor('gbase8a') === 5258, 'GBase 8a prefills 5258')
  check(defaultPortFor('oceanbase') === 2881, 'OceanBase prefills 2881')
  check(defaultPortFor('tidb') === 4000, 'TiDB prefills 4000')
  check(defaultPortFor('cockroachdb') === 26257, 'CockroachDB prefills 26257')
  check(defaultPortFor('yugabyte') === 5433, 'YugabyteDB prefills 5433')
  check(defaultPortFor('mysql') === 3306, 'MySQL keeps 3306')
  check(defaultPortFor('nonsense') === 0, 'an unknown engine prefills nothing')

  check(supportsSchema('oracle') === true, 'oracle has a schema level')
  check(supportsSchema('dm') === false, 'dm has no separate schema level')
  check(supportsSchema('kingbase') === true, 'KingbaseES has a schema level')
  check(supportsSchema('mariadb') === false, 'MariaDB has no schema level of its own')
  check(supportsSchema('mongodb') === false, 'a document store has no schema level')
}

{
  const catalog = catalogEngines()
  const byType = new Map(catalog.map(entry => [entry.type, entry]))
  check(catalog.length > 9, 'the catalog carries the families as well as the drivers')
  check(byType.get('oracle')?.port === 1521, 'the catalog lists oracle')
  check(byType.get('dm')?.port === 5236, 'the catalog lists dm')
  check(byType.get('kingbase')?.label.includes('金仓'), 'the KingbaseES label reads 人大金仓')
  check(byType.get('kingbase')?.schema === true, 'KingbaseES asks for a schema')
  check(byType.get('dm')?.schema === false, 'dm does not ask for a schema')
  check(byType.get('postgresql') === undefined, 'the bare PostgreSQL spelling is not offered twice')
  check(byType.get('pgsql') === undefined, 'the pgsql spelling is not offered twice')
  check(byType.get('postgres') !== undefined, 'PostgreSQL itself is offered once')
  const types = catalog.map(entry => entry.type)
  check(new Set(types).size === types.length, 'no engine appears twice')
  const fileEntries = catalog.filter(entry => entry.file).map(entry => entry.type)
  check(fileEntries.includes('sqlite'), 'file engines are marked as such')
  check(byType.get('oracle')?.file === false, 'a server engine is not a file engine')
}

{
  // Every catalog entry must be resolvable: the form offers it, so the host has
  // to be able to open it.
  const unresolvable = catalogEngines().filter(entry => resolveDriver(entry.type) === null)
  check(unresolvable.length === 0, `every catalog entry resolves (${unresolvable.map(e => e.type).join(',')})`)
  const installed = new Set(availableDrivers().map(driver => driver.kind))
  check(installed.has('oracle'), 'oracledb is installed')
  check(installed.has('dm'), 'dmdb is installed')
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
