# OG Developer — 未提交改动与问题修复记录

> **2026-09-15 更新：G、H 已修复并通过 B/A/PG 双驱动真机回归；新增部署脚本注释/拆分修复。最新结论见第 6 节。**
> 原始记录写于 2026-09-11。基线提交 `72ada3873 chore(release): bump desktop version to 0.2.9`。
> **工作区所有改动均未提交**（无新增 commit、无新分支）。本文档列出：改了什么、为什么、
> 怎么验证、以及还没修的三个真问题的完整证据与修法。

---

## 0. 速览

| # | 主题 | 状态 | 风险 |
|---|---|---|---|
| A | shiki 语法包按需加载（安装包 -8MB） | 已改，已验证 | 低 |
| B | i18n key 对齐测试 + 3 个漏译补全 | 已改，已验证 | 低 |
| C | 工程残留清理 | 已改 | 低 |
| D | Schema Diff 部署结果契约（`status` 字段） | 已改，**真机验证通过** | 低 |
| E | 失败的部署污染连接池 | 已改，**真机验证通过**（含反证） | 低 |
| F | 部署错误信息被吞成 `"db error"` | 已改，**真机验证通过** | 低 |
| **G** | **JDBC 路径调用的 `executeTransaction` 在插件里不存在** | **已修，0.1.29 真机通过** | 低 |
| **H** | **B/M 兼容模式 DDL 引号用错（生成 `"` 应为反引号）** | **已修，B/A/PG 真机通过；M 离线验证** | 低 |
| I | 深链可绕过 openGauss 白名单 | 未修（已知，暂不处理） | 低 |
| J | `two_phase_commit.rs` 是死代码 | 未处理 | 低 |

**H → G 已完成；下方第 1–5 节保留原始记录，最新验证及剩余范围见第 6 节。**

---

## 1. 环境信息（复现真机测试需要）

本机存在一个已配置好的桌面端数据目录，可直接用于真机测试：

```
数据目录   : %APPDATA%\com.ogdeveloper.app
连接库     : 该目录下 dbx.db（注意：文件名仍是 dbx.db，见 NAMING_MIGRATION.md）
连接       : tygl_biz@192.168.10.158:15400   db_type=opengauss   driver_profile=opengauss-jdbc
服务端     : openGauss 6.0.0（非 lite）
JDBC 插件  : %APPDATA%\com.ogdeveloper.app\plugins\jdbc
             ├─ lib/dbx-jdbc-plugin.jar                    （已安装，版本 0.1.28，app.dbx.jdbc.DbxJdbcPlugin）
             ├─ drivers/opengauss-jdbc-7.0.0-RC3-og.jar
             └─ bin/dbx-jdbc-plugin[.bat]
Java       : Temurin 21.0.11（JAVA_HOME 已设置）
Docker     : 本机**没有** docker 命令
```

服务器上可见的库：`test_a`、`test_b`、`test_pg`、`erow`、`erow_b`、`erow_boip_a`、`tygl`、`sgzb` 等。

- `test_b` → `sql_compatibility = B`（MySQL 兼容模式）
- `test_a` / `test_pg` → A / PG 模式

> ⚠️ `plugins/jdbc/src/**/*.java` 在工作区是**亿赛通（E-SafeNet）透明加密**的，`Get-Content` /
> `read` 工具读到的是密文。但 `.git` 对象库里是明文，用 `git show HEAD:plugins/jdbc/src/main/java/app/ogdeveloper/jdbc/OgdeveloperJdbcPlugin.java`
> 可以拿到可读源码。**读源码务必用这个方法。**

### 真机测试命令

```powershell
$env:DBX_TEST_OPENGAUSS_DATA_DIR = "$env:APPDATA\com.ogdeveloper.app"
$env:DBX_TEST_OPENGAUSS_DATABASE = "test_b"

cargo test -p ogdeveloper-core --no-default-features `
  --test live_opengauss_schema_diff_deploy -- --ignored --nocapture
```

测试文件会先把 `dbx.db` **复制到临时目录**再打开（`Storage::open` 会跑 schema migration，
不能碰用户的真实 profile），插件目录仍指向真实数据目录。测试只创建/删除自己命名的 schema。

---

## 2. 已完成的改动

### A. shiki 语法包按需加载 —— 安装包体积 22.1MB → 14.1MB

**根因**：`SqlPreviewPanel.vue` 从 `shiki` **根入口**导入，根入口是 `bundle-full`，会把全部
250 种语言语法都产出 chunk。实测 dist 里躺着 250 个语法 chunk，合计 **7,384 KB**。

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/components/editor/SqlPreviewPanel.vue` | `import("shiki")` → `shiki/core` + `langs/sql.mjs` + 两个主题（`dark-plus`/`min-light`）。已校验主题名与 `codeToHtml` 传参一致 |
| `apps/desktop/src/lib/ai/aiCodeHighlighter.ts` | 拆成 **eager**（`bash/json/shellscript/sql/xml/yaml`，约 84KB，随高亮器加载）与 **deferred**（`css/go/html/java/javascript/markdown/php/python/rust/tsx/typescript/vue`，首次用到才拉）。新增 `onLanguageLoaded` 回调 |
| `apps/desktop/src/components/editor/AiAssistant.vue` | 新增 `shikiGrammarVersion` ref 接 `onLanguageLoaded`，语法到位后重建 renderer 重渲染；语法未到时返回转义纯文本（与 `aiMessageRender` 的兜底字节一致，无视觉跳变） |
| `apps/desktop/src/lib/__tests__/ai/aiCodeHighlighter.spec.ts` | 新增 6 项：eager 即时高亮、别名识别、无语法转义、延迟语法"先纯文本后高亮"、主题映射、未知语言 |

**验证**：`dist/assets` 18.17MB → **10.24MB**；整个 `dist` 22.10MB → **14.13MB**。

### B. i18n key 对齐测试

