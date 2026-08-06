# openGauss 修复补丁说明（分支 opengauss-fixes）

基于 dbx（https://github.com/t8y2/dbx，Apache-2.0）master 修复 openGauss 支持的四类问题。
修复原则是**沿用 dbx 既有模式**（目录探测 → SQL 变体 → 前端能力表），不引入新架构。

## 修复内容

### 1. 执行 package/存储过程脚本被切碎（SQL 切分器）

**根因**：`crates/dbx-core/src/sql.rs` 的 `SqlDialectProfile::for_database_type()` 没有
`DatabaseType::OpenGauss` 分支，落入了不支持 PL/SQL 块、不支持 `/` 行终止符的默认
profile，导致 `CREATE PACKAGE BODY` 这类内部全是分号的语句被按 `;` 切碎（GaussDB 有
正确配置，openGauss 漏了）。

**修复**：openGauss 复用 `gaussdb()` profile（Oracle 风格 PL/SQL 块 + `/` 行终止 +
dollar-quoted 例程体）。

### 2. 对象树缺少 同义词 / 包 节点

**后端**（`crates/dbx-core/src/db/postgres.rs`）：
- 新增目录探测 `postgres_has_pg_catalog_relation()`（沿用 prokind/prosp 探测模式）；
- 探测到 `pg_catalog.gs_package` 时，对象列表追加 `PACKAGE` / `PACKAGE_BODY` 行
  （有 `pkgbodydeclsrc` 时才出 body 行，对齐 Oracle 的展示方式）；
- 探测到 `pg_catalog.pg_synonym` 时追加 `SYNONYM` 行，comment 列带 `FOR 目标对象`；
- 原生 PostgreSQL 没有这两个目录，探测天然把新 UNION 分支限定在 openGauss 上，
  不影响其它 PG 系数据库。

**前端**（`apps/desktop/src/lib/database/databaseObjectCapabilities.ts`）：
- `opengauss` 的侧栏对象能力从 `POSTGRES_OBJECTS` 扩为
  `POSTGRES_OBJECTS + SYNONYM + PACKAGE + PACKAGE_BODY`（分组节点、图标、i18n
  前端已有 Oracle 的实现，直接复用）。

### 3. package / synonym 源码查看与编译回环

`crates/dbx-core/src/schema.rs` 的 `postgres_object_source_sql_inner` 原先对这些
对象类型一律返回 `SELECT NULL WHERE FALSE`。新增 openGauss 专属分支：
- `SYNONYM` → 由 `pg_synonym` 重建 `CREATE OR REPLACE SYNONYM x FOR y;`；
- `PACKAGE` / `PACKAGE_BODY` → 由 `gs_package` 重建可执行 DDL。

> **已真机验证（openGauss-lite 7.0.0-RC3）**：`gs_package` 存的是规范化形式
> ` PACKAGE  DECLARE  <声明> end `（并非原始 CREATE 文本），body 初始化段在
> `pkgbodyinitsrc`（` INSTANTIATION begin...END`）。补丁按此重建 DDL：剥掉
> `PACKAGE DECLARE` 包装和尾部裸 `END`，拼上 `CREATE OR REPLACE PACKAGE [BODY]
> 模式.名 AS ... END 名;`，含初始化段时先拼接 `pkgbodyinitsrc`。
> spec/body/含初始化段的 body 均已在真机回环执行验证通过。

返回的源码可直接编辑后回存执行（配合修复 1，编译不再被切碎）。

### 4. A 兼容模式类型支持

`plugins/dialects/opengauss.yaml` 原类型表基本是原生 PG 类型。补充：
`NUMBER`、`VARCHAR2`、`NVARCHAR2`、`RAW`、`BLOB`、`BINARY_INTEGER(PLS_INTEGER)`、
`BINARY_FLOAT`、`BINARY_DOUBLE`、`JSONB`、`INTERVAL`。

## 已知遗留（留待专用版）

- **SHA256 认证**：openGauss 默认 `password_encryption_type=2`（sha256），
  tokio-postgres 原生协议不支持，连接会失败。规避方式（二选一）：
  1. 服务端给用户改用 md5：`ALTER USER xxx IDENTIFIED BY 'pwd' REPLACE 'pwd';`
     前提 `password_encryption_type=0`；或
  2. 用 dbx 自带的 JDBC 插件（`jdbc:opengauss://host:5432/db` +
     `org.opengauss.Driver`，官方驱动原生支持 sha256）。
  专用版应内嵌官方 JDBC 驱动作为默认连接方式，彻底消除此问题。
- 尚未做 `sql_compatibility`（A/B/C/PG）模式探测，方言行为未按模式切换。
- 包内函数/存储过程的层级展示（package 下挂子程序节点）未做，当前包是平铺节点。

## 验证结果

- `cargo check -p dbx-core` ✓
- `cargo test -p dbx-core --lib`：4036 通过 / 1 失败——失败项
  `sql_parser::git::tests::rejects_non_git_directory` 是环境性失败（本机 `/tmp/.git`
  碰巧存在），与本次修改无关。
- 新增测试：切分器 profile 断言、openGauss package 脚本端到端切分（带 `/` 与不带）、
  对象列表 SQL 含/不含 gs_package、pg_synonym 分支、package/synonym 源码 SQL 生成。
- `npx vitest run`（前端全量）：6983 通过。
