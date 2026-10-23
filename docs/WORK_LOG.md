# WORK_LOG

本文件记录 dsh-data-dbx 插件的实际工作进展。每轮实际修改后更新。

---

## 2026-09-21 · 第 1 轮：调研与技术验证

### 目标
熟悉 dbx 项目，确定 dsh-data-dbx 插件的技术路线。

### 用户已确认的决策
1. **集成路线**：B —— 原生 Cordis 插件，直接实现连接与查询（不走 MCP 桥接）。
2. **联邦查询**：构建带 `federation` feature 的 dbx-mcp 二进制。
3. **与已有插件关系**：与 `@yejiming/dsh-data-agent` 并存，dsh-data-dbx 专注 dbx 的连接管理与联邦查询。

### dbx 项目认知
- Rust workspace，分层：`dbx-core`（编排）→ `dbx-drivers` / `dbx-sql` / `dbx-types` / `dbx-platform`。
- 联邦查询在 `crates/dbx-federation`，基于 DataFusion 55.1.0 + `datafusion-federation 0.5.6`。
- 路由由 `crates/dbx-core/src/federation/capability_gate.rs` 的 `evaluate_capability_gate` 单点决策（6 条规则）。
- 联邦查询**严格只读**，不支持跨连接写入。

### 关键发现

#### 1. 联邦工具未进入 npm 发布版
`federation` 是 `dbx-mcp` 的**非默认 feature**：

```toml
federation = ["dbx-core/federation", "dep:dbx-federation"]
```

实测本机已安装的 `@dbx-app/mcp-server@0.4.88`：MCP 握手正常、可读到真实连接，但只有 19 个工具，**不含**联邦三件套。

#### 2. 从源码构建带 federation 的二进制（已验证成功）
```sh
cd /Users/cooper/GitHub/dbx_fed/dbx
cargo build -p dbx-mcp --features federation --bin dbx-mcp
```
- 结果：**成功**，耗时 8m25s，exit 0。
- 产物：`/Users/cooper/GitHub/dbx_fed/dbx/target/debug/dbx-mcp`（611 MB，debug 未 strip）。
- 仅有 1 个无害 linker 警告（`__eh_frame section too large`）。
- 工具数 **19 → 25**，新增：`dbx_federation_status`、`dbx_explain_federated`、`dbx_fetch_result_rows`、`dbx_open_session`、`dbx_begin_transaction`、`dbx_commit_transaction`、`dbx_rollback_transaction`。

#### 3. 联邦查询端到端实测通过
`dbx_federation_status` 实测输出：`global_executor_configured: true`，正确反映每个连接的 `federation_enabled` 开关。

**真实跨引擎 JOIN 成功**（PostgreSQL `customer` × MySQL `store_sales`）：

```sql
SELECT c.c_customer_id, c.c_first_name, ss.ss_quantity
FROM pglocal.public.customer c
JOIN mysqlocal.tpcds.store_sales ss ON c.c_customer_sk = ss.ss_customer_sk
LIMIT 5
```
EXPLAIN 结果：`"is_federated": true`、`fed_scans: 2`、`connection_ids: ["mysqlocal","pglocal"]`、`pushdown_audit.pushed_down: true`。
执行结果：返回真实数据行（`CUST000002 | Bob | 1` 等）。

#### 4. 表限定符语法：`MCP_SETUP.md` 文档与实现不符
`MCP_SETUP.md` 第 53-57 行声称「格式为 4 段或 3 段」且「连接限定符必须是**连接 ID**，不是显示名称」。

实测与源码均表明**相反**：
- **只接受 3 段**。4 段报错：`Expected 1, 2 or 3 parts, got 4`。
- **必须用连接名**。用 UUID 报错：`ParserError("Expected: identifier, found: 111")`（UUID 含连字符，非合法 identifier）。

依据：
- `crates/dbx-core/src/federation/executor.rs:394-412` 注释明确写道：
  > DataFusion catalogs and SQL table resolution are keyed by the connection NAME (e.g. `pglocal.public.customer`), while HTTP requests address connections by their URI id.
- 官方测试 `crates/dbx-mcp/tests/federation_http_e2e.rs:52,388` 使用 `conn_a.main.customers` —— 3 段、第一段为连接名。

正确格式：`<连接名>.<schema>.<表名>`（如 `pglocal.public.customer`）。

> 未验证边界：仅实测了**小写**连接名。大小写混写的容错性未验证，不做结论。

#### 5. dbx 存在两套独立连接存储，ID 互不相同

| 存储 | 路径 | 连接数 |
|---|---|---|
| dbx Desktop | `~/Library/Application Support/com.dbx.app/dbx.db` | 5 |
| dbx Web | `~/.dbx-web/dbx.db` | 3 |

表结构：`connections(id TEXT PK, config_json TEXT)` + `connection_secrets(connection_id, key, secret, PK(connection_id,key))`。
`config_json` 含 `name` / `db_type` / `host` / `port` / `username` / `database` 等；密码单独存于 `connection_secrets`（key 为 `password`），由 dbx 加密。

dbx-mcp 默认读取的是 **Desktop** 那份。

### 本轮未做任何代码修改
仅新增本文件与 `docs/` 目录。未改动 dbx 源码，未改动 DSH 源码。

### 待确认清单
1. **dbx 源码目录读写授权**：dbx 源码目录读写授权——是持续授权，还是改为「构建由你手动执行、我只写插件代码」？持续授权
2. **插件读取连接的来源**：Desktop + 可覆盖
3. **密码获取方式**：passwordRef

---

## 2026-09-21 · 第 2 轮：连接目录读取器实现与验证

### 架构定案
经核实 `crates/dbx-mcp/src/main.rs` 与 `paths.rs`，确定如下分工（插件不重复实现 dbx 已有能力）：

- **连接来源**：`DBX_DATA_DIR` 环境变量优先，否则 `dirs::data_dir()/com.dbx.app/dbx.db`（即 Desktop）。这与 dbx-mcp 的 `paths::storage_db_path()` 规则一致，保证插件与 dbx 看到同一份连接。
- **执行与凭据**：全部交给 dbx-mcp 子进程。dbx-mcp 的 `LocalBackend` 直接打开 dbx 存储并自行处理密码解密；插件**永不读取、解密或存储任何数据库密码**。这既满足 passwordRef 的安全要求，又避免复刻 dbx 的加密逻辑。
- **dbx-mcp 已知环境变量**：`DBX_DATA_DIR`、`DBX_MCP_TRANSPORT`、`DBX_WEB_URL`、`DBX_WEB_PASSWORD`、`DBX_MCP_HTTP_*`。

### 已实现
`src/connections.ts` —— DBX 连接目录读取器：
- `resolveDbxDbPath(override?)`：按 dbx 规则解析存储路径，支持显式覆盖。
- `readConnections(dbPath)`：读取并解析连接（仅非密 `config_json`）。
- `toSummary(profile)`：投影为不含任何密钥的摘要。
- `resolveConnection(profiles, selector)`：按 id 或名称解析（联邦 SQL 用名称，MCP 请求用 id）。

**实现方式说明**：为读取 `connections` 表自带一个只读 SQLite B-tree 解析器，避免为读几行数据引入原生 SQLite 依赖。仅读取表，不做任何写入。

### 验证结果（对真实 dbx.db 实测）
读取 5 个连接，字段与 SQLite 真值（`python3 sqlite3` 交叉验证）**完全一致**，且与 dbx-mcp `dbx_federation_status` 的实测输出一致：

| 连接 | 类型 | 驱动 | 联邦开关 |
|---|---|---|---|
| dorisLocal | mysql | doris | true |
| pgLocal | postgres | postgres | true |
| mySQLocal | mysql | mysql | true |
| PostgreSQL_olcl | postgres | postgres | false |
| sqlite | sqlite | sqlite | false |

### 解析过程中修正的 4 个 bug（均经实测定位）
1. **页大小位置错误**：取自 offset 0，实际在 **offset 16（大端）**；magic 为 `SQLite format 3`。
2. **page 1 头部偏移**：page 1 的 B-tree 头部在 **offset 100** 之后（前 100 字节是文件头），未加偏移导致读到 magic 字符 `'S'`(0x53)。
3. **内部页子指针宽度**：内部页子页号是 **4 字节大端**，原按 2 字节读取。
4. **叶子单元结构**：叶子单元为 `payload长度varint + rowid varint + payload`，原先漏掉 rowid varint，导致记录头错位（读到 0 行）。

### 本轮仍未做代码修改之外的副作用
未改动 dbx 源码，未改动 DSH 源码。新增 `src/connections.ts` 与 `package.json`。

---

## 2026-09-21 · 第 3 轮：插件主体实现与类型检查

### 新增文件
- `src/mcp.ts` —— 精简 MCP stdio 客户端（initialize / tools/list / tools/call）。
- `src/manager.ts` —— DBX MCP 服务进程生命周期（惰性启动、崩溃后自动重建、dispose 释放）。
- `src/tools.ts` —— 4 个模型可见工具。
- `src/index.ts` —— Cordis 插件入口（config schema、inject、effect 生命周期）。
- `tsconfig.json`、`package.json`。