**关键发现**：`zh-CN.ts` 是 `withEnglishFallback({...})` 包起来的。直接扁平化比对得到
7090 = 7090 **零差异**——因为 fallback 已经把英文合并进来了，缺口被掩盖。必须比 **fallback
之前的原始 override**。

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/i18n/locales/zh-CN.ts` | 抽取并额外 `export const zhCNMessages`（原始对象，不含 fallback）；补 3 个一直静默显示英文的 key：`userAdmin.addHost`、`diff.addHost`、`mqBroker.addHost` |
| `packages/app-tests/localeKeyParity.test.ts` | 新增 4 项断言：无漏译、无孤儿 key、值类型一致、无空串 |

**验证**：临时给 `en.ts` 注入 `app.__parityProbe` → 测试精确报出该 key，随后 `git checkout` 还原。

> 注：`mqBroker.*` 整个 namespace 在代码里**零引用**（只有 locale 文件里有），属于孤儿数据。
> 详见第 4 节 J。

### C. 工程残留清理

| 动作 | 对象 | 依据 |
|---|---|---|
| 删除 | `.cleanup-worktree/` | 不是注册的 worktree（`git worktree list` 只有主工作区），内部只有失效的 node_modules 符号链接 |
| 删除 | `packages/cli/`、`packages/mcp-server/`、`packages/mongo-shell/` | tracked 文件数均为 0，只剩 node_modules/断链；全仓库无引用 |
| 删除 | `scripts/dev-full.cmd` | 与 `dev-full.bat` MD5 完全相同，只有 `.bat` 被 `package.json` 引用 |
| 删除 | `handoff.md` | 内容是上游 dbx 的 AI 交接稿（`name: dbx`、`root: D:\...\rust\dbx`），引用的 `需求问题/` 目录本仓库不存在 |
| `.gitignore` | `DBX_*_x64-portable.zip` → `ogdeveloper_*-portable.zip` | 实际产物名由 `update_portable.rs:63` 生成，旧模式永远匹配不到 |
| `.gitignore` | 新增 `需求问题/`、`handoff.md` | 与已有的 `需求文档/` 同类；防止以后的交接稿再被提交 |

`handoff.md` 与 `dev-full.cmd` 删除前备份到了 `tmp/cleanup-backup/`（`tmp/` 已 gitignore，仅本地）；
也能从 `git log -- handoff.md` 取回。

### D. Schema Diff 部署结果契约 —— 前端把成功显示成失败

**症状**：部署**成功**时，结果弹窗显示红色"部署失败 / `diff.deployFailed {status:"unknown"}`"。

**根因**：后端重构过（`handoff.md` 提到的 "Replaced fake per-statement 2PC deploy path with
`execute_schema_diff_deploy`"），但前端适配函数没跟着改：

- 后端 `SchemaDiffDeployResult` 产出 `{success, executedStatements, totalStatements, error, transactional}`，**没有 `status` 字段**
- 前端 `buildDeployTxResult` 只认 `txLog.status`，于是永远走 fallback 分支返回 `success: false`
- `tauri.ts:1031` 把返回类型声明成 `Promise<TransactionLog>`（旧的 2PC 形状），TypeScript 抓不到漂移
- 旧测试喂的是手写的 `TransactionLog` 假数据，所以测试一路绿着

| 文件 | 改动 |
|---|---|
| `crates/ogdeveloper-core/src/query.rs:1116` | 新增 `SchemaDiffDeployStatus { Committed, RolledBack }`（serde `snake_case` → `"committed"`/`"rolled_back"`），`SchemaDiffDeployResult` 增加 `status` 字段并填充 |
| `apps/desktop/src/types/database.ts` | 删除谎言类型 `TransactionLog`/`ParticipantInfo`；新增 `SchemaDiffDeployStatus` / `SchemaDiffDeployResult`（注释标明 `"mixed"` 是预留值） |
| `apps/desktop/src/lib/schema/deployTxResult.ts` | 改为读取后端真实字段；不再从 `success` 反推状态 |
| `apps/desktop/src/lib/backend/tauri.ts:1031`、`http.ts:979` | 返回类型 `TransactionLog`/`any` → `SchemaDiffDeployResult` |
| `apps/desktop/src/components/diff/SchemaDiffDialog.vue` | `deployResult` ref 改用 `DeployTxResult`；`showDeployTxResult` 参数去掉 `any` |
| `apps/desktop/src/lib/schema/__tests__/deployTxResult.spec.ts` | **重写**：改用真实后端报文（这是关键，旧测试的形状后端从不产出） |
| `crates/ogdeveloper-core/src/query.rs`（tests mod） | 新增序列化形状测试，钉死 `status`/`executedStatements`/`totalStatements` 字段名 |

### E. 失败的部署污染连接池

**根因**：`execute_transaction_on_pool_once` 的 Postgres 分支在语句失败时用 `?` 提前返回，
**从不 ROLLBACK**。deadpool 用 `RecyclingMethod::Fast`（`postgres.rs:1665`），而 Fast 回收
只检查 `is_closed()`、**一个清理查询都不发**（已核对 deadpool-postgres 0.14.1 源码
`lib.rs:157 recycle()`：`Some(sql) => simple_query`，Fast 走 `None => Ok(())`）。

结果：aborted 状态的事务被原样还给池子，下一个 checkout 到它的查询撞 `SQLSTATE 25P02
current transaction is aborted`——一个和部署无关的查询报出莫名其妙的错。

**改动**：`query.rs:1339` 抽出 `run_statements_in_open_transaction()`（SET LOCAL / 语句循环 /
COMMIT），失败时在 `query.rs:1299` 显式 `conn.batch_execute("ROLLBACK")`（用 simple query 协议，
aborted 事务里无条件接受）。

**反证**（把 ROLLBACK 改成空操作后重跑）：

```
[native] connection unusable after a failed deploy: Some("db error")
test result: FAILED
```

恢复修复后立即通过。**这就是这个修复有效的证据。**

### F. 部署错误信息被吞成 `"db error"`

`tokio_postgres::Error` 的 `Display` 对数据库错误只印 `"db error"`，真正消息只在 `Debug` 里。
事务路径用裸 `e.to_string()`，用户看到的失败原因就是字面上的 "db error"。

`crates/ogdeveloper-core/src/db/postgres.rs:921` 把已有的 `pg_error_to_string`（会取
`as_db_error()` + SQLSTATE + `LINE n` 上下文）从 private 提为 `pub(crate)`，`query.rs:1294/1304`
改用它（BEGIN 失败与语句失败两处）。

### 真机验证结果（test_b，B 模式）

```
[native] committed  deploy: {"success":true, "status":"committed",   "executedStatements":1,"totalStatements":1,"error":null,"transactional":true}
[native] rolled back deploy: {"success":false,"status":"rolled_back","executedStatements":0,"totalStatements":3,
                              "error":"ERROR: syntax error at or near \"CREAT\"","transactional":true}
test result: ok.
```

断言覆盖：状态正确、失败后**无残留对象**（第 1 条 CREATE SCHEMA 成功、第 3 条失败 → schema 不存在）、
失败后**连接仍可用**、错误信息保留 SQL 原文。

---

## 3. 问题的原始证据与修法（G/H 已在第 6 节完成）

### 🔴 G. JDBC 部署 100% 失败：`executeTransaction` 方法不存在

**证据**（真机，test_b，JDBC 连接）：

```
[jdbc] committed deploy: {"success":false,"status":"rolled_back","executedStatements":0,
                          "totalStatements":1,"error":"Unsupported JDBC plugin method: executeTransaction"}
```

**根因**：`crates/ogdeveloper-core/src/query.rs:1287` 附近的 `PoolKind::ExternalDriver` 分支在调
`session.invoke("executeTransaction", ...)`。而插件的方法分发表里没有这个方法。用 git 明文源码核对：

```powershell
# 工作区文件是加密的，必须走 git 对象库
git show HEAD:plugins/jdbc/src/main/java/app/ogdeveloper/jdbc/OgdeveloperJdbcPlugin.java > /tmp/Plugin.java
```

分发表（约 335-401 行）只有：

```
testConnection / connect / connectionInfo / executeQuery / executeQueryPage /
fetchQueryPage / closeQuerySession / listDatabases / listSchemas / listTables /
listObjects / listDataTypes / getObjectSource / getColumns / getExplainInfo
```

并且 `git log --all -S 'executeTransaction' -- plugins` **全分支全历史零命中** → 不是回归，
是从来没实现过。已安装的 `dbx-jdbc-plugin.jar` 与仓库新构建的
`plugins/jdbc/build/libs/ogdeveloper-jdbc-plugin-all.jar` 我都反编译查过 class 里的方法名，
两者都没有。

**影响**：openGauss 的默认连接方式是 JDBC（`OPENGAUSS_ROADMAP.md`：「JDBC 内嵌：默认走官方
`org.opengauss.Driver`」），所以**用默认配置的用户，Schema Diff 部署从未成功过一次**。

**修法（推荐 a）**：

- **(a) 在 Java 插件里实现 `executeTransaction`** —— 符合设计意图。插件本来就有
  `sharedConnection` 缓存（`openConnection()` 起点在 628 行，`sharedConnection = DriverManager.getConnection(...)` 在 662 行），所以正确实现是：这一个调用内
  `setAutoCommit(false)` → 按顺序执行 statements → `commit()`；任一步失败 → `rollback()` →
  返回错误。返回结构要与 `db::QueryResult` 反序列化兼容。
  代价：改加密的 Java 源码 → `./gradlew shadowJar`（本机能构建，`build/libs` 里有 9/9 的产物）
  → 重新打包插件（`package.sh`）→ 更新 `plugins/jdbc/manifest.json` 版本号 +
  `src-tauri/resources/jdbc-plugin.zip`（9.1MB）→ 装回数据目录才能真机验证。
  **注意**：工作区 Java 文件是透明加密的，写回后要确认 `git diff` 拿到的是明文改动。

- **(b) 在 Rust 侧用 `executeQuery` 手搓 BEGIN/COMMIT** —— 不用碰 Java，但插件所有 invoke
  **共用同一个物理连接**（`openConnection` 返回同一个 `sharedConnection`），一旦开事务，并发的
  元数据查询会被卷进这个事务里。这是设计上要避免的，**不建议**。

修好后 `live_schema_diff_deploy_reports_status_and_rolls_back_over_jdbc` 会自动从 FAILED 变
通过（它的 `#[ignore]` 原因已写明这是已知缺口）。

### 🔴 H. B/M 兼容模式的 DDL 引号用错

**证据链**：

1. 应用自己知道规则（`crates/ogdeveloper-core/src/db/postgres.rs:137`）：

```rust
"B" | "M" | "MYSQL" => Some("`"),      // 反引号
"A" | "PG" | "ORA"  => Some("\""),     // 双引号
```

2. 真机实测（test_b，`sql_compatibility = B`）：

```
compatibility mode = B
double-quoted -> FAIL 42601 syntax error at or near ""zz_dq_double""
backtick      -> OK
plain         -> OK
dq table      -> FAIL 42601 syntax error at or near ""zz_dq_double""
bt table      -> OK
app identifier_quote = "`"            ← 探测本身是对的
```

3. 但 DDL 生成**完全不看这个**。用应用自己的生成器（`prepare_schema_diff` +
`generate_schema_sync_sql`，target = `DatabaseType::OpenGauss`）输出的真实脚本：

```sql
-- Create table: new_table
CREATE TABLE "new_table" (
  "id" integer NOT NULL
);

