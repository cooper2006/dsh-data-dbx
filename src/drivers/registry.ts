/**
 * Which driver serves which engine.
 *
 * DBX names an engine with a `db_type` string (`postgres`, `mysql`, `doris`,
 * `gaussdb`, …) that is a product name, not a protocol. Several products speak
 * the same protocol: Doris, StarRocks and MySQL all speak the MySQL protocol;
 * Redshift, GaussDB and openGauss all speak the PostgreSQL protocol. This
 * registry maps every product name onto the protocol driver that speaks it, so
 * the panel offers a working connection for a name the driver never heard of.
 *
 * Two things follow from that, and both are deliberate:
 *
 * - The catalog below lists more names than there are drivers. Each family
 *   member carries its own label and default port, because a Redshift cluster
 *   listens on 5439 and an OceanBase server on 2881 even though the wire
 *   protocol is the same one MySQL speaks.
 * - A driver whose npm package does not resolve is not offered in the form, but
 *   it is still used to *resolve* a saved row. A connection that already exists
 *   must fail with "the package is not installed" rather than turn into an
 *   unknown engine the panel refuses to open.
 *
 * Engines with no driver here are reported as unsupported rather than
 * mis-served: the panel says so, and the DBX transport stays available for
 * them.
 *
 * @module dsh-data-dbx/drivers/registry
 */

import { createRequire } from 'node:module'

import type { Driver } from './types.ts'
import { createClickhouseDriver } from './clickhouse.ts'
import { createDmDriver } from './dm.ts'
import { createMongodbDriver } from './mongodb.ts'
import { createMysqlDriver } from './mysql.ts'
import { createOracleDriver } from './oracle.ts'
import { createPostgresDriver } from './postgres.ts'
import { createRedisDriver } from './redis.ts'
import { createSqliteDriver } from './sqlite.ts'
import { createSqlServerDriver } from './sqlserver.ts'

/** One engine the connection form can offer. */
export interface EngineCatalogEntry {
  /** The engine key the host matches on. */
  type: string
  /** The name the form shows. */
  label: string
  /** The port the form prefills. */
  port: number
  /** Whether the engine addresses a local file instead of a host. */
  file: boolean
  /** Whether the engine has a schema level the form can ask for. */
  schema: boolean
}

/** The engines the panel can drive itself. */
const DRIVERS: readonly Driver[] = [
  createPostgresDriver(),
  createMysqlDriver(),
  createSqlServerDriver(),
  createClickhouseDriver(),
  createSqliteDriver(),
  createMongodbDriver(),
  createRedisDriver(),
  createOracleDriver(),
  createDmDriver(),
]

/** One product that speaks a protocol another driver already speaks. */
interface FamilyMember {
  /** The product name a connection records. */
  type: string
  /** The name the form shows. */
  label: string
  /** The port that product listens on, when it has its own. */
  port: number
  /**
   * Whether the form should list it.
   *
   * A second spelling of a database that already has its own driver entry
   * (`postgresql` next to `postgres`) must resolve but must not be offered: two
   * rows in the picker for one engine is a question the form cannot answer.
   */
  hidden?: boolean
}

/**
 * Products that speak the PostgreSQL protocol.
 *
 * The first three are spellings of PostgreSQL itself; the rest are separate
 * products, several of which pick a port of their own, which is why each one
 * carries its port rather than inheriting 5432.
 */