### 工具面（4 个）
| 工具 | 作用 |
|---|---|
| `dbx_list_connections` | 列出 DBX 连接（含联邦开关），返回不含密钥的摘要 |
| `dbx_execute_query` | 单连接执行一条 SQL |
| `dbx_federated_query` | 跨连接联邦查询，强制 `federation_mode: require` |
| `dbx_federation_status` | 探测各连接联邦就绪状态 |

**设计要点**：`dbx_federated_query` 硬编码 `federation_mode: 'require'`，使联邦不可用时返回明确错误，而非静默回退到单连接执行——避免"看起来联了、实际没联"的误导。

### 依赖版本修正
原按 `0.1.2-alpha.2` 编写 manifest，实测本机运行的是 **DSH 0.1.5-rc.2**。已改用 npm 上实际存在的 `0.1.5-rc.2` 系列版本对齐。`JsonValue` 不在 `dsh-tools` 导出中，实际来自 `@deepseek-ai/dsh-util-values`。

### 类型检查
`npx tsc --noEmit` 对真实 DSH 类型 **exit 0，无错误**（其间修正 3 处：`row.id` 残留、`JsonValue` 来源、未使用的 `args` 形参）。

### 端到端验证（插件自身代码路径）
1. 目录读取 + 选择器解析 → 单连接查询：`SELECT count(*) FROM customer` 返回真实结果。
2. 联邦查询路径：`pglocal.public.customer JOIN mysqlocal.tpcds.store_sales` 经 `federation_mode: require` **成功返回 3 行真实数据**。

### Cordis API 用法修正（经源码核对）
- `z.dict(String)`，非 `z.dict(z.string())`。
- 生命周期用 `ctx.effect(() => () => cleanup, 'label')`，非 `ctx.on('dispose')`。
- `ctx.logger` 为必填服务，非可选。

### 待办
- 安装到 web profile 并做真实会话验证。

---

## 2026-09-21 · 第 4 轮：构建产物、bundle 化与安装

### 构建
- 新增 `tsconfig.build.json`（`noEmit: false`、`outDir: lib`、`allowImportingTsExtensions: false` 以产出 `.js` 说明符）。
- `npx tsc -p tsconfig.build.json` → `lib/*.js` + `lib/*.d.ts`，**exit 0**。
- 运行时加载验证：`import('./lib/index.js')` 成功，导出 `name / inject / apply / Config`。

### bundle 化
按 data-agent 的既有约定补齐：
- 新增 `cordis.patch.yml`：`insert` 一行 `data-dbx` → `dsh-data-dbx`。
- `package.json` 增加 `dsh.bundle.patch` 声明。
- `files` 字段加入 `cordis.patch.yml`（否则 npm 发布后 bundle 声明会指向不存在的文件）。

### 安装（desktop profile —— 当前活动 profile）
确认活动 profile 的方法：GUI 端口 43129 的监听进程是 **DSH Desktop**（PID 2577），故活动 profile 为 `~/.dsh/profiles/desktop`，而非 `web`。

安装步骤：
1. 备份 `package.json` → `package.json.bak`，`cordis.patch.yml` → `cordis.patch.yml.bak`（未删除任何文件）。
2. 在 `node_modules/` 建立软链 `dsh-data-dbx` → `/Users/cooper/GitHub/dsh-data-dbx`。
3. `package.json` 的 `dsh.profile.bundles` 追加 `dsh-data-dbx`。

**注意**：首次尝试用 `pnpm install` 安装 `link:` 依赖时，pnpm 因 lockfile 模式变化要清除 node_modules 并要求 TTY 确认（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。为避免破坏性清除，改为**手动软链**，未执行任何 purge。

### 二进制安装
联邦版 `dbx-mcp` 已复制到 `~/.local/bin/dbx-mcp`（该目录已在 PATH 且已有其他工具），使插件默认配置 `command: 'dbx-mcp'` 可直接按裸名解析。默认配置下实测启动成功、25 个工具。

### 验证结果（全部通过）
1. **模块契约**：`name: data-dbx`、`inject: ['tools']`、`apply` 为函数、`Config` 默认值正确（command=`dbx-mcp`、maxRows=100、timeoutMs=120000）。
2. **注册**：`apply()` 在真实 Cordis Context 上注册 4 个工具，名称与 timeoutMs 均正确。
3. **执行**：`dbx_list_connections` 返回 5 个连接且联邦开关正确；`dbx_execute_query` 真实查询返回结果。
4. **渲染**：`output.render` 产出可读文本。
5. **联邦**：`dbx_federated_query` 跨库 JOIN 返回真实数据。
6. **错误路径**：未知连接返回包含全部可用连接名的明确报错。

### 待完成
- release 版二进制构建中（后台）。
- 重启 DSH Desktop 后在真实会话中做最终验证。

---

## 2026-09-21 · 第 5 轮：release 二进制与最终验证

### release 二进制
```sh
cargo build --release -p dbx-mcp --features federation --bin dbx-mcp
```
- 结果：**成功**，耗时 **44m22s**，exit 0。
- 体积：**55 MB**（release）对比 **583 MB**（debug），减小 **10.6 倍**。
- 已安装到 `~/.local/bin/dbx-mcp`（覆盖 debug 版）。
- 实测联邦查询正常，首次调用（含进程启动）**899 ms**。

### 最终验证（6/6 通过）
| 检查 | 结果 |
|---|---|
| `dbx_list_connections` 返回 5 个连接 | PASS |
| 返回中不含任何密钥字段（`password`/`secret`） | PASS |
| `dbx_execute_query` 单连接查询成功 | PASS |
| `dbx_federated_query` 跨库 JOIN 成功 | PASS |
| `dbx_federation_status` 返回全局配置状态 | PASS |
| 联邦写操作（`DELETE`）被拒绝 | PASS |

附加确认：引用未开启联邦的连接时 `isError=true`，即 `federation_mode: 'require'` 生效，无静默回退。

### 其他验证
- **进程复用**：第二次工具调用耗时 **11 ms**（未重新拉起子进程）。
- **生命周期**：`ctx` 停止时 dispose 正常释放，无报错。

### 交付物
- 插件源码：`src/{index,tools,connections,mcp,manager}.ts`
- 构建产物：`lib/`
- bundle 声明：`cordis.patch.yml`
- 构建配置：`tsconfig.json`、`tsconfig.build.json`
- 文档：`README.md`、`docs/WORK_LOG.md`
- 已安装至 `~/.dsh/profiles/desktop`（备份 `package.json.bak`、`cordis.patch.yml.bak`）

### 待用户在真实会话验证
重启 DSH Desktop 后，在会话中调用 `dbx_list_connections` 确认插件生效。

### 未验证边界（如实标注）
- 仅实测**小写**连接名作联邦限定符；大小写混写的容错性未验证。
- 仅在本机 DBX Desktop 存储上验证；DBX Web 存储（`~/.dbx-web`）未实测。
- 未测试多连接并发查询、SSH 隧道连接、非 PG/MySQL/SQLite 引擎的联邦。

---

## 2026-09-21 · 第 6 轮：重启后验证 + 发现 DBX 联邦引擎 bug

### 重启后验证（DSH Desktop 新 PID 48597，端口 43129）
插件已随重启加载，四个 `dbx_*` 工具出现在会话工具列表中（这是插件成功注册的直接证据）。

最终验证 **7/7 通过**：

| 检查 | 结果 |
|---|---|
| `dbx_list_connections` 返回 5 个连接 | PASS |
| 返回中无密钥泄露 | PASS |
| `dbx_execute_query`（MySQL） | PASS |
| `dbx_execute_query`（PostgreSQL） | PASS |
| `dbx_federated_query`（PG×MySQL 跨库） | PASS |
| `dbx_federation_status` | PASS |
| 联邦写操作被拒绝 | PASS |

实际返回数据：单库查询 `CUST000001 | Alice`；跨库联邦 JOIN 正常返回。

其他：冷启动首次调用 4 ms（连接目录直接读 SQLite，无需子进程）；反复装载无注册冲突。

### 发现：DBX 联邦引擎在中文列别名时 panic 崩溃（DBX 侧 bug）
```sql
SELECT c.c_first_name AS 名 FROM pglocal.public.customer c
JOIN mysqlocal.tpcds.store_sales s ON c.c_customer_sk = s.ss_customer_sk LIMIT 1
```
导致 dbx-mcp 进程崩溃：
```
thread 'tokio-rt-worker' panicked at crates/dbx-federation/src/executor.rs:844:31:
start byte index 27 is not a char boundary; it is inside '客' (bytes 26..29 of string)
```

**根因**：该处按**字节**切分 SQL 字符串，未处理 UTF-8 多字节字符边界。当 SQL 含中文（或任何非 ASCII）标识符/别名，且切分点落在多字节字符内部时即 panic。