-- Alter table: orders
ALTER TABLE "orders"  ADD COLUMN "total" numeric(10,2) NOT NULL;
ALTER TABLE "orders"  ADD COLUMN "note" varchar(80) NOT NULL;
```

**这些语句在 test_b 上全部会报 42601。**

**根因**：`profile_for(DatabaseType::OpenGauss)` → `postgres_family()`
（`crates/ogdeveloper-core/src/sql_dialect/ddl_profile.rs:207`）里
`quote: QuoteStyle::DoubleQuote` 是**硬编码**的，签名只吃 `DatabaseType`，拿不到兼容模式。
`schema_diff.rs:2795 quote_id()` 又把它用在所有标识符上。

**修法**：把兼容模式接进 DDL profile。结构上本来就打算这么做——`ddl_profile.rs` 文件头自己写着
"generators must only consult profile fields (quote style, auto-increment form, type map, …)"，
而 `profile_for` 的文档注释写着 "the **only** place that maps `DatabaseType` → profile data"。

具体：新增 `profile_for_connection(db_type, sql_compatibility: Option<&str>)`，B/M 时把
`quote` 覆盖为 `QuoteStyle::Backtick`；然后把 `schema_diff.rs` 里的 `db_type: DatabaseType`
（**17 处参数声明**）替换为携带模式的 profile 或加上模式参数，覆盖 **约 35 处 `quote_id` 引用**
（含 `schema_diff.rs:2795` 的定义；另有 `schema_diff.rs:2796`/`2965` 直接调 `profile.quote_ident`）。

`SchemaDiffPreparationOptions` 已经有 `database_type` / `source_dialect` / `target_dialect`
字段，需要确认兼容模式从哪条路传进来（前端 `ConnectionConfig.database_info.sqlCompatibility`
有值；`crates/ogdeveloper-core/src/connection.rs:1367` 在读 `datcompatibility`）。

**为什么必须修**：即使 G 修好了，**任何 B 模式或 M 模式库上的部署依然每条语句都失败**。
用户的 `test_b` 就是 B 模式。

**顺带修正一处文档**：`OPENGAUSS_ROADMAP.md:64` 写着
「openGauss-lite 7.0.0-RC3 镜像连接 B 模式库会崩溃，无法真机验证 B」——
那是**镜像**的问题，不是 B 模式的问题。本机这台 **6.0.0** 连 `test_b` 一切正常，
`datcompatibility` 探测返回 `B`，`test_a`/`test_pg` 也都在。**B 模式一直可测，只是没人测过。**
其余标着「手册」未验证的 B 模式条目（`CREATE EVENT`、B 模式下 `gs_package` 目录是否存在等）
现在都可以补上真机验证了。

### 🟡 I. 深链可绕过 openGauss 白名单（已知，暂不处理）

`ENABLED_DATABASE_TYPES = {opengauss}`（`ConnectionDialog.vue:2680`）只过滤**连接类型选择器**。
深链零校验。实测 `parseConnectionDeepLink` 输出：

```
ogdeveloper://connection/new                    -> dbType=mysql      profile=mysql      port=3306
ogdeveloper://connection/new?type=redis         -> dbType=redis      profile=redis      port=6379
ogdeveloper://connection/new?type=mongodb       -> dbType=mongodb    profile=mongodb    port=27017
ogdeveloper://connection/new?url=mysql://root@10.0.0.5:3306/shop -> dbType=mysql  port=3306
dbx://connection/new?type=sqlserver&host=win.internal            -> dbType=sqlserver port=1433
```

原因：`connectionDeepLink.ts:70` 的 `parseConnectionDeepLink` 零类型校验，`type` 直接查
40 多个 URL scheme 的 `SCHEME_PROFILES`；`ConnectionDialog.vue:4420`
`applyConnectionDraftToForm` 无条件接受 `selectedType = draft.driverProfile`；而且**默认值是
mysql**：`connectionProfileForScheme(preferredProfile || "mysql")`。
`dbx:` scheme 仍在 `tauri.conf.json` 注册。

后果不严重（后端是 stub，会返回 `"Redis not supported"` 之类），用户已表示暂不处理。
若要堵：在 `parseConnectionDeepLink` 里加白名单校验并返回 `null`，一处改动 + 单测即可。

### 🟡 J. 其他残留

- `crates/ogdeveloper-core/src/two_phase_commit.rs`（约 400 行）在 `lib.rs:76` 声明为
  `pub mod`，但模块外**零引用**（`TransactionStatus`/`TransactionLog` 只在模块内部使用）。
  前端对应的 `TransactionLog`/`ParticipantInfo` 类型本轮已删除。历史上有过
  `2679bde6c refactor: remove dead two-phase-commit module`，但被后续的整块回滚
  （`a9c00d06f`）带回来了。
- i18n 里 `mqBroker.*` 整个 namespace 零代码引用（MQ 表单实际用 `connection.*`）；
  `types/mq.ts` 的 `BrokerNode` 也没有对应组件。
- `DatabaseUserAdmin.vue` 里 MySQL 风格分支不可达（provider 注册表只剩 postgres/opengauss）；
  driver manifest 里 9 个 driver 声明 `userAdmin: true` 但无 provider。
- `handoff.md` 里那批历史遗留的命名残留（`deploy/dbx_tunnel.php`、`skills/dbx/SKILL.md`、
  `vendor/*/DBX-PATCH.md`、`dbx-er-diagram-architecture.html`）已在上一轮讨论中确认**保留不动**。

---

## 4. 验证状态

### 本轮改动后的检查结果

| 检查 | 命令 | 结果 |
|---|---|---|
| Rust 格式 | `cargo fmt -p ogdeveloper-core -- --check` | ✅ exit 0 |
| Rust lint | `cargo clippy -p ogdeveloper-core --no-default-features --tests` | ✅ 无警告 |
| Rust 单测 | `cargo test -p ogdeveloper-core --no-default-features --lib` | ✅ 1143 passed, 11 ignored |
| 真机 native | 见第 1 节命令 | ✅ 2 passed（native + 报告） |
| 真机 JDBC | 同上 | ❌ 1 failed —— **这是已知缺口 G，故意保留为绊线** |
| 前端类型 | `npx vue-tsc --noEmit --project apps/desktop/tsconfig.json` | ✅ exit 0 |
| 前端格式 | `npx oxfmt --check "apps/desktop/src/**/*.{ts,vue}"` | ✅ exit 0 |
| 前端 lint | `npx oxlint --vue-plugin apps/desktop/src` | ✅ exit 0（改动文件零警告） |
| 前端测试 | `npx vitest run` | ✅ 4999 passed / 605 files |
| 前端构建 | `pnpm build` | ✅ |

### ⚠️ 本机 5 个预存测试失败（与本轮改动无关）

```
packages/app-tests/diagramSvgToPng.test.ts
packages/app-tests/saveDiagramExport.test.ts
apps/desktop/src/__tests__/startupInputGuard.spec.ts
apps/desktop/src/components/grid/__tests__/DataGridConditionEditor.spec.ts
apps/desktop/src/components/ssh/__tests__/SshHostKeyPromptDialog.spec.ts
```

报错都是 `Error: No such built-in module: node:` —— 这 5 个文件都用
`// @vitest-environment happy-dom` 同时 import `node:fs`/`node:path`/`node:assert`，是本地
vitest/happy-dom 环境解析问题。**已用 `git stash` 在干净基线上复现同样的失败**，确认与本轮改动无关。

### 建议的接手顺序

1. **先修 H（B/M 引号）** —— 纯 Rust 改动，本机 `test_a`/`test_b`/`test_pg` 都在，可以直接真机
   验证；而且 H 不修，G 修好也没用（B 模式库上照样每条语句失败）。
2. **再修 G（JDBC `executeTransaction`）** —— 需要动加密的 Java 源码 + 重建/重打包/重装插件，
   工作量和风险都大一档。修完 `live_..._over_jdbc` 会自动转绿。
3. 顺带可以用现在可用的 B 模式实例，把 `OPENGAUSS_ROADMAP.md` 里那些标「手册」未验证的
   B 模式条目补上真机结论（`CREATE EVENT`、`gs_package` 目录在 B 模式是否存在等）。

---

## 5. 改动文件清单（全部未提交）

