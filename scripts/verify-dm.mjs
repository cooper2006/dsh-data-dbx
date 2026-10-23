// Round-14 self-check: the 达梦 (DM8) driver, without a DM server.
//
// DM is a PostgreSQL-like engine with an Oracle-shaped catalogue. Two things
// make it worth a self-check rather than a smoke test:
//
//   - Its connection string carries no database name. A DM server holds exactly
//     one database, so the field the form calls "database" is a *schema* here,
//     applied with `SET SCHEMA` after connecting. Getting that wrong connects
//     fine and then reports every table as missing.
//   - Its client answers `metaData` in three different shapes (one object, a list
//     of objects, or a list of lists) depending on the statement, and reading the
//     wrong one loses every column name.
//
// The driver takes its `dmdb` module as a parameter and this script hands it a
// fake that records every statement. What is covered:
//   - the address the panel's fields produce;
//   - `SET SCHEMA` being issued when a schema is named, in the schema field or in
//     the database field, and not being issued when neither is;
//   - metadata in all three shapes, and rows read back in metadata order;
//   - the 500-row page and its truncation marker;
//   - the user list standing in for the database list, and the metadata queries
//     scoping to the schema the picker named;
//   - the driver failing as `dm` — not as a bare module error — when the package
//     or the server is missing.
//
// Usage: node scripts/verify-dm.mjs

import { createDmDriver } from '../lib/drivers/dm.js'
import { formatCell } from '../lib/drivers/types.js'

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

/** The answer the next non-metadata statement gives, when set. */
let nextAnswer = { rows: [], metaData: [] }

/** The fake `dmdb` connection. */
class FakeConnection {
  async execute(sql, params, options) {
    statements.push({ sql, params, options })
    if (sql.startsWith('SET SCHEMA')) return { rows: [], metaData: [] }
    if (sql.includes('FROM all_users')) {
      return {
        rows: [{ USERNAME: 'PANWEI' }, { USERNAME: 'SYSDBA' }],
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
            DATA_TYPE: 'BIGINT',
            NULLABLE: 'N',
            DATA_DEFAULT: null,
            PRIMARY_KEY: 1,
          },
          {
            COLUMN_NAME: 'NOTE',
            DATA_TYPE: 'VARCHAR(50)',
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
    dbType: 'dm',
    host: 'dm.example.com',
    port: 5236,
    username: 'SYSDBA',
    password: 'SYSDBA001',
    database: 'PANWEI',
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
  return createDmDriver(() => fakeModule)
}

console.log('dm driver')

{
  const driver = load()
  check(driver.kind === 'dm', 'kind is dm')
  check(driver.label === '达梦 DM8', 'label names 达梦 DM8')
  check(driver.dialect === 'DM SQL', 'dialect is DM SQL')
  check(driver.defaultPort === 5236, 'default port is 5236')
  check(driver.file === false, 'dm is not a file engine')
  check(driver.package === 'dmdb', 'package is dmdb')
  check(driver.sql === true, 'dm accepts SQL')
}

console.log('dm address')

{
  const driver = load()
  await driver.connect(spec({}))
  check(configs[0]?.connectString === 'dm.example.com:5236', 'the address is host:port')
  check(configs[0]?.user === 'SYSDBA', 'the login user is passed through')
  check(configs[0]?.password === 'SYSDBA001', 'the password is passed through')
  check(configs[0]?.database === undefined, 'no database is asked for')
}

{
  const driver = load()
  await driver.connect(spec({ port: 5237, host: '10.0.0.5' }))
  check(configs[0]?.connectString === '10.0.0.5:5237', 'the address follows the fields')
}

console.log('dm schema switch')

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const statement = statements.find(entry => entry.sql.startsWith('SET SCHEMA'))
  check(statement !== undefined, 'a named schema is switched to')
  check(statement?.sql === 'SET SCHEMA "HR"', 'the schema is quoted into the statement')
  await connection.close()
}

{
  // A DM server has one database, so the database field *is* the schema.
  const driver = load()
  const connection = await driver.connect(spec({ database: 'SALES' }))
  const statement = statements.find(entry => entry.sql.startsWith('SET SCHEMA'))
  check(statement?.sql === 'SET SCHEMA "SALES"', 'the database field doubles as the schema')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ database: '', schema: '' }))
  const statement = statements.find(entry => entry.sql.startsWith('SET SCHEMA'))
  check(statement === undefined, 'no schema means no switch')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'a"b' }))
  const statement = statements.find(entry => entry.sql.startsWith('SET SCHEMA'))
  check(statement?.sql === 'SET SCHEMA "a""b"', 'a quote in the schema is doubled')
  await connection.close()
}

