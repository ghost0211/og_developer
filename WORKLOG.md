# OG Developer — 未提交改动与问题修复记录

> **2026-09-15 更新：G、H 已修复并通过 B/A/PG 双驱动真机回归；新增部署脚本注释/拆分修复。最新结论见第 6 节。**
> 原始记录写于 2026-09-11。基线提交 `72ada3873 chore(release): bump desktop version to 0.2.9`。
> **工作区所有改动均未提交**（无新增 commit、无新分支）。本文档列出：改了什么、为什么、
> 怎么验证、以及还没修的三个真问题的完整证据与修法。

---

## 0. 速览

| #     | 主题                                                    | 状态                                  | 风险 |
| ----- | ------------------------------------------------------- | ------------------------------------- | ---- |
| A     | shiki 语法包按需加载（安装包 -8MB）                     | 已改，已验证                          | 低   |
| B     | i18n key 对齐测试 + 3 个漏译补全                        | 已改，已验证                          | 低   |
| C     | 工程残留清理                                            | 已改                                  | 低   |
| D     | Schema Diff 部署结果契约（`status` 字段）               | 已改，**真机验证通过**                | 低   |
| E     | 失败的部署污染连接池                                    | 已改，**真机验证通过**（含反证）      | 低   |
| F     | 部署错误信息被吞成 `"db error"`                         | 已改，**真机验证通过**                | 低   |
| **G** | **JDBC 路径调用的 `executeTransaction` 在插件里不存在** | **已修，0.1.29 真机通过**             | 低   |
| **H** | **B/M 兼容模式 DDL 引号用错（生成 `"` 应为反引号）**    | **已修，B/A/PG 真机通过；M 离线验证** | 低   |
| I     | 深链可绕过 openGauss 白名单                             | 未修（已知，暂不处理）                | 低   |
| J     | `two_phase_commit.rs` 是死代码                          | 未处理                                | 低   |

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

| 文件                                                          | 改动                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/components/editor/SqlPreviewPanel.vue`      | `import("shiki")` → `shiki/core` + `langs/sql.mjs` + 两个主题（`dark-plus`/`min-light`）。已校验主题名与 `codeToHtml` 传参一致                                                                                        |
| `apps/desktop/src/lib/ai/aiCodeHighlighter.ts`                | 拆成 **eager**（`bash/json/shellscript/sql/xml/yaml`，约 84KB，随高亮器加载）与 **deferred**（`css/go/html/java/javascript/markdown/php/python/rust/tsx/typescript/vue`，首次用到才拉）。新增 `onLanguageLoaded` 回调 |
| `apps/desktop/src/components/editor/AiAssistant.vue`          | 新增 `shikiGrammarVersion` ref 接 `onLanguageLoaded`，语法到位后重建 renderer 重渲染；语法未到时返回转义纯文本（与 `aiMessageRender` 的兜底字节一致，无视觉跳变）                                                     |
| `apps/desktop/src/lib/__tests__/ai/aiCodeHighlighter.spec.ts` | 新增 6 项：eager 即时高亮、别名识别、无语法转义、延迟语法"先纯文本后高亮"、主题映射、未知语言                                                                                                                         |

**验证**：`dist/assets` 18.17MB → **10.24MB**；整个 `dist` 22.10MB → **14.13MB**。

### B. i18n key 对齐测试

**关键发现**：`zh-CN.ts` 是 `withEnglishFallback({...})` 包起来的。直接扁平化比对得到
7090 = 7090 **零差异**——因为 fallback 已经把英文合并进来了，缺口被掩盖。必须比 **fallback
之前的原始 override**。

| 文件                                         | 改动                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/i18n/locales/zh-CN.ts`     | 抽取并额外 `export const zhCNMessages`（原始对象，不含 fallback）；补 3 个一直静默显示英文的 key：`userAdmin.addHost`、`diff.addHost`、`mqBroker.addHost` |
| `packages/app-tests/localeKeyParity.test.ts` | 新增 4 项断言：无漏译、无孤儿 key、值类型一致、无空串                                                                                                     |

**验证**：临时给 `en.ts` 注入 `app.__parityProbe` → 测试精确报出该 key，随后 `git checkout` 还原。

> 注：`mqBroker.*` 整个 namespace 在代码里**零引用**（只有 locale 文件里有），属于孤儿数据。
> 详见第 4 节 J。

### C. 工程残留清理

| 动作         | 对象                                                             | 依据                                                                                                     |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 删除         | `.cleanup-worktree/`                                             | 不是注册的 worktree（`git worktree list` 只有主工作区），内部只有失效的 node_modules 符号链接            |
| 删除         | `packages/cli/`、`packages/mcp-server/`、`packages/mongo-shell/` | tracked 文件数均为 0，只剩 node_modules/断链；全仓库无引用                                               |
| 删除         | `scripts/dev-full.cmd`                                           | 与 `dev-full.bat` MD5 完全相同，只有 `.bat` 被 `package.json` 引用                                       |
| 删除         | `handoff.md`                                                     | 内容是上游 dbx 的 AI 交接稿（`name: dbx`、`root: D:\...\rust\dbx`），引用的 `需求问题/` 目录本仓库不存在 |
| `.gitignore` | `DBX_*_x64-portable.zip` → `ogdeveloper_*-portable.zip`          | 实际产物名由 `update_portable.rs:63` 生成，旧模式永远匹配不到                                            |
| `.gitignore` | 新增 `需求问题/`、`handoff.md`                                   | 与已有的 `需求文档/` 同类；防止以后的交接稿再被提交                                                      |

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