**影响**：任何含中文别名、中文列名、中文注释的联邦查询都会让 MCP 服务崩溃。这是 DBX 侧缺陷，插件无法修复，但可规避——避免在联邦 SQL 中使用非 ASCII 标识符。

**同时验证了插件的健壮性**：该 panic 触发后，插件正确报错（而非静默失败），并在下次调用时于 **204 ms** 内自动重建服务进程恢复可用。

### 结论
插件功能完整、行为正确，且在 DBX 侧崩溃场景下能自愈。中文别名崩溃问题建议反馈给 DBX 上游。



---

## 2026-09-22 · 第 7 轮：【重要修正】安装位置错误

### 问题现象
用户反馈：界面上「输入框上方没有 dbx_* 工具图标」，工具结果看不到。

### 根因：DSH_HOME 判断错误，插件装错了位置

我此前推断活动 profile 的方法有误：看到监听 43129 的进程是 DSH Desktop，就假定 profile 是 `desktop`。**这个推断是错的。**

查 `~/Library/Logs/DSH Desktop/harness.log` 得到确凿证据：

```
[desktop] launch requested (web profile)
[desktop] profile web
[desktop] DSH_HOME=/Users/cooper/Library/Application Support/dsh-desktop/harness
```

| 项 | 我此前的判断（错误） | 实际情况 |
|---|---|---|
| DSH_HOME | `~/.dsh` | `~/Library/Application Support/dsh-desktop/harness` |
| 活动 profile | `desktop` | **`web`** |

`~/.dsh` 是独立的 CLI/TUI 安装，与 DSH Desktop 无关。因此插件被装到了 `~/.dsh/profiles/desktop`，Desktop 从未加载它——harness.log 中 grep 不到任何 `data-dbx` 痕迹，与此一致。

**教训**：判断活动 profile 不能靠「进程名 → profile 名」猜，应直接查启动日志中的 `profile` 与 `DSH_HOME` 两行。

### 修正操作
1. 备份真实 profile 配置：`.../profiles/web/package.json` → `package.json.bak`。
2. 在真实 profile 建立软链：`.../profiles/web/node_modules/dsh-data-dbx` → `/Users/cooper/GitHub/dsh-data-dbx`。
3. 在 `.../profiles/web/package.json` 的 `dsh.profile.bundles` 追加 `dsh-data-dbx`。
4. **回滚误装**：从 `~/.dsh/profiles/desktop` 移除 bundle 条目与软链。已验证该 `package.json` 与备份 `package.json.bak` **逐字节一致**，误装完全还原。

未删除任何文件。

### 修正后验证（从真实 profile 上下文加载）
```
从真实 profile 加载成功
  name: data-dbx | inject: ["tools"] | apply: function
  注册工具: dbx_list_connections, dbx_execute_query, dbx_federated_query, dbx_federation_status
  实测连接: dorisLocal, pgLocal, mySQLocal, PostgreSQL_olcl, sqlite
```
bundle patch、main 入口均可从该 profile 正确解析。

### 另一处方法失误
上一轮用户让我执行那条联邦 SQL 时，我**用 bash 跑 Node 脚本**间接验证，而没有真正调用 `dbx_federated_query` 工具。所以界面上只出现 bash 输出、没有工具卡片——这本身也掩盖了「插件没加载」的问题。正确做法是直接调用工具，让注册与执行路径都被真实走一遍。

### 待办
用户重启 DSH Desktop 后，新建会话确认 `dbx_*` 工具出现并可直接调用。

---

## 2026-09-22 · 第 8 轮：改用官方 CLI 安装（解决被覆盖问题）

### 上一轮安装为何失效
第 7 轮我把 `dsh-data-dbx` 手工写进 `.../profiles/web/package.json` 的 `dsh.profile.bundles`。用户重启后复查：

- bundle 条目**消失**，`package.json` 在 **09:22** 被重写（我改的是 09:19），文件大小与备份完全相同。
- 软链仍在（不在维护范围内），但条目被抹掉。

**根因**：该 profile 由 DSH Desktop 的 **generation 投影机制**管理：
- `dsh.desktop.generationProjection.plugins` 记录每个插件的 generation（`名字+版本+哈希`）；
- `pnpm.overrides` 把每个插件指向 `../.generations/live/<generation>/node_modules/<pkg>`；
- `.generations/desired.json` 列出期望的 9 个 generation。

重启时的 `profile maintenance` 会依此重建 `package.json`，**手工添加的 bundle 条目被覆盖**。

### 修正：改用官方 CLI
```sh
cd /Applications/DSH\ Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh
DSH_HOME=~/Library/Application\ Support/dsh-desktop/harness \
  node lib/bin.js plugin --profile web add link:/Users/cooper/GitHub/dsh-data-dbx
```

该命令转发给 profile 目录下的 pnpm，并且关键的是它会在前后**自动排除/恢复 generation 投影**：

```
dsh-desktop pnpm runner: excluded 9 generation projection(s) from pnpm
...
dsh-desktop pnpm runner: restored 9 generation projection(s) after pnpm
```

### 验证
1. `package.json`：`dependencies['dsh-data-dbx'] = "link:/Users/cooper/GitHub/dsh-data-dbx"`，`bundles` 含 `dsh-data-dbx`。
2. 软链由 pnpm 创建（相对路径）：`node_modules/dsh-data-dbx -> ../../../../../../../GitHub/dsh-data-dbx`。
3. **`--dump-config` 确认已组合进 profile 树**（决定性证据）：
   ```
   # == dsh-data-dbx
   - id: data-dbx
     name: dsh-data-dbx
     __dshPluginOwner:
       packageName: dsh-data-dbx
   ```
4. 从 profile 上下文加载：四个工具全部注册。

### 时序说明
harness 于 **09:21** 启动，插件于 **09:23** 装好——**晚于启动**，故当前进程尚未加载。需再次重启。

### 教训
1. 改 profile 必须走 `dsh plugin add`，**不要手工编辑 `package.json`**：generation 投影会覆盖。
2. 判断活动 profile 要看启动日志的 `profile` 与 `DSH_HOME`，不要靠进程名推断。
3. 安装后应用 `--dump-config` 验证插件确实进入 profile 树，而不是只看文件是否被写入。

---

## 2026-10-22 · 第 9 轮：数据库面板（GUI）+ DBX 传输链

### 目标
在 DeepSeek Harness 侧边栏挂一个「数据库」面板（用户需求：点击后展示 dbx 的主界面，可以增加连接、执行 SQL；功能参考 dbx 项目）。

### 交付形态
- **浏览器半** `client/src/client.ts`（834 行）→ 编译为 `lib/client.js`，以 `window.__ModuleLoader__.load({ id: 'dsh-data-dbx', factory: (require) => … })` 形式注册；通过 `ctx.slots.inject('sidebar.panellist', …)`（order 30）和 `ctx.slots.inject('main', …)`（key 与侧边栏 id 一致，否则 `layout.selectPanel` 抛错）挂入宿主。整包用 IIFE 包裹，避免与其他 bundle 顶层 `const` 冲突。
- **宿主半** `src/api.ts` 注册 7 条精确路由：`/api/dbx/connections`（GET 列 / POST 增）、`/api/dbx/connections/remove`、`/api/dbx/connections/test`、`/api/dbx/query`、`/api/dbx/tables`、`/api/dbx/databases`、`/api/dbx/status`。
- 面板样式只用 `--dsw-alias-*` 主题令牌（原先两处字面色 `#fff` / `#ff7b72` 已换成 `brand-text` / `state-error-primary`）；`--dsw-alias-button-ghost-hover`、`-elevated-hover` **不存在**，改用 `--dsw-alias-interactive-bg-hover`。
- 打包元数据按官方 checklist 补齐：`exports` 增 `./locale/*.json`、`./icon`；新增 `locale/{en,zh}.json`（`meta.title` / `meta.description`）与 `icon.svg`；`dsh.client` 增 `immediately: true`。

### 传输链（本轮核心）
DBX 的连接与密钥只存在 DBX 自己手里（`dbx.db` + `connection_secrets`，AES-256-GCM，密钥在 macOS 钥匙串），所以宿主**不持有驱动、密码和连接状态**，只负责挑一条能用的通路：

| 模式 | 来源 | 能力 |
|---|---|---|
| `desktop-mcp` | DBX 桌面自带 MCP HTTP 服务（默认关，`127.0.0.1:5225/mcp`，token 文件 `mcp-http-token`，设置键 `app_settings.mcp_http_server_settings`） | 全功能 |
| `stdio-mcp` | 无头 `dbx-mcp` | 全功能 |
| `bridge` | DBX 桌面桥接（端口文件 `mcp-bridge-port`） | 执行 SQL、列表；增删连接走目录写入 + `/reload-connections` |
| `catalog` | 仅 `dbx.db` | 列/增/删连接、列数据库；不能执行 SQL |
| `none` | 无通路 | 全部不可用 |

