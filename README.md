[English](README.en.md) | **简体中文**

<div align="center">

# OG Developer

**专门为 openGauss 打造的现代化数据库开发工具 —— 桌面端（Tauri）+ Web 端**

基于 [dbx](https://github.com/t8y2/dbx)（Apache-2.0）深度定制，裁剪通用入口，专注于 openGauss 一种数据库，把方言细节与 PL/SQL 开发体验做深做透。

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Based on](https://img.shields.io/badge/based%20on-dbx-2b7bd9)](https://github.com/t8y2/dbx)
[![openGauss](https://img.shields.io/badge/openGauss-6.0%20%7C%207.0-red.svg)](https://opengauss.org/)

</div>

---

## 💡 为什么有 OG Developer？

通用数据库客户端（如 DBeaver、Navicat 或原版 dbx）虽然连接类型繁多，但面对 openGauss 时往往存在水土不服：
- 默认连接受限于 SHA-256 密码加密协议；
- PL/SQL 脚本切分容易把包体内部的分号切碎；
- 缺少对 Package（包头/包体）、同义词、作业（Job）的原生层级支持；
- 缺乏对 `dbe_pldebugger` 图形化调试与 `DBMS_OUTPUT` 输出流的完整支持；
- 过程与包体内部的引用依赖关系难以分析。

**OG Developer 反其道而行** —— 将连接类型白名单裁剪为仅保留 openGauss，全力解决上述痛点，对标 PL/SQL Developer 与 Oracle SQL Developer 的开发体验，做最懂 openGauss 的专用开发工具。

---

## ✨ 核心杀手锏特性

### 1. 🔌 零门槛极速连接与双通道支持
- **内嵌官方 JDBC 驱动**：默认内嵌 `org.opengauss.Driver`，开箱即用，原生支持 openGauss 默认的 SHA-256 身份认证机制与兼容参数。
- **双通道架构**：同时提供原生 Wire 协议连接（vendored `tokio-postgres`），精准捕获 `RAISE NOTICE` / `INFO` 消息流。

### 2. ⚡ PL/SQL 程序窗口 (Program Window)
- **专为过程/函数/包打造的 IDE 窗口**：
  - **包头/包体双标签独立维护**：支持 Package 规范（Specification）与包体（Body）一键无缝切换编辑。
  - **编译并保存**：一键执行编译，实时反馈毫秒级编译耗时与状态。
  - **编译错误行精准映射**：自动解析 openGauss 报错中的 `LINE n`，与编辑器代码行精准联动并在报错列表中点击跳转。
  - **源码差异比对 (Diff)**：保存前一键与数据库现有源码进行逐行改动比对。
  - **代码美化与格式化**：内置针对 openGauss / Oracle 方言的 SQL 美化器。

### 3. 🐞 图形化 PL/SQL 调试器 (Debugger)
- **底层基于 openGauss 原生 `dbe_pldebugger` 双会话模型**（已在 openGauss 7.0 真机全流程验证）：
  - **断点管理**：在编辑器行号槽点击添加、删除和启用/禁用断点。
  - **单步控制**：单步步入（Step Into）、单步跳过（Step Over）、跳出（Step Out）、继续运行（Continue）与终止（Abort）。
  - **变量监视与修改**：实时查看局部变量表（`info_locals`），支持查看与运行时修改变量值（`set_var`）。
  - **调用栈回溯**：直观展示多层子程序调用的 Backtrace 栈帧；执行结束或停止后保留最后一次有效快照。

### 4. 🕸️ 双向对象引用与依赖分析 (Dependencies & Lineage)
- **全方位打通存储过程、函数、包规范、包体的依赖追踪**：
  - **引用方 (References / Depends On)**：基于静态 PL/SQL 词法抽取与 Catalog 符号消歧，精确识别过程/包体引用的表、视图、例程、包、序列与类型。
  - **被引用方 (Referenced By / Used By)**：结合 `pg_depend` 与全库 PL 源码快速扫描，一键找出所有调用/依赖当前表、视图或函数的外部过程与包体。
  - **双入口呈现**：侧边栏对象树（展开 `引用` / `被引用` 子节点）与程序窗口（底部 `依赖关系` 专属面板）。

### 5. ⏱️ PL/SQL 逐行性能剖析器 (PL/SQL Profiler)
- **底层基于 openGauss `gms_profiler` 扩展**：
  - **行级热力图与耗时分布**：自动捕获存储过程或包体每行代码的实际执行次数（Count）、总耗时（Total Time）、平均耗时（Avg Time）、最小/最大耗时；
  - **性能热点直观定位**：按耗时占比进行热力条形高亮（<10% 绿色、10-30% 蓝色、30-60% 黄色、>60% 红色），毫秒级定位性能瓶颈代码行。

### 6. 🔴 无效对象批量重编译中心 (Recompile Invalid Objects)
- **数据库对象改动后的一键自愈**：
  - **全库失效对象快速扫描**：基于 `dbe_pldeveloper.gs_source`（`status = 'f'`）与 `dbe_pldeveloper.gs_errors`，一键拉出所有编译报错的过程、函数、包规范与包体；
  - **批量/单项安全重编译**：支持一键「全部重编译」或「重编译选中项」，实时呈现编译进度与报错详情，支持一键在程序窗口定位修复。

### 7. 💻 交互式命令窗口 (Command Window)
- **融合 IDE 便捷性与终端沉浸感的交互窗口**：
  - **openGauss 原生元命令全面支持**：支持 `\d`（表结构）、`\dt`（表清单）、`\df`（函数/过程）、`\dv`（视图）、`\dn`（模式）、`\di`（索引）、`\ds`（序列）、`\du`（用户与角色）、`\c <dbname>`（切换数据库）、`\timing`（耗时切换）、`clear`（清屏）、`\?` / `help`（帮助）；
  - **SQL*Plus / 常用运维命令兼容**：支持 `DESC table`、`SHOW ERRORS`、`SHOW USER` 以及标准 SQL 与 PL/SQL 块执行。

### 8. 🎯 例程图形化执行与测试 (Routine Test Panel)
- **参数智能推导**：自动提取存储过程与函数的入参、出参（OUT / INOUT）与默认值。
- **OUT 参数结果集回显**：存储过程返回的 OUT 字段自动转为网格与结构化结果展示。
- **DBMS_OUTPUT 捕获**：执行后自动拉取 `gms_output.get_lines`，呈现服务器端打印日志。

### 6. 🌳 完备的对象树与元数据体系
- **完整对象体系**：支持 表、视图、物化视图、存储过程、函数、包（Package & Package Body）、同义词（Synonym）、定时作业（Job）、自定义类型（Type）、序列（Sequence）。
- **包内子程序层级展示**：通过 `pg_proc.propackageid → gs_package` 关联，包节点展开即可直观查看下挂的所有函数与过程。
- **无效对象与幽灵源码支持**：
  - 标记编译失败对象（`dbe_pldeveloper.gs_source.status = 'f'` 红点告警，对标 Oracle INVALID 状态）。
  - 编译失败的对象即便在 `pg_proc` 中无实体，也能在树中呈现并查看保存在 `gs_source` 中的原始 CREATE 源码。

### 7. 🛡️ 兼容模式与 Oracle 方言深度适配
- **模式自适应**：连接后自动感知 `sql_compatibility`（A / B / C / PG / M），自动切换关键字提示、语法切分与信息面板。
- **A 兼容模式类型全覆盖**：原生支持 `NUMBER`、`VARCHAR2`、`NVARCHAR2`、`RAW`、`BLOB`、`BINARY_INTEGER`/`PLS_INTEGER`、`BINARY_FLOAT`、`BINARY_DOUBLE`、`JSONB`、`INTERVAL` 等。
- **PL/SQL 块切分器**：识别 GaussDB / Oracle 风格 PL/SQL 块、`/` 行终止符与 `$$` 包裹块，批量脚本执行绝不破坏内部结构。

---

## 🛠️ 现代化开发与 IDE 生产力工具

- 📊 **会话与锁监控 (Session & Lock Monitor)**：实时查看 `pg_stat_activity` 活动会话列表、查询耗时、锁等待状态，支持一键终止会话。
- 🔍 **全局三模搜索中心**：支持按对象名（元数据）、定义文本（DDL/源码全文）、项目工作区文件进行秒级定位。
- 🔖 **SQL 编辑器增强**：行号槽书签（Bookmark 🔖）、F2 / Shift+F2 快速跳转、多结果集持久化视图、执行进度追踪。
- 📈 **数据网格 (Data Grid)**：列头快速聚合统计（求和/平均值/极值/去重）、行内就地编辑、复杂 JSON / 空间几何图层预览、全格式导出（Excel/CSV/JSON/SQL）。
- 📁 **工作区与项目管理 (Workspace Projects)**：支持本地目录项目工程化管理与批量 SQL 执行。

---

## 🔀 与上游项目的关系

本仓库是 [dbx](https://github.com/t8y2/dbx)（Copyright (c) dbx contributors）的**深度定制派生分支 (Fork)**，基于 Apache License 2.0 分发。

- 详细修改清单与署名记录见 [NOTICE](NOTICE)。
- 完整保留 dbx 原始 Git 提交历史，保证署名可追溯。
- 产品名为 **OG Developer**，不声称获得 dbx 项目的官方背书。
- 本仓库主分支为 `main`，上游变更通过 `upstream` 远程分支保持同步。

---

## 🚀 快速开始

### 环境准备
- **Node.js**：>= 22（推荐通过 `.nvmrc` 配置）与 **pnpm** >= 10
- **Rust**：Stable 工具链（用于 Tauri 与 Rust Core）
- **Linux 依赖**：`webkit2gtk`、`fontconfig` 等 Tauri 系统库
- **Windows 依赖**：参见 [BUILD_WINDOWS.md](BUILD_WINDOWS.md)（需 MSVC 工具链）
- **NixOS**：参见 [README-NIX.md](README-NIX.md)

### 安装与运行

```bash
pnpm install          # 安装前端依赖

# 桌面端开发（Tauri）
pnpm dev:tauri

# Web 端开发（前端 5173 + 本地后端服务）
pnpm dev:web          # 启动 Web 前端
pnpm dev:backend      # 启动 Web 后端
```

### 构建与打包

```bash
pnpm build            # 前端类型检查与构建
pnpm tauri build      # 构建各平台桌面安装包（.deb / .rpm / .msi / .dmg 等）
```

### 测试

```bash
# 前端全量单元测试
npx vitest run

# Rust 后端核心库测试
cargo test -p dbx-core --no-default-features \
  --features duckdb-sidecar,mq-admin,sqlite-sqlcipher --lib
```

本地测试实例推荐使用 Docker 容器（`openGauss-lite` 7.0.0-RC3，默认端口 5432）。

---

## 📖 相关文档

- [OG_DEVELOPER.md](OG_DEVELOPER.md) —— 仓库架构布局与演进说明
- [OPENGAUSS_FIXES.md](OPENGAUSS_FIXES.md) —— openGauss 核心修复清单（切分器/对象树/源码/类型）
- [OPENGAUSS_ROADMAP.md](OPENGAUSS_ROADMAP.md) —— 特性规划与实施路线图
- [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) —— 贡献指南

---

## 📄 开源许可证

本项目基于 [Apache License 2.0](LICENSE) 开源发布。
派生作品信息请参见 [NOTICE](NOTICE)。