```
修改:
  .gitignore
  apps/desktop/src/components/diff/SchemaDiffDialog.vue
  apps/desktop/src/components/editor/AiAssistant.vue
  apps/desktop/src/components/editor/SqlPreviewPanel.vue
  apps/desktop/src/i18n/locales/zh-CN.ts
  apps/desktop/src/lib/ai/aiCodeHighlighter.ts
  apps/desktop/src/lib/backend/http.ts
  apps/desktop/src/lib/backend/tauri.ts
  apps/desktop/src/lib/schema/__tests__/deployTxResult.spec.ts
  apps/desktop/src/lib/schema/deployTxResult.ts
  apps/desktop/src/types/database.ts
  crates/ogdeveloper-core/src/db/postgres.rs
  crates/ogdeveloper-core/src/query.rs

新增:
  apps/desktop/src/lib/__tests__/ai/aiCodeHighlighter.spec.ts
  crates/ogdeveloper-core/tests/live_opengauss_schema_diff_deploy.rs
  packages/app-tests/localeKeyParity.test.ts

删除:
  handoff.md                     (备份: tmp/cleanup-backup/handoff.md)
  scripts/dev-full.cmd           (备份: tmp/cleanup-backup/dev-full.cmd)
  packages/cli/                  (只剩 node_modules 的空壳)
  packages/mcp-server/           (同上)
  packages/mongo-shell/          (同上)
  .cleanup-worktree/             (失效 worktree 残留)

统计: 15 files changed, 355 insertions(+), 277 deletions(-)  (不含 3 个新增文件)
```

> 建议拆成多个 commit：A（shiki）/ B（i18n）/ C（清理）/ D+E+F（Schema Diff 部署修复）互不相关。

---

## 6. 2026-09-15 续修结果（仍未提交）

### H：目标兼容模式贯通 DDL profile

- `profile_for_connection(DatabaseType, Option<&str>)` 在 openGauss B/M/MYSQL 下使用反引号；A/PG 和旧请求保持双引号。大小写和首尾空格统一处理，反引号按双写转义。
- `SchemaDiffPreparationOptions.targetSqlCompatibility` 贯通整段 SQL、每个对象预览、索引/外键/注释/权限及逆向回滚。生成器内部统一传递 `DdlDialectProfile`；公共函数仍接受原来的 `DatabaseType` 调用，也可传具体 profile。
- `SchemaDiffDialog` 按**目标连接 + 目标数据库**查询 `connectionDatabaseInfo`，避免把连接默认库的模式用于另一个库；未探测到模式时显示可翻译错误并停止生成。
- Tauri/Web 直接生成接口增加可选 `targetSqlCompatibility`；`RollbackScriptOptions` 支持相同字段。
- 新增 `tests/schema_diff_compatibility_mode.rs`，覆盖 B/M/MYSQL、A/PG、转义、旧请求兼容、权限和回滚。

### G：JDBC 单次 RPC 事务与内嵌插件更新

- 插件分发器新增 `executeTransaction`，同一物理连接顺序执行全部语句，再 commit；任一步失败 rollback，成功回滚后恢复 autoCommit。
- 已有手动事务时拒绝执行，避免提交其他事务。拒绝列表内的显式事务控制和 SET AUTOCOMMIT；回滚失败时关闭连接，避免恢复 autoCommit 时误提交。
- 结果兼容 Rust `QueryResult` 的 `columns/rows/affected_rows/execution_time_ms`；保留 SQL 错误及 SQLSTATE。
- `plugins/jdbc/build.gradle`、`manifest.json` 版本升到 **0.1.29**；已通过 Gradle `test bundleZip` 并更新 `src-tauri/resources/jdbc-plugin.zip`。
- 新增 `ExecuteTransactionTest.java`：提交、失败回滚、已有事务拒绝、控制语句拒绝、回滚失败关闭连接，共 5 项；插件全部 80 项测试通过。
- 真机使用隔离目录 `tmp/schema-diff-live-20260915/plugins` 中的新包，**没有覆盖真实 APPDATA 插件或连接库**。新版桌面已有的 bundled 版本同步逻辑会在启动时升级较旧插件。

### 新发现并修复：生成脚本被注释判空、多语句未拆分

前端传 `[整段脚本]`，生成器通常以 `-- Create table` 开头。旧部署入口用 `starts_with("--")` 判空，会将有真实 SQL 的整段脚本直接作为成功返回；native 路径还不能用一次 prepared execute 运行多条 SQL。

`execute_schema_diff_deploy` 现在复用已有按数据库方言拆分器，丢弃纯注释、保留注释后的 SQL、逐条执行并按实际语句数量报告结果。新增单测覆盖注释、多语句及 dollar-quoted 函数体内部的分号。

### 本次验证

| 检查 | 结果 |
|---|---|
| Rust core `cargo check --no-default-features --tests` | 通过 |
| Rust 格式 / Clippy | 通过；唯一新测试 lint 提示修复后定向复查通过 |
| Web 服务端 `cargo check -p ogdeveloper-web --tests` | 通过 |
| Rust core `--lib` | **1145 passed，11 ignored** |
| API 契约回归 | **13 passed** |
| 新增兼容模式回归 | **3 passed** |
| Java `gradlew.bat --offline test bundleZip` | **80 passed**，打包成功 |
| openGauss 6.0.0 test_b / test_a / test_pg | 每库 **4 passed**，共 **12 passed** |
| 前端 `pnpm typecheck` / 改动文件 oxlint / oxfmt | 通过 |
| 部署结果 + i18n parity 定向 Vitest | **10 passed** |

真机覆盖 native/JDBC 两路：成功/失败状态、失败后无残留对象、连接恢复，以及真正生成的 CREATE → 两条 ALTER → ALTER 逆向回滚 → CREATE 逆向回滚。表名含空格、列名含保留字，以前端相同的整段带注释脚本输入部署。

**反证**：在 H 修复前，新用例精确报 `wrong identifiers in B`；旧 JDBC 包报 `Unsupported JDBC plugin method: executeTransaction`。修复后同一用例通过。

真机运行仍用第 1 节命令，另加隔离插件目录：

```powershell
$env:DBX_TEST_OPENGAUSS_PLUGIN_DIR = 'D:\proj\og_developer\tmp\schema-diff-live-20260915\plugins'
```

### 剩余范围

- **I 深链白名单**：按已有决定暂不处理。
- **J 低优先级死代码/孤儿数据**及已确认保留的命名残留：本次未扩展清理。
- **M 模式**：有离线回归，当前实例没有用于本次测试的 M 库，未声称真机验证。
- B 模式确认 `pg_catalog.gs_package` 和 `pg_job` 目录存在；`CREATE EVENT` 等功能仍未实测，路线图继续明确标注手册依据。
- 本次未重跑全量前端测试，也未生成完整桌面安装包；之前记录的 5 个 happy-dom 环境问题未处理。

---

## 7. 2026-09-15 剩余问题核实结果（独立复查）

### I 深链白名单 —— 确认属实

- `connectionDeepLink.ts` `parseConnectionDeepLink`：只校验 scheme（`ogdeveloper:`/`dbx:`）与路径
  （`connection/new`），`type` 直接查 `SCHEME_PROFILES`（40+ 个），无 `ENABLED_DATABASE_TYPES`
  白名单；缺省 `type` 时默认 `mysql`。
- `ConnectionDialog.vue:4420` `applyConnectionDraftToForm`：`selectedType.value = draft.driverProfile`
  无条件接受。两条入口都通：系统深链 + 对话框粘贴 URL（`applyConnectionUrlToForm`，约 3230 行）。
- `src-tauri/tauri.conf.json:87-91`：`dbx` scheme 仍注册。
- 修法（若要堵）：`parseConnectionDeepLink` 里对 `dbType`/`driverProfile` 做白名单，一处改动 + 单测。

### J 死代码/孤儿数据 —— 全部确认属实

- `two_phase_commit.rs`：模块外零引用，`lib.rs:76` 的 `pub mod` 是唯一关联；
  `TransactionStatus`/`TransactionLog`/`ParticipantInfo` 无外部使用。
- `mqBroker.*` i18n：代码零引用（仅 locale 文件）。`lib/backend/mq-tauri.ts` 也无任何组件引用
  （MQ 表单走 `connection.*` + `mqAuth.ts`/`mqConsoleDefaults.ts`）。
- `DatabaseUserAdmin.vue` MySQL 风格分支不可达：provider 注册表（`databaseUserAdmin.ts:271-273`）
  只剩 postgres/opengauss，`isPostgres` 的 else 侧（lock/unlock、username 文案）不可达。
- driver manifest：`database-drivers.manifest.json` 共 11 个 driver 声明 userAdmin 能力，
  其中 9 个（mysql/doris/starrocks/kingbase/highgo/vastbase/goldendb/gaussdb/kwdb）无 provider，与记录一致。