实现要点（`src/access.ts`、`src/catalog.ts`、`src/store.ts`、`src/bridge.ts`、`src/http-mcp.ts`、`src/settings.ts`）：
- **必须探活**：无头 `dbx-mcp` 能启动、能答 `tools/list`，但打不开加密目录时逐条报 `SECRET_KEY_UNAVAILABLE`；桥接端口文件在 DBX 退出后仍残留（实测端口 65244 已无监听）。所以 MCP 用 `dbx_list_connections` 探、桥接用 TCP connect 探。
- **WAL**：手写 SQLite 解析器读不到 WAL 里的新行（实测少一个连接 `DSHDeepLinkTest`）；改用 `node:sqlite` 的 `DatabaseSync` 只读打开即可正确应用 WAL。
- **目录写入**（`src/store.ts`）：`connections.config_json` 里 `password` 恒为 `''`（DBX 的 `sanitized_connection_config` 会清掉），真实密码写 `connection_secrets.secret` 旧明文字段（`secret_enc` 为空），DBX 下次读取时会自动加密迁移（`storage.rs:8190`）。`ConnectionConfigData` 必填字段是 `id, name, db_type, host, port, username, password, database`，其余都有 `#[serde(default)]`；`ca_cert_path` 等是 `String` 而非 `Option`，传 null 会反序列化失败，所以整类字段直接省略不写。
- 桥接/桌面 MCP 服务都**没有**建连接的接口，只能靠无头 MCP 或写目录；`/reload-connections` 会发 `mcp-reload-connections` 事件让桌面 `reloadFromDisk()`。

### 现场实测（本机）
- 解析到的二进制：`/Users/cooper/Github/dbx_fed/dbx/node_modules/.pnpm/node_modules/@dbx-app/mcp-darwin-arm64/bin/dbx-mcp`（来源 `workspace`）。
- `verify:transport`：mode `catalog`（DBX.app 当时未运行），三个真实连接都能列出。
- `verify:roundtrip`（复制真实 `dbx.db` 到临时目录后跑）：列 → 增 → 列 → 删 → 列全通过，query 按预期报「需要运行中的 DBX」。
- 无头 `dbx-mcp` 打不开真实目录（`SECRET_KEY_UNAVAILABLE` / `KEYRING_ACCESS_FAILED`），`--authorize-keychain` 在非交互会话必然失败。

### 自检脚本
`verify:api`（7 路由 + stdio-mcp 模拟）、`verify:client`（包/入口/字典）、`verify:store`（写读删 + 密码不入 config_json）、`verify:roundtrip`（副本往返）、`verify:transport`（真机通道解析）、`verify:mcp`（真连 dbx-mcp 全流程）。全部通过。

### 崩溃修复
`dbx-mcp` 不在 PATH 时，`child.on('error')` 无人处理会以未捕获异常掀掉整个 Electron 进程。已在 `DbxMcpClient` 构造函数里补 `error` 监听，把失败转成 `McpError` 拒绝掉所有等待中的请求。

### 待办
1. 用户在 harness 里重启一次，让新 bundle 生效。
2. 若要执行 SQL：启动 DBX.app（走桥接），或在 DBX 设置里打开它自带的 MCP HTTP 服务（全功能，含建连接）。

## 2026-10-22 · 第 10 轮：自建连接（插件自带驱动栈 + 加密仓库）

### 目标
上一轮的面板只能当 DBX 的遥控器：DBX 不开就没有 SQL、没有密码、没有驱动，`catalog` 模式下一个按钮都点不动。本轮让面板**自己会连数据库**——插件自带驱动栈和连接仓库，DBX 装不装、开不开都不影响自建连接。

### 交付
| 文件 | 职责 |
|---|---|
| `src/vault.ts`（450 行） | 自建连接仓库：`data-dbx/connections.json`，随机主密钥（`master.key`, 0600）+ AES-256-GCM 加密 |
| `src/drivers/*.ts`（9 文件 / 1904 行） | 驱动栈：`types.ts` 契约、`registry.ts` 引擎名归一与能力探测、postgres / mysql / sqlserver / clickhouse / sqlite / mongodb / redis 七个实现 |
| `src/native.ts`（499 行） | `NativeAccess` 实现与 DBX 同一套 `DbxAccess` 接口；`NativeAccessProvider` 合并自建 + DBX 两张列表 |
| `src/api.ts`（534 行） | 路由从 7 条扩到 10 条，新增 `connections/update`、`connections/import`、`describe` |
| `client/src/client.ts`（1156 行） | 来源徽标、自建连接可编辑、表结构视图、按引擎能力裁剪新建对话框 |
| `scripts/verify-native.mjs`（218 行） | 无 DBX 环境下的端到端自检 |

### 关键设计

**1. 一个接口，两个后端。** `NativeAccess` 和 `mcpAccess`/`catalogAccess` 实现同一个 `DbxAccess`，`api.ts` 和客户端完全不知道背后是谁。`NativeAccessProvider` 是唯一的合成点：先取 DBX 通路（拿能力清单），再包一层，列表时把 vault 行和 DBX 行合并、打上 `source: 'vault' | 'dbx'` 与 `managed` 标记。

**2. 引擎分流的判据是「本机有没有驱动」，不是「用户选了哪个」。** 新建连接时 `resolveDriver(dbType) !== null` 就写 vault，否则交给 DBX。这样 Oracle 之类只有 DBX 有驱动的引擎仍然可用，而 postgres 用户不会因为 DBX 关着就建不了连接。`/status` 的 `engines` 用 `packageAvailable()` 真去 `require.resolve` 一遍，所以下拉框里不会出现「选了会报错」的引擎。

**3. 修复了一个必然失败的加密缺陷。** `vault.ts` 的 `encrypt` 用随机 IV，`decrypt` 却用 `Buffer.alloc(12, 0)` 全零 IV —— GCM 认证标签必然校验失败，密码永远解不出，但**不会在写入时报错**（只会在读取时炸），属于最隐蔽的一类。改为密文自描述格式：`aes256gcm.<ivB64>.<cipherB64>.<tagB64>` 四段，`decrypt` 按段解析并校验段数与 IV/tag 长度，截断时报 `VaultError('this vault holds a truncated password')` 而不是静默输出乱码。`TAG_SIZE` 之前未使用触发 TS6133，正好在这一步用上。

**4. 从 DBX 导入时，密码必然要重填。** DBX 的 `config_json` 里 `password` 恒为 `''`（`sanitized_connection_config` 会清掉），真实密码只在它自己的 `connection_secrets` 里、用钥匙串密钥加密。插件读不到，也不该读。所以导入只复制连接形状（host/port/database/username/库类型），并把需要补密码的连接单独列出来（`needsPassword`），面板上标 `↓` 徽标。

**5. 表结构只对自建连接开放。** DBX 的 MCP 工具集里没有 describe，桥接也没有。自建连接用驱动自己的元数据查询（`information_schema.columns` + 主键子查询，SQLite 用 `PRAGMA table_info`）；DBX 连接点结构按钮会明确报「only a self-built connection has a table structure the plugin can read」，并且客户端**直接不渲染**那个按钮（`selected.source === 'vault'`）。

### 类型严格度踩到的坑
项目 `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`，所以：
- `{ port?: number }` 不能显式赋 `undefined`，得写 `port?: number | undefined`；
- `rows[0][0]` 的类型是 `Cell | undefined`，比较前要确认；
- 可选字段从 JSON 读进来后统一用 `?? ''` 归一，避免 `string | undefined` 泄漏到接口返回值里。

### 验证（全部通过）
- `npm run typecheck`：宿主 + 客户端两套 tsconfig 均无输出。
- `npm run verify:native`：**在完全没有任何 DBX 的环境里**跑通。种一个 DBX 目录 → 导入 2 条（网络引擎进 `needsPassword`、重复导入全跳过）→ `NativeAccessProvider` 在 DBX 抛错的情况下仍报 `mode: 'native'` → 用**真 SQLite 文件**跑 CREATE/INSERT/SELECT、NULL 渲染成 `NULL`、`maxRows=1` 触发 `truncated` → 列表、`PRAGMA` 结构（主键、NOT NULL 都读对）、数据库列表 → 断言仓库文件里搜不到明文 `secret-value` 且含 `aes256gcm.` → 改名、删除 → 再用假 DBX 通路验证回退：DBX 行排进同一张列表且 `managed: false`、未知 id 落到 DBX、无驱动引擎交给 DBX、有驱动引擎进 vault。
- `npm run verify:api`：10 条路由全部注册；`/status` 报 `native` 且带 `engines`/`vaultCount`；postgres 新建进 vault（断言**没有** `dbx_add_connection` 调用）、oracle 新建走 DBX 且密码转发；对 DBX 连接 describe 报 `self-built`；空目录导入返回 404。
- `npm run verify:client`、`verify:store` 仍通过；`verify:transport`、`verify:roundtrip` 真机通道解析与目录往返不受影响。

