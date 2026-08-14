[English](README.en.md) | **简体中文**

<div align="center">

# og developer

**openGauss 专用数据库开发工具 —— 桌面端（Tauri）+ Web。**

基于 [dbx](https://github.com/t8y2/dbx) 的深度定制版，只专注 openGauss 一种
数据库，把方言细节与 PL/SQL 开发体验做透。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Based on](https://img.shields.io/badge/based%20on-dbx-2b7bd9)](https://github.com/t8y2/dbx)

</div>

---

## 为什么有 og developer

dbx 支持 70+ 种数据库；og developer 反其道而行——入口裁剪到**只保留
openGauss**，把全部精力投入到：

- **openGauss 方言深度**：PL/SQL 感知的语句切分、A 兼容模式类型、
  包/同义词目录（`gs_package` / `pg_synonym` / `gs_source`）、源码重建、
  `sql_compatibility`（A/B/C/PG/M）模式感知。
- **PL/SQL 开发体验**：基于 `dbe_pldebugger` 的图形调试器、DBMS_OUTPUT /
  `RAISE NOTICE` 捕获、编译错误行定位、包内子程序层级与无效对象标记。
- **零门槛连接**：默认内嵌官方 openGauss JDBC 驱动
  （`org.opengauss.Driver`），根治 SHA-256 认证问题；同时保留原生 wire 协议。

上游 dbx 代码尽量原样保留：连接类型白名单是唯一的入口裁剪——放宽白名单即可
恢复其它数据库。

## 特性

### openGauss 深度定制

- **连接**：内嵌官方 JDBC 驱动（自动就位，支持 `jdbc:opengauss://`），另有
  原生 wire 协议并捕获 RAISE NOTICE（vendored `tokio-postgres` fork）。
- **PL/SQL 切分器**：openGauss 复用 GaussDB 方言 profile——PL/SQL 块、
  `/` 行终止符、dollar-quoted 例程体，`CREATE PACKAGE BODY` 等不再被 `;` 切碎。
- **对象树**：`PACKAGE` / `PACKAGE_BODY` / `SYNONYM` / `TYPE` / `JOB` 节点、
  包内子程序层级、无效对象（编译失败）标记、幽灵源码、分组计数、全部展开、
  另存为、表/视图/物化视图/包创建模板。
- **源码查看**：优先 `gs_source` 原始 CREATE 全文，`gs_package` 兜底；
  包/同义词 DDL 重建为可执行形式，可编辑后回存执行（编译回环）。
- **执行反馈**：DBMS_OUTPUT 与 `RAISE NOTICE` 消息经 JDBC/原生双路捕获，
  显示在结果视图；编译错误把 `LINE n` 映射回编辑器行。
- **A 兼容模式类型**：`NUMBER`、`VARCHAR2`、`NVARCHAR2`、`RAW`、`BLOB`、
  `BINARY_INTEGER`/`PLS_INTEGER`、`BINARY_FLOAT`、`BINARY_DOUBLE`、`JSONB`、
  `INTERVAL`。
- **图形化 PL/SQL 调试器**：编辑器内断点、变量表、调用栈、单步/继续/跳出，
  基于 `dbe_pldebugger` 双会话模型（已在 openGauss-lite 7.0.0-RC3 真机
  全流程验证）。
- **兼容模式感知**：连接后探测 `sql_compatibility`，驱动树节点显隐、编辑器
  方言与信息面板（A/PG 规则已真机验证）。

### 继承自 dbx 的通用能力

- SQL 编辑器基础：补全、多语句执行、批量执行进度、结果网格与导出。
- Schema 浏览器、表结构编辑、扩展管理、数据传输等通用数据库工具能力。

### og developer 新增的通用能力

以下能力并非继承自 dbx，而是本仓库新增的：

- **SQL 书签**：行号槽 🔖 位置书签、右键添加/删除/跳转（F2 / Shift-F2）。
- **菜单栏与编辑器命令**：项目/搜索/编辑/工具菜单，撤销/重做/剪切/复制/
  粘贴/查找/查找并替换，SQL 另存为。
- **三模式搜索**：文件（项目目录内）、元数据（对象名）、数据库对象（定义文本）。
- **workspace 项目管理**：创建/打开项目（命名工作目录），文件搜索以项目为
  默认根。
- **会话管理**：`pg_stat_activity` 会话列表、手动/定时刷新、终止会话。
- **格式化示例预览**：SQL 格式化设置面板中的实时示例。
- **输出视图**：DBMS_OUTPUT / `RAISE NOTICE` 行在结果区的“输出”页展示。

## 与上游的关系

本仓库是 [dbx](https://github.com/t8y2/dbx)（Copyright (c) dbx
contributors）的**派生 fork**，基于 Apache License 2.0 分发。

- 相对上游的全部修改见 [NOTICE](NOTICE)。
- 完整保留 dbx 的 git 历史，保证署名可追溯。
- 产品名为 "og developer"，不声称获得 dbx 项目的背书或与 dbx 存在隶属关系。

### 分支

- `main` —— 产品主线：品牌化、入口裁剪与 openGauss 特性。
- `opengauss-fixes` —— 干净的 openGauss 修复集，随时可作为 PR 提交给上游。

上游以 `upstream` remote 跟踪，定期合并。

## 快速开始

### 环境要求

- Node.js 22（见 `.nvmrc`）与 pnpm 10
- Rust（stable），用于 Tauri 后端
- Linux：`webkit2gtk`、`fontconfig` 等 Tauri 系统库
- Windows：见 [BUILD_WINDOWS.md](BUILD_WINDOWS.md)（必须 MSVC 工具链）
- NixOS：见 [README-NIX.md](README-NIX.md)

### 安装与运行

```bash
pnpm install          # 前端依赖
pnpm dev              # 前端开发服务器（Vite）
pnpm dev:tauri        # 桌面端（Tauri）
```

Web 模式（前后端分开跑）：

```bash
pnpm dev:web          # Web 前端，端口 5173
pnpm dev:backend      # Web 后端
```

### 构建与打包

```bash
pnpm build            # 类型检查 + 前端构建
pnpm tauri build      # 桌面安装包（.deb/.rpm/.msi/...）
```

### 测试

```bash
npx vitest run        # 前端测试
cargo test -p dbx-core --no-default-features \
  --features duckdb-sidecar,mq-admin,sqlite-sqlcipher --lib   # Rust 测试
```

测试实例为本机 Docker 容器（`openGauss-lite` 7.0.0-RC3，端口 5432）；
[Makefile](Makefile) 里另有 `db-*` 系列目标管理测试库。

## 文档

- [OG_DEVELOPER.md](OG_DEVELOPER.md) —— 仓库布局、与原版的差异
- [OPENGAUSS_FIXES.md](OPENGAUSS_FIXES.md) —— openGauss 修复集（切分器/
  对象树/源码/类型），已在 7.0 真机验证
- [OPENGAUSS_ROADMAP.md](OPENGAUSS_ROADMAP.md) —— 依据官方 6.0 手册与
  7.0 真机实测的特性路线图
- `docs/` —— 文档站点（`make docs` 本地预览）

## 贡献

见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)（或
[CONTRIBUTING.md](CONTRIBUTING.md)）。回馈上游最规范的方式：把
`opengauss-fixes` 分支的修复以 PR 形式提交给
[上游 dbx](https://github.com/t8y2/dbx)。

## 许可证

Apache License 2.0。本项目是 [dbx](https://github.com/t8y2/dbx)
（Copyright (c) dbx contributors）的派生作品；见
[LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