const POSTGRES_FAMILY: readonly FamilyMember[] = [
  { type: 'postgresql', label: 'PostgreSQL', port: 5432, hidden: true },
  { type: 'pgsql', label: 'PostgreSQL', port: 5432, hidden: true },
  { type: 'redshift', label: 'Amazon Redshift', port: 5439 },
  { type: 'gaussdb', label: 'GaussDB (华为)', port: 5432 },
  { type: 'opengauss', label: 'openGauss (华为)', port: 5432 },
  { type: 'greengage', label: 'GreenGate (Greenplum)', port: 5432 },
  { type: 'kingbase', label: 'KingbaseES (人大金仓)', port: 54321 },
  { type: 'highgo', label: 'HighGo (瀚高)', port: 5866 },
  { type: 'vastbase', label: 'Vastbase (海量)', port: 5432 },
  { type: 'cockroachdb', label: 'CockroachDB', port: 26257 },
  { type: 'yugabyte', label: 'YugabyteDB (YSQL)', port: 5433 },
  { type: 'timescaledb', label: 'TimescaleDB', port: 5432 },
]

/** Products that speak the MySQL protocol. */
const MYSQL_FAMILY: readonly FamilyMember[] = [
  { type: 'mariadb', label: 'MariaDB', port: 3306 },
  { type: 'tidb', label: 'TiDB', port: 4000 },
  { type: 'oceanbase', label: 'OceanBase (蚂蚁)', port: 2881 },
  { type: 'polardb', label: 'PolarDB (阿里云)', port: 3306 },
  { type: 'greatdb', label: 'GreatDB (万里)', port: 3306 },
  { type: 'gbase8a', label: 'GBase 8a (南大通用)', port: 5258 },
  { type: 'goldendb', label: 'GoldenDB (中兴)', port: 3306 },
  { type: 'doris', label: 'Apache Doris', port: 9030 },
  { type: 'starrocks', label: 'StarRocks', port: 9030 },
]

/** Product names the drivers know by another spelling. */
const ALIASES: Readonly<Record<string, string>> = {
  postgresql: 'postgres',
  pgsql: 'postgres',
  // The connection form has always accepted `pg`, and a vault row may hold it;
  // without this entry such a row would resolve to no driver and look unusable.
  pg: 'postgres',
  mssql: 'sqlserver',
  'sql server': 'sqlserver',
  sqlsvr: 'sqlserver',
  mongo: 'mongodb',
  'mongo-db': 'mongodb',
  ch: 'clickhouse',
  sqlite3: 'sqlite',
  // 达梦 is written both ways in the wild.
  dameng: 'dm',
  dm8: 'dm',
}

/** Every engine name the registry can serve, with its driver. */
const BY_KIND = new Map<string, Driver>()
for (const driver of DRIVERS) BY_KIND.set(driver.kind, driver)

/** Ports that differ from the protocol driver's own default. */
const PORT_OVERRIDES = new Map<string, number>()
for (const member of [...POSTGRES_FAMILY, ...MYSQL_FAMILY]) {
  PORT_OVERRIDES.set(member.type, member.port)
}

/** Whether a family list names this engine. */
function inFamily(family: readonly FamilyMember[], dbType: string): boolean {
  return family.some(member => member.type === dbType)
}

/**
 * Resolve one product name onto the driver that speaks its protocol.
 *
 * @param dbType - the engine name a connection recorded.
 * @returns the driver, or null when no driver speaks this protocol.
 */
export function resolveDriver(dbType: string): Driver | null {
  const wanted = dbType.trim().toLowerCase()
  if (wanted.length === 0) return null

  const aliased = ALIASES[wanted] ?? wanted
  const direct = BY_KIND.get(aliased)
  if (direct !== undefined) return direct

  if (inFamily(POSTGRES_FAMILY, aliased)) return BY_KIND.get('postgres') ?? null
  if (inFamily(MYSQL_FAMILY, aliased)) return BY_KIND.get('mysql') ?? null

  // A driver is never loaded by importing it eagerly when its package is
  // missing: the registry holds only what `require` could resolve.
  return null
}

/** Whether the panel can connect to this engine without DBX. */
export function supportsEngine(dbType: string): boolean {
  return resolveDriver(dbType) !== null
}

/**
 * The drivers whose packages are installed.
 *
 * A driver with no package (`node:sqlite`) is always available. The ones that
 * do have a package are filtered, so the form never offers an engine whose
 * client library failed to install.
 */