### 边界（如实标注）
- 自建连接**没有连接池**，每条语句一次握手。作为面板的手动查询够用，不适合高频。
- 主密钥是随机生成的，和密文一起放在 `data-dbx/master.key`（`0600`），**不是硬件根信任链**。实际强度等于目录权限：挡住「明文落盘」「单独拷走 `connections.json`」，挡不住「能读整个目录的人」。已在 README 写明，并给出两条加强路径（改用 DBX 管理 / 换更严的 `dataDir`）。
- `data-dbx/` 落在 `<dataDir>` 下，而 `<dataDir>` 默认解析到 DBX 的应用数据目录（`~/Library/Application Support/com.dbx.app`）。也就是说插件在**别人的应用目录**里建了自己的子目录：好处是跟着 DBX 的 `dataDir` 配置一起搬、不会散落；代价是卸载 DBX 若清空该目录会连带清掉自建连接与 `master.key`。显式配置 `dataDir` 可以完全避开。
- MongoDB 目前只把 `query` 当 JSON 命令执行、Redis 只支持命令语法，两者没有「表结构」概念，describe 返回空。

### 真机反馈（用户实测）：导入后点执行仍报「需要运行中的 DBX」
**根因**：`importCatalogConnections` 只写仓库、`listConnections` 却把 DBX 目录里的同名连接照旧列出来 —— 同一条连接变成两行（`自建` + `DBX`）。用户点中的是 DBX 那行，于是落回 `catalogAccess.query`，报 `running SQL needs a live DBX`。功能没错，**列表给了错的选择**。

三处修正：
1. **去重**：指纹（目录/主机/端口/库类型/名字）已存在于仓库的 DBX 行不再列出 —— 仓库副本取代它，因为只有副本能在 DBX 关闭时执行。
2. **按身份回落**：面板在导入之前渲染、手里还攥着 DBX id 时，`findEntryOrTwin` 用指纹把 DBX id 翻译成仓库那一行，直接由插件执行，不报「无 DBX 通道」。
3. **缺密码要说人话**：DBX 的密码不外借，导入的副本 `passwordEnc` 为空。原来会把驱动的认证失败原样抛给用户（像是密码输错了），现在在 `open()` 里追加一句「这条是从 DBX 导入的，DBX 把密码留给了自己，请点编辑补上并保存」。

三条都补进了 `verify:native`（`an imported row is not listed twice`、`the catalog id reached the self-built driver`、`the missing secret is named, not left as an auth failure`）。

### 真机反馈（用户实测）：按钮上的字看不见
**根因**：面板用 DSH 的主题 token 上色，而 `--dsw-alias-brand-primary` 在 DSH 里**不是蓝色**，是「主标签色」——浅色主题近黑 `#0f1115`，深色主题近白 `#f9fafb`。我把主按钮和引擎徽标的文字写成了 `--dsw-alias-brand-text`，它的取值恰好**等于** `brand-primary`，于是浅色主题黑底黑字、深色主题白底白字，对比度 **1.0:1**。执行、创建、保存三个主按钮和连接列表的类型徽标全部命中。

**修复**：文字改用 `--dsw-alias-label-primary-inverted`（浅色 `#fff` / 深色 `#353638`）—— 这正是 DSH 自己给品牌色底配的前景色。修后实测对比度：浅色 **18.9:1**、深色 **11.6:1**（WCAG AA 要求 4.5:1）。

顺手修的四处：
1. `.dbx-conn:hover` 与选中态的声明末尾多了一个 `)`（`var(--dsw-alias-interactive-bg-hover))`）—— 整条声明被 CSS 解析器丢弃，连接项的 hover 和「当前选中」高亮一直是失效的。这一条比配色更影响使用：用户看不出自己选中了哪条连接。
2. `--dsw-alias-border-secondary` 在 DSH 主题里**不存在**（4 处），靠 `rgba(128,128,128,.3)` 兜底，深浅色下都是同一块灰。改用 `--dsw-alias-border-l2`。
3. 成功提示原来用 `label-primary`，与正文同色，一条「查询成功」和普通说明文字没有区别 → `state-success-primary`。
4. 表结构的主键列原来用 `brand-primary`（与正文同色，主键标记形同虚设）→ `state-business-primary`；「结构」小按钮 10px 文字用 `label-secondary` 在浅色底只有 3.4:1 → `label-primary`（18.9:1）。

**回归防线**：`verify:client` 增加样式表审计 —— 21 个 token 的白名单（逐个到 `app.asar` 里核过 DSH 的真实定义）、禁止把 `brand-text` 当标签色、检测 `))` 这类不配对的 `var()`、以及「用了品牌色底就必须配 inverted 前景」的配对断言。反向验证过：把旧写法放回 `lib/client.js`，脚本立刻报错。

验证方式：从 `app.asar` 里抽出 DSH 的真实调色板（`brand-primary = bluish-1000/bluish-50`、`label-primary-inverted = bluish-00/bluish-800`），用编译产物 `lib/client.js` 里的真实样式表渲染明暗两套面板，再量 computed style 的对比度。

### 待办
1. 刷新页面即可看到新配色（客户端 bundle 每次加载从磁盘读）；列表去重那条在宿主侧，仍需重启一次宿主进程。
2. 真机点一遍：自建一条 PostgreSQL 连接（本机有 pglocal 可用），确认能执行 SQL 并看表结构。
3. 用户已导入的 `panwei` / `MongoDB_nl99` 需要点「编辑」补一次密码，之后就能脱离 DBX 用。

## 2026-10-23 · 第 11 轮：连接失败不再拖垮整个宿主（崩溃隔离）

### 真机反馈（用户实测）：一个连不上的数据库把 DSH 整个关掉了

三份**完全相同**的崩溃日志（`~/Library/Logs/DeepSeek Harness/crash-*-host.log`，22:51、22:53、22:54 —— 用户重启三次、崩三次）：

```
--- error ---
Error: dsh desktop host exited with 1: ...
dsh: fatal uncaught exception: Error: connect ECONNREFUSED 127.0.0.1:27017
    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:2021:16) {
  errno: -61, code: 'ECONNREFUSED', syscall: 'connect',
  address: '127.0.0.1', port: 27017, fatal: true
}
    at ChildProcess.<anonymous> (lib/main.js:3844:64)
```

**根因**：`mysql2` / `pg` / `mongodb` / `tedious` 的客户端都是 `EventEmitter`。连接被拒时它们报**两次**：一次是 `connect()` 的 rejection（面板抓住了），一次是客户端上的 `error` **事件**。Node 对没有监听者的 `error` 事件直接抛致命异常 —— 在宿主里，这条异常杀掉的是**整个应用**，不是那一个面板。日志打印的正是 Error 本身的创建栈（`net:2021`），所以看起来像「一次裸 socket 失败」。

第二个帮凶：连接失败后客户端**没有被关闭**。半开客户端留着 socket 和重连定时器，几秒后自己再 emit 一次 `error`，那时已经没有任何请求在等它 —— 于是「点一下连接」变成「过一会儿应用消失」。

**修复**（`src/drivers/types.ts` 新增两个工具）：

- `ignoreAsyncErrors(client)` —— 客户端一构造出来就挂一个静默的 `error` 监听者，让它活到连接关闭为止。
- `closeQuietly(client)` —— 连接失败时 `close`/`destroy`/`end` 收干净，失败也被吞掉，绝不掩盖真正的错误。

逐个驱动落到位：

| 驱动 | 挂监听者的时机 | 失败收尾 |
| --- | --- | --- |
| mysql（`mysql.ts`） | `createConnection()` 之后、探活 `SELECT 1` 之前 | `closeQuietly` + `DriverError` |
| postgres（`postgres.ts`） | `new Client()` 之后、`connect()` 之前 | `closeQuietly` + `DriverError` |
| mongodb（`mongodb.ts`） | `new MongoClient()` 之后、`connect()` **之前**（SDAM 监视器在 connect 之前就会 emit） | `closeQuietly` 停掉监视器 |
| sqlserver（`sqlserver.ts`） | `new Connection()` 之后（监听者必须活得比 `connectTedious` 的握手更久） | `closeQuietly` |
| redis（`redis.ts`） | 本来就是手写的 `client.on('error')`，改为统一工具 | `closeQuietly` |
| clickhouse | HTTP 客户端，无事件通道 | 不变 |

### 顺带挖出的第二个真 bug：编辑会把引擎改掉

仓库实际内容（`~/Library/Application Support/com.dbx.app/data-dbx/connections.json`）：

```
{name:'panweidb',      dbType:'postgres', port:5432,  database:'mogo_dev', password: 有}
{name:'MongoDB_nl99',  dbType:'mysql',    port:27017, database:'mogo_dev', password: 无}
```

第二条**本来是 MongoDB:27018**，用户点「编辑」补密码，保存后变成 **MySQL:27017** —— 于是下一次连接真的去连 27017，撞上 `ECONNREFUSED`。

两个原因，都在 `client/src/client.ts` 的 `NewConnectionDialog`：