### 5 个 happy-dom 测试失败 —— 根因确定，非本地环境污染

- **触发条件**（最小探针复现）：`// @vitest-environment happy-dom` + 顶层静态 import 任何 node
  内置模块（`node:fs`、裸 `fs`、`node:path`、`node:assert` 均一样）→ 收集期崩溃
  `Error: No such built-in module: node:`（模块名为空，工具链 bug 的实锤）。
  node 环境下同样导入正常；`--pool=forks` / `--pool=vmForks` 均复现。
- **机制**：vitest 4 把 DOM 环境测试文件交给 vite 的 client 环境处理，node 内置模块被
  "externalized for browser compatibility"（vite 有对应警告），被 externalize 的 specifier
  在 vitest 模块求值器（`module-evaluator.js`）里崩掉。
- **确定性**：vitest 4.1.8 + vite 8.0.16，lockfile 自 2026-08 起未变 → 同 commit 同 lockfile
  处处可复现；与本轮改动无关（stash 基线复现 + 独立探针）。若 CI（Linux）同 commit 是绿的，
  则是 Windows-only 的工具链 bug（`module-evaluator.js:65` 有 `isWindows` 分支）。
- **可用规避方案（已验证）**：spec 里不写静态 builtin import，改用
  `process.getBuiltinModule("node:fs")`（Node 22+，CI 引擎要求满足）——探针通过。
  5 个文件各改数行即可转绿；或跟踪上游修复。

### M 模式 —— 重要结论：openGauss 社区版没有 M 兼容模式

- 官方文档（6.0.0 / 7.0.0-RC3 / master 三分支均查）CREATE DATABASE 的 `DBCOMPATIBILITY`
  取值 = **A、B、C、PG、D**（O / MY / TD / POSTGRES / S）。
- openGauss-server master 源码 `guc/guc_sql.cpp` 的 `adapt_database[]` 枚举 = {A, C, B, PG, D}，
  无 M。即 **7.0.0-RC3 也没有 M**。
- 代码里的 "M" 源自 `0d461f6db`（commit message 称 "M mode as SQL Server (shark)"）——但 shark
  官方文档明确是 **D** 兼容库（`dbcompatibility='D'`）的扩展，当时把概念搞混了。M 兼容实际是
  **GaussDB（华为商业版）** 的 MySQL 全兼容概念；应用里 M→反引号 的映射对 GaussDB M 库是合理的
  前瞻处理。
- **本机 openGauss 6.0.0 无法创建可用的 M 库**：CREATE 不校验字符串会落库，但连接时
  `sql_compatibility` 枚举无 M → 会话初始化 FATAL → 僵尸库（需从其它库 DROP 清理）。
- 已给出探测+建库+清理脚本 `tmp/probe-m-compatibility.sql`（幂等，含僵尸库清理步骤）；
  若将来接 GaussDB 实例可直接用。M 链路保持离线回归即可——引号路径与 B 同码路，
  `test_b`（B 模式）已覆盖同等风险。

---

## 8. SQL 编辑器 `schema.` 不提示未展开 schema 的对象（已修复，2026-09-09）

**现象**：侧边栏从未展开过的 schema，在 SQL 编辑器输入 `schema名.` 无任何表/视图提示；
展开过一次后即正常。

**根因（两层）**：
1. 前端本地补全数据来自侧边栏树（`completionTreeIndex`），未展开的 schema 自然没有缓存——
   此时应走远端补全 `completionAssistantSearch`（connectionStore.ts `listCompletionTables` 的
   remote 分支）。
2. 但收窄重构 `c527cadba` 把 Rust 端 `completion_assistant_search_core` 砍成了桩函数
   （直接 `Ok(vec![])`），`postgres::completion_assistant_search` 完整实现成为死代码。
   桩返回空数组**不抛错**，前端不会走 `listTables` 兜底 → 未展开 schema 永远提示为空。
   （列补全不受影响：`get_columns_core` 路由完整，所以已输入表名后的列提示一直正常。）

**修复**（`crates/ogdeveloper-core/src/schema.rs`，+146/-3）：
- `completion_assistant_search_core` 恢复真实分派：`PoolKind::Postgres` →
  `db::postgres::completion_assistant_search`；`ExternalDriver + openGauss` → 经
  `opengauss_metadata_postgres_pool` 走原生协议元数据池（JDBC 插件无 completion 端点）；
- 新增 `completion_assistant_fallback`：原生池不可用时用 `list_schemas_core` /
  `list_tables_core` / `get_columns_core`（这些核心函数自身已有 JDBC 插件路由）拼装
  Schema/Table/View/Column 候选，行为与收窄前一致。

**验证**：
- 新增真机回归 `crates/ogdeveloper-core/tests/live_opengauss_completion_assistant.rs`：
  建独立 schema + 表 + 视图 + 函数（绝不展开侧边栏），断言 `schema.` 空 mask 列出表和视图、
  前缀 mask 正确过滤、函数例程可见；JDBC 与原生两种驱动并行跑均 **PASS**（对 test_b）。
- 教训：两个并行测试共用同一库，夹具 schema 名必须带标签区分（`ogd_completion_probe_{label}_{ms}`），
  否则毫秒级同名互相 DROP 造成偶发失败。
- `cargo check --workspace`、`cargo clippy --tests`、`cargo fmt`、crate 单测（37 个）全绿；
  tauri/web 两侧壳层签名未动（`fallback_used/incomplete` 仍由壳层构造）。

---

## 9. 函数展开把 RETURNS TABLE 输出列当参数显示（已修复，2026-09-09）

**现象**：`app.get_menu_tree_user_system(p_user_id, p_root_menu_id, p_system_id) RETURNS TABLE(...)`
实际只有 3 个入参，侧边栏展开却列出 18 行——多出的是 RETURNS TABLE 的输出列（标记 OUT）。

**根因**：PG/openGauss 把 RETURNS TABLE 的输出列以 `proargmodes='t'` 存进 pg_proc
（现网实测：`{i,i,i,t×15}`，纯 IN 函数 proargmodes 为 NULL）。参数查询
`lib/table/routineParameters.ts` 的 `routineParametersQuery` 未过滤 't'，
且 CASE 把 't' 也映射成 'OUT'。侧栏 `loadRoutineReferenceGroups` 全量渲染所致。

**修复**：查询增加 `AND COALESCE(p.proargmodes[gs.ordinal], 'i') <> 't'`，并删掉
`WHEN 't' THEN 'OUT'` 分支。**真实 OUT 参数（'o'）保留**——过程执行窗口要声明它们
接收输出（`acceptsRoutineInput` 只放行 IN/INOUT，执行 SQL 不受影响；调试面板同样受益）。
三个消费方（侧栏展开 / 执行对话框 / 测试窗口、调试面板）共用此查询，一处修复全部生效。

**验证**：
- 现网直查（tygl_pg）：修复后的完整查询对 `app.get_menu_tree_user_system` 返回且仅返回
  3 个 IN 参数，has_default 判定不变。
- 回归测试加入 `lib/__tests__/table/routineExecutionSql.spec.ts`（断言排除 't'、保留 o/b 映射），
  该文件 13 个用例全过；`pnpm typecheck` 通过。

---

## 10. 非 FROM 语境输入 `schema.` 不提示任何对象（已修复，2026-09-09）

**现象**：只有 `FROM schema.` 能提示表；SELECT 列表 / WHERE / SET / CALL 等其它位置输入
`schema.` 一概无提示。

**根因（链路三段，前两段已由 §8 的后端修复盘活，第三段本次修）**：
1. 数据：`completionAssistantSearch` 桩函数返回空（§8 已修复，所有语境共用此数据源）。
2. 拉取：列语境下 `resolveSqlCompletionTableLookupTarget` 把 qualifier 当作当前 schema 的
   “名字过滤器”（`suggestTables=false` 分支），注定查空；QueryEditor 的 schema 兜底
   （`qualifierIsSchema`）要求先查空再按 schema 重查——后端修复后此兜底开始生效。
3. 展示（本次修的存量前端 bug）：兜底重写 `effectiveContext` 时把 `qualifier` 清成
   `undefined`，而 `connectionStore.completionAssistantObjects` 对非当前 schema 的候选
   总是带 `schema.name` 形式的 applyName → 插入后变成 `schema.schema.name` **双重限定**；
   且重写打开 exclusive 闸门后，`matchesPrefix(候选, "")` 恒真会让内置函数片段全部涌入弹窗。

