# dsh-data-dbx

把 [DBX](https://github.com/t8y2/dbx) 的数据库连接、SQL 执行与**跨库联邦查询**接成 DeepSeek Harness 的原生工具。

插件本身不实现数据库驱动、不解密凭据、不做查询规划：它读取 DBX 已经存好的连接目录，启动 `dbx-mcp` 子进程，把 DBX 的能力暴露成 4 个模型可见工具。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `dbx_list_connections` | 列出 DBX 中的连接（id、名称、引擎、端点、联邦开关）。**先调这个**，另两个工具用它的 id 或名称寻址。 |
| `dbx_execute_query` | 对单个连接执行一条 SQL，返回 markdown 表格。 |
| `dbx_federated_query` | 跨连接联邦查询：一条 SQL 里 JOIN 多库的表。 |
| `dbx_federation_status` | 探测各连接的联邦就绪状态，写联邦 SQL 前先确认。 |

## 跨库联邦查询

在一条 SQL 里把多个库的表 JOIN 起来，由 DBX 的 DataFusion 联邦引擎执行：

```sql
SELECT c.c_customer_id, c.c_first_name, ss.ss_quantity
FROM pglocal.public.customer c
JOIN mysqlocal.tpcds.store_sales ss
  ON c.c_customer_sk = ss.ss_customer_sk
LIMIT 5
```

这个例子把 **PostgreSQL** 的 `customer` 与 **MySQL** 的 `store_sales` 关联起来。

### 表名格式：`<连接名>.<schema>.<表名>`

三点必须注意：

1. **三段，不是四段。** DataFusion 的标识符层级是 `catalog.schema.table`，`database` 不属于该层级。写四段会报 `Expected 1, 2 or 3 parts, got 4`。
2. **第一段是连接「名称」，不是连接 ID。** DataFusion 的 catalog 按连接名注册。用 UUID 会报 `ParserError: Expected: identifier`（UUID 含连字符，不是合法标识符）。
3. **每个被引用的连接都要开启联邦。** 用 `dbx_federation_status` 先确认。

> 注：DBX 仓库的 `MCP_SETUP.md` 对这两点的描述与实现不符（它写的是「四段或三段」且「必须用连接 ID」）。以上行为经实测与源码（`crates/dbx-core/src/federation/executor.rs`、`tests/federation_http_e2e.rs`）双重确认。

联邦查询**严格只读**，不支持跨连接写入。

## 依赖：需要带 federation 的 dbx-mcp

联邦能力在 dbx-mcp 中是**非默认 feature**，npm 上发布的 `@dbx-app/mcp-server` **不含**联邦工具。要使用 `dbx_federated_query`，需自行构建：

```sh
git clone https://github.com/t8y2/dbx
cd dbx
cargo build --release -p dbx-mcp --features federation --bin dbx-mcp
cp target/release/dbx-mcp ~/.local/bin/
```

不带 federation 的构建仍可使用 `dbx_list_connections` 与 `dbx_execute_query`。

## 数据库面板（GUI）

除了给模型用的 4 个工具，插件还在 DeepSeek Harness 里挂了一个**「数据库」面板**：侧边栏出现一个数据库图标，点开就是 DBX 的主界面形态——左边是连接列表，右边是 SQL 编辑器和结果表格。

面板有**两条独立的通路**，同一张列表里混排，每条连接带自己的来源徽标：

- **自建连接**（徽标「自建」）：连接存在插件自己的加密仓库里，SQL 由**插件自带的驱动栈**直接执行，不需要 DBX 存在。
- **DBX 连接**（徽标「DBX」）：连接和密码仍归 DBX 管，插件只把请求转给 DBX（下面那张传输链表）。

面板能做的事：

| 操作 | 自建连接 | DBX 连接 |
|---|---|---|
| 列出连接 | `data-dbx/connections.json` | DBX 目录（`dbx.db`）或 `dbx_list_connections` |
| 新增连接 | 有驱动的引擎写进插件仓库（密码用 AES-256-GCM 加密后落盘） | `dbx_add_connection`；桥接/目录模式下直接写 DBX 自己的目录表 |
| 测试连接 | 开一条真连接跑 `SELECT 1` | `dbx_execute_query`（DBX 没有独立的 test 工具） |
| 执行 SQL | 插件自带驱动，点「执行」就走 | `dbx_execute_query`（桥接模式下走桌面桥接的 `/data/execute-query`） |
| 列出数据库 / 表 | 驱动自己的元数据查询 | `dbx_list_databases` / `dbx_list_tables` |
| **查看表结构** | ✅ 列名、类型、可空、默认值、主键 | ❌ 不显示按钮（结构只能由插件自己的驱动读） |
| 修改 / 删除连接 | 直接改插件仓库 | `dbx_remove_connection`；桥接/目录模式下直接删目录行 |
| 从 DBX 导入 | — | ✅ 一键把 DBX 目录里的连接复制进插件仓库（密码需重填） |

> 导入之后**同一个连接只会出现一行**（「自建」那条），DBX 那行被仓库副本取代——因为只有副本能在 DBX 关闭时执行 SQL。DBX 的密码不外借，导入的副本第一次执行会提示补密码：选中它点「编辑」，填上密码保存即可。

面板还会在右侧列出当前连接的表，点一下就把表名插入编辑器；表名旁的 `▤` 按钮看表结构。`Cmd/Ctrl + Enter` 执行语句。

### 自建通道：插件自己的驱动栈 + 加密仓库

这条通路是让面板**脱离 DBX 也能用**的关键。它不是去读 DBX 的实现，而是插件自己做了一份最小可用的「连接仓库 + 驱动层」：

- **驱动层** `src/drivers/`：每个驱动一个文件，**包按需懒加载**——没装 `pg` 就不影响 `mysql2`，连到不支持的引擎会明确报「the "pg" package is not installed」而不是崩。已实现九个协议驱动：PostgreSQL、MySQL、SQL Server、ClickHouse、SQLite、MongoDB、Redis、Oracle（`oracledb` thin 模式，无需 Instant Client）、达梦 DM8（`dmdb`）；SQLite 用 Node 内置的 `node:sqlite`（`DatabaseSync`），不引第三方依赖。
- **引擎名归一** `src/drivers/registry.ts`：DBX 的 `db_type` 是**产品名**而不是协议名，所以这里维护两张家族表——PostgreSQL 家族（`postgresql`/`pgsql` 是同一数据库的拼写，另有 `redshift` **5439**、`gaussdb`、`opengauss`、`greengage`、`kingbase` **54321**、`highgo` **5866**、`vastbase`、`cockroachdb` **26257**、`yugabyte` **5433**、`timescaledb`）与 MySQL 家族（`mariadb`、`tidb` **4000**、`oceanbase` **2881**、`polardb`、`greatdb`、`gbase8a` **5258**、`goldendb`、`doris`、`starrocks`）。每个家族成员带自己的标签与默认端口，所以引擎目录里有 28 项、底下只有 9 个驱动（面板再把 DuckDB、RQLite、H2 几个只有 DBX 能开的引擎接在后面）。`catalogEngines()` 就是这份目录；`availableDrivers()` 会按「npm 包是否解析得到」过滤，缺包时下拉不出现该引擎，但**已存的连接仍能解析**（否则会变成面板打不开的未知引擎）。
- **连接仓库** `src/vault.ts`：`<dataDir>/data-dbx/connections.json`，一条记录 = 一个连接。密码**不落明文**：首次使用生成 32 字节随机主密钥写到同目录的 `master.key`（`0600`），AES-256-GCM 加密，每条连接独立随机 IV，落盘格式是自描述的 `aes256gcm.<ivB64>.<cipherB64>.<tagB64>`（4 段）。读的时候按段解析并校验段数与 IV/tag 长度，截断的密文会明确报「this vault holds a truncated password」，而不是静默解出乱码。
- **Schema**：PostgreSQL 家族（`postgres`/`postgresql`/`pgsql`/`pg`/`redshift`/`gaussdb`/`opengauss` 等）多一层命名空间。连接对话框里填的 schema 会被驱动在**每个会话**上设成 `search_path`（`SELECT set_config('search_path', $1, false)`，值走绑定参数，名字里有空格也不用引号处理），所以 `SELECT * FROM users` 会解析到该 schema；表列表与结构视图的 `information_schema` 查询也限定在同一个 schema。留空 = 服务器默认（通常是 `public`）。Oracle 也有这一层，但语义不同：它是**会话 schema**，连接后由驱动发 `ALTER SESSION SET CURRENT_SCHEMA`，默认值是登录用户本身，所以表单不预填。达梦更特殊：一台服务器只有一个库，`database` 字段实际上就是 schema，驱动连接后发 `SET SCHEMA`；表单里 schema 字段优先，留空则回落到它。MySQL 的 schema 就是它的数据库、文档库没有这一层，所以表单只对支持 schema 的引擎显示该字段；DBX 的连接配置里没有 schema 字段，因此 DBX 通道上的连接不显示、也不接受这个值。

- **能力适配** `src/native.ts`：`NativeAccess` 实现和 DBX 通路同一套 `DbxAccess` 接口，所以 `api.ts` 与客户端**不需要知道**自己面对的是哪个后端。`NativeAccessProvider` 先试自建、再落到 DBX 传输链，并在同一张列表里合并两边的连接；`/status` 的 `mode` 因此多了 `native` 一个值。

`GET /api/dbx/status` 还会返回 `engines`（下拉里全部引擎的类型名，含同族产品）、`engineCatalog`（每个引擎的标签、默认端口、是否文件型、**是否有 schema 层**）和 `vaultCount`（自建连接数），新建连接对话框据此决定哪些引擎可选、以及要不要显示 schema 字段。`engines` 必须覆盖 catalog 的每一项：面板用它判断一个 DBX 连接该走自建还是交回 DBX，漏一个就会把能自建的连接错误地推给 DBX。

> **密钥强度的边界，说清楚**：主密钥是随机生成的，**存在密文旁边的 `master.key` 里**，两者都靠文件权限保护（`0600` / 目录属主）。所以它的实际强度等于「这个目录的文件权限」：
>
> - 防住了「密码明文躺在 `connections.json` 里」——单独把 `connections.json` 拷走、贴进 issue、被备份工具同步出去，都读不到密码；
> - **没防住**「能读这个目录的人」——他能连 `master.key` 一起读走。这不是硬件根信任链（不是 Keychain / Secure Enclave）。
>
> 想要更强的保证，二选一：同一条连接改用 DBX 管理（密码由 DBX 用钥匙串加密），或者把 `dataDir` 指向一个权限更严的位置。

### 传输链：五种模式，按能力依次尝试

DBX 的连接和密钥由 DBX 自己保管（`dbx.db` + `connection_secrets`，AES-256-GCM，密钥在 macOS 钥匙串）。宿主半因此**不持有任何驱动、密码或连接状态**，只负责在几条通路里挑一条能用的，并把面板不支持的动作藏起来：

| 模式 | 来源 | 能做什么 |
|---|---|---|
| `native` | 插件自带的驱动栈 + 加密仓库 | 自建连接的全部动作；DBX 不可用时其余连接仍能列 |
| `desktop-mcp` | DBX 桌面自带的 MCP HTTP 服务（默认关，`127.0.0.1:5225/mcp`） | 全部：列/增/删连接、执行 SQL、列表 |
| `stdio-mcp` | 无头 `dbx-mcp`（能读到钥匙串密钥时） | 全部 |
| `bridge` | DBX 桌面桥接（`mcp-bridge-port`） | 执行 SQL、列表；增删连接由本插件写 DBX 目录表 + 调 `/reload-connections` 让桌面刷新 |
| `catalog` | 仅 `dbx.db` 目录（DBX 没在运行） | 列/增/删连接、列数据库；**不能执行 SQL** |
| `none` | 什么都没有 | 全部不可用，并给出下一步提示 |

- 探测顺序是 `native` → `desktop-mcp` → `stdio-mcp` → `bridge` → `catalog` → `none`：**只要能自建就绝不会因为 DBX 没开而退化成只读**。
- `GET /api/dbx/status` 返回当前模式、来源和能力（外加 `engines` / `vaultCount`），面板左下角显示通道徽标；某个能力不可用时按钮直接置灰并给出提示文案。
- 每次连接 MCP 都会先用 `dbx_list_connections` **探活**：无头服务虽然能启动、能答 `tools/list`，但打不开加密目录时会逐条报 `SECRET_KEY_UNAVAILABLE`，不探活就会选中一个假通的通道。
- 桥接端口会先用 TCP 探一下：`mcp-bridge-port` 文件在 DBX 退出后仍然留着，不探活会把已死的通道当成活的。

### 两半结构

- **浏览器半** `client/src/client.ts` → 编译成 `lib/client.js`，只负责渲染，通过同源 `fetch('/api/dbx/*')` 与宿主通信，不直接碰数据库。
- **宿主半** `src/api.ts`（路由与参数翻译）+ `src/native.ts`（自建通道）+ `src/access.ts`（DBX 传输链与能力）→ 在 harness 的 connection 服务上注册 10 条精确路由，先问自建通道，问不到再翻译成 DBX MCP 工具调用或 DBX 目录读写，并把 DBX 的 markdown 输出解析成表格行。
- `src/catalog.ts` 用 `node:sqlite` 只读打开 `dbx.db`（**会正确应用 WAL**，手写的解析器读不到 WAL 里的新行），`src/store.ts` 负责按 DBX 自己的表结构写目录（`connections` 存无密码的 `config_json`，密码走 `connection_secrets` 的旧明文列，DBX 下次读取时会自己加密）。

宿主 API 只在 `connection` 服务存在时注册（`ctx.inject(['connection'], …)`），所以无头运行（只有 CLI/模型工具）时不受影响。

### 装上面板

面板要求三件事同时成立：

1. `lib/client.js` 已经构建出来（`npm run build`；harness 找不到这个文件会**直接报错**，不会静默跳过）；
2. profile 的 `package.json` 的 `dsh.profile.bundles` 里含 `dsh-data-dbx`；
3. harness 重启过（新插件在启动时注册，之后再装需要重启一次）。

### 跑起来的前提

- **`dbx-mcp` 二进制必须能找到。** 解析顺序：配置的 `command` → 环境变量 `DBX_MCP_COMMAND` → `PATH` → `~/.local/bin`、`~/bin`、`~/.npm-global/bin` → npm 全局 `node_modules/@dbx-app/mcp-*` → 工作区里的 DBX 检出；都找不到就退化成 `'dbx-mcp'` 并给出提示。本机实测解析到 `/Users/cooper/Github/dbx_fed/dbx/node_modules/.pnpm/node_modules/@dbx-app/mcp-darwin-arm64/bin/dbx-mcp`（来源 `workspace`）。
- **要用无头通道，得先解决钥匙串。** 钥匙串条目 `com.dbx.app.secret-store.v1` / `local-data-encryption-key` 存在，但非交互读取会被 ACL 挡下，报 `SECRET_KEY_UNAVAILABLE`。二选一：
  - 用**同一个**官方 `dbx-mcp` 可执行文件跑一次 `dbx-mcp --authorize-keychain`，在终端里点「始终允许」（非交互会话里会直接失败：`KEYRING_ACCESS_FAILED: existing DBX Keychain key cannot be authorized: UNIX[Operation not permitted]`）；
  - 或把密钥导出给无头进程：`DBX_SECRET_KEY` / `DBX_SECRET_KEY_FILE`。
- **进程要能写 DBX 数据目录。** `dbx-mcp` 以读写方式打开 `dbx.db`（WAL），只读挂载会报 `attempt to write a readonly database`。
- **自建连接不需要 DBX**。这是本轮的重点：装好依赖（`npm i`）后面板自带驱动，DBX 开不开、装不装都不影响自建连接执行 SQL。
- **DBX 连接要执行 SQL，DBX 桌面得在运行**（走桥接），或者启用了桌面的 MCP HTTP 服务，或者无头 `dbx-mcp` 能读到密钥。DBX 没开时，DBX 那部分连接会自动降到「仅配置目录」：仍能列/增/删，执行按钮置灰。
- **DDL 属于高风险 SQL**，DBX MCP 默认拦截（`Error [SQL_BLOCKED]: High-risk SQL is disabled in DBX MCP settings.`），需要放行高风险 SQL 才能跑 `CREATE TABLE` 等语句。
- **SQLite / DuckDB 连接指向的文件必须已存在**才能交给 DBX（它拒绝代建，`Error [DBX_TOOL_ERROR]: File does not exist: …`）。自建通道会在新增时直接建一个空文件；经由 DBX 时面板也会先建一个空文件。

### 自检脚本

```sh
npm run verify:native      # 自建通道：导入、真 SQLite 文件、增删改、结构、脱敏、换密钥、DBX 回退
npm run verify:pg          # PostgreSQL 驱动：search_path、schema 限定的表列表与结构，无需服务器
npm run verify:mongo       # MongoDB 驱动：命令解析、BSON 渲染、集合与索引，无需服务器
npm run verify:oracle      # Oracle 驱动：easy-connect、CURRENT_SCHEMA、元数据视图、截断，无需服务器
npm run verify:dm          # 达梦驱动：SET SCHEMA、三种 metaData 形状、元数据视图，无需服务器
npm run verify:api         # 宿主路由：注册、参数翻译、DBX 输出解析、/status、自建/DBX 分流
npm run verify:client      # 浏览器半：包注册、侧边栏入口、主面板、字典
npm run verify:store       # 目录写入：写/读/删连接，密码不进 config_json
npm run verify:roundtrip   # 目录往返：复制真实 dbx.db 后 列→增→列→删→列
npm run verify:transport   # 真机解析当前走哪条通道、能力如何
npm run verify:mcp         # 端到端：真连 dbx-mcp，增删连接、跑 SQL、列表
```

`verify:mcp` 会把 `dbx.db` 复制到临时目录再跑，并给 MCP 进程一个临时的 `DBX_SECRET_KEY_FILE`，因此不碰真实目录、也不需要钥匙串授权；`verify:roundtrip` 只操作副本，不写用户的真实 DBX 目录。

## 安装

```sh
dsh plugin --profile desktop add dsh-data-dbx
```

> 桌面 profile 由 Electron 应用独占管理，命令行会拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 这种情况下在 harness 的插件管理界面里安装，或者手动改 profile。

或手动：在 profile 的 `node_modules/` 下软链本包，并把 `dsh-data-dbx` 加入
`package.json` 的 `dsh.profile.bundles`。

手动安装时注意：**先把 `lib/client.js` 构建出来**（`npm run build`），再启动 harness。
harness 启动时按 `exports["./client"]` 找浏览器半的产物，找不到会直接报
`client-modules: client bundle not found; run 'pnpm run build' before launch`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `dbx-mcp` | MCP 服务可执行文件。指向带 federation 的构建以启用联邦。 |
| `args` | `[]` | 传给 MCP 服务的额外参数。 |
| `dataDir` | 见下 | 存放 `dbx.db` 的 DBX 数据目录。 |
| `env` | `{}` | MCP 服务进程的额外环境变量。 |
| `startupTimeoutMs` | `30000` | 启动握手超时（毫秒）。 |
| `timeoutMs` | `120000` | 单次工具调用超时（毫秒）。 |
| `maxRows` | `100` | 单条语句返回行数上限。 |

### `dataDir` 解析规则

与 DBX 自身一致（对应 `crates/dbx-mcp/src/paths.rs`）：

1. 显式配置的 `dataDir`；
2. 环境变量 `DBX_DATA_DIR`；
3. 平台数据目录 + `com.dbx.app`（macOS 为 `~/Library/Application Support/com.dbx.app`）。

> **注意**：DBX Desktop 与 DBX Web 使用**两套独立的连接存储**，ID 互不相同。
> 默认读取的是 Desktop 那份；要读 Web 那份，需显式设置 `dataDir` 为 `~/.dbx-web`。

## 安全

- 对 **DBX 连接**，插件从不读取、解密或存储密码：DBX 把密码存在自己的 `connection_secrets` 表中并自行解密，插件只读非密的连接配置。
- 对**自建连接**，密码必须由插件自己保管，因此用随机主密钥（`data-dbx/master.key`，`0600`）+ AES-256-GCM 加密后写入 `data-dbx/connections.json`，落盘格式 `aes256gcm.<iv>.<ciphertext>.<tag>`，每个连接独立随机 IV；`verify:native` 会断言仓库文件里搜不到明文密码，也会断言密文带 `aes256gcm.` 前缀。
- `master.key` 是**唯一**能解开仓库的东西：删了它就等于删掉所有自建连接（重新生成会得到新密钥，旧密文再也解不开）。删单条连接请用面板。
- 好消息是 `master.key` 与 `connections.json` 都不会被提交——`data-dbx/` 在 DBX 的应用数据目录下，不在仓库里。
- `dbx_list_connections` 返回的连接摘要不含任何密钥字段。
- `dbx_federated_query` 固定使用 `federation_mode: 'require'`：联邦不可用时返回明确错误，而非静默回退到单连接执行——避免「看起来联了、实际没联」的误导。

## 限制

- 联邦查询只读，不支持跨连接写入。
- **自建通道每次查询开一条新连接，用完即关**，没有连接池：单条语句的延迟里含一次握手，高频小查询会比 DBX 慢。
- 自建通道的驱动覆盖 PostgreSQL、MySQL、SQL Server、ClickHouse、SQLite、MongoDB、Redis、Oracle、达梦九类，另有二十来个同族产品名复用前两类协议；DuckDB、RQLite、H2、Snowflake、Cassandra 等仍只有 DBX 有驱动，这类引擎的新建连接会自动交给 DBX。
- **Oracle 与达梦没有在真机上验证过**：本机没有这两个实例，驱动只验过「包能加载 + 元数据视图的 SQL 形状」（`verify:oracle` / `verify:dm` 用注入的假模块）。第一次连真服务器可能要微调元数据视图（达梦的 `ALL_*` 视图在中/低版本上可能不全）。
- `oracledb` 的安装脚本被 npm 的 allowScripts 策略跳过时也能用：驱动走的是 **thin 模式**（纯 JS，不需要 Instant Client），`require('oracledb')` 实测 `26.0.0 thin=true`。
- **MongoDB 没有 SQL**，面板的输入框对它是自己的一套命令语言：`find <集合> [filter] [limit]`、`count`、`distinct`、`aggregate`、`insert`/`insertMany`、`update`、`replace`、`delete`、`create`/`drop` 集合、`createIndex`/`dropIndex`/`indexes`、`collections`（也接受 `show collections`）、`databases`（`show dbs`）、`stats`、`explain`、`ping`、`use <库>`。占位符和点集合时的插入内容会按引擎自动切换。
- 每次插件加载会启动一个 `dbx-mcp` 子进程；首个工具调用时才惰性启动。
- 子进程崩溃后会在下次调用时自动重建，但该次调用会失败一次。

### ⚠️ 联邦 SQL 中避免使用中文（或非 ASCII）标识符

DBX 联邦引擎有一个 UTF-8 处理缺陷（`crates/dbx-federation/src/executor.rs:844`）：它按**字节**而非字符切分 SQL 字符串，当切分点落在多字节字符内部时会 panic，导致 `dbx-mcp` 进程崩溃。

实测触发语句：

```sql
SELECT c.c_first_name AS 名 FROM pglocal.public.customer c
JOIN mysqlocal.tpcds.store_sales s ON c.c_customer_sk = s.ss_customer_sk LIMIT 1
```

```
thread 'tokio-rt-worker' panicked at crates/dbx-federation/src/executor.rs:844:31:
start byte index 27 is not a char boundary; it is inside '客' (bytes 26..29 of string)
```

**规避方式**：联邦 SQL 中的表别名、列别名、注释均使用 ASCII 标识符，中文仅出现在查询结果的**数据值**中（数据值不受影响）。

```sql
-- 推荐：别名用 ASCII
SELECT c.c_first_name AS name, ss.ss_quantity AS qty
FROM pglocal.public.customer c
JOIN mysqlocal.tpcds.store_sales ss ON c.c_customer_sk = ss.ss_customer_sk
```

这是 DBX 侧的问题，插件无法修复。崩溃后插件会在下次调用时自动重建服务并恢复（实测约 204 ms）。