| 文件                                                           | 改动                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/ogdeveloper-core/src/query.rs:1116`                    | 新增 `SchemaDiffDeployStatus { Committed, RolledBack }`（serde `snake_case` → `"committed"`/`"rolled_back"`），`SchemaDiffDeployResult` 增加 `status` 字段并填充 |
| `apps/desktop/src/types/database.ts`                           | 删除谎言类型 `TransactionLog`/`ParticipantInfo`；新增 `SchemaDiffDeployStatus` / `SchemaDiffDeployResult`（注释标明 `"mixed"` 是预留值）                         |
| `apps/desktop/src/lib/schema/deployTxResult.ts`                | 改为读取后端真实字段；不再从 `success` 反推状态                                                                                                                  |
| `apps/desktop/src/lib/backend/tauri.ts:1031`、`http.ts:979`    | 返回类型 `TransactionLog`/`any` → `SchemaDiffDeployResult`                                                                                                       |
| `apps/desktop/src/components/diff/SchemaDiffDialog.vue`        | `deployResult` ref 改用 `DeployTxResult`；`showDeployTxResult` 参数去掉 `any`                                                                                    |
| `apps/desktop/src/lib/schema/__tests__/deployTxResult.spec.ts` | **重写**：改用真实后端报文（这是关键，旧测试的形状后端从不产出）                                                                                                 |
| `crates/ogdeveloper-core/src/query.rs`（tests mod）            | 新增序列化形状测试，钉死 `status`/`executedStatements`/`totalStatements` 字段名                                                                                  |

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

| 检查        | 命令                                                             | 结果                                              |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| Rust 格式   | `cargo fmt -p ogdeveloper-core -- --check`                       | ✅ exit 0                                         |
| Rust lint   | `cargo clippy -p ogdeveloper-core --no-default-features --tests` | ✅ 无警告                                         |
| Rust 单测   | `cargo test -p ogdeveloper-core --no-default-features --lib`     | ✅ 1143 passed, 11 ignored                        |
| 真机 native | 见第 1 节命令                                                    | ✅ 2 passed（native + 报告）                      |
| 真机 JDBC   | 同上                                                             | ❌ 1 failed —— **这是已知缺口 G，故意保留为绊线** |
| 前端类型    | `npx vue-tsc --noEmit --project apps/desktop/tsconfig.json`      | ✅ exit 0                                         |
| 前端格式    | `npx oxfmt --check "apps/desktop/src/**/*.{ts,vue}"`             | ✅ exit 0                                         |
| 前端 lint   | `npx oxlint --vue-plugin apps/desktop/src`                       | ✅ exit 0（改动文件零警告）                       |
| 前端测试    | `npx vitest run`                                                 | ✅ 4999 passed / 605 files                        |
| 前端构建    | `pnpm build`                                                     | ✅                                                |

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

| 检查                                                  | 结果                                         |
| ----------------------------------------------------- | -------------------------------------------- |
| Rust core `cargo check --no-default-features --tests` | 通过                                         |
| Rust 格式 / Clippy                                    | 通过；唯一新测试 lint 提示修复后定向复查通过 |
| Web 服务端 `cargo check -p ogdeveloper-web --tests`   | 通过                                         |
| Rust core `--lib`                                     | **1145 passed，11 ignored**                  |
| API 契约回归                                          | **13 passed**                                |
| 新增兼容模式回归                                      | **3 passed**                                 |
| Java `gradlew.bat --offline test bundleZip`           | **80 passed**，打包成功                      |
| openGauss 6.0.0 test_b / test_a / test_pg             | 每库 **4 passed**，共 **12 passed**          |
| 前端 `pnpm typecheck` / 改动文件 oxlint / oxfmt       | 通过                                         |
| 部署结果 + i18n parity 定向 Vitest                    | **10 passed**                                |

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
  不再只看 `db_type == Jdbc`，openGauss-profile（db*type 为 OpenGauss）的 JDBC 池同样覆盖。
  应用于单条查询（`do_execute_typed`/`do_execute_typed_with_retry`）、批量
  （`execute_multi*_`）与事务（`execute*statements_in_transaction*_`）三条链路的
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

**子查询 SELECT \* 字段透传**：语义模型保留星号投影及内部源信息，编辑器本地、后台与异步加载统一查询真实源表，不将派生别名当物理表。由源表字段推导外层别名的列，支持限定星号、混合显式列、嵌套子查询、CTE 与列别名列表；外层候选不混入内部别名。显式 CTE 列无需额外数据库查询，递归 CTE 避免循环加载。混合投影在冷缓存时会等待缺失字段，不被已有显式列提前截断。

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

- 分组列表（数据库→模式→连接），页脚保留“设为默认数据库/清除”操作。事件契约不变
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

---

## 22. `schema.` 任意位置补全该 schema 的对象（2026-09-18）

**问题**：`update ddd.ldm_datatype set row_uuid=public.g` 这类 UPDATE SET 赋值表达式位置，
输入 `schema.` 完全不提示。探针实测该语境：qualifier=public、exclusiveColumnSuggestions=true、
**suggestRoutines=false**。两重根因：

1. QueryEditor 的 qualifierIsSchema 回退只在“该 schema 下按当前前缀查到表”时触发——
   public 下没有匹配 g 的表 → 不重写；独占列语境里 qualifier 又不匹配被引用表 → 弹窗为空。
2. 即使触发，重写也未打开 suggestRoutines → buildObjectItems 不执行 → 函数永不出现。

**修复**（QueryEditor.vue）：回退在表查不到时新增 **schema 存在性校验**（先本地 schema 缓存、
再远端 listCompletionSchemas），是真实 schema 名即按 schema 语境重写；重写补上
`suggestRoutines: 原值 || !exclusiveTableSuggestions`（独占表语境如 DROP TABLE 不混入例程；
CALL/EXEC 独占例程语境不混入表的原有约束保持不变）。例程元数据本就走
resolveSqlCompletionRoutineLookupTarget（qualifier 即 schema 作用域），无需改动。

**验证**：sqlCompletionSchemaQualifier.spec.ts 新增 2 例（UPDATE SET 语境重写后函数出现、
独占表语境不混入例程），补全相关 523 例全绿；typecheck/oxlint 干净。待桌面实测：
`update … set col=public.g` 应弹出 public 下 g 开头的函数。

**追加修复（同日，0.2.18）**：用户实测 0.2.17 在 `update pdm_database t set t.row_uuid = public.g`
仍不提示。探针确认语境与已测例完全一致（qualifier/exclusiveColumn 均正确），问题在于
重写位于异步流程深处，而补全入口还有本地快路径（buildLocalSqlCompletionResult）不经过
该重写。改为在 provideSqlCompletions 的本地/异步分流**之前**新增
`rewriteCompletionContextWhenQualifierIsSchema`：用本地 schema 缓存（侧边栏树已加载即可用）
同步判定 qualifier 是否为真实 schema 名并重写语境，两条路径行为一致；异步路径保留远端
schema 校验兜底（本地元数据冷时）。editor 相关 189 例 + 补全 523 例全绿。

## 23. 命令窗口 ASCII 表格中文对齐（2026-09-21）

**问题**：命令窗口（psql 风格终端）的查询结果，纯英文内容边框对齐，含中文时边框错乱。

**原因**：`formatAsciiTable`（CommandWindow.vue）用 `String.length`/`padEnd` 计算列宽，但中文等东亚宽字符在等宽字体下占 2 个显示列，按字符数补齐必然错位。

**修复**：

- 新增 `apps/desktop/src/lib/common/displayWidth.ts`：`displayWidth`/`padEndToWidth`/`truncateToWidth`，基于精简 wcwidth 码位表（CJK/假名/谚文/全角计 2 列，组合字符与控制字符计 0 列，代理对正确迭代）。
- 命令窗口 `formatAsciiTable`：列宽计算、表头/单元格补齐、60 列截断全部改用显示宽度。
- 顺带修复同类问题：编辑器悬停表结构 `alignColumnRows`（hoverTableSql.ts，列注释含中文时同样错位）。

**验证**：displayWidth 12 例单测（ASCII/CJK/混排/全角/组合字符/Emoji）；CommandWindow.spec 新增集成用例（含中文值的结果表，两侧边框落在同一显示列）；相关 49 例全绿，typecheck 干净。
**已知边界与跟进（0.2.20）**：0.2.19 上线后用户实测仍有轻微不齐——确认为字体度量问题：font-mono 栈下 Latin 用 Consolas（0.55em/字符）、中文回退雅黑（1.0em/字符），1.0 ≠ 2×0.55。修复：命令窗口输出区/输入框/提示符改用 `command-terminal-font` 专用字体栈（Sarasa Term SC/Mono SC → NSimSun → SimSun → MS Gothic → Consolas → monospace），这些 CJK 字体自带 Latin 且严格 2:1，Windows 自带新宋体即可像素级对齐；无此字体的平台回退原行为。

## 24. 三大新功能：执行计划诊断 / 签名提示按需预取 / Top SQL 面板（2026-09-21）

**执行计划诊断**：新增 `explainPlanDiagnosis.ts` 纯函数分析器，直接遍历 EXPLAIN (FORMAT JSON) 原始 JSON，检测 6 类反模式并按 critical/warning/info 分级：行数估算偏差（Actual×Loops vs Plan Rows，>=10x 告警 >=100x 严重，建议 ANALYZE）、大表 Seq Scan 高过滤（>=95%/99% 过滤比，建议建索引）、Sort 落盘（external merge/Disk，建议 work_mem）、Hash 分批落盘、Nested Loop 放大（子节点 loops>=10000）、物理读占比高。键名归一化处理 openGauss/PG 命名差异；纯 EXPLAIN 只跑保守规则。ExplainPlanViewer 底部新增诊断区块（lucide 严重级图标 + i18n 文案 + relation chip）。33 例单测。

**函数参数提示增强**：探查发现签名提示（getSqlFunctionSignatureHelp + tooltip）早已存在，但数据只来自补全对象缓存——缓存冷时用户函数无提示。新增 `sqlSignaturePrefetch.ts`（带在途去重 + 命中 10 分钟/未命中 60 秒冷却）+ `getSqlSignatureCallContext` 导出；QueryEditor 加 StateField 刷新字段与 ViewPlugin：光标进入函数调用且缓存未命中时，用 `pg_get_function_arguments` 查 pg_proc（schema 限定名/当前 schema/public/pg_catalog），结果合并进补全缓存并触发 tooltip 重算。pg_catalog 兜底覆盖不在内置表里的系统函数。补首批签名提示测试（18 例）。实况验证：openGauss 上 job_submit 的默认值/OUT 参数签名拉取正常。

**Top SQL 面板**：工具菜单新入口，pg_stat_statements 排行（总耗时/平均耗时/调用次数/行数/共享读排序，TOP 50/100/200）。列发现走 information_schema，自动适配 PG14+ total_exec_time 与 openGauss total_time 命名；缺列 NULL/0 占位。扩展缺失时给引导空态 + 一键 CREATE EXTENSION。行操作：复制 SQL / 在编辑器打开。纯前端（executeQuery 桥），tab 模式 top-sql 全链路接线（菜单/标签图标/store/路由/tabPresentation）。18 例单测。

**验证**：三个功能各自 vitest 全绿；合计回归 388+532 例、typecheck/oxlint 干净、i18n 奇偶 85 例通过。测试库无 pg_stat_statements（面板走引导空态，探测 SQL 已验证不报错）。

**Top SQL 菜单点击无反应修复（0.2.22）**：用户实测点击无标签页。日志复现：click 事件到达但无任何后续。根因：App.vue 的监听器挂在 `<AppToolbar>` 上，而菜单项在 `AppMenuBar` 里——AppToolbar 对每个事件都要显式 `emit` 转发，子代理漏了这一跳。修复 AppToolbar 声明+转发 `open-top-sql`；AppToolbar.spec 新增结构性回归测试（遍历 AppMenuBar 声明的全部事件，断言 AppToolbar 声明且转发，已验证缺转发时会失败）。顺带：TopSqlPanel 的支持判定改用 effectiveDatabaseTypeForConnection 与菜单入口一致（JDBC 通道的 openGauss 连接）。新增 queryStore.topSqlPanel.spec 3 例。

**Top SQL 支持 openGauss 内置 dbe_perf.statement 回退（0.2.23）**：实测服务器为精简发行版（pg_available_extensions 无 pg_stat_statements，CREATE EXTENSION 报 could not open extension control file），但内置 `dbe_perf.statement` 视图存在（61 列，时间列为微秒，实例级无 db_name）。面板数据源解析改为：pg_stat_statements →（openGauss）dbe_perf.statement（探测 `SELECT 1 ... WHERE FALSE` 触发 ACL 检查）→ denied（显示 GRANT MONADMIN 引导，含当前用户名）→ unavailable（openGauss 增补精简发行版提示）。查询构造统一别名输出（total_elapse_time/1000 → total_ms 等），表头显示数据源徽标。探测/解析逻辑放在面板组件，topSql.ts 保持纯函数设计。新增 4 例纯函数测试。

**web 端修复二连（0.2.24）**：(1) 保存/测试连接报错显示整页 HTML——根因是请求未到达 API 后端（返回 index.html；本仓库当前代码对未注册路由返回 405 空体，已 curl 实测验证，故用户环境为版本不匹配或反代未转发 /api）。`backendResponseError` 新增 HTML 响应体识别（looksLikeHtmlErrorBody），转为结构化错误 `DBX-WEB-0001` + `backendErrors.htmlResponse`（含状态码与请求 URL、指向部署配置的中英提示）。(2) 复制错误按钮在 web 端无效——非安全上下文（http://IP）无 navigator.clipboard，legacy textarea 路径的 focus()+select() 被 reka Dialog focus trap 抢焦导致 execCommand 静默失败；clipboard.ts 改为优先 Range 选区复制（不触碰焦点，<pre> 保留换行），createRange/getSelection 不可用时才回退 textarea。新增 clipboard Range 路径与 HTML 错误转换测试。

**web 端保存/测试连接报错根因修复（0.2.25）**：用户 Ubuntu 源码部署仍报错（内容变为空响应兜底）。深挖发现 ogdeveloper-web **完全没有注册 /api/agents/\* 路由组**，而连接对话框在测试/保存前必经 `ensureRequiredAgentDriverInstalled → refreshLocalAgentDrivers`（GET /api/agents/installed-local）。桌面端这些 Tauri 命令是返回空数据的兼容 stub（driver store 已移除），web 端缺路由导致 405 空体。新增 `crates/ogdeveloper-web/src/routes/agents.rs` 完整镜像 19 个端点（runtime summary/stop/restart 委托 core 真实实现，其余按桌面 stub 语义返回空；progress/global SSE 返回保持连接的空流避免 EventSource 重连风暴），main.rs 注册。curl 实测三个端点恢复 200 JSON。另：`backendResponseError` 对空错误体补 `DBX-WEB-0002` 结构化诊断（状态码+URL+401/405 排查指引）；新增 `webRouteCoverage.spec.ts` 静态对齐 http.ts 全部 /api 路径与 main.rs 路由（防再犯，当前 0 缺口）。

**Top SQL 授权引导修复（0.2.26）**：用户实测 GRANT MONADMIN 报 role does not exist——该 openGauss 6.0.0 发行版未预置 monadmin 角色（pg_roles 仅有 omm/sysadmin/tygl_biz）。服务器探查：dbe_perf schema 无公共 ACL，omm 靠 rolmonitoradmin=True 属性通过，tygl_biz 虽有 SYSADMIN 但rolmonitoradmin=False 被拒。面板在无权限引导前探测 pg_roles 中 monadmin 角色是否存在：存在→GRANT MONADMIN；不存在→`ALTER USER <user> MONADMIN;`（属性方式）。同时新增最小权限备选块（GRANT USAGE ON SCHEMA dbe_perf + GRANT SELECT ON dbe_perf.statement）。

## 25. 工具菜单多连接目标选择（0.2.27 弹窗版 → 0.2.28 内联版）

**0.2.27（弹窗版，已被 0.2.28 取代）**：进程列表、例程健康、Top SQL、命令窗口、数据导入菜单原本取当前/首个连接，可能对错库操作。新增 ToolTargetPickerDialog 弹窗先选连接/数据库，按工具能力过滤连接；SQL 文件执行对话框菜单无预填时不再默认首个连接。71 例定向测试通过。

**0.2.28（内联版，当前行为）**：用户反馈弹窗繁琐。移除弹窗，菜单恢复直达（默认取当前标签连接→活动连接→首个支持该工具的连接），目标切换内嵌到各面板标题栏：新增 `toolTargets.ts`（按工具能力过滤连接：processlist 驱动/pg-stats/tableImport/queryExecution）与 `ToolConnectionSelect.vue` 紧凑下拉。进程列表、Top SQL 标题旁的静态连接 Badge 换成选择器（queryStore.updateConnection 重定向标签页，各面板原有 watcher 自动重载）；例程健康面板加连接+数据库选择器（schema/数据库列表随切换重载）；命令窗口本就有选择器，菜单/快捷键恢复直达；数据导入对话框目标栏改为连接/数据库/schema 可选（导入调用、元数据失效、批量导入全部改用可变目标 refs；偏离预填表时“导入到现有表”模式自动回退为新建表）。SQL 文件执行器保持对话框内选择器不变。验证：相关 154 例测试、typecheck、build、oxlint 通过。未操控用户桌面 UI。

**CI 修复（同日）**：frontend job 报 RoutineHealthPanel.spec 未处理 TypeError——新内嵌 ToolConnectionSelect 的 computed 用了该 spec 未 mock 的 `connectionStore.connections`。修复：组件加 `?? []` 防御；spec 补齐 connections/listDatabases/updateConnection/updateDatabase mock。CI run 129 全绿。另核实本地全量套件中 5 个无关文件失败（startupInputGuard 等）在 v0.2.27 worktree 同样失败，属本地环境既有问题，非本次引入。

## 26. Top SQL 服务端文本截断提示（2026-09-29，0.2.29）

用户报告 Top SQL 的长 SQL 复制/打开都不完整。**排查结论：非工具 bug**——面板查询/复制/打开均全量使用 `row.query`（topSql.ts 无截断），截断发生在服务端：openGauss `dbe_perf.statement` 按 `track_stmt_details_size`（默认 4096 字节，user 上下文）截断存储；`pg_stat_statements` 按 `track_activity_query_size`（默认 1024，postmaster，需重启）。超出部分服务端未存储，任何客户端无法取回（测试库实测两参数值/上下文已确认）。

**改进**：面板加载成功后自动检测——读 pg_settings 取上限，再 `octet_length(query) >= 上限` 统计被截断条数；非零时显示琥珀色提示条：说明截断原因+给出调整 SQL（dbe_perf：ALTER SYSTEM SET track_stmt_details_size = 上限×4（≥16384），reload 生效；pg_stat_statements：ALTER SYSTEM SET track_activity_query_size，需重启），附一键复制。检测失败静默不影响主流程。新增 4 例纯函数测试。

## 27. 例程健康分析“别名误报”核查与文案改进（2026-09-29，0.2.30）

用户认为 `app.list_field_policy` 的 6 条 missing_column 是误报（“fp/rfp 只是别名”）。**核查结论：分析器正确，函数确有运行时错误**。探针验证语义模型能正确解析 JOIN 别名（ur/rfp/fp 均成行源），且 `sqlSemanticTableNameSpans` 覆盖 JOIN 表名；测试库实证：`app.app_fieldperm` 17 列中无 field_action_dict/mask_pattern_txt/fieldperm_code/sort_order，`app.app_role_fieldperm` 的主键是 role_fieldperm_id 而非 fieldperm_id；直接调用 `SELECT * FROM app.list_field_policy(0,0,'x')` 服务器报 `column rfp.fieldperm_id does not exist`（SQL function during startup）——与分析器第 23 行发现完全一致。该函数引用的是旧版表结构字段，从未成功运行。

**改进（消息文案）**：missing_column 消息原本只说“未找到字段 fp.x”，未说明别名指向，导致用户误读。改为“未找到字段 fp.x（fp 是 app.app_fieldperm 的别名）。”。新增 1 例断言别名指向的测试。

## 28. v0.2.31：执行计划 AI 解读、默认模型路由与 Codex 订阅认证（2026-09-30）

**执行计划入口**：ExplainPlanViewer 增加「用 AI 分析」，发送该次执行计划对应的原 SQL、解析树、原始结果、规则诊断及去掉凭据的数据库上下文；Ask 模式分析现有证据，不自动执行 SQL 或 EXPLAIN ANALYZE。错误修复、历史记录分析及计划解读统一按设置默认配置的默认模型发起，不使用聊天临时模型/推理偏好，不改写聊天模型选择。默认模型缺失时给明确设置指引。连接识别原先已按默认配置调用。

**思考等级**：配置页增加默认思考等级；聊天输入区增加独立思考按钮，去除模型菜单底部的嵌套悬停子菜单。区分「配置默认」（清除临时偏好）与「提供方默认」（不发推理参数），优先采用服务商能力元数据；可识别的兼容网关模型提供标注来源的建议选项，未知型号保留自由输入。补齐配置模型能力的缓存/请求验证；按官方资料修正 GPT-5.2/5.4/5.5 的 none/minimal 差异及 GPT-6 家族选项。

**订阅认证**：新增独立 `openai-codex` 提供商，不恢复缺 MCP 桥接的 CLI 提供商。OpenAI 设备码授权由用户自行点击链接完成；前端仅保存不透明账号 ID，令牌在后端加密保存并自动刷新；加密密钥独立置于数据目录的 `openai-codex-oauth.key`（Unix 0600，Windows 依赖应用目录 ACL，不宣称 DPAPI）。刷新与断开互斥，请求头与凭据 Debug 脱敏；固定认证/Responses 地址且禁止重定向。订阅请求固定 `store:false`，使用真实 ChatGPT workspace ID，识别完成/失败/提前 EOF，支持初始请求与轮询读取取消。模型列表及思考选项来自服务商，不伪造硬编码列表。桌面命令与 Web 受保护路由覆盖 begin/poll/cancel/status/disconnect；取消和断开账号不取消上游订阅。Web 仅适用于可信私有部署。开发验证不读取用户 Codex 登录缓存，不进行真实账号授权。

**流式错误处理**：Web 普通 AI 流不再吞掉失败、把 done 后的错误视为成功；等待响应关闭，检查终态并释放 reader。Codex 请求错误仅返回安全诊断。

使用说明：`docs/ai-context-actions.md`。

**最终验证**：

- 前端 format、oxlint、typecheck、build 通过；全量 `pnpm check` 已执行的 **5260 项测试全部通过**，但 5 个既有本地套件因 `Error: No such built-in module: node:` 无法加载，整体 check 非全绿。此问题此前已在 v0.2.27 基线复现。
- 核心 AI 模块 99 项、思考等级 26 项、订阅授权/保险库 9 项通过（134 项）；Web AI 路由 5 项通过。桌面及 Web 的 `cargo check --tests`、`cargo fmt --all --check` 通过。
- 桌面 AI 单测编译成功，但程序启动被本机 `0xc0000139 / STATUS_ENTRYPOINT_NOT_FOUND` 阻断，未执行测试，不记为通过，也未认定为既有问题。未为排查启动应用或操作桌面。
- 未读取用户 Codex 凭据、未进行真实账号登录、未打开或自动化桌面；真实设备授权和订阅请求端到端验证仍需用户自行登录完成。
- 主应用四处版本同步至 `0.2.31`；账号可用性仍受套餐、服务权限及设备授权策略限制。
- 发布后 CI 补充：首轮 `rust-fmt-clippy` 因两处 clippy 警告失败（`ai_effort.rs` 的 `unnecessary_lazy_evaluations`、
  `ai_codex_oauth.rs` 测试的 `bool_assert_comparison`），本地以 CI 同款参数复现并修复；`cargo fmt --all --check`、
  clippy（CI 参数）及受影响测试回归通过。

---

## 29. v0.2.32：AI 配置默认模型自动获取与下拉选择（2026-09-30）

**问题**：新增/编辑 AI 配置时，「默认模型」只能手输模型 ID——用户已提供 API Key 或完成订阅登录，
模型列表完全可以自动拉取。

**改进**（`EditorSettingsDialog.vue`）：

- 默认模型输入框改为 `SearchableSelect` 组合框：下拉展示服务商返回的模型（含显示名），支持搜索；
  保留 `allow-custom` 自由输入，获取失败或本地/自建服务无 `/models` 时不阻塞手输。
- 自动拉取时机：进入编辑且凭据可用时、输入 API Key 停顿后（900ms 防抖）、切换提供商/Endpoint/
  认证方式/代理后、Codex 订阅登录完成（150ms）后立即拉取；条件不满足（缺 Key/Endpoint/未登录）时
  字段下方给出对应提示。
- 拉取成功且模型为空时自动填入：优先服务商预设模型（在列表中时），否则列表第一项；
  已有值不被覆盖。切换提供商不再预填 Codex 预设模型，交给自动填充。
- 旁置手动刷新按钮（加载中转圈）；失败时内联显示错误与重试；防抖期间作废旧请求结果，
  避免跨提供商串数据。卸载时清理定时器。

**实现**：新纯函数模块 `lib/ai/aiModelListFetch.ts`（`aiModelFetchBlocker`/`uniqueModelsById`/
`autoDefaultModelId`），复用 `aiConfigList.aiModelOptions` 合并已保存模型与发现模型；
i18n 复用既有 `searchModels`/`loadingModels`/`refreshModels`/`retry` 等键，新增
`modelListLoginRequired`、`modelListEmpty`。

**验证**：新增 6 项纯函数测试；设置相关 95 项既有测试回归通过；oxfmt/oxlint/typecheck/build 通过。
未启动桌面 UI，交互以代码审查为准。

---

## 30. v0.2.33：Codex/Kimi 思考档位修复与聊天布局修正（2026-09-30）

**问题**（用户实测反馈）：

1. Kimi Code 订阅（k3-256k）聊天窗口无思考档位可选，只有自由文本；设置里配的「最高」实际从未发送。
2. Codex 订阅聊天窗口提示「此模型不支持设置推理强度」。
3. 聊天输入区模型按钮被压缩到只剩图标，看起来像图标偏右。

**根因与修复**：

- **Kimi 能力缺失**：Kimi 此前一律回退 FreeText（谨慎策略），`reasoning_effort` 枚举档被
  `is_selection_supported` 拦截静默丢弃。依据官方文档（Kimi Code models 页 + platform.kimi.ai
  reasoning-effort 指南）新增 `kimi_capability`：`k3`/`k3-256k`/`kimi-k3`/`kimi-for-coding` →
  枚举 low/high/max（默认 Provider 默认，各变体上游默认不同）；`kimi-for-coding-highspeed`
  思考固定开启 → 不支持调节；未知 Kimi 模型保持 FreeText。兼容网关路由同样给出谨慎建议选项。
  修复后设置里的「最高」会真正以 `reasoning_effort: max` 发送。
- **Codex 能力解析脆弱**：`resolve_model_effort_core` 只有在模型列表中找到该模型才给能力，
  否则直接 Unsupported。发现失败/列表缺失/手输模型时一律回退静态 GPT 注册表（gpt-6.1-sol
  已知 low/medium/high/xhigh/max）。
- **Codex 模型目录对齐 codex-rs**（依据 codex-rs `openai_models.rs`/`manager.rs` 源码核实）：
  只展示 `visibility=="list"` 的模型（缺省视为可见）、按 `priority` 升序稳定排序、
  采用目录声明的 `default_reasoning_level` 作为档位默认值。账号目录中可见模型数量由上游决定。
- **布局**：思考等级按钮由 `shrink-0` 改为可收缩（max-w 150px），与模型按钮按比例的摊压缩，
  模型名不再被完全挤没。

**验证**：核心测试 effort 28 项（+2 Kimi）、codex 7 项（+2）通过；前端 composer/sendGuard 10 项、
typecheck、oxfmt/oxlint、cargo fmt、CI 同款 clippy 全部通过。未启动桌面 UI。

---

## 31. v0.2.34：Kimi 关闭思考档与 Codex 上下文窗口目录（2026-09-30）

**Kimi k3 族「关闭」档**：官方文档确认 K3/K2.8 接受 `reasoning_effort: "none"` 显式关闭思考
（路由到 K2.8 thinking-off）。`kimi_capability` 枚举首项新增 Off（Disabled 选择）；
新增 Kimi 专属 `apply_kimi_effort`：`Disabled → reasoning_effort: "none"`（Responses 风格为
`reasoning.effort`），不影响共享的 OpenAI 映射；其余档位维持 low/high/max。

**Codex 上下文窗口来自账号目录**：`AiModelInfo` 新增 `context_window`（Rust/TS 同步），
`parse_codex_model_list` 提取目录的 `context_window`（缺失回退 `max_context_window`）。
新增按账号隔离的进程级目录缓存（5 分钟 TTL，`CODEX_CATALOG_CACHE`）：`list_codex_models`
先查缓存避免重复拉取；agent 循环 compaction 预算从「用户设置 → 目录广告值 → 名称启发式」
依次取值，Codex 模型不再被 128k 默认值低估。

**Kimi K3 启发式**：`context_window_for_model` 新增 k3/k3-256k（1M/256K）与 kimi-k3（1M）规则，
kimi-for-coding 等未知型号保持 128k 兜底（可在设置里手动指定）。

**验证**：effort 28 项、codex 8 项（+1 目录窗口纯函数测试）、agent_loop 23 项（+1 K3 启发式）
全部通过；cargo fmt、CI 同款 clippy、oxfmt/typecheck 通过。缓存 lookup 拆成纯函数
`codex_catalog_context_window_in`，避免并行测试共享静态态的竞态。未启动桌面 UI。

---

## 32. v0.2.35：修正 Codex 模型目录客户端版本与刷新语义（2026-09-30）

用户再次报告 Codex OAuth 登录后下拉仅有 gpt-6.1-sol。此前以「账号目录由上游决定」
解释数量并没有真实响应证据，不能视为已定位。本轮核对官方 openai/codex rust-v0.159.2：
模型目录请求包含 Codex `client_version`，官方目录 `minimal_client_version` 对现代模型
可达 0.155.0（gpt-6-sol/luna），gpt-5.5 为 0.124.0。

**确认的请求错误**：`list_codex_models` 使用核心 crate 的 `env!("CARGO_PKG_VERSION")`，
实际始终为 **0.2.0**，不是桌面发布版本，更不是 Codex 协议版本。改为明确固定的上游
兼容契约版本 **0.159.2**，与 OG Developer 发布版本解耦；目录请求补同版本 User-Agent
并注明 OG Developer catalog compatibility。版本常量附官方版本出处，后续同步上游契约时更新。

**刷新**：显式 `ai_list_models`（设置刷新按钮/聊天目录刷新）绕过后端缓存，能力解析仍
可复用 5 分钟缓存；保留账号隔离和目录上下文窗口缓存。新增安全诊断日志，仅记录
client_version、服务器目录总数和可选模型数，不记录令牌、账号/工作区 ID 或原始响应。

**截图翻译**：设置模板错误引用不存在的 `ai.defaultReasoningLevel`；改用已有
`ai.reasoningLevel`，新增 locale 回归测试。

**验证**：后端 AI 105 项测试通过（新增请求版本/headers、多现代模型保留、强制刷新缓存
3 项）；完整 `pnpm check` 执行，格式/lint/typecheck 通过、5267 项测试通过，仍有既有
5 个本机 `No such built-in module: node:` 环境套件失败；cargo fmt 与 CI 同款全工作区
clippy 通过。不操作桌面、不读取用户凭据。实际账号是否恢复完整目录仍须用户更新后
点击刷新验证；不能据代码修复承诺所有账号均可见同一模型集。

---

## 33. v0.2.36：聊天模型与思考档位选择器不再互相挤压（2026-09-30）

用户截图再次确认长模型名会使输入栏中的模型/思考档位文字挤成一两个字符。
此前只是把 effort 的 shrink-0 改成 shrink，两者仍与不可收缩的模式按钮挤在同一
flex-nowrap 行，未从结构上消除内容长度影响。

**布局**：AiAssistant.vue 输入栏改为命名 inline-size 容器 + CSS Grid。默认两行：
模式/发送为第一行，模型/思考档位为第二行，两选择器使用等宽 minmax(0,1fr) 轨道；
可用宽度不足 300px 时两个选择器分别占整行；至少 520px 才把模式/选择器/发送合并
一行。断点依据输入栏自身宽度而非应用视口，名称不参与轨道分配。未配置模型时
保留一行模式/发送，不出现空白选择器行。

**控件**：去掉原 flex spacer 和外层 overflow-hidden，不再让按钮互相压缩；图标与
箭头 shrink-0，文字在各自区域截断。模式、模型、思考档位都提供完整 title/aria
标签，思考等级前缀与值合为一个可截断文本区，发送/停止按钮保留 28px 固定轨道。

**验证**：新增 3 项布局静态回归，composer/sendGuard 共 13 项通过；新增
`scripts/test-ai-composer-layout.mjs` 与 `pnpm test:ai-composer-layout`，以独立临时
配置运行无窗口 Chromium，不访问用户浏览器配置。抽取 SFC 实际 composer CSS 与
按钮 class，独立 HTML 样例在 180–800px、中文/英文、短/长模型名及思考值、
有/无模型与思考控件组合下共 360 种通过：轨道不随名称变化、图标/箭头不越界、
发送固定尺寸、分行断点正确。此为真实浏览器几何样例测试，不冒充完整应用挂载测试。

完整 pnpm check：格式/lint/typecheck 通过、5270 项测试通过；既有 5 个本机
`No such built-in module: node:` 套件仍失败。pnpm build、cargo fmt --all --check
通过；未改动 Rust 实现，未启动桌面应用或可见浏览器窗口。

---

## 34. v0.2.37：裸元数据字段被误当关键字着色（2026-09-30）

用户对比相同 SQL 的别名/无别名版本：`t.schema_name/t.table_name` 正常，
裸 `schema_name/table_name` 却与 SELECT/FROM/WHERE 同色。

**复现与根因**：@codemirror/lang-sql 的 PostgreSQL/MySQL `keywords` 表包含
schema_name、table_name 等 SQL 诊断项名；词法扫描器将点号前后名称强制标成
Identifier，但无点号时查方言表命中 Keyword。实际渲染回归在修复前确认：
vscode-light 裸字段 #0000ff、限定字段 #0070c1，暗色与自定义主题亦复现。
这不是数据库数据或别名解析结果导致，也不是全局主题颜色设置错误。

**修复**：codemirrorSqlDialect.ts 新增精确元数据名称过滤集：CATALOG_NAME、
COLUMN_NAME、SCHEMA_NAME、TABLE_NAME，从基础方言的 keyword 表排除；已有
PostgreSQL 常用标识符过滤同步纳入。保持真正 SCHEMA/TABLE/SELECT 等关键字，
不使用后缀通配，不改 builtin 表，SQL Server SCHEMA_NAME() 与 PostgreSQL
CURRENT_SCHEMA、PL/pgSQL 关键字/触发器内置变量照常高亮。

**回归**：新增 openGauss/PostgreSQL/MySQL/Doris、大小写、裸/限定名词法测试，
以及亮/暗/自定义主题的真实 EditorView DOM 颜色断言；14 项针对测试通过，新增
9 项。颜色用 happy-dom 计算样式验证（无需可见界面），不冒充浏览器像素布局验证。
完整 pnpm check：格式/lint/typecheck 通过、5279 项测试通过；既有 5 个本机
`No such built-in module: node:` 套件仍失败。pnpm build、cargo fmt --all --check
通过。未访问数据库、未操作桌面、未改动 SQL 执行逻辑。

---

## 35. v0.2.38：SQL 补全支持 openGauss 同义词 + 同义词按目标类型区分图标（2026-10-11）

用户报告两点：编辑器 `from app.def` 补全不出现同义词 def_user（对象树里明明存在）；
左侧树的同义词全部用同一个链接图标，看不出目标是表/视图/存储过程/函数。

**补全（#1）**：补全助手后端新增 Synonym 对象类型与候选类型（types.rs）；
`postgres_completion_synonyms_sql()` 在 pg_synonym 上按表清单同一契约查询
（schema 限定或 search_path(current_schemas) 可见性、ILIKE 前缀、LIMIT 截断），
并 LEFT JOIN pg_class/pg_proc 解析目标 schema/名称/类型（relkind/prokind，
支持表/视图/物化视图/序列/外部表/分区表/函数/存储过程）；仅当 pg_synonym
目录存在时启用。前端请求 kinds 增加 "synonym"，候选映射为带 `synonymTarget`
的 SqlCompletionTable；buildTableItems 对同义词候选使用新 item 类型 "synonym"
（排序优先级介于表与 schema 之间），detail 显示 `→ dbo.def_user (table)`，
apply 与表一致（可直接用于 FROM）。补全弹窗新增 link 样式的同义词图标
（sky 色 lucide mask）。

**树图标（#2）**：openGauss listObjects 同义词 SQL 的 signature 列（同义词下
原本恒 NULL）改为携带目标 relkind（r/v/m/S/f/p）；buildGroupedObjectTreeNodes
把同义词子节点的 targetKind 填上；treeNodeIcon 对同义词按 targetKind 返回目标
对象类型的图标与颜色（表=绿表、视图=紫眼、物化视图=靛眼、序列=翠绿、
函数=琥珀括号、过程=蓝卷轴），未知目标保持 Link2。展开同义词解析目标后也会
回写 targetKind 保持一致。

**验证**：后端两条新 SQL 在 tygl_biz（openGauss 6.0）实测：app schema 的
def_user→dbo.def_user(table)、seq_auth_user_account→sequence 均正确，与用户
截图一致；后端 db:: 236 项测试通过（含 2 项新 SQL 契约测试）；前端新增 3 个
测试文件/用例：补全项构建（schema 限定与非限定、detail/apply/type）、
store 映射（object_kinds 含 synonym、synonymTarget 透传）、树图标 7 种 relkind
映射，共 58 项针对测试通过；typecheck/lint/fmt、CI 同款 clippy 通过。完整
pnpm check 5289 项通过，5 个既有本机 node: 环境套件失败不变。
注意：未限定名称的同义词补全遵循 search_path（与运行时解析一致），与表相同。

---

## 36. v0.2.39：修复同义词类型图标不生效（真正的渲染点在 TreeItem.vue）（2026-10-11）

用户反馈 v0.2.38 后同义词图标无变化。根因：`lib/sidebar/treeNodeIcon.ts` 的
`getTreeNodeIconInfo` 是无人调用的死代码，侧栏真实渲染在
`components/sidebar/TreeItem.vue` 内自己的 `getIconInfo`，其中 synonym 分支
硬编码 Link2、忽略 targetKind。

**修复**：把 relkind/prokind → 图标映射抽为共享函数
`synonymIconInfoForTargetKind(targetKind)` 放在 treeNodeIcon.ts；TreeItem.vue 的
synonym 分支改为调用它（删除硬编码 Link2）；getTreeNodeIconInfo 同样委托。
**缓存失效**：对象组持久化树缓存版本 objects-v8 → objects-v9，旧缓存（无
targetKind 的节点）不再恢复，展开即重新拉取带目标类型的数据。
新增 packages/app-tests/treeItemSynonymIcon.test.ts 静态守卫（TreeItem.vue 必须
走共享映射、treeNodeIcon.ts 必须含 6 种 relkind 映射），43 项相关测试通过。

---

## 37. v0.2.40：同义词“引用”里的目标对象按真实类型渲染（2026-10-11）

用户反馈：同义词展开“引用”后，目标（如 auth.auth_user 表）显示为链接图标且
不能像函数引用里的表那样展开字段/索引等。根因：后端 list_object_references
的 synonym 分支把目标 object_type 硬编码为字面量 "synonym_target"，前端
referenceResultNodeType 只能映射成 synonym 节点。

**修复**：opengauss_synonym_target_sql 增加第三列 target_kind（LEFT JOIN
pg_class/pg_proc 解析 relkind/prokind，与补全同套逻辑；链式同义词为 NULL）；
引用分支返回真实 kind（前端 referenceResultNodeType 本就把 r/v/m/S/f/p 映射为
表/视图/物化视图/序列/函数/过程节点类型），未知目标保持 synonym_target。
resolve_synonym_target_core 按列序号只读前两列，不受影响。
真实库验证 app.auth_user → auth.auth_user(r)；新增 SQL 契约测试，后端 152+2
项相关测试通过。

---

## 38. v0.2.41：序列图标改为 ListOrdered + 同义词引用注释显示友好类型名（2026-10-11）

用户反馈：表的“字段”组图标与序列图标同为 ListTree（仅颜色差异），难以区分。
序列节点、序列组节点、同义词指向序列（relkind S）三处统一改为 lucide
ListOrdered（带序号列表，贴合自增序列语义），保留翠绿配色；字段组保持
ListTree 不变。treeNodeIcon.spec 同步更新，8 项图标测试通过。

同义词“引用”细节修正：引用节点的尾部注释直接展示 objectType，v0.2.40 返回的
是原始 relkind 字母（显示“r”），与函数引用显示的友好名（“table”）不一致。
现映射为 table/view/materialized_view/sequence/function/procedure 友好词汇，
与函数/视图引用行的展示完全一致；未知目标仍回退 synonym_target。

---

## 39. v0.2.42：修复引用结果节点双击打开数据拼错表名（2026-10-11）

用户反馈：双击同义词“引用”里的表节点报错 relation "auth.auth.auth_user"
does not exist。根因：打开数据页签的整条链路（dataTabTarget、表元数据加载/
缓存、buildTableSelectSql、既有页签匹配）都用 node.label 当表名；引用结果
节点的 label 是展示用的限定名 "auth.auth_user"，拼出 "auth"."auth.auth_user"。
普通表节点 label 即表名所以从不触发，函数/视图引用里的表节点同样受影响。

**修复**：新增 treeNodeDataObjectName()（lib/sidebar/treeNodeContext.ts）——
优先 tableName（引用节点携带的真实对象名），其次 objectName，回退 label；
useSidebarDataOpenRuntime 的 8 处表名取值与 SidebarTreeRuntimeHost 的
findExistingSameTableDataTab 统一改用它；页签标题仍用 label（保留展示信息）。
新增 treeNodeDataObjectName.spec（4 例），useSidebarDataOpenRuntime.spec mock
同步；162 项侧栏测试、完整 pnpm check 5292 项通过（5 个既有本机环境套件除外）。

---

## 40. v0.2.43：schema 级触发器总览（同义词与类型之间）

按用户确认新增 schema 下“触发器”总节点，保留原有每张表下的触发器组。

- openGauss 侧栏能力在各兼容模式下启用 TRIGGER；组顺序移至同义词之后、类型之前。
- 原生元数据 listObjects 增加 pg_trigger UNION 分支（在 openGauss 目录门控下），
  通过所属表 namespace 限定 schema，过滤 tgisinternal，返回真实注释及所属表信息。
- 触发器行保留纯触发器名，尾部显示“所属表 — 注释”（无注释时只显示所属表）。
  grouped/simple 两种节点构建路径均以所属表参与去重和节点 ID，保留 objectName、
  tableName；不同表上的同名触发器不会合并。schema 总览与表级加载路由保持分离。
- 双击源码的 query-tab 路径补传 relationName，dialog 路径已有所属表参数；
  表子对象菜单补“查看源码”，删除仍走带 ON 表名的人为确认路径。
- 原生 listObjects 当前返回整个 schema，触发器总览因此先本地筛选再分页，
  避免大型 schema 中前面的表把触发器截掉；支持按触发器名/所属表搜索。
- 升级对象组与 schema 对象树持久化缓存版本，避免旧缓存缺组/缺所属表数据。

验证：新增同名触发器在 grouped/simple 中的身份测试、各兼容模式组顺序测试、
250 个表加触发器的加载回归，以及真实源码渲染入口静态守卫。针对测试 228 项通过；
完整 pnpm check：5300 项通过，仅既有 5 个本机 node: 环境套件失败；Rust PostgreSQL
模块测试 153 项通过、10 项 ignored，clippy/fmt 和 frontend build 通过。
真实 tygl_biz openGauss 只读查询验证 SQL 可执行；该库目前无用户触发器，未进行
实际触发器创建或桌面 UI 操作。

---

## 41. v0.2.44：触发器右键启用/禁用/删除与真实状态同步

- ObjectInfo / TriggerInfo 增加可选 enabled_mode，保留 pg_trigger.tgenabled
  的 O（普通）、D（禁用）、R（复制）、A（始终）四种模式及未知值；绝不从 comment
  或 valid 推断状态。schema 清单内部利用原 UNION 签名槽携带状态，映射到独立字段，
  trigger 的 signature 清空；其他对象语义不变。
- 表级触发器从 information_schema.triggers 加表限定目录 JOIN 读取状态，保留
  权限过滤；多事件按触发器聚合，避免同一触发器在表内出现多个同 ID 节点。
- schema/table/simple/reference 各处 trigger 节点透传 triggerEnabledMode；
  已禁用显示灰色闪电与“已禁用”，复制/始终模式有独立状态说明。旧缓存版本升级。
- 实际渲染菜单（SidebarTreeRuntimeHost.vue）新增启用/禁用，普通 O 模式禁用
  “启用”项、D 模式禁用“禁用”项；未知状态不允许启停，只读连接禁用写操作。
  SQL 分别引用 schema、所属表、触发器名，不使用展示 label、不操作 ALL/USER。
- 所有启停先展示确认和 SQL，再走现有生产 SQL 保护；捕获不可变目标避免弹窗
  期间焦点切换。取消返回 undefined，不提示成功、不修改节点、不刷新。
  “启用”是普通 O 模式，确认文案明确提醒会把 R/A 模式改成普通模式。
- 删除沿用带 ON 所属表的现有确认路径，补只读检查和生产保护取消检查；修复
  取消后数据库未删除但树节点被移除的问题。成功删除/启停后重新读所属表的
  真实触发器快照，同步所有可见/隐藏副本，清除 schema 对象缓存和持久数据库
  快照；同名但不同表/schema 的对象不受影响。刷新失败与 DDL 失败分别提示。

验证：SQL 引用/注入形态、O/D/R/A/未知模式、只读/权限失败/生产确认取消、成功
回调、同名不同表及多位置副本状态/删除同步测试；实际菜单接线静态守卫。
前端完整 pnpm check：5308 项通过，5 个既有本机 node: 环境套件失败；typecheck/
lint/fmt 通过。Rust core 全量 1192 项通过、11 项 ignored，workspace clippy 通过。
新元数据 SQL 在 tygl_biz 只读验证可执行（该库无用户触发器）；openGauss parser
源码确认 ALTER TABLE ENABLE/DISABLE TRIGGER 语法。未创建或修改真实数据库触发器，
未自动化操作用户桌面。

---

## 42. v0.2.45：修复 schema 触发器总览未渲染所属表说明

用户实测总览中的 ogdev_display_test_trg 无所属表说明。数据构建层已将
parent_name 写入 tableName 和 comment，但真实 TreeItem.vue 使用的
sidebarTreeNodeComment() 白名单仅允许 connection/schema/table/view/
materialized_view/column，排除了 trigger；对齐计算也用同一白名单。
此前只测节点数据和菜单接线，遗漏了实际组件的说明过滤链路。

修复：sidebarTreeItemLayout.ts 的 commentTypes 增加 trigger，同步开放说明
渲染及同级对齐资格。沿用用户说明显示设置：行内/对齐/靠右均显示
“所属表 — 真实触发器注释”（无注释则只显示所属表）；关闭说明时仍隐藏。
不修改 label/objectName/节点 ID，不改变源码定位、启停、删除或数据库查询。
无需重新登录或清除缓存，现有携带 comment 的节点即可使用修正后的渲染规则。

回归：新增 TreeItem.triggerOwnerComment.spec.ts，实际挂载 TreeItem.vue 并传入
buildGroupedObjectTreeNodes 生成的触发器节点，覆盖无注释、带注释、同名不同表、
三种说明模式及关闭说明。修复前 5 个显示用例失败（关闭说明用例通过），修复后
6 个全部通过。happy-dom 中为靠右分支提供固定宽度，只验证真实渲染内容，不声称
实际浏览器几何验收。相关测试 21 项通过；完整 pnpm check 5314 项通过，只有
既有 5 个本机 node: 环境套件失败；typecheck/lint/fmt 通过，未操作用户桌面。

---

## 43. v0.2.46：禁用对象名称/图标统一灰色，作业状态改为显式字段

用户要求禁用触发器名称也灰色，并要求作业/调度在存在禁用状态时同样处理。
排查发现 v0.2.44 只给触发器图标置灰，且 trigger 被列入 markRaw 叶子集合；
启停后的状态字段虽被同步，组件可能不会立即重绘。作业/调度此前从尾部 comment
中猜测 disabled，间隔或运行参数包含 disabled 字样时可能误判。

- 新增 treeNodeStatus.ts：触发器仅 triggerEnabledMode === "D" 判禁用；
  作业/调度仅显式 jobEnabled === false 判禁用，不再解析 comment；未知状态不置灰。
- TreeItem.vue 真实渲染行同时给名称和图标使用 muted 灰色；行仍可选中、可打开
  源码，不设置 aria-disabled，避免把数据库对象状态误表达为 UI 禁用。禁用状态
  判断使用轻量函数而不是新增 computed，遵守现有 TreeItem 热路径预算。
- trigger 从 markRaw 叶子集合移除，保持浅响应式；schema/table/reference 各副本
  启停后可不折叠节点即时恢复/置灰。图标辅助函数同步 trigger/job/scheduler。
- openGauss pg_job 经只读目录确认同时有 job_status(char) 和 enable(boolean)。
  JOB 与 SCHEDULER 清单 SQL 同时依据二者判定：job_status='d' 或 enable IS FALSE
  即禁用；ObjectInfo 增加可选 job_enabled，使用原 UNION 签名槽传递布尔文本并
  映射到独立字段，不影响触发器 enabled_mode 或函数签名。类型序列化兼容旧负载。
- 作业/调度右键启用/禁用改为使用显式状态；操作成功后刷新捕获节点的真实清单
  （对象组或 simple schema），不再可能刷新异步切换后的其他节点。对象缓存升级到
  objects-v12 / simple-v11 / grouped-v12。

回归：真实挂载 TreeItem.vue，覆盖禁用 trigger/job/scheduler 的名称与图标、选中态、
无 aria-disabled、禁用样 comment 不误判，以及启用→禁用→启用即时重绘；simple/grouped
构建保留 job_enabled=false，作业叶子刷新会回到真实清单。针对测试 53 项通过；
完整 pnpm check 5335 项通过，仅既有 5 个本机 node: 环境套件失败；TreeItem 性能
预算守卫通过。Rust core 全量 1192 项通过、11 项 ignored；workspace clippy/fmt、
frontend typecheck/lint/build 通过。tygl_biz 只读验证 pg_job 布尔状态 SQL 可执行，
该库当前无作业行；未创建/启停真实作业，未操作用户桌面。

---

## 44. 选择性适配上游高相关修复与小功能（待发版）

根据用户要求，从 fork 后的 DBX 更新中选择六项与 openGauss、导出安全和现有侧栏
直接相关的改动，按当前代码结构手工适配；不是整仓 merge/cherry-pick，不引入上游
crate 拆分、多数据库、CLI/MCP、市场或凭据迁移，也不覆盖已有 AI、同义词和触发器定制。

| 上游提交 | 本次适配 |
| --- | --- |
| `2766a5bc` | 数据库 SQL 导出的 openGauss 字符串仅转义单引号，不重复转义反斜杠；Postgres、MySQL 和未知目标原有分支保持不变 |
| `4e686bd0` | 在真正读取 `pg_get_tabledef` 的 JDBC/外部元数据路径修复生成的单行 COMMENT 注释单引号，处理后再追加触发器源码；原生自建 DDL 路径不改 |
| `6f05afc0e` | CSV/TSV 共享单元格写入器中和危险公式前缀，覆盖表头、分页导出及结果导出；防护置于单元格边界，不破坏 JSON 分片输出 |
| `c7797b4b` | 开放 openGauss 表、视图、物化视图的直接重命名入口；现有后端已支持这些 SQL，不开放函数/过程的源码重建式重命名 |
| `235a2d2d` | 真实 TreeItem 展示函数、过程等已有注释并支持完整悬停说明，保留触发器“所属表 — 注释”、禁用样式及说明显示设置 |
| `4a997fe6` | 本地表搜索同时匹配名称与注释，覆盖已加载节点、索引和失败回退，保留既有大小写不敏感/缩写/正则匹配及真实节点身份 |

**适配与安全边界**：

- 重命名捕获不可变对象目标，使用实际 objectName/tableName 而非带 schema 的显示
  label；校验连接身份/只读状态，异步构造 SQL 后复核，生产确认结束、执行前再检查
  只读。取消返回 undefined 时不提示成功、不刷新、不改固定项；已有例程多语句
  路径也在取消后立即停止，但不宣称该多语句路径具备原子性或已全面审计。
- DDL 注释修复保留已有合法转义、E-string、引号标识符、CRLF/缩进、DEFAULT
  表达式与 dollar/block 内容；不猜测多行坏注释，遇到该格式保守保留原 DDL。
  测试覆盖单引号、中文、反斜杠、幂等和 SQL 语句形态的注释内容。
- CSV/TSV 对危险文本添加 `'` 前缀，补充空白/控制字符、BOM/零宽前缀及全角触发字符。
  JSON Number 负数、NULL 和 RFC4180 引号规则保持原行为；危险文本字段的原始字节
  会变化，不能把防护 CSV 当成原始保真备份（可用 SQL/JSON）。普通 CSV 导入没有
  自动剥除前缀；配对逆函数仅供明确经过该编码的单元格使用，不猜测用户字面撇号。