export function availableDrivers(): readonly Driver[] {
  return DRIVERS.filter(driver => driver.package === null || packageAvailable(driver.package))
}

/**
 * Every engine the connection form offers: the drivers first, then the family
 * members they already speak.
 *
 * A family member is a real choice, not an alias: a user picking KingbaseES
 * wants 54321 prefilled and the label to read 人大金仓.
 *
 * @returns the catalog, in the order the form shows it.
 */
export function catalogEngines(): readonly EngineCatalogEntry[] {
  const entries: EngineCatalogEntry[] = []
  for (const driver of availableDrivers()) {
    entries.push({
      type: driver.kind,
      label: driver.label,
      port: driver.defaultPort,
      file: driver.file,
      schema: supportsSchema(driver.kind),
    })
  }
  for (const member of [...POSTGRES_FAMILY, ...MYSQL_FAMILY]) {
    if (member.hidden === true) continue
    entries.push({
      type: member.type,
      label: member.label,
      port: member.port,
      file: false,
      schema: supportsSchema(member.type),
    })
  }
  return entries
}

/**
 * The statement language a connection speaks, for the editor's label.
 *
 * @param dbType - the engine name.
 * @returns the dialect name, or null when no driver serves it.
 */
export function dialectFor(dbType: string): string | null {
  return resolveDriver(dbType)?.dialect ?? null
}

/**
 * The port a connection should default to, for the connection form.
 *
 * @param dbType - the engine name.
 * @returns the port, or 0 when the engine is file-based or unknown.
 */
export function defaultPortFor(dbType: string): number {
  const wanted = dbType.trim().toLowerCase()
  const override = PORT_OVERRIDES.get(ALIASES[wanted] ?? wanted)
  if (override !== undefined) return override
  return resolveDriver(dbType)?.defaultPort ?? 0
}

/**
 * Whether an engine has a schema level inside its database.
 *
 * The PostgreSQL family resolves unqualified names through `search_path`;
 * Oracle resolves them in the login user's schema and lets the session switch.
 * MySQL's "schema" *is* its database and a document store has no such level, so
 * the connection form must not offer the field for those engines.
 *
 * @param dbType - the engine name.
 * @returns whether a schema applies.
 */
export function supportsSchema(dbType: string): boolean {
  const driver = resolveDriver(dbType)
  if (driver === null) return false
  if (driver.kind === 'oracle') return true
  if (driver.kind === 'postgres') return true
  const wanted = ALIASES[dbType.trim().toLowerCase()] ?? dbType.trim().toLowerCase()
  return inFamily(POSTGRES_FAMILY, wanted)
}

/**
 * The schema a connection falls back to when the panel sends none.
 *
 * @param dbType - the engine name.
 * @returns the default schema, empty when the engine has none.
 */
export function defaultSchemaFor(dbType: string): string {
  if (!supportsSchema(dbType)) return ''
  // Oracle's default schema is the login user, which the driver resolves; the
  // form has nothing to prefill.
  return resolveDriver(dbType)?.kind === 'oracle' ? '' : 'public'
}

/**
 * Whether an engine addresses a file path rather than a host.
 *
 * @param dbType - the engine name.
 * @returns whether the engine is file-based.
 */
export function isFileEngine(dbType: string): boolean {
  return resolveDriver(dbType)?.file === true
}

/** Lazily-created `require`, so the registry can probe optional packages. */
const requireModule = createRequire(import.meta.url)

/**
 * Whether one npm package is installed, without importing it.
 *
 * Used to report an engine as unavailable when its driver package is missing,
 * which keeps the plugin loadable in a checkout that has not run the optional
 * dependency install.
 *
 * @param packageName - the package to look for.
 * @returns whether it resolves.
 */
export function packageAvailable(packageName: string): boolean {
  try {
    requireModule.resolve(packageName)
    return true
  } catch {
    return false
  }
}