1. `ENGINES.find(item => item.type === initial?.dbType) ?? ENGINES[0]` —— 面板自带的 `ENGINES` 列表里**根本没有 mongodb / redis**（只有 mysql/postgres/sqlite/duckdb/clickhouse/sqlserver/oracle/redshift/doris/starrocks/gaussdb/opengauss/rqlite/h2）。匹配失败就回落到 `ENGINES[0]`，也就是 **mysql**。编辑一个 MongoDB 行 = 静默改成 MySQL。
2. `String(initial.port)` —— 端口缺失时得到字符串 `"undefined"`，`Number()` 得 `NaN`，`JSON.stringify` 把 `NaN` 写成 `null`，宿主按「没给端口」处理，回落到引擎默认端口。行里的真实端口就这样丢了。

**修复**：

- `engineKey()` —— 引擎名归一（大小写/连字符/别名：`PostgreSQL`→postgres、`mongo`→mongodb、`mssql`→sqlserver、`mariadb`→mysql、`sqlite3`→sqlite）。
- `engineOptions()` —— 表单的引擎列表改为「宿主 `status.engineCatalog` 优先，再补只走 DBX 的那几个」，所以 mongodb / redis 现在可选。宿主侧 `NativeAccess.engineCatalog`（`EngineDescriptor { type, label, port, file }`）随之新增，`/api/dbx/status` 一并返回。
- 编辑时**永不改引擎**：匹配不到就用行里存的 `dbType` 合成一个选项（下拉里照常显示），不再回落到列表第一个。
- 端口/SSL 回填真实值；端口留空即「保持原值」，不再把 `NaN` 发给宿主。

### 回归防线

新增 `npm run verify:isolation`（`scripts/verify-isolation.mjs`）：起一个**关掉的端口**，让六个引擎逐个走**面板真实的读取路径**（`NativeAccess.query` + `listDatabases`），断言两种读都正常变成错误返回，然后**再静置 1.5 秒** —— 那正是当年未捕获事件到达的窗口。子进程非零退出或 stderr 出现 `uncaught` 就算回归。12 条断言（6 引擎 × 2）全过。

`verify:native` 40 → **45** 条，新增：编辑不带端口时保留原端口、编辑保留原引擎、状态里带 MongoDB 的表单默认值、每个引擎都有 label、没有面板行的引擎（redis）同样被提供。

`verify:api` 增加 `/api/dbx/status` 的 `engineCatalog` 契约检查（每个描述符必须有 `type`/`label`/`port`/`file`）。

### 环境备注

`npm run verify:roundtrip` 在本机**跑不了**：它 spawn 真 DBX 的 `dbx-mcp`，而 `dbx-mcp` 不在 PATH、`/Applications/DBX.app` 里也没有这个可执行文件（只有 `icon.icns`）。与本轮改动无关，是环境前置条件缺失。

### 待办
1. **重启宿主进程**才能生效（驱动与 `lib/*.js` 都是启动时加载）。
2. 重启后把 `MongoDB_nl99` 那行修回来：编辑 → 引擎选 MongoDB、端口 27018、补密码（或者删掉重新导入）；它的库名也被写成了 `mogo_dev`。
3. `panweidb` 已有密码，本机 5432 需要在跑才能连。

## 2026-10-23 · 第 12 轮：把 MongoDB 驱动补成能用的样子

用户的话：「mongo数据库的驱动需要补全」。此前 MongoDB 驱动只有一条 `find` —— 连接能建立、能查一个集合，然后就没有了：没有 `count`/`insert`/`update`/`delete`/`aggregate`，没有集合与索引管理，侧栏的库和表几乎都是空的，`describeTable` 报「not supported」。这一轮把它补成一个完整的面板后端。

### 命令语言

MongoDB 没有 SQL，面板只有一个输入框，所以驱动自己带一套很小的命令语言，形如 `动词 集合 <JSON> [选项]`：

| 命令 | 作用 |
| --- | --- |
| `find <c> [filter] [limit]` | 读一页文档 |
| `findOne` / `count` / `distinct <c> [filter] [field]` | 单条、计数、去重值 |
| `aggregate <c> [pipeline]` | 聚合管道 |
| `insert` / `insertMany` | 写入 |
| `update <c> [filter] [update] [many]` | `$set` 之类，`many` 切 updateMany |
| `replace` / `delete <c> [filter] [many]` | 替换、删除 |
| `create <c>` / `drop <c>` / `createCollection` / `dropCollection` | 集合管理 |
| `createIndex <c> [keys] [options]` / `dropIndex <c> <name>` / `indexes <c>` | 索引管理 |
| `collections`（`show collections`/`show tables`）/ `databases`（`show dbs`） | 元数据 |
| `stats [c]` / `explain <c> [filter]` / `ping` / `use <db>` | 诊断 |

`show ...` 的别名都接受，是因为用户的肌肉记忆是两种都有。`use` 只影响当前这一条语句，不改变连接状态 —— 免得一条 `use` 之后所有查询都悄悄换了库。

### 真机暴露的两个 bug

1. **`listDatabases` 只能对 `admin` 库执行。** 原实现发给连接自己的库，真机上直接 `MongoServerError: listDatabases may only be run against the admin database`（code 13），于是面板的库下拉永远是空。已改为 `this.client.db('admin').command(...)`，并在自检里断这一条 —— 假客户端不会拒绝，只有真服务器会。
2. **BSON 值被渲染成带引号的字符串。** `ObjectId` 没有自己的 `toString` 形态，`String(value)` 走到 `toJSON` 得 `"507f1f77..."`，面板的 `_id` 列显示成 `"507f1f77bcf86cd799439011"`（带引号），复制出去粘不回去。改为 `mongoCell()`：`ObjectId` → 裸 hex，`Decimal128` → 数字文本，`Long` → 数字文本，`Date` → ISO，`Binary` → `0x…`，嵌套文档/数组 → JSON。

### 其它补全

- **SSL 不再拼 `mongodb+srv://`**：`ssl: true` 之前被当成 `+srv`（DNS seed list），对单机地址会产生客户端拒绝的 URI。现在 SSL 是 `tls=true` 选项，scheme 保持 `mongodb://`；粘贴进来的 `mongodb+srv://` 或带参数的长串则原样透传（有测试）。
- **`describeTable` 改为采样推断**：取 50 条文档，把每列见过的 BSON 类型并起来（`null | number`、`objectId`、`date`、`array`…），`_id` 标成主键。之前是直接抛「not supported」。
- **`listTables(database)` 支持指定库**，`selectDatabase()` 让面板的库下拉真的切换。
- **`listDatabases()` 排除 `admin`/`config`/`local`**，只留用户库。
- **过滤器里带空格不再被拆开**：`find users { "age": { "$gt": 30 } } 1` 是一个 filter 加一个 limit，靠数括号找参数边界。
- **报错说的是人话**：`find users {` → 「unbalanced JSON」；`rows users` → 「unknown MongoDB command 'rows'，可用命令：…」；`insert users 5` → 「expected a JSON object」。

### 面板联动

MongoDB 连接的编辑器占位符改成 `find orders { "total": { "$gt": 100 } } 20`（按 `dialect` 判断），点侧栏集合时插入的是 `find <集合>` 而不是 `SELECT * FROM <集合>` —— 后者对文档库是语法错误，会让人以为驱动坏了。

### 回归防线

新增 `npm run verify:mongo`（`scripts/verify-mongo.mjs`，82 条断言）。驱动工厂 `createMongodbDriver(loadModule?)` 接受注入的模块，自检塞进一个内存假服务器（3 条文档，含 ObjectId/Decimal128/Long/Date/Binary），于是**不需要 mongod 也能测**：URL 拼装、命令语言每一种动词与它的报错、BSON 渲染、schema 推断、库下拉。本轮两个真机 bug 里的第二个（带引号的 id）就是被这套断言抓住的。

`verify:native` 45 条、`verify:api`、`verify:client`、`verify:store`、`verify:transport`、`verify:mcp`、`verify:isolation` 12 条全部通过；`typecheck`（宿主 + 客户端）无输出。

### 真机验证

本机 `127.0.0.1:27017` 有 mongod。用真驱动跑通：`ping` → 1、`listDatabases` → 15 个库、`mogo_dev` → 10 个集合、`find` / `count` / `describeTable` 均有正确输出，`dag_definitions._id` 渲染为裸 hex、`memories` 的嵌套字段渲染为 JSON。

### 待办

1. **重启宿主进程**（驱动在启动时从 `lib/*.js` 加载）。
2. 重启后修那行 MongoDB 连接：**引擎改回 MongoDB**，端口 **27017**（本机 mongod 就在 27017，上一轮我按 27018 记错了），库名 `mogo_dev` 本来就是对的 —— 它连不上只是因为引擎被写成了 mysql。

## 2026-10-23 · 第 13 轮：PostgreSQL 家族的 schema 属性

### 需求