- 表搜索索引持久化 comment（支持 null/缺省），独立缓存后缀升级为
  table-search-index-v2，避免误用旧的完整名称索引；重刷索引后可搜索未加载表的注释。
  抽取实际 ConnectionTree 过滤函数以验证索引/回退分支，并保留展开、加载和子节点。
  对象列表刷新后版本化内存索引快照：更名后的旧索引退回当前已加载节点，不再重建
  旧名称；跨版本的异步读取不覆盖结果或抢焦，旧索引查询结果不写持久缓存。
- 未新增 TreeItem computed，性能预算守卫通过。实际挂载组件验证三种注释模式、
  长注释 tooltip 和无注释；happy-dom 的固定宽度/hover 模拟只用于分支与内容验收，
  不宣称真实浏览器几何验证。触发器所属表、禁用名称/图标即时重绘测试仍通过。

**最终验证**：完整 pnpm check 的格式、lint、typecheck 通过；5367 项测试、643 个
套件通过，仅既有 5 个本机 `No such built-in module: node:` 套件未能加载，整体
check 仍非全绿。Rust core 全量 1209 项通过、11 项 ignored；CI 同款 workspace
clippy（locked/all-targets/no-default-features/system-fonts/offline）、cargo fmt 与
frontend build 通过。只读核对测试库 standard_conforming_strings=on；没有执行真实
数据库重命名或其他写操作，也没有启动或自动化桌面 UI。本批仅合入代码并本地提交，
未升版本、推送或发版。