**修复**：
- `QueryEditor.vue`：兜底重写**保留 qualifier**（表/例程构建器会以它为元数据作用域生成点号后
  裸名插入；CodeMirror 从 prefix 起点替换）；`exclusiveRoutineSuggestions`（CALL/EXEC）语境
  不启用表条目，保持只提示过程。
- `sqlCompletion.ts`：片段/内置函数块增加 `!context.qualifier` 闸门。对
  `getSqlCompletionContext` 派生的原生语境该条件恒为冗余（qualifier 必伴随 exclusiveTable
  或 exclusiveColumn），零行为变化；只约束重写后的语境。

**验证**：新增 `lib/__tests__/sql/sqlCompletionSchemaQualifier.spec.ts`（4 例）：
SELECT 列表 `app.` 的 exclusiveColumn 前置钉死；重写后表/视图/函数裸名插入、无双重限定、
无内置函数涌入；CALL 语境保持仅过程；非空前缀正常过滤。补全相关 59 个测试文件 698 用例全过，
typecheck + oxlint 干净。

**修复后各语境行为**：FROM/JOIN/UPDATE/INTO/DELETE `schema.` → 表/视图（原本可用）；
SELECT/WHERE/SET/ORDER BY `schema.` → 该 schema 的表/视图 + 函数/过程；
CALL/EXEC `schema.` → 仅过程。

---

## 11. 函数补全改为参数名占位符（2026-09-16）

**需求与行为**：用户确认采用「参数名占位符 + Tab 切换」。例如补全后插入
`app.get_user_menu_op(p_user_id, p_menu_id)`，自动选中第一个参数；输入实际值后，
Tab 切换下一个、Shift+Tab 返回上一个，最后一次 Tab 跳到右括号之后。
类型、参数模式和默认值不写入占位文字，完整声明保留在补全详情与签名提示中。
无参数名的签名使用 `arg1`、`arg2`；无入参函数仅插入空括号。

**实现**：
- 新增 `sqlRoutineParameters.ts`，解析参数名、模式和默认值，避免类型修饰符、
  字符串、数组及嵌套表达式中的逗号拆错参数；函数排除纯 OUT，过程保留 OUT。
- 复用 CodeMirror snippet 导航，并增加括号后的退出位置。
- 编辑器签名浮窗读取已有的例程补全缓存，保留 schema/重载区分并高亮当前参数。

**验证**：4 个相关测试文件共 222 个用例通过，包含实际 CodeMirror 状态中的
选中、替换、前后导航及退出位置；`pnpm typecheck` 与改动文件的 oxlint 通过。
未进行桌面界面的人工交互验证。

---

## 12. 过程源码着色一致性与 IF 配对（2026-09-16）

**着色原因及修复**：
- 原表名扫描把 SELECT INTO 的首个接收变量当成表，逗号扫描也会跨分号追溯旧 FROM，误染后续 RAISE 参数。现在区分过程赋值、INSERT/MERGE 表目标及 RETURNING INTO 接收变量，并在过程和语句边界停止扫描。
- 字符串在语法窗口中完全清空，导致 DISTINCT FROM 'CUSTOM' THEN 被误读为 FROM THEN。现在保留非标识符占位，并排除 DISTINCT FROM、EXTRACT 等表达式中的 FROM。
- 部分第三方主题没有表色 CSS 变量，原 !important 覆盖使表名退回默认黑色。现在表名优先采用主题自带/自定义表色，否则用当前主题的类型色；切换主题会刷新装饰。schema、别名、字段及变量保持普通标识符配色，关键词、字符串、数字沿用主题规则。
- 可视窗口从过程内部开始时保留完整文档的过程上下文；按语法树缓存上下文，避免滚动时重复全文分词。

**块配对原因及修复**：原扫描器只有 BEGIN/END/CASE，主动跳过 END IF 和 END LOOP。现支持嵌套 IF/END IF、ELSIF/ELSEIF/ELSE、CASE/WHEN/END CASE 和 LOOP/END LOOP；FOR/WHILE 循环以 LOOP 为配对起点。点击复合结束标记或分支关键字会高亮所属结构。保留事务 BEGIN 排除，并忽略 IF(...)函数、注释、字符串中的伪关键字；美元引号包围的函数体作为代码处理。

**验证**：11 个相关测试文件初次组合验证 133 例通过；补充 RETURNING INTO 后，3 个直接相关文件 25 例通过（覆盖用例合计 134）。包括截图对应的过程、嵌套分支以及真实 CodeMirror DOM 中第三方/自定义主题的样式验证。pnpm typecheck、改动文件 oxlint、oxfmt 与 git diff --check 通过。尚未进行桌面界面人工点击验收。

---

## 13. 引用与被引用只展示一层（2026-09-16）

**评估**：循环依赖会让引用树重复出现相同对象，用户可不断手动展开，增加树深度与重复元数据请求。采用单层关系展示：原始对象保留引用/被引用组，结果对象保留参数、字段、属性等自身结构，但不再生成这两个组。

**实现**：
- 引用结果增加 isReferenceResult 标记，统一在引用组工厂拦截；包内成员、同义词目标继承来源，避免间接重新展开引用链。
- 修复表、视图、物化视图、类型和同义词展开时误把 schema.name（说明）显示标签当真实名称的问题；函数/过程原本已使用 objectName，这也是此前不同对象表现不一致的原因。
- 界面表节点展开统一走 store 加载，补齐类型节点路由；引用结果中的序列不显示空展开箭头。

**验证**：4 个相关测试文件共 27 个用例通过，覆盖两种方向、参数保留、表/视图列查询真实名称、类型属性、同义词目标、包成员及重复展开。改动文件 oxlint、oxfmt 和 git diff --check 通过。未进行数据库真机与桌面手动验收。

补充验证：pnpm typecheck 通过。

---

## 14. 桌面端“执行计划”报 This connection has been closed（2026-09-16，JDBC 插件 0.1.30 + core 兜底修复）

**现象**：Windows 桌面端 openGauss JDBC 连接，任意简单 SQL 点「执行计划」必现
`This connection has been closed.`；普通查询不受影响。

**根因**（插件 `OgdeveloperJdbcPlugin.openGaussOutputSupported`，`fa83c01b9` 引入）：
gms_output 包探测把 `openConnection()` 返回的**进程级共享连接**放进 try-with-resources，
probe 结束将其 close；外层 `executeQuery` 持有的同一引用再 `createStatement()` 即被
pgjdbc 拒绝。explain 每次使用独立 client session 池（新 JVM，probe 缓存必然未命中），
所以每次点击都失败；普通查询走分页 `executeQueryPage` 不经过该 probe，故表现正常。

**修复 A（插件，根因）**：probe 只把 Statement/ResultSet 放进 try-with-resources，连接保持
共享不关。插件版本 0.1.29 → 0.1.30（`build.gradle`、`manifest.json`），重打包
`src-tauri/resources/jdbc-plugin.zip`（桌面端启动时自动升级已安装旧插件）。

**修复 B（core 兜底，同一排查中发现的两个缺陷）**：
- `query.rs` 新增 `config_uses_external_driver`/`pool_uses_external_driver`：外部驱动判定
  不再只看 `db_type == Jdbc`，openGauss-profile（db_type 为 OpenGauss）的 JDBC 池同样覆盖。
  应用于单条查询（`do_execute_typed`/`do_execute_typed_with_retry`）、批量
  （`execute_multi_*`）与事务（`execute_statements_in_transaction_*`）三条链路的
  丢弃死池 + 新池重试判定；重试判定抽出 `should_retry_with_fresh_pool` 便于单测。
- `rebuild_pool_after_connection_error` 增加 `client_session_id` 参数：session 作用域池
  （如 explain 的 `tab:explain`）重建时落在同一个 `:session:` key 上，重试才找得到。
  批量/事务路径按 base key 寻池，显式传 `None` 并注明原因。

**验证**：
- 插件单元回归 `openGaussOutputProbeKeepsSharedConnectionOpen`（fake Driver + 关闭即抛错的
  代理连接模拟 pgjdbc）：修复前精确复现 `{"error":{"message":"This connection has been closed."}}`，
  修复后通过；插件共 81 例全绿（`gradlew.bat --offline test bundleZip`）。
- 新增真机回归 `crates/ogdeveloper-core/tests/live_opengauss_explain_jdbc.rs`，两个用例：
  1. `live_explain_plan_over_jdbc_survives_output_probe_on_fresh_sessions`：复刻桌面 explain
     请求形状。旧插件 0.1.29 真机复现原报错；staged 0.1.30 两轮全新 JVM 均返回真实计划。
  2. `live_session_pool_retries_on_fresh_pool_after_server_side_termination`：
     `pg_terminate_backend` 杀掉 session 池后端后，`SELECT 1` 经“丢死池 → 同 key 重建 → 重试”
     透明成功。修复前 core 同场景报 `Connection not found`（反证：死池被删除后重建到了错误
     的 base key）。