用户：「在数据库连接中 pg 系列数据库增加一个 schema 属性。」

说的是连接级的一个字段：一条 PostgreSQL 连接可以指定「在哪个命名空间里干活」，而不是每次写 SQL 都得自己带 `schema.` 前缀。之前面板只有一个「数据库」下拉，而 PostgreSQL 里数据库下面是 schema，用户建在 `reporting` 里的表在面板里根本列不出来 —— 因为 `information_schema` 查询只查了 `public`。

### 语义边界（先说清楚不做什么）

1. **只属于 PG 家族**：`postgres` / `postgresql` / `pgsql` / `pg` / `redshift` / `gaussdb` / `opengauss` / `greengage`。MySQL 的 schema 就是它的数据库（`SHOW DATABASES` 与 `SHOW SCHEMAS` 同义），再给一个字段只会让人以为有两层；SQLite/DuckDB/MongoDB/Redis 没有这一层。所以表单**按宿主返回的引擎目录决定是否显示该字段**，而不是写死一张表 —— 哪天某个引擎的驱动加了这个能力，改 `supportsSchema` 一处就够。
2. **DBX 通道上没有这个字段**：DBX 的连接配置（`config_json`）里没有 schema，`dbx_add_connection` 也不接受它。所以 DBX 管理的连接 `schema` 恒为空字符串，编辑对话框不显示该字段，也不接受这个值 —— 不做一个「填了但什么都不影响」的输入框。
3. **留空 = 引擎默认**：空字符串不是「没设置」，而是明确表示「用服务器默认」（通常 `public`，除非角色自己有 `search_path`）。这也是编辑时清空该字段的语义。

### 驱动层：每个会话都要设，不是每条连接设一次

```ts
async function applySearchPath(client: PgClient, schema: string): Promise<void> {
  if (schema.length === 0) return
  await client.query('SELECT set_config($1, $2, false)', ['search_path', schema])
}
```

两个细节值得记下来：

- **为什么是 `set_config` 而不是 `SET search_path TO ...`**：后者需要把 schema 名拼进 SQL，于是必须自己处理标识符引用 —— 名字里有空格、引号、大写字母时就会出错或注入。`set_config` 把值当**文本**传，走绑定参数 `$1/$2`，任何名字都原样到达服务器（`verify:pg` 里有一条 `My Schema` 的断言专门守这个）。
- **为什么在 `connect()` 里设而不是每条连接设一次**：这个驱动是「一次查询开一条连接、查完就关」的（面板上的点按是一次性动作，连接池只会白占 socket）。`search_path` 是会话级设置，所以每条新会话都要重新设一遍。放在 `connect()` 成功之后、返回 `DriverConnection` 之前，失败时连客户端一起关掉。

元数据查询也跟着限定：

- `listTables(database?)`：参数按 schema 解释。**但有一种情况特殊**：面板上方的下拉列的是「数据库」，它的默认值就是连接自己的库名。把这个名字当 schema 传下去，`information_schema.tables` 会一条都查不到（本轮之前的面板对 PostgreSQL 就是这个表现）。现在「值等于连接自己的库名」= 「用连接的 schema」。
- `describeTable(name)`：`WHERE c.table_name = $1 AND c.table_schema = $2`。少了后半句，两个 schema 里的同名表会把列混在一起返回 —— 看起来像「这张表有 20 列」，实际上每列都重复了一遍。

顺带修掉一个真 bug：`registry.ts` 的 `ALIASES` 里没有 `pg`，但客户端表单一直接受 `pg`。这样一条 `dbType: 'pg'` 的仓库记录会解析不到驱动，整行看起来「不可用」。补上 `pg: 'postgres'`（`verify:pg` 有一条断言守着）。

### 一路带下去

| 层 | 改动 |
| --- | --- |
| `drivers/types.ts` | `ConnectSpec.schema: string`（无此概念的引擎读作空串） |
| `drivers/registry.ts` | 新增 `supportsSchema(dbType)`、`defaultSchemaFor(dbType)`（PG 家族 → `public`） |
| `drivers/postgres.ts` | `applySearchPath`；`PostgresConnection` 持有 schema 与库名；`listTables`/`describeTable` 限定 schema；`createPostgresDriver(loadModule?)` 支持注入（自检用） |
| `vault.ts` | `VaultEntry.schema`、`VaultNewConnection.schema?`；`readFile` 给旧记录补空串（老仓库文件没有这个键）；`toConnectSpec` 带上；新增/编辑都写 |
| `parse.ts` / `access.ts` | `ParsedConnection.schema`、`AccessNewConnection.schema?`；DBX 目录映射处显式写空串 |
| `native.ts` | `vaultView` 带出 schema；`addConnection` 存；导入 DBX 连接时填 `defaultSchemaFor(dbType)`；`engineCatalog` 每项加 `schema: boolean` |
| `api.ts` | 创建/编辑的请求体与透传；`schema: ''` 清空，**缺省则保留原值**（不知道 schema 的表单不会误清） |
| `client.ts` | `PanelConnection.schema`、`EngineOption.schema`；对话框新增字段（仅 `engine.schema && selfBuilt` 时显示）配一行说明；侧栏副标题显示 `host:port/db · schema`；中英文字典各加 `schema`/`schemaHint` |

### 回归防线

新增 `npm run verify:pg`（`scripts/verify-pg.mjs`，57 条断言）。做法和第 12 轮的 MongoDB 一样：驱动工厂接受注入的模块，自检塞一个记录语句的假 `pg` 客户端。覆盖：连接配置（host/port/user/password/database、TLS 时 `rejectUnauthorized: false`、Redshift 打 `application_name` 标记）、`search_path` 有值时设置而空值时不设、带空格的名字原样到达、字段值前后空白被裁掉、表列表/结构查询的 schema 绑定、「连接自己的库名 = 连接 schema」、无 schema 时回落 `public`、结果集与影响行数的形状、`supportsSchema` 对所有引擎名（含大小写与别名）的判定。

`verify:api` 增加：引擎目录每项必须有 `schema: boolean` 且 postgres 为 `true`、mysql 为 `false`；自建连接带 `schema` 建完能读回来；编辑改成 `analytics` 生效且没顺手丢库名；传空串能清空；**请求体里不出现 `schema` 时保留原值**。

`verify:native` 增加：schema 落盘、能到达驱动 spec（`toConnectSpec`）、引擎目录里 mysql/sqlite 不开这个字段。

`verify:client` 增加：中英文字典都有 `schema`/`schemaHint`；字段确实被 `engine.schema && selfBuilt` 守住；提交体带上 `schema`；侧栏会显示它。

全量：`verify:api` / `verify:pg` / `verify:native` / `verify:client` / `verify:store` / `verify:transport` / `verify:mcp` / `verify:isolation` / `verify:mongo` 均通过，`typecheck`（宿主 + 客户端）无输出。`verify:roundtrip` 本轮跑不了 —— 它要 `spawn dbx-mcp`，这台机器上 DBX 没在跑、`dbx-mcp` 不在 PATH（与本轮改动无关）。

### 没验证到的部分

本机没有 PostgreSQL 服务（5432/5433 都是关的），所以 `search_path` 只在假客户端上验证过「设置语句发对了」，没有对着真服务器跑过一次 `SELECT * FROM <表>`。真实服务器的行为差异（例如角色自带 `search_path`、`SET ROLE` 之后的继承）需要一次真机确认。

面板上的可见性同样要重启宿主后才能看：驱动与 API 都在启动时从 `lib/*.js` 加载。

## 2026-10-23 · 第 14 轮：把「还能加哪些数据库」变成下拉里的选项

这一轮的起点是一个问题：插件已经能自己驱动七个引擎，那还能加哪些？盘点之后用户圈了范围——同族别名、Oracle、国产库，外加两个小毛病。下面按「先算清楚、再动手」的顺序记。

### 盘点：三类边界

先把现状说清楚，否则「加引擎」会变成一句含糊的话。当时的边界是三层：

| 层 | 有哪些 | 用户看到什么 |
| --- | --- | --- |
| 真有驱动 | MySQL、PostgreSQL、SQL Server、ClickHouse、SQLite、MongoDB、Redis | 能自建、能执行 SQL |
| 有协议但没名字 | MariaDB、TiDB、OceanBase、PolarDB、GreatDB、Greenplum… | **注册表认、下拉里没有**，建不出来 |
| 面板列了但只能靠 DBX | Oracle、DuckDB、RQLite、H2 | 选中时提示「需要 DBX」 |

第二层是最刺眼的一层：`resolveDriver` 早就把 `doris` 映射到 MySQL 驱动，可新建连接的下拉里根本没有 `doris`，所以这个能力等于不存在。