{
  // The schema field wins over the database field when both are present.
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR', database: 'SALES' }))
  const statement = statements.find(entry => entry.sql.startsWith('SET SCHEMA'))
  check(statement?.sql === 'SET SCHEMA "HR"', 'the schema field wins over the database field')
  await connection.close()
}

console.log('dm rows')

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
  // The client keys object rows by the column's own case, which for an alias is
  // upper case; a lower-case lookup must still find the value.
  const driver = load()
  nextAnswer = {
    rows: [{ ID: 5, NOTE: null }],
    metaData: [{ name: 'ID' }, { name: 'NOTE' }],
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT id, note FROM t')
  const cells = outcome.rows[0] ?? []
  check(cells[0] === 5, 'an upper-case key is found for a lower-case column name')
  check(formatCell(cells[1]) === 'NULL', 'a null cell renders as NULL')
  await connection.close()
}

{
  // A single statement may report its columns as one metadata object rather than
  // a list; both shapes have to end up with the same header.
  const driver = load()
  nextAnswer = {
    rows: [{ A: 1 }],
    metaData: { name: 'A' },
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT 1 AS a FROM dual')
  check(outcome.columns.join(',') === 'A', 'a single metadata object still names the column')
  await connection.close()
}

{
  // A batch reports a list per statement; the first one belongs to the statement
  // the panel ran.
  const driver = load()
  nextAnswer = {
    rows: [{ A: 1 }],
    metaData: [[{ name: 'A' }, { name: 'B' }]],
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT 1 AS a, 2 AS b FROM dual')
  check(outcome.columns.join(',') === 'A,B', 'a nested metadata list names both columns')
  const shortCells = outcome.rows[0] ?? []
  check(shortCells.length === 2, 'a short row pads to the header')
  check(formatCell(shortCells[1]) === 'NULL', 'a padded cell is null')
  await connection.close()
}

{
  const driver = load()
  nextAnswer = {
    // Positional answers carry no keys at all.
    rows: [[10, 'x']],
    metaData: [{ name: 'ID' }, { name: 'NAME' }],
  }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('SELECT id, name FROM t')
  check(outcome.rows[0]?.join('|') === '10|x', 'a positional row lines up with the header')
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
  nextAnswer = { rows: [], metaData: [], rowsAffected: 3 }
  const connection = await driver.connect(spec({}))
  const outcome = await connection.query('DELETE FROM t')
  check(outcome.columns.length === 0, 'an answer with no columns is a statement')
  check(outcome.affectedRows === 3, 'the affected count is reported')
  await connection.close()
}

console.log('dm metadata')

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  const databases = await connection.listDatabases()
  check(databases.join(',') === 'PANWEI,SYSDBA', 'the user list doubles as the schema list')
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
  check(query?.params?.[0] === 'HR', 'the schema scopes the table list')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ schema: 'HR' }))
  await connection.listTables('SALES')
  const query = statements.at(-1)
  check(query?.params?.[0] === 'SALES', 'a named schema scopes the table list')
  await connection.close()
}

{
  const driver = load()
  const connection = await driver.connect(spec({ database: 'PANWEI' }))
  const columns = await connection.describeTable('ORDERS')
  check(columns.length === 2, 'both columns are described')
  check(columns[0]?.name === 'ID', 'a column name is read back')
  check(columns[0]?.primaryKey === true, 'a primary key is recognised')
  check(columns[1]?.nullable === true, 'a nullable column is recognised')
  check(columns[0]?.defaultValue === null, 'a null default stays null')
  check(columns[1]?.defaultValue === '0', 'a default is trimmed')
  const query = statements.at(-1)
  check(query?.params?.[0] === 'PANWEI', 'the schema scopes the column view')
  check(query?.params?.[1] === 'ORDERS', 'the table name scopes the column view')
  await connection.close()
}

console.log('dm failure')

{
  const brokenModule = {
    OUT_FORMAT_OBJECT: 4002,
    async getConnection() {
      throw new Error('用户名或密码错误')
    },
  }
  const driver = createDmDriver(() => brokenModule)
  let thrown = null
  try {
    await driver.connect(spec({}))
  } catch (error) {
    thrown = error
  }
  check(thrown !== null, 'a failed connect throws')
  check(thrown?.kind === 'dm', 'the error names the engine')
  check(String(thrown?.message).includes('用户名或密码错误'), 'the server message survives')
}

{
  const driver = createDmDriver(() => {
    throw new Error("Cannot find module 'dmdb'")
  })
  let thrown = null
  try {
    await driver.connect(spec({}))
  } catch (error) {
    thrown = error
  }
  check(thrown?.kind === 'dm', 'a missing package is an engine error')
  check(String(thrown?.message).includes('dmdb'), 'the message names the package')
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
