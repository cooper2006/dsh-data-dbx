/**
 * The bundle body.
 *
 * Everything lives inside one function so the bundle declares no global
 * binding: the harness loads client bundles as plain scripts, and two
 * bundles that declare the same top-level name would break each other.
 */
;(function dbxClientBundle(): void {
  /**
   * The browser half of the DBX panel.
   *
   * The panel is a small database workbench inside the harness: a sidebar with
   * the configured DBX connections, a SQL editor, and a results grid. Every
   * action travels to the host over the harness connection service
   * (`/api/dbx/*`), and the host answers by calling DBX's own MCP tools — this
   * half never talks to a database and never sees a secret it did not type.
   *
   * The bundle is loaded by the harness module loader, so it registers itself
   * through `window.__ModuleLoader__` and keeps `react` external: the shell
   * already provides it.
   *
   * @module dsh-data-dbx/client
   */

  /** One connection as the panel shows it. */
  interface PanelConnection {
    id: string
    name: string
    dbType: string
    host: string
    port: number
    database: string
    /** Namespace inside the database; only a self-built row carries one. */
    schema: string
    groupPath: string
    note: string
    /** `vault` when the plugin owns the row, `dbx` when DBX does. */
    source: 'vault' | 'dbx'
    /** Whether this plugin may edit or remove the row. */
    managed: boolean
    /** The SQL dialect the connection speaks, when a driver names one. */
    dialect: string | null
    /** Whether the row was copied out of DBX and may still need a password. */
    imported: boolean
    /** Whether the connection asks for TLS; only the vault knows its own. */
    ssl?: boolean | undefined
  }

  /** One column of one table, as the structure view shows it. */
  interface PanelColumn {
    name: string
    dataType: string
    nullable: boolean
    defaultValue: string | null
    primaryKey: boolean
  }

  /** One table or view as the panel shows it. */
  interface PanelTable {
    name: string
    tableType: string
  }

  /** The parsed outcome of one executed statement. */
  interface PanelResult {
    columns: string[]
    rows: string[][]
    rowCount: number
    affectedRows: number | null
    truncated: boolean
    resultId: string | null
    messages: string[]
    text: string
  }

  /** What the DBX transport the host reached can do. */
  interface PanelCapabilities {
    list: boolean
    add: boolean
    remove: boolean
    query: boolean
    tables: boolean
    databases: boolean
  }

  /** Which route the host answered from, and what it supports. */
  interface PanelStatus {
    mode: 'native' | 'desktop-mcp' | 'stdio-mcp' | 'bridge' | 'catalog' | 'none'
    source: string
    capabilities: PanelCapabilities
    /** Engines the plugin opens with its own driver stack. */
    engines: string[]
    /** The same engines with the label and port the form needs. */
    engineCatalog?: EngineOption[] | undefined
    /** Connections the plugin itself stores. */
    vaultCount: number
  }

  /** The engines the new-connection form offers. */
  interface EngineOption {
    type: string
    label: string
    port: number
    /** Whether the engine addresses a local file instead of a host. */
    file: boolean
    /** Whether the engine has a schema level the form should ask for. */
    schema: boolean
  }

  /** Engines whose name the panel accepts as another engine's spelling. */
  const ENGINE_ALIASES: Record<string, string> = {
    postgresql: 'postgres',
    pg: 'postgres',
    pgsql: 'postgres',
    postgres: 'postgres',
    mssql: 'sqlserver',
    sqlsvr: 'sqlserver',
    sqlserver: 'sqlserver',
    mongo: 'mongodb',
    mongodb: 'mongodb',
    sqlite3: 'sqlite',
    sqlite: 'sqlite',
    mariadb: 'mysql',
    mysql: 'mysql',
    ch: 'clickhouse',
    clickhouse: 'clickhouse',
    redis: 'redis',
  }

  /**
   * Reduce a database type to the key the engine list matches on.
   *
   * DBX reports a connection's type its own way (`MongoDB`, `mongo`,
   * `PostgreSQL`), so comparing raw strings both misses rows and — worse —
   * falls through to the first engine in the list, which silently turned a
   * MongoDB connection into a MySQL one on its first edit.
   *
   * @param dbType - the stored or reported database type.
   * @returns the canonical key.
   */
  function engineKey(dbType: string): string {
    const bare = dbType.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    return ENGINE_ALIASES[bare] ?? bare
  }

  /**
   * The engines the form offers: what the host can open on its own first, then
   * the rest, which the form hands to DBX.
   *
   * @param catalog - the host's own engines, when the status reported them.
   * @returns the option list, without duplicates.
   */
  function engineOptions(catalog: readonly EngineOption[]): EngineOption[] {
    const options: EngineOption[] = []
    const seen = new Set<string>()
    for (const item of [...catalog, ...ENGINES]) {
      const key = engineKey(item.type)
      if (seen.has(key)) continue
      seen.add(key)
      options.push(item)
    }
    return options
  }

  const ENGINES: EngineOption[] = [
    { type: 'mysql', label: 'MySQL', port: 3306, file: false, schema: false },
    { type: 'postgres', label: 'PostgreSQL', port: 5432, file: false, schema: true },
    { type: 'sqlite', label: 'SQLite (file)', port: 0, file: true, schema: false },
    { type: 'duckdb', label: 'DuckDB (file)', port: 0, file: true, schema: false },
    { type: 'clickhouse', label: 'ClickHouse', port: 8123, file: false, schema: false },
    { type: 'sqlserver', label: 'SQL Server', port: 1433, file: false, schema: false },
    { type: 'oracle', label: 'Oracle', port: 1521, file: false, schema: false },
    { type: 'redshift', label: 'Amazon Redshift', port: 5439, file: false, schema: true },
    { type: 'doris', label: 'Apache Doris', port: 9030, file: false, schema: false },
    { type: 'starrocks', label: 'StarRocks', port: 9030, file: false, schema: false },
    { type: 'gaussdb', label: 'GaussDB', port: 5432, file: false, schema: true },
    { type: 'opengauss', label: 'openGauss', port: 5432, file: false, schema: true },
    { type: 'rqlite', label: 'RQLite', port: 4001, file: false, schema: false },
    { type: 'h2', label: 'H2', port: 9092, file: false, schema: false },
  ]

  /** The panel's locale namespace. */
  const LOCALE_NS = 'dataDbx.panel'

  /** The panel id: the sidebar entry and the main panel share it. */
  const PANEL_ID = 'dsh-data-dbx'

  /** The English dictionary. */
  const EN: Record<string, string> = {
    panel: 'Databases',
    connections: 'Connections',
    newConnection: 'New connection',
    noConnections: 'No connections yet.',
    remove: 'Remove',
    test: 'Test',
    run: 'Run',
    running: 'Running…',
    editorPlaceholder: 'SELECT * FROM …',
    editorPlaceholderMongo: 'find orders { "total": { "$gt": 100 } } 20',
    tables: 'Tables',
    refresh: 'Refresh',
    rows: 'rows',
    affected: 'rows affected',
    emptyResult: 'Run a statement to see results.',
    name: 'Name',
    engine: 'Engine',
    host: 'Host',
    port: 'Port',
    username: 'User',
    password: 'Password',
    database: 'Database',
    schema: 'Schema',
    schemaHint: 'Unqualified table names resolve here. Leave it empty for the server default (public).',
    ssl: 'SSL',
    create: 'Create',
    cancel: 'Cancel',
    filePath: 'File path',
    connectedTo: 'Connected to',
    transport: 'Transport',
    transportDesktopMcp: 'DBX desktop MCP server',
    transportStdioMcp: 'dbx-mcp',
    transportBridge: 'DBX desktop bridge',
    transportCatalog: 'DBX catalog only',
    transportNone: 'No DBX transport',
    readOnlyNotice: 'This transport cannot create connections. Enable the DBX desktop MCP server in DBX settings.',
    noQueryNotice: 'Running SQL needs a live DBX. Start the DBX desktop app, or enable its MCP server.',
    transportNative: 'Self-built drivers',
    sourceVault: 'self-built',
    sourceDbx: 'DBX',
    importDbx: 'Import DBX connections',
    edit: 'Edit',
    save: 'Save',
    close: 'Close',
    structure: 'Structure',
    columns: 'Column',
    dataType: 'Type',
    nullable: 'Nullable',
    defaultValue: 'Default',
    primaryKey: 'Key',
    exportCsv: 'Export CSV',
    importedNotice: 'imported from DBX, may still need a password',
    selfBuiltHint: 'This engine is opened by the plugin\u2019s own driver stack and stored in its encrypted vault.',
    dbxHint: 'The plugin has no driver for this engine; the connection is stored in DBX.',
  }

  /** The Chinese dictionary. */
  const ZH: Record<string, string> = {
    panel: '数据库',
    connections: '连接',
    newConnection: '新建连接',
    noConnections: '还没有连接。',
    remove: '删除',
    test: '测试',
    run: '执行',
    running: '执行中…',
    editorPlaceholder: 'SELECT * FROM …',
    editorPlaceholderMongo: 'find orders { "total": { "$gt": 100 } } 20',
    tables: '表',
    refresh: '刷新',
    rows: '行',
    affected: '行受影响',
    emptyResult: '执行语句后在此显示结果。',
    name: '名称',
    engine: '类型',
    host: '主机',
    port: '端口',
    username: '用户名',
    password: '密码',
    database: '数据库',
    schema: 'Schema（模式）',
    schemaHint: '不限定的表名在这个命名空间里查找；留空则用服务器默认（public）。',
    ssl: 'SSL',
    create: '创建',
    cancel: '取消',
    filePath: '文件路径',
    connectedTo: '当前连接',
    transport: '通道',
    transportDesktopMcp: 'DBX 桌面 MCP 服务',
    transportStdioMcp: 'dbx-mcp',
    transportBridge: 'DBX 桌面桥接',
    transportCatalog: '仅 DBX 配置目录',
    transportNone: '无可用 DBX 通道',
    readOnlyNotice: '当前通道无法新建连接。请在 DBX 设置中启用“桌面 MCP 服务”。',
    noQueryNotice: '执行 SQL 需要运行中的 DBX。请启动 DBX 桌面应用，或启用其 MCP 服务。',
    transportNative: '自建驱动',
    sourceVault: '自建',
    sourceDbx: 'DBX',
    importDbx: '导入 DBX 连接',
    edit: '编辑',
    save: '保存',
    close: '关闭',
    structure: '表结构',
    columns: '列',
    dataType: '类型',
    nullable: '可空',
    defaultValue: '默认值',
    primaryKey: '键',
    exportCsv: '导出 CSV',
    importedNotice: '从 DBX 导入，可能仍需填写密码',
    selfBuiltHint: '此引擎由插件自带驱动栈直连，连接保存在插件自己的加密仓库中。',
    dbxHint: '插件没有此引擎的驱动，连接会保存到 DBX。',
  }

  /** The style sheet the panel injects into the page. */
  const STYLE = `
  .dbx-root {
    display: flex;
    height: 100%;
    min-height: 0;
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font-family: var(--dsh-font-family-text, system-ui, sans-serif);
    font-size: 13px;
  }
  .dbx-side {
    width: 248px;
    flex: 0 0 248px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-layer-1);
    min-height: 0;
  }
  .dbx-side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    font-weight: 600;
    border-bottom: 1px solid var(--dsw-alias-border-l2);
  }
  .dbx-side-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 6px;
    margin: 0;
    list-style: none;
  }
  .dbx-conn {
    display: block;
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    padding: 7px 9px;
    cursor: pointer;
  }
  .dbx-conn:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dbx-conn[data-active="true"] {
    background: var(--dsw-alias-button-ghost-active-fill);
    border-color: var(--dsw-alias-border-l3);
  }
  .dbx-conn-name { display: flex; align-items: center; gap: 6px; font-weight: 500; }
  .dbx-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--dsw-alias-brand-primary);
    color: var(--dsw-alias-label-primary-inverted);
  }
  .dbx-conn-sub {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    color: var(--dsw-alias-label-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dbx-side-foot {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--dsw-alias-border-l2);
  }
  .dbx-side-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .dbx-transport { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .dbx-transport-label { color: var(--dsw-alias-label-secondary); }
  .dbx-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); line-height: 1.4; }
  .dbx-main { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .dbx-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--dsw-alias-border-l2);
    flex-wrap: wrap;
  }
  .dbx-select, .dbx-input {
    background: var(--dsw-alias-bg-layer-2);
    color: inherit;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 6px;
    padding: 5px 8px;
    font: inherit;
    min-width: 0;
  }
  .dbx-select:focus, .dbx-input:focus { outline: 1px solid var(--dsw-alias-brand-primary); }
  .dbx-btn {
    background: var(--dsw-alias-button-elevated-fill);
    color: inherit;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 6px;
    padding: 5px 10px;
    font: inherit;
    cursor: pointer;
  }
  .dbx-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .dbx-btn:disabled { opacity: 0.5; cursor: default; }
  .dbx-btn-primary {
    background: var(--dsw-alias-button-primary-fill);
    border-color: transparent;
    color: var(--dsw-alias-label-primary-inverted);
  }
  .dbx-btn-primary:hover { background: var(--dsw-alias-button-primary-hover); }
  .dbx-editor {
    flex: 0 0 220px;
    width: 100%;
    resize: vertical;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
    font-family: var(--dsh-font-family-code, ui-monospace, monospace);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .dbx-editor:focus { outline: none; }
  .dbx-status {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--dsw-alias-label-secondary);
    border-bottom: 1px solid var(--dsw-alias-border-l2);
    min-height: 26px;
  }
  .dbx-status[data-kind="error"] { color: var(--dsw-alias-state-error-primary); }
  .dbx-status[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
  .dbx-results { flex: 1 1 auto; overflow: auto; min-height: 0; }
  .dbx-grid { border-collapse: collapse; width: 100%; font-family: var(--dsh-font-family-code, ui-monospace, monospace); font-size: 12px; }
  .dbx-grid th, .dbx-grid td {
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    border-right: 1px solid var(--dsw-alias-border-l1);
    padding: 4px 9px;
    text-align: left;
    white-space: pre;
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dbx-grid th {
    position: sticky;
    top: 0;
    background: var(--dsw-alias-bg-layer-2);
    font-weight: 600;
    z-index: 1;
  }
  .dbx-grid td[data-null="true"] { color: var(--dsw-alias-label-tertiary); font-style: italic; }
  .dbx-row-index { color: var(--dsw-alias-label-tertiary); text-align: right; user-select: none; }
  .dbx-tables {
    border-top: 1px solid var(--dsw-alias-border-l2);
    max-height: 168px;
    overflow: auto;
    padding: 6px 8px;
  }
  .dbx-tables-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
  .dbx-table-chip {
    display: inline-block;
    margin: 2px 4px 2px 0;
    padding: 2px 7px;
    border-radius: 10px;
    border: 1px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-layer-2);
    cursor: pointer;
    font-family: var(--dsh-font-family-code, ui-monospace, monospace);
    font-size: 11.5px;
  }
  .dbx-table-chip:hover { border-color: var(--dsw-alias-brand-primary); }
  .dbx-table-row { display: inline-flex; align-items: center; gap: 2px; }
  .dbx-table-structure {
    font-size: 10px; padding: 1px 5px; border-radius: 4px; cursor: pointer;
    color: var(--dsw-alias-label-primary); background: transparent;
    border: 1px solid var(--dsw-alias-border-l2);
  }
  .dbx-table-structure:hover { border-color: var(--dsw-alias-brand-primary); }
  .dbx-structure {
    padding: 6px 12px; border-top: 1px solid var(--dsw-alias-border-l2);
    overflow: auto; max-height: 32%;
  }
  .dbx-structure-title {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dsw-alias-label-secondary); margin-bottom: 4px;
  }
  .dbx-structure table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .dbx-structure th, .dbx-structure td {
    text-align: left; padding: 3px 8px;
    border-bottom: 1px solid var(--dsw-alias-border-l2);
  }
  .dbx-structure th { color: var(--dsw-alias-label-secondary); font-weight: 500; }
  .dbx-pk { color: var(--dsw-alias-state-business-primary); font-weight: 600; }
  .dbx-modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--dsw-alias-bg-mask-1);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }
  .dbx-modal {
    width: 420px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 64px);
    overflow: auto;
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l3);
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 18px 48px var(--dsw-alias-bg-mask-2);
  }
  .dbx-modal h2 { margin: 0 0 12px; font-size: 15px; }
  .dbx-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  .dbx-field label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
  .dbx-field-row { display: flex; gap: 10px; }
  .dbx-field-row .dbx-field { flex: 1 1 0; }
  .dbx-check { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .dbx-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .dbx-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin-bottom: 10px; white-space: pre-wrap; }
  `

  /**
   * Build the browser half of the plugin.
   *
   * @param require - the harness module loader's require.
   * @returns the plugin's exports: `apply` and `inject`.
   */
  function createClient(require: (id: string) => unknown): { apply: (ctx: unknown) => void; inject: string[] } {
    const React = require('react') as {
      createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
      useState: <T>(initial: T) => [T, (value: T | ((previous: T) => T)) => void]
      useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void
      useCallback: <T>(callback: T, deps?: unknown[]) => T
      useRef: <T>(initial: T) => { current: T }
      Fragment: unknown
    }
    const h = React.createElement

    /**
     * Call one host route and unwrap its JSON envelope.
     *
     * @param path - the route path, relative to the harness origin.
     * @param init - the request method and body.
     * @returns the parsed payload.
     */
    async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
      const hasBody = init?.body !== undefined
      const request: RequestInit = {
        method: init?.method ?? 'GET',
        credentials: 'same-origin',
      }
      if (hasBody) {
        request.headers = { 'content-type': 'application/json' }
        request.body = JSON.stringify(init?.body)
      }
      const response = await fetch(path, request)
      const raw = await response.text()
      let payload: Record<string, unknown> | null = null
      try {
        payload = raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : null
      } catch {
        payload = null
      }
      if (!response.ok) {
        const reason = payload !== null && typeof payload['error'] === 'string' ? payload['error'] : raw
        throw new Error(reason.length > 0 ? reason : `request failed (${response.status})`)
      }
      if (payload !== null && payload['ok'] === false) {
        const reason = typeof payload['error'] === 'string' ? payload['error'] : 'request failed'
        throw new Error(reason)
      }
      return payload as T
    }

    /**
     * Inject the panel's style sheet once.
     */
    function ensureStyle(): void {
      if (document.getElementById('dsh-data-dbx-style') !== null) return
      const element = document.createElement('style')
      element.id = 'dsh-data-dbx-style'
      element.textContent = STYLE
      document.head.appendChild(element)
    }

    /** The database icon the sidebar shows. */
    function DbxIcon(props: { size?: number; active?: boolean }): unknown {
      const size = props.size ?? 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('ellipse', { cx: 12, cy: 5.5, rx: 7.5, ry: 3.2 }),
        h('path', { d: 'M4.5 5.5v6c0 1.77 3.36 3.2 7.5 3.2s7.5-1.43 7.5-3.2v-6' }),
        h('path', { d: 'M4.5 11.5v6c0 1.77 3.36 3.2 7.5 3.2s7.5-1.43 7.5-3.2v-6' }),
      )
    }

    /**
     * The new-connection form.
     *
     * The same form creates a connection and edits a self-built one. The engine
     * decides where the row lives: an engine the plugin has a driver for is
     * stored in the plugin's own vault, anything else is handed to DBX.
     */
    function NewConnectionDialog(props: {
      t: (key: string) => string
      initial: PanelConnection | null
      engines: string[]
      catalog: EngineOption[]
      onClose: () => void
      onSubmit: (body: Record<string, unknown>) => Promise<void>
    }): unknown {
      const initial = props.initial
      const options = engineOptions(props.catalog)
      const matched = initial === null
        ? undefined
        : options.find(item => engineKey(item.type) === engineKey(initial.dbType))
      // An edit always keeps the engine the row was stored with. Falling back to
      // the first engine in the list is what turned a stored MongoDB connection
      // into a MySQL one pointed at port 27017 the first time it was edited.
      const initialEngine: EngineOption = matched ?? (initial === null
        ? (options[0] as EngineOption)
        : {
          type: initial.dbType,
          label: initial.dbType,
          port: initial.port,
          file: false,
          schema: initial.schema.length > 0,
        })
      // The stored engine may be one the list does not name; keep it selectable
      // instead of silently showing a different engine.
      const selectOptions = options.some(item => engineKey(item.type) === engineKey(initialEngine.type))
        ? options
        : [initialEngine, ...options]
      const [name, setName] = React.useState(initial === null ? '' : initial.name)
      const [engine, setEngine] = React.useState<EngineOption>(initialEngine)
      const [host, setHost] = React.useState(initial === null ? '' : initial.host)
      const storedPort = initial === null ? 0 : initial.port
      const effectivePort = Number.isFinite(storedPort) && storedPort > 0 ? storedPort : initialEngine.port
      const [port, setPort] = React.useState(initialEngine.file || effectivePort <= 0 ? '' : String(effectivePort))
      const [username, setUsername] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [database, setDatabase] = React.useState(initial === null ? '' : initial.database)
      const [schema, setSchema] = React.useState(initial === null ? '' : initial.schema)
      const [ssl, setSsl] = React.useState(initial !== null && initial.ssl === true)
      const [error, setError] = React.useState<string | null>(null)
      const [busy, setBusy] = React.useState(false)

      const selfBuilt = props.engines.includes(engine.type)

      const submit = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const typedPort = Number(port)
          const body: Record<string, unknown> = {
            name: name.trim(),
            dbType: engine.type,
            host: host.trim(),
            // An empty port keeps the stored one on an edit and falls back to
            // the engine's default on a create; sending `NaN` used to reach the
            // host as `null` and quietly point the row at a different server.
            port: engine.file ? 0 : Number.isFinite(typedPort) && typedPort > 0 ? typedPort : undefined,
            database: database.trim().length > 0 ? database.trim() : undefined,
            // An empty schema is meaningful: it means "the engine's default",
            // so it is sent as an empty string rather than dropped, which is
            // how an edit clears a schema that was set by mistake.
            schema: engine.schema ? schema.trim() : undefined,
            ssl,
          }
          // A blank user or password keeps the stored one on an edit: sending
          // an empty string would overwrite the secret the vault already holds.
          if (username.trim().length > 0) body['username'] = username.trim()
          if (password.length > 0) body['password'] = password
          if (initial !== null) body['connectionId'] = initial.id
          await props.onSubmit(body)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setBusy(false)
        }
      }, [name, engine, host, port, username, password, database, schema, ssl, initial])

      const field = (label: string, control: unknown): unknown => h('div', { className: 'dbx-field' }, h('label', null, label), control)

      return h(
        'div',
        { className: 'dbx-modal-backdrop', onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) props.onClose()
        } },
        h(
          'div',
          { className: 'dbx-modal' },
          h('h2', null, initial === null ? props.t('newConnection') : props.t('edit')),
          error === null ? null : h('div', { className: 'dbx-error' }, error),
          field(props.t('name'), h('input', {
            className: 'dbx-input',
            value: name,
            autoFocus: true,
            placeholder: 'my-postgres',
            onChange: (event: { target: { value: string } }) => setName(event.target.value),
          })),
          field(props.t('engine'), h('select', {
            className: 'dbx-select',
            value: engine.type,
            onChange: (event: { target: { value: string } }) => {
              const next = selectOptions.find(item => item.type === event.target.value)
              if (next === undefined) return
              setEngine(next)
              setPort(next.port === 0 ? '' : String(next.port))
            },
          }, selectOptions.map(item => h('option', { key: item.type, value: item.type },
            props.engines.includes(item.type) ? `${item.label} · ${props.t('sourceVault')}` : item.label)))),
          h('div', { className: 'dbx-note' }, selfBuilt ? props.t('selfBuiltHint') : props.t('dbxHint')),
          field(engine.file ? props.t('filePath') : props.t('host'), h('input', {
            className: 'dbx-input',
            value: host,
            placeholder: engine.file ? '/path/to/database.db' : '127.0.0.1',
            onChange: (event: { target: { value: string } }) => setHost(event.target.value),
          })),
          engine.file
            ? null
            : h('div', { className: 'dbx-field-row' },
              field(props.t('port'), h('input', {
                className: 'dbx-input',
                value: port,
                onChange: (event: { target: { value: string } }) => setPort(event.target.value),
              })),
              field(props.t('database'), h('input', {
                className: 'dbx-input',
                value: database,
                onChange: (event: { target: { value: string } }) => setDatabase(event.target.value),
              }))),
          // A schema is only meaningful where a driver can honour it: the
          // plugin's own PostgreSQL family. A DBX connection's profile has no
          // schema field, so offering it there would promise nothing.
          engine.schema && selfBuilt
            ? field(props.t('schema'), h('input', {
              className: 'dbx-input',
              value: schema,
              placeholder: 'public',
              onChange: (event: { target: { value: string } }) => setSchema(event.target.value),
            }))
            : null,
          engine.schema && selfBuilt
            ? h('div', { className: 'dbx-note' }, props.t('schemaHint'))
            : null,
          engine.file
            ? null
            : h('div', { className: 'dbx-field-row' },
              field(props.t('username'), h('input', {
                className: 'dbx-input',
                value: username,
                placeholder: initial === null ? '' : '••••',
                onChange: (event: { target: { value: string } }) => setUsername(event.target.value),
              })),
              field(props.t('password'), h('input', {
                className: 'dbx-input',
                type: 'password',
                value: password,
                placeholder: initial === null ? '' : '••••',
                onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
              }))),
          h('label', { className: 'dbx-check' },
            h('input', { type: 'checkbox', checked: ssl, onChange: (event: { target: { checked: boolean } }) => setSsl(event.target.checked) }),
            props.t('ssl')),
          h('div', { className: 'dbx-modal-actions' },
            h('button', { className: 'dbx-btn', onClick: props.onClose }, props.t('cancel')),
            h('button', { className: 'dbx-btn dbx-btn-primary', disabled: busy, onClick: submit },
              initial === null ? props.t('create') : props.t('save'))),
        ),
      )
    }

    /**
     * The name of the route that answered.
     *
     * @param t - the panel's translator.
     * @param status - what the host reported, or null while it is unknown.
     * @returns a short label for the route.
     */
    function transportLabel(t: (key: string) => string, status: PanelStatus | null): string {
      if (status === null) return t('transport')
      if (status.mode === 'native') return t('transportNative')
      if (status.mode === 'desktop-mcp') return t('transportDesktopMcp')
      if (status.mode === 'stdio-mcp') return t('transportStdioMcp')
      if (status.mode === 'bridge') return t('transportBridge')
      if (status.mode === 'catalog') return t('transportCatalog')
      return t('transportNone')
    }

    /** One cell of a CSV file, quoted only when it has to be. */
    function csvCell(value: string): string {
      return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
    }

    /**
     * The panel page: connections on the left, editor and results on the right.
     */
    function DbxPage(props: { t: (key: string) => string }): unknown {
      const t = props.t
      const [connections, setConnections] = React.useState<PanelConnection[]>([])
      const [selectedId, setSelectedId] = React.useState('')
      const [databases, setDatabases] = React.useState<string[]>([])
      const [database, setDatabase] = React.useState('')
      const [tables, setTables] = React.useState<PanelTable[]>([])
      const [sql, setSql] = React.useState('')
      const [result, setResult] = React.useState<PanelResult | null>(null)
      const [columns, setColumns] = React.useState<PanelColumn[] | null>(null)
      const [columnsTable, setColumnsTable] = React.useState('')
      const [error, setError] = React.useState<string | null>(null)
      const [notice, setNotice] = React.useState<string | null>(null)
      const [busy, setBusy] = React.useState(false)
      const [dialog, setDialog] = React.useState<{ editing: PanelConnection | null } | null>(null)
      const [transport, setTransport] = React.useState<PanelStatus | null>(null)

      const selected = connections.find(item => item.id === selectedId)

      const loadStatus = React.useCallback(async () => {
        const payload = await call<PanelStatus>('/api/dbx/status')
        setTransport(payload)
      }, [])

      const loadConnections = React.useCallback(async () => {
        const payload = await call<{ connections: PanelConnection[] }>('/api/dbx/connections')
        const list = payload.connections ?? []
        setConnections(list)
        setSelectedId(previous => {
          if (previous.length > 0 && list.some(item => item.id === previous)) return previous
          return list.length > 0 ? (list[0] as PanelConnection).id : ''
        })
      }, [])

      React.useEffect(() => {
        ensureStyle()
        loadConnections().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
        loadStatus().catch(() => undefined)
      }, [loadConnections, loadStatus])

      // The databases and the tables of the selected connection follow it, and
      // a structure view of another connection would be misleading.
      React.useEffect(() => {
        setColumns(null)
        setColumnsTable('')
        if (selectedId.length === 0) {
          setDatabases([])
          setTables([])
          return
        }
        let cancelled = false
        call<{ databases: string[] }>(`/api/dbx/databases?connectionId=${encodeURIComponent(selectedId)}`)
          .then(payload => {
            if (cancelled) return
            setDatabases(payload.databases ?? [])
          })
          .catch(() => {
            if (!cancelled) setDatabases([])
          })
        call<{ tables: PanelTable[] }>(`/api/dbx/tables?connectionId=${encodeURIComponent(selectedId)}`)
          .then(payload => {
            if (cancelled) return
            setTables(payload.tables ?? [])
          })
          .catch(() => {
            if (!cancelled) setTables([])
          })
        return () => { cancelled = true }
      }, [selectedId])

      const run = React.useCallback(async () => {
        if (selectedId.length === 0) {
          setError(t('noConnections'))
          return
        }
        if (sql.trim().length === 0) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = await call<{ result: PanelResult }>('/api/dbx/query', {
            method: 'POST',
            body: { connectionId: selectedId, sql, database: database.trim().length > 0 ? database.trim() : undefined },
          })
          setResult(payload.result)
        } catch (cause) {
          setResult(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [selectedId, sql, database, t])

      const save = React.useCallback(async (body: Record<string, unknown>) => {
        const editing = typeof body['connectionId'] === 'string' && (body['connectionId'] as string).length > 0
        const payload = await call<{ message: string }>(
          editing ? '/api/dbx/connections/update' : '/api/dbx/connections',
          { method: 'POST', body },
        )
        setDialog(null)
        setNotice(payload.message ?? '')
        await loadConnections()
      }, [loadConnections])

      const remove = React.useCallback(async () => {
        if (selected === undefined) return
        setBusy(true)
        setError(null)
        try {
          await call('/api/dbx/connections/remove', { method: 'POST', body: { connectionId: selected.id } })
          setResult(null)
          setColumns(null)
          setNotice('')
          await loadConnections()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [selected, loadConnections])

      const insert = React.useCallback((name: string) => {
        // A document store has no `SELECT`: a collection name is only useful
        // inside a command, so the chip types the command that reads it.
        const mongo = selected !== undefined && selected.dialect === 'MongoDB commands'
        const statement = mongo ? `find ${name}` : `SELECT * FROM ${name}`
        setSql(previous => (previous.length === 0 ? statement : `${previous}\n${statement}`))
      }, [selected])

      const describe = React.useCallback(async (table: string) => {
        if (selected === undefined) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = await call<{ columns: PanelColumn[] }>(
            `/api/dbx/describe?connectionId=${encodeURIComponent(selected.id)}&table=${encodeURIComponent(table)}`,
          )
          setColumns(payload.columns ?? [])
          setColumnsTable(table)
        } catch (cause) {
          setColumns(null)
          setColumnsTable('')
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [selected])

      const importFromDbx = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = await call<{ message: string }>('/api/dbx/connections/import', {
            method: 'POST',
            body: { all: true },
          })
          setNotice(payload.message ?? '')
          await loadConnections()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [loadConnections])

      const exportCsv = React.useCallback(() => {
        if (result === null || result.columns.length === 0) return
        const lines = [result.columns.map(csvCell).join(',')]
        for (const row of result.rows) lines.push(row.map(csvCell).join(','))
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${(selected === undefined ? 'result' : selected.name).replace(/[^\w.-]+/g, '-')}.csv`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      }, [result, selected])

      const test = React.useCallback(async () => {
        if (selected === undefined) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = await call<{ message: string }>('/api/dbx/connections/test', {
            method: 'POST',
            body: { connectionId: selected.id },
          })
          setNotice(payload.message ?? '')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }, [selected])

      const status = error !== null
        ? h('div', { className: 'dbx-status', 'data-kind': 'error' }, error)
        : busy
          ? h('div', { className: 'dbx-status' }, t('running'))
          : result === null
            ? h('div', { className: 'dbx-status' }, t('emptyResult'))
            : h('div', { className: 'dbx-status', 'data-kind': 'ok' },
              result.columns.length > 0
                ? `${result.rowCount} ${t('rows')}${result.truncated ? ' (truncated)' : ''}`
                : `${result.affectedRows ?? 0} ${t('affected')}`)

      const grid = result !== null && result.columns.length > 0
        ? h('table', { className: 'dbx-grid' },
          h('thead', null, h('tr', null,
            h('th', { className: 'dbx-row-index' }, '#'),
            result.columns.map((column, index) => h('th', { key: `${column}-${index}` }, column)))),
          h('tbody', null, result.rows.map((row, rowIndex) => h('tr', { key: rowIndex },
            h('td', { className: 'dbx-row-index' }, String(rowIndex + 1)),
            row.map((cell, cellIndex) => h('td', {
              key: cellIndex,
              'data-null': cell === 'NULL' ? 'true' : 'false',
              title: cell,
            }, cell))))))
        : null

      const structure = columns === null
        ? null
        : h('div', { className: 'dbx-structure' },
          h('div', { className: 'dbx-structure-title' },
            h('span', null, `${t('structure')} · ${columnsTable}`),
            h('button', {
              className: 'dbx-btn',
              onClick: () => { setColumns(null); setColumnsTable('') },
            }, t('close'))),
          h('table', null,
            h('thead', null, h('tr', null,
              h('th', null, t('columns')),
              h('th', null, t('dataType')),
              h('th', null, t('nullable')),
              h('th', null, t('defaultValue')),
              h('th', null, t('primaryKey')))),
            h('tbody', null, columns.map(column => h('tr', { key: column.name },
              h('td', null, column.name),
              h('td', null, column.dataType),
              h('td', null, column.nullable ? '✓' : ''),
              h('td', null, column.defaultValue === null ? '' : column.defaultValue),
              h('td', { className: column.primaryKey ? 'dbx-pk' : '' }, column.primaryKey ? 'PK' : ''))))))

      const canRemove = transport === null
        ? true
        : selected !== undefined && selected.source === 'vault'
          ? true
          : transport.capabilities.remove

      return h(
        'div',
        { className: 'dbx-root' },
        h(
          'aside',
          { className: 'dbx-side' },
          h('div', { className: 'dbx-side-head' },
            h('span', null, t('panel')),
            h('div', { className: 'dbx-side-actions' },
              h('button', {
                className: 'dbx-btn',
                title: t('importDbx'),
                disabled: busy,
                onClick: () => { importFromDbx().catch(() => undefined) },
              }, '⇩'),
              h('button', {
                className: 'dbx-btn',
                title: t('newConnection'),
                disabled: transport !== null && !transport.capabilities.add,
                onClick: () => setDialog({ editing: null }),
              }, '+'))),
          h('ul', { className: 'dbx-side-list' },
            connections.length === 0
              ? h('li', { className: 'dbx-conn-sub' }, t('noConnections'))
              : connections.map(connection => h('li', { key: connection.id },
                h('button', {
                  className: 'dbx-conn',
                  'data-active': connection.id === selectedId ? 'true' : 'false',
                  onClick: () => { setSelectedId(connection.id); setDatabase('') },
                },
                h('span', { className: 'dbx-conn-name' },
                  h('span', null, connection.name),
                  h('span', { className: 'dbx-badge' },
                    connection.source === 'vault' ? t('sourceVault') : t('sourceDbx')),
                  h('span', { className: 'dbx-badge' }, connection.dbType),
                  connection.imported
                    ? h('span', { className: 'dbx-badge', title: t('importedNotice') }, '↓')
                    : null),
                h('span', { className: 'dbx-conn-sub' },
                  connection.dbType === 'sqlite' || connection.dbType === 'duckdb'
                    ? connection.host
                    : `${connection.host}:${connection.port}`
                      + `${connection.database.length > 0 ? `/${connection.database}` : ''}`
                      + `${connection.schema.length > 0 ? ` · ${connection.schema}` : ''}`))))),
          h('div', { className: 'dbx-side-foot' },
            h('div', { className: 'dbx-transport' },
              h('span', { className: 'dbx-transport-label' }, t('transport')),
              h('span', { className: 'dbx-badge' }, transportLabel(t, transport))),
            transport === null
              ? null
              : h('div', { className: 'dbx-note', title: transport.source },
                `${transport.vaultCount} ${t('sourceVault')} · ${transport.engines.length} ${t('engine')}`),
            transport !== null && !transport.capabilities.query
              ? h('div', { className: 'dbx-note' }, t('noQueryNotice'))
              : null,
            h('div', { className: 'dbx-side-actions' },
              h('button', { className: 'dbx-btn', onClick: () => { loadConnections().catch(() => undefined) } }, t('refresh')),
              selected !== undefined && selected.source === 'vault'
                ? h('button', { className: 'dbx-btn', onClick: () => setDialog({ editing: selected }) }, t('edit'))
                : null,
              selected === undefined
                ? null
                : h('button', {
                  className: 'dbx-btn',
                  disabled: transport !== null && !transport.capabilities.query,
                  onClick: test,
                }, t('test')),
              selected === undefined
                ? null
                : h('button', {
                  className: 'dbx-btn',
                  disabled: !canRemove,
                  onClick: remove,
                }, t('remove')))),
        ),
        h(
          'section',
          { className: 'dbx-main' },
          h('div', { className: 'dbx-head' },
            h('select', {
              className: 'dbx-select',
              value: selectedId,
              onChange: (event: { target: { value: string } }) => { setSelectedId(event.target.value); setDatabase('') },
            }, connections.length === 0
              ? h('option', { value: '' }, t('noConnections'))
              : connections.map(connection => h('option', { key: connection.id, value: connection.id },
                connection.source === 'vault'
                  ? `${connection.name} · ${t('sourceVault')}`
                  : connection.name))),
            databases.length > 0
              ? h('select', {
                className: 'dbx-select',
                value: database,
                onChange: (event: { target: { value: string } }) => setDatabase(event.target.value),
              }, h('option', { value: '' }, t('database')),
              databases.map(name => h('option', { key: name, value: name }, name)))
              : null,
            h('button', { className: 'dbx-btn dbx-btn-primary', disabled: busy || selectedId.length === 0 || (transport !== null && !transport.capabilities.query), onClick: run }, t('run')),
            result !== null && result.columns.length > 0
              ? h('button', { className: 'dbx-btn', onClick: exportCsv }, t('exportCsv'))
              : null),
          h('textarea', {
            className: 'dbx-editor',
            value: sql,
            spellCheck: false,
            placeholder: selected !== undefined && selected.dialect === 'MongoDB commands'
              ? t('editorPlaceholderMongo')
              : t('editorPlaceholder'),
            onChange: (event: { target: { value: string } }) => setSql(event.target.value),
            onKeyDown: (event: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                run()
              }
            },
          }),
          status,
          notice === null || notice.length === 0 ? null : h('div', { className: 'dbx-status' }, notice),
          h('div', { className: 'dbx-results' }, grid),
          structure,
          tables.length === 0
            ? null
            : h('div', { className: 'dbx-tables' },
              h('div', { className: 'dbx-tables-title' }, t('tables')),
              tables.map(table => h('span', { key: table.name, className: 'dbx-table-row' },
                h('span', {
                  className: 'dbx-table-chip',
                  title: table.tableType,
                  onClick: () => insert(table.name),
                }, table.name),
                // Structure is read by the plugin's own driver, so it only
                // exists for a connection the plugin owns.
                selected !== undefined && selected.source === 'vault'
                  ? h('button', {
                    className: 'dbx-table-structure',
                    title: `${t('structure')} · ${table.name}`,
                    onClick: (event: { stopPropagation: () => void }) => {
                      event.stopPropagation()
                      describe(table.name).catch(() => undefined)
                    },
                  }, '▤')
                  : null))),
        ),
        dialog === null
          ? null
          : h(NewConnectionDialog, {
            t,
            initial: dialog.editing,
            engines: transport === null ? [] : transport.engines,
            catalog: transport === null || transport.engineCatalog === undefined ? [] : transport.engineCatalog,
            onClose: () => setDialog(null),
            onSubmit: save,
          }),
      )
    }

    /**
     * Register the sidebar entry and the main panel.
     *
     * @param ctx - the browser-half plugin context.
     */
    function apply(ctx: unknown): void {
      const context = ctx as {
        slots: {
          inject: (name: string, register: () => unknown) => () => void
          register: (options: Record<string, unknown>, component: unknown) => () => void
        }
        locale: {
          bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
          register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void
        }
        effect: (execute: () => (() => void) | void, label?: string) => void
      }

      context.effect(() => {
        const dispose = context.locale.register(LOCALE_NS, { zh: ZH, en: EN })
        return () => { dispose() }
      }, 'data-dbx.locale')

      const t = context.locale.bind(LOCALE_NS)

      context.slots.inject('sidebar.panellist', () => context.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: LOCALE_NS,
        label: () => t('panel'),
      }, DbxIcon))

      context.slots.inject('main', () => context.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
        inject: () => ({ t }),
      }, DbxPage))
    }

    return { apply, inject: ['slots', 'locale'] }
  }

  ;(window as unknown as {
    __ModuleLoader__: {
      load: (entry: { id: string; factory: (require: (id: string) => unknown) => unknown }) => void
    }
  }).__ModuleLoader__.load({
    id: 'dsh-data-dbx',
    factory: (require: (id: string) => unknown) => createClient(require),
  })

})()