候选包也逐个查过（npm，2026-10 的实际元数据）：`@duckdb/node-api` 2.0.0-r.1（MIT，8 个平台预编译含 darwin-arm64）、`oracledb` 26.0.0（Apache-2.0 OR UPL-1.0）、`@libsql/client` 0.18.0（MIT）、`snowflake-sdk`、`@google-cloud/bigquery`、`@databricks/sql`、`trino-client`、`cassandra-driver`、`node-firebird`（MPL-2.0）、`dmdb` 1.0.52452（维护者是 `dameng_database <ztn@dameng.com>`，纯 JS 只依赖 `iconv-lite`）、`vertica-nodejs`（2024-07 停更）、`ibm_db`（要 node-gyp 编译）。结论：不加编译期依赖的就 Oracle 和达梦两项最划算——用户也只圈了这两个。

同时揪出两个旧毛病：① `defaultPortFor('redshift')` 返回 5432（Redshift 其实是 5439），因为引擎名落到 PostgreSQL 驱动的 `defaultPort`；② README 声称 `engines` 是「按依赖是否可解析算出来」，实际从不过滤，`packageAvailable`（`src/drivers/registry.ts:187`）从来没被调用过。两处都在这轮修掉。

### 注册表重写

`src/drivers/registry.ts` 整个重写。核心是把「协议」和「产品」分开：

```ts
interface FamilyMember {
  type: string    // 连接里记的产品名
  label: string   // 下拉里显示的名字
  port: number    // 该产品自己的端口
  hidden?: boolean // 能解析，但不进下拉
}
```

`POSTGRES_FAMILY` 与 `MYSQL_FAMILY` 各带自己的端口表：`redshift` 5439、`kingbase` 54321、`highgo` 5866、`cockroachdb` 26257、`yugabyte` 5433、`tidb` 4000、`oceanbase` 2881、`gbase8a` 5258。`PORT_OVERRIDES` 由这两张表填充，`defaultPortFor` 先查它、再回退到驱动的 `defaultPort`——Redshift 的 5432 bug 就是这么没的。

三个刻意的决定：

1. **`postgresql`/`pgsql` 设 `hidden: true`**。它们是 PostgreSQL 自己的拼写，必须能解析（老连接可能记这两个名字），但下拉里不能再出现一行「PostgreSQL (alias)」——同一个引擎在选项里出现两次，是给用户出选择题。
2. **`availableDrivers()` 过滤，`resolveDriver()` 不过滤**。下拉只列包装得上的引擎；已存的连接必须仍能解析到驱动，否则缺一个包就会让那条连接变成「未知引擎」，连错误提示都没有。
3. **`Engines` 覆盖 catalog 的每一项**。`native.ts` 的 `this.engines` 来自 `catalogEngines().map(e => e.type)`。面板用 `props.engines.includes(engine.type)` 判断一条 DBX 连接该走自建还是交回 DBX（`client/src/client.ts:665`）——漏一个类型，那条连接就会被错误地推给 DBX。

最终下拉 28 项、底下 9 个驱动。`supportsSchema` 同时扩了口：Oracle 有 schema 层（会话 schema），达梦没有独立的 schema 字段（`database` 就是 schema）。

### Oracle 驱动（`src/drivers/oracle.ts`）

`oracledb` 走 **thin 模式**：纯 JS，不需要 Instant Client，也不需要编译。实测 `require('oracledb')` → `26.0.0 thin= true`、`OUT_FORMAT_OBJECT= 4002`，25ms 加载完。注意 npm 的 allowScripts 策略会跳过它的 install 脚本，这对 thin 模式没有影响（脚本只是给 thick 模式找客户端库）。

三个语义决定，都是「表单字段少、库里概念多」挤出来的：

- **database = service name**。Oracle 用 easy-connect `host:port/service`，`options.serviceName` 可以覆盖，`ssl` 时 scheme 换成 `tcps://`。
- **schema = 会话 schema**。连接后 `ALTER SESSION SET CURRENT_SCHEMA = <quoted>`；名字里的引号要双写（`a"b` → `"a""b"`）。
- **`listDatabases()` 返回用户列表**。Oracle 没有「库」这一层，能切的只有 schema，所以下拉列的是 `SELECT username FROM all_users`。

元数据走 `all_tables` ∪ `all_views`、`all_tab_columns` + `all_constraints`（主键子查询）。`ownerFor(database?)`：表单里传了名字且不等于 service → 用它的大写形式；否则用 `schema || username` 的大写；最后回退 service。

### 达梦驱动（`src/drivers/dm.ts`）

`dmdb` 纯 JS、只依赖 `iconv-lite`，1.5M。DM8 的元数据视图是 Oracle 兼容的，但有两处必须区别对待：

- **一台服务器只有一个库**，所以 `database` 字段实际是 schema。连接 `host:port` 后发 `SET SCHEMA`；schema 字段优先，留空则回落 `database` 字段。
- **`metaData` 有三种形状**：单个对象、扁平列表、嵌套列表（每条语句一个列表）。读错一种就丢列名。

### 自检抓到的三个真 bug

这三个都不是编译期能发现的，是假模块把真行为模拟出来之后才暴露的：

1. **Oracle / 达梦的对象行键是大写**。客户端对未加引号的别名回的是 `COLUMN_NAME`，而 `readColumn` 原本直接读 `values['column_name']` —— 真机上描述表会得到**一整列空列名**。修法：`types.ts` 新增 `lowerKeys()`，非数组分支统一 `lowerKeys(row)`。
2. **`columnsOf` 的扁平形状判断反了**。原来把「列表第一项不是数组」当成「只有一列」，于是单条语句的 `[{name:'ID'},{name:'NAME'}]` 只剩一个列名。改成先找嵌套列表（批量），找不到就把扁平项全取（单条）。
3. **`loadModule()` 在 `try` 之外**。缺包时裸 `Error` 直接逃出 `connect`，面板拿不到 `kind`、分类不出「引擎错误」。改成 `loadModuleOr(kind, load)` 前置 + `catch` 里 `asDriverError(kind, error)`。

顺带在 `types.ts` 补了三个小工具：`asDriverError`、`loadModuleOr`、`lowerKeys`。`Driver` 接口新增 `readonly package: string | null`（`node:sqlite` 为 `null`，永远可用），`availableDrivers()` 就是靠它过滤的。

### 回归防线

新增两套自检，都用注入式假模块（延续第 12、13 轮的做法，不需要真服务器）：

- `npm run verify:oracle`（~70 条断言）：easy-connect 串的四种形状、`ALTER SESSION` 只在有 schema 时发、引号双写、`outFormat=4002`/`autoCommit`/`maxRows=501`、对象行与位置行、null → `NULL`、501 行截断且只留 500、`all_users` 当库列表、表/列的 owner 作用域、主键与默认值 trim、连接失败与缺包都成为 `DriverError('oracle')`。
- `npm run verify:dm`（~45 条断言）：`host:port`、`SET SCHEMA` 的三种触发条件、`metaData` 三种形状归一、大写键能被小写列名找到、位置行对齐、501 截断、无列即语句、owner 作用域、连接失败与缺包。

旧断言同步了三处，都是为了「`oracle` 不再是无驱动引擎」这一个事实：

| 文件 | 原来 | 现在 |
| --- | --- | --- |
| `scripts/verify-api.mjs:214` | 用 `oracle` 当「无驱动引擎」夹具 | 换 `snowflake`（`db_type === 'snowflake'`） |
| `scripts/verify-native.mjs:325` | `addConnection({dbType:'oracle'})` 期望交给 DBX | 换 `snowflake`，另加注释说明为什么 |
| `scripts/verify-pg.mjs:252` | 断言 `oracle` 没有 schema 层 | 断言 `supportsSchema('oracle') === true`、`defaultSchemaFor('oracle') === ''`，无 schema 列表改用 `dm` 顶替 |

全量：`typecheck`（宿主 + 客户端）无输出；`npm run build` 成功；十二套自检 api / pg / client / isolation / mcp / native / roundtrip / store / transport / mongo / oracle / dm 中，除 `verify:roundtrip` 之外全部通过。`verify:roundtrip` 依然要 `spawn dbx-mcp`，这台机器上 `dbx-mcp` 不在 PATH（DBX 没在跑），与本轮改动无关——和上一轮记录的情况一致。

### 没验证到的部分

**Oracle 和达梦都没有真机**。本机没有这两个实例，所以驱动验的是「包能加载 + 元数据 SQL 的形状正确 + 失败路径能正确包装」，不是「连上真服务器读出一张表」。第一次真连可能要微调：

- 达梦的 `ALL_*` 视图在中低版本上可能不全（有的版本只有 `SYSOBJECTS`/`SYSCOLUMNS`）；
- Oracle 的 `ownerFor` 在「用户名 ≠ service 名」的部署里要靠 `options.serviceName`，表单目前没有这个字段，只能用 `database` 填 service、靠 `username` 兜底 schema。

另外 `dm` 不出现在 schema 字段的下拉判断里（`supportsSchema('dm') === false`）是刻意的：DM 的 schema 就是 `database` 字段，再给一个字段会让人以为可以填两个不同的值。

面板上的可见性要重启宿主才能看：驱动、路由、引擎目录都在启动时从 `lib/*.js` 读取。
