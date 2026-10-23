/**
 * Reading DBX's text output.
 *
 * DBX answers in text: a markdown table for a result set, a `- name (TYPE)`
 * listing for tables, a `- name` listing for databases, and a plain sentence
 * for a statement that changed rows. Every parser here turns one of those
 * answers into the shape the panel draws, and nothing else in the plugin
 * touches the raw text.
 *
 * @module dsh-data-dbx/parse
 */

/** One connection as the panel shows it. */
export interface ParsedConnection {
  id: string
  name: string
  dbType: string
  host: string
  port: number
  database: string
  /**
   * Namespace inside the database, for engines that have one.
   *
   * DBX's connection list has no such column and its profile has no such
   * field, so a row that lives in DBX reports an empty string here; only a
   * connection this plugin stores can carry a schema.
   */
  schema: string
  groupPath: string
  note: string
}

/** One table or view as the panel shows it. */
export interface ParsedTable {
  name: string
  tableType: string
}

/** The parsed outcome of one executed statement. */
export interface ParsedQueryResult {
  /** Column headers, empty when the statement returned no rows. */
  columns: string[]
  /** Row cells, aligned with `columns`. */
  rows: string[][]
  /** Rows DBX reported for the statement. */
  rowCount: number
  /** Affected rows for a statement that returned no result set. */
  affectedRows: number | null
  /** Whether DBX truncated the page and kept the rest for continuation. */
  truncated: boolean
  /** Continuation id for `dbx_fetch_result_rows`, when the page was capped. */
  resultId: string | null
  /** Server messages DBX appended to the result. */
  messages: string[]
  /** The raw DBX output, kept for the "raw" view. */
  text: string
}

/**
 * Split one markdown table row into its cells.
 *
 * DBX escapes a literal pipe inside a cell as `\|`, so a plain `split('|')`
 * would tear such a cell apart. The scan below keeps escaped pipes inside the
 * cell they belong to.
 *
 * @param line - one table line, with or without its outer pipes.
 * @returns the trimmed cell values, with escaped pipes unescaped.
 */
export function splitMarkdownRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)

  const cells: string[] = []
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (char === '\\' && body[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/** Whether a line is the `| --- | --- |` separator of a markdown table. */
function isSeparatorRow(line: string): boolean {
  const cells = splitMarkdownRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell))
}

/**
 * Read the first markdown table out of a DBX text output.
 *
 * @param text - the raw DBX output.
 * @returns the headers and rows, or null when the output holds no table.
 */
export function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim().startsWith('|'))
  if (start < 0) return null
  if (start + 1 >= lines.length || !isSeparatorRow(lines[start + 1] as string)) return null

  const headers = splitMarkdownRow(lines[start] as string)
  const rows: string[][] = []
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim()
    if (!line.startsWith('|')) break
    const cells = splitMarkdownRow(line)
    // A short row is padded so the grid keeps its column alignment.
    while (cells.length < headers.length) cells.push('')
    rows.push(cells)
  }
  return { headers, rows }
}

/**
 * Parse a DBX query output into a shape the results grid can draw.
 *
 * @param text - the raw DBX output.
 * @returns the parsed result.
 */
export function parseQueryResult(text: string): ParsedQueryResult {
  const result: ParsedQueryResult = {
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: null,
    truncated: false,
    resultId: null,
    messages: [],
    text,
  }

  const affected = /^Query executed\. (\d+) row\(s\) affected\.$/m.exec(text)
  if (affected !== null) {
    result.affectedRows = Number(affected[1])
    result.rowCount = result.affectedRows
  }

  const table = parseMarkdownTable(text)
  if (table !== null) {
    result.columns = table.headers
    result.rows = table.rows
    result.rowCount = table.rows.length
  }

  const counted = /\n(\d+) row\(s\)(?:\n|$)/.exec(text)
  if (counted !== null && table !== null) result.rowCount = Number(counted[1])

  const truncated = /\[结果已截断[^\]]*\]\s*\nresult_id:\s*(\S+)/.exec(text)
  if (truncated !== null) {
    result.truncated = true
    result.resultId = truncated[1] as string
  } else {
    result.truncated = /\[结果已截断/.test(text)
  }

  const messageIndex = text.indexOf('\nServer messages:')
  if (messageIndex >= 0) {
    result.messages = text
      .slice(messageIndex + '\nServer messages:'.length)
      .split('\n')
      .map(line => line.replace(/^-\s*/, '').trim())
      .filter(line => line.length > 0)
  }

  return result
}

/**
 * Read DBX's connection list output.
 *
 * `dbx_list_connections` answers with a markdown table whose columns are
 * `ID | Name | Group Path | Type | Host | Port | Database | Note`. The columns
 * are matched by name so a future DBX column cannot shift the reading.
 *
 * @param text - the raw DBX output.
 * @returns the connections, in DBX's own order.
 */
export function parseConnectionList(text: string): ParsedConnection[] {
  const table = parseMarkdownTable(text)
  if (table === null) return []
  const index = (name: string): number => table.headers.findIndex(header => header.trim().toLowerCase() === name)
  const idIndex = index('id')
  const nameIndex = index('name')
  if (idIndex < 0 || nameIndex < 0) return []

  const groupIndex = index('group path')
  const typeIndex = index('type')
  const hostIndex = index('host')
  const portIndex = index('port')
  const databaseIndex = index('database')
  const schemaIndex = index('schema')
  const noteIndex = index('note')

  const connections: ParsedConnection[] = []
  for (const row of table.rows) {
    const id = (row[idIndex] ?? '').trim()
    const name = (row[nameIndex] ?? '').trim()
    if (id.length === 0 && name.length === 0) continue
    connections.push({
      id,
      name,
      dbType: typeIndex >= 0 ? (row[typeIndex] ?? '').trim() : '',
      host: hostIndex >= 0 ? (row[hostIndex] ?? '').trim() : '',
      port: portIndex >= 0 ? Number((row[portIndex] ?? '0').trim()) || 0 : 0,
      database: databaseIndex >= 0 ? (row[databaseIndex] ?? '').trim() : '',
      schema: schemaIndex >= 0 ? (row[schemaIndex] ?? '').trim() : '',
      groupPath: groupIndex >= 0 ? (row[groupIndex] ?? '').trim() : '',
      note: noteIndex >= 0 ? (row[noteIndex] ?? '').trim() : '',
    })
  }
  return connections
}

/**
 * Read DBX's `- name (TYPE)` listing of tables and views.
 *
 * @param text - the raw DBX output.
 * @returns the listed tables.
 */
export function parseTableList(text: string): ParsedTable[] {
  const tables: ParsedTable[] = []
  for (const line of text.split('\n')) {
    const match = /^-\s+(.+?)\s+\(([^)]*)\)\s*$/.exec(line.trim())
    if (match === null) continue
    tables.push({ name: match[1] as string, tableType: match[2] as string })
  }
  return tables
}

/**
 * Read DBX's `- name` listing of databases.
 *
 * @param text - the raw DBX output.
 * @returns the database names.
 */
export function parseDatabaseList(text: string): string[] {
  const databases: string[] = []
  for (const line of text.split('\n')) {
    const match = /^-\s+(.+?)\s*$/.exec(line.trim())
    if (match === null) continue
    databases.push(match[1] as string)
  }
  return databases
}