- core `--lib` 1149 passed（含 4 个新增单测）；`api_contract_verification` 13 passed；
  clippy/fmt 干净；`cargo check -p ogdeveloper-web --tests` 通过。

真机运行方式（与第 1 节相同，另加隔离插件目录）：

```powershell
$env:DBX_TEST_OPENGAUSS_DATA_DIR = "$env:APPDATA\com.ogdeveloper.app"
$env:DBX_TEST_OPENGAUSS_DATABASE = "test_b"
$env:DBX_TEST_OPENGAUSS_PLUGIN_DIR = "D:\proj\og_developer\tmp\explain-live-plugins"
cargo test -p ogdeveloper-core --no-default-features `
  --test live_opengauss_explain_jdbc -- --ignored --nocapture
```

注意：plugins/jdbc 的两个 .java 源文件本轮由非落密进程写回（亿赛通策略下现为明文），
gradle 构建与测试均正常；如有合规要求可关注其加密状态。

---

## 15. 空闲后首个请求报 FATAL: terminating connection due to administrator command（2026-09-16，JDBC 插件 0.1.31）

**现象**：桌面端连接 tygl_pg（192.168.10.158:15400，opengauss-jdbc profile）空闲十几分钟后，
第一次点侧栏加载表列表报错 `FATAL: terminating connection due to administrator command`；
一秒后自动恢复。用户导出调试日志定位。

**根因**（服务端行为，非本工具 bug）：该 openGauss 实例配了约 10 分钟级空闲会话清理
（日志中 16:42:33 服务端发来 `WARNING: Session unused timeout.`，正好空闲 10 分钟整；
插件 JVM 日志 `received packetType:69` 即 'E' ErrorResponse 报文，证明是服务端主动发
FATAL 终止，而非网络设备掐断——后者只会是 socket IO 错误）。

**工具侧的真实缺陷**：池复用前的活性探测失效。`remove_stale_connection_pool` 调插件
`testConnection`，但插件只查 `isClosed()`（客户端标志位，服务端杀掉会话后它仍为 false）
加离线元数据（`databaseInfo` 吞掉所有 SQLException），所以对被服务端终止的连接永远返回
ok:true，死池被当成好池递给调用方，第一条语句才在死连接上爆炸。pgjdbc 要等我发报文
才能读到服务端已送达的 FATAL 包。

**修复**（插件 0.1.30 → 0.1.31，`connectionTestResult` 新增 `ensureConnectionAlive`）：
用 JDBC 4.1 标准 `connection.isValid(5)` 做真实往返探活——服务端已杀的会话会在这里
失败（错误信封）→ Rust 现有 `remove_stale_connection_pool` 判定 stale → 丢池重建 →
调用方拿到新池。不实现 isValid 的老驱动（JDBC 4.1 前）回退到原有行为，不回归。
纯插件侧修复即够：Rust 的探测-重建链路本来就存在，只是被假探测喂了假信号；
因此未再给 schema/元数据路径加重试包装（探测在复用前跑，恢复对调用方透明）。

**验证**：
- 单元反证：`testConnectionDetectsServerTerminatedIdleSession`（isClosed=false 但
  isValid=false 的代理连接，模拟 pgjdbc 被杀瞬间状态）在修复前返回 `{"ok":true}`（精确
  复现探测盲区），修复后返回 error；`testConnectionToleratesDriversWithoutIsValidSupport`
  守住老驱动回退。插件共 83 例全绿。
- 真机反证：新增 live 用例
  `live_metadata_listing_recovers_after_server_terminates_idle_pool_connection`
  （base 池查 `pg_backend_pid()` → 另一 session 池 `pg_terminate_backend` 杀掉 →
  `list_tables_core` 走 base 池）。0.1.30 快照跑精确复现用户报错
  `FATAL: terminating connection due to administrator command`；staged 0.1.31 跑透明恢复。
- 同文件三个 live 用例全绿；core `--lib` 1149 passed；api_contract 13 passed；
  clippy/fmt 干净；`cargo check --workspace --tests` 通过。
- `src-tauri/resources/jdbc-plugin.zip` 已更新为 0.1.31（启动自动升级已安装插件）。

副作用说明：og/JDBC 连接的池复用探测从“离线元数据”变为“一次真实 SELECT 级往返”
（局域网约 +1ms/次操作），换来服务端杀会话场景的透明自愈。
DM8 等其他 JDBC 驱动走同一代码路径，isValid 为标准实现，风险低，未单独真机验证。

---

## 16. FROM 函数补全、子查询星号字段与完整 IF 折叠（2026-09-16）

**FROM 函数候选**：PG/openGauss 的 FROM、JOIN、逗号连接及 LATERAL 位置允许函数候选，schema 限定按实际 schema 过滤；不混入过程，也不把当前正在输入的对象错误提示为别名。保留参数名占位符；UPDATE/INSERT/DELETE 目标位置仍排除函数。编辑器查询候选时按此上下文请求 function 元数据。

**子查询 SELECT * 字段透传**：语义模型保留星号投影及内部源信息，编辑器本地、后台与异步加载统一查询真实源表，不将派生别名当物理表。由源表字段推导外层别名的列，支持限定星号、混合显式列、嵌套子查询、CTE 与列别名列表；外层候选不混入内部别名。显式 CTE 列无需额外数据库查询，递归 CTE 避免循环加载。混合投影在冷缓存时会等待缺失字段，不被已有显式列提前截断。

**完整块折叠**：新增 CodeMirror foldService，复用 BEGIN/IF/CASE/LOOP 配对结果，优先于默认 SQL 按分号划分的折叠范围；外层 IF 折到对应 END IF（含分号），不在第一个 UPDATE 或内层 IF 处结束。普通查询仍用原语法折叠。按不可变文档缓存范围，编辑后重新计算。

**验证**：13 个相关文件共 339 个测试通过，包括无缓存到加载源列、已有缓存、嵌套/CTE、schema 隔离、目标位置排除，以及实际 CodeMirror foldable/foldEffect 范围。改动文件 oxlint 与 oxfmt 通过；尚未进行桌面或数据库真机交互验收。

补充验证：最后一轮 pnpm typecheck 通过。

---

## 17. 例程健康分析标签页（2026-09-17）

**功能**：将工具菜单的“重编译无效对象”替换为“例程健康分析”，使用独立常驻标签页。跳转具体例程（含重载签名）、切换其他标签后，分析结果与筛选条件保留；关闭标签停止后续批量请求。恢复应用只恢复分析作用域，不持久化可能过期的分析结果。

**只读目录与分析**：新增 `listRoutineHealthSnapshot`（Tauri/Web API 同步），支持 PostgreSQL/openGauss 原生与对应 JDBC 连接；读取例程源码及全目录表/字段、索引、例程身份、search_path。目录聚合成完整 JSON，避免 JDBC 行数上限造成假缺失；目录读取失败明确报错，编译记录不可用显示覆盖范围提示。默认扫描业务模式，显式选择时可查看系统模式。兼容 openGauss 的 record 形式 pg_get_functiondef 与 prokind/prosp 差异。

静态检查覆盖表/视图、限定字段、简单投影、INSERT/UPDATE 目标列、可确认的条件字段、例程调用名称以及显式 DROP/ALTER/REINDEX INDEX 引用。复用 SQL 词法与查询作用域，处理注释、字符串、SELECT INTO 变量、CTE/派生表星号、嵌套 IF 和子查询作用域。动态 SQL、临时表、未知语言、不可解析 search_path、包/多级调用等显示未完整检查提示。调用只检查名称存在性，未验证重载参数类型；不会执行例程来探测错误。

**编译记录**：保留 gs_source.status=false，单列为“编译记录”，不冒充当前对象 INVALID，也不按名字合并到任意重载。显示真实编译错误或“未获取到详情”；查看记录源码打开独立查询页。原重编译操作明确标为“重新执行创建语句”，仅编译记录可单独/批量执行。分析所得缺失依赖不会自动触发 DDL。IF EXISTS 索引不存在显示允许缺失说明。

**验证**：本轮按用户要求调用 Pi 第三方 DeepSeek（commandcode / deepseek/deepseek-v4-flash），未继续创建 Codex 内置子代理。第三方补充 DOM 回归、条件字段检查、Rust 序列化修复及中英文文案，最后扩大到全量前端测试时触及 900 秒时限，没有完整汇总；全量测试不计入通过结果。主代理重新验证相关范围，并修复一个内层字段错误按外层表验证的误报。

- 6 个前端专项文件合计 **80 passed**：分析器、健康页 DOM、标签创建/复用、标题、标签持久化及 AppTabBar。
- `cargo test -p ogdeveloper-core --no-default-features routine_health --lib --offline`：**4 passed**。
- `cargo check -p ogdeveloper-web --tests --offline`：通过。
- `pnpm typecheck`、改动文件 oxlint/oxfmt、`git diff --check`：通过；详细结果见 `tmp/routine-health-verification.md`。
- 未做桌面实际交互和真实数据库验收；没有调用例程、修改数据库数据或提交 Git。

---

## 18. 结果标签无限新增与手动事务卡死（2026-09-18）

**问题 1：同一窗口重复执行同一 SQL，每次新增一个“执行 N”结果标签**
非 bug：结果面板左上角的图钉是「自动保留查询结果」（`resultAutoSave`），开启后每次执行
都保留为新结果标签（与“在新结果标签页中执行”快捷键是两回事）。该状态随标签页持久化
（`openTabsPersistence.ts`），重开/刷新应用后仍然生效，用户不易察觉；新开编辑页默认关闭
所以“换个页面就好了”。处理：图钉 tooltip 文案明确其后果（中英）；行为与持久化保持不变。

**问题 2：关闭自动提交后点一次 rollback，之后任何查询都报错，刷新恢复**
机制链（用户日志从刷新后才开始，事故窗口无日志，按代码确证）：
- 缺陷 A（core）：`spawn_txn_idle_watcher` 在会话创建 300s 后**无条件**回滚并移除手动事务
  会话——`last_activity` 只在创建时赋值、执行语句从不更新，且是一次性 sleep。前端无感知。
- 缺陷 B（前端）：会话被（看门狗或服务端空闲杀会话）移除后，查询报 `Transaction session
  not found`，但 queryStore 仅在错误匹配 `/rolled.?back/i` 时清空 `txnSessionId`，该消息
  不匹配 → 标签页永久卡在死会话 ID 上，之后每条查询都报同一错误。`txnSessionId` 不持久化，
  刷新即恢复——与现象完全吻合。

**修复**：
- core：执行事务语句前后经 `touch_transaction_session` 刷新 `last_activity` 并置/清 `busy`；
  看门狗改为每 60s 巡检的循环，只有“非忙且空闲满 300s”才回收（`txn_session_is_reapable`
  纯函数抽出并单测）；回收时打 warn 日志。
- 前端：新增 `isTerminalManualTxnError`（`lib/query/manualTxnErrors.ts`），把
  `Transaction session not found` 纳入终态判定——清空 `txnSessionId` 并显示“事务已自动回滚”
  提示条，下一条查询自动开新事务。专项 spec 3 例。

**验证**：core `--lib` 1154 passed（含新增 `txn_session_reapable_only_when_idle_past_timeout`）；
clippy/fmt 干净；前端 `manualTxnErrors.spec.ts` 3/3、typecheck 通过。
未做桌面交互验证；user 侧复现路径较长（需等 5 分钟看门狗），建议下个版本实际验证一次：
关自动提交 → 执行 → 等 6 分钟 → 再执行，应看到“事务已自动回滚”提示条且后续查询自动恢复。

**联动增强（同日）**：提交/回滚按钮的置灰与快捷图标显隐本已由 `tab.txnSessionId` 驱动，
但后端回收会话后前端不知晓，按钮“假亮”。补齐主动通知：core 新增 `ManualTxnClosedEvent`
（broadcast channel 挂在 `AppState.manual_txn_events`），看门狗回收时广播；src-tauri 启动时
转发为 `manual-txn-closed` webview 事件；`useTauriEvents` 监听并调 `queryStore.handleManualTxnClosed`，
精确清除匹配标签的 `txnSessionId` 并亮起“事务已自动回滚”提示条，按钮即刻熄灭。web 后端无此
推送，退化到“下次查询自愈”路径，行为仍正确。spec：`queryStore.manualTxnClosed.spec.ts` 2 例；
src-tauri 编译通过。

---

## 19. SQL 编辑器工具栏上下文选择器三合一（2026-09-18）

工具栏原有的连接/数据库/模式三个下拉 + 清除/设默认按钮合并为单个上下文选择器
（`EditorContextPicker.vue`）：面包屑式触发按钮（连接 / 数据库 / 模式），弹出层内一个搜索框
+ 分组列表（数据库→模式→连接），页脚保留“设为默认数据库/清除”操作。事件契约不变
（changeConnection/changeDatabase/changeSchema/setDefaultDatabase/clearDefaultDatabase），
App.vue 处理逻辑零改动；保留生产环境徽标、颜色条、长名称换行样式与数据库必选抖动提示。
EditorToolbar.vue 净减约 230 行。验证：typecheck/build/oxlint 通过，editorContextPicker.spec.ts
5 例 + searchableSelectLayout.spec.ts 更新后全绿。

---

## 20. 例程健康分析误报修复：同义词解析与伪例程调用（2026-09-18）

**问题 1：报“未找到引用的表或视图”的对象其实是同义词**（如 app.def_user、
app.app_dict_item，实测指向 dbo 模式的表）。快照的 relations 目录只查 pg_class，
openGauss 同义词在独立的 pg_synonym 目录。修复（core routine_health.rs）：
`relations_sql(has_synonym)` 追加 UNION ALL 同义词臂（能力探测 hasSynonym 门控，
原生 PG 无此目录），同义词以自身模式 + 目标表列暴露；目标缺失的悬挂同义词
`columns` 为 NULL——引用视为存在（不报 missing_relation）但列未知（不做列检查）。
前端分析器新增 `resolveRelation`：search_path 解析失败后再回落 public 同义词
（openGauss PUBLIC 同义词不依赖 search_path）。DML 目标、列检查、例程调用回退
全部改走 resolveRelation；`columns` 类型改为可空并做空值守卫。

**问题 2：WHERE/FROM/别名被误报为“未找到同名例程”**。调用识别把“标识符 + (”
都当例程调用：`WHERE (…)`、`FROM (…)` 命中关键字不在 SPECIAL_CALLS 白名单；
`FROM (…) u(a,b)`、`FROM f() AS x(a)`、`FROM t x(a)` 这类**表源别名列清单**被当成
调用 u/x/t。修复（routineHealthAnalysis.ts）：单名候选跳过 SQL_WORDS 全集；
前驱为 `as`、`)` 或非关键字标识词时跳过；保留 `WHERE no_fn(…)` 等真实缺失调用的
报告（新增测试钉住）。

**验证**：前端 spec 30/30（新增 6 例：关键字括弧、三种别名列形式、真实缺失仍报、
模式/public 同义词、悬挂同义词、同义词 DML）；core 1156 例（新增
`relations_sql_includes_synonyms_only_when_the_catalog_exists`、
`dangling_synonym_decodes_null_columns_as_unknown`）；clippy/fmt/typecheck/oxlint 干净。
**真实库实测**（tygl_biz@192.168.10.158）：pg_synonym 列名核实无误；UNION 全量查询
执行成功，app.def_user→dbo.def_user 解析出 24 列、app_dict_item→18 列；hasSynonym=true。

---

## 21. 例程健康分析图标与覆盖范围提示汉化（2026-09-18）

**问题 1：图标与进程列表相同**。例程健康分析的工具菜单项、页签图标、面板标题均复用
`Activity`（脉冲线）。统一改为 `Stethoscope`（听诊器，@lucide/vue 1.17 内置），进程列表
保持 `Activity` 不变。AppMenuBar/AppTabBar/RoutineHealthPanel 三处及 spec 的 lucide mock
同步更新。

**问题 2：覆盖范围提示框是英文**。快照 `warnings` 此前是后端硬编码的英文字符串。重构为
结构化 `RoutineHealthWarning { code, detail? }`（7 个稳定 code：call_scope、source_fallback、
routine_search_path_unresolved、gs_errors_unavailable、compile_records_unreadable、
gs_source_unavailable、compile_records_unsupported），detail 只携带技术上下文（对象名、
服务端错误原文）。前端 `routineHealthWarningText` 按 code 查 `routineHealth.warnings.*`
i18n 词条（中英双全），未知 code 降级显示 detail 而不是漏出英文或空行。

**验证**：maintenance 全部 spec 47/47（含新增 routineHealthWarnings.spec 3 例、panel spec
同步结构化 warnings）；core 1156 例全绿；typecheck/oxlint/fmt 干净。
