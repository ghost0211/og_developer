# openGauss 专用版特性路线图

> 依据：openGauss 6.0.0 官方手册（Markdown 源码）+ openGauss-lite 7.0.0-RC3 真机实测。
> 凡标注「已实测」的条目均在 7.0 实例上验证过；标注「手册」的来自 6.0 官方文档。

## 一、对象树补齐（P0）

| 特性 | 目录/语法 | 状态 | 说明 |
|---|---|---|---|
| 包/同义词节点 | `gs_package` / `pg_synonym` | ✅ 已修复 | 见 OPENGAUSS_FIXES.md |
| 包内层级 | `pg_proc.propackageid → gs_package.oid` | 已实测 | 包节点展开显示子程序（函数/过程），含签名 |
| 无效对象标记 | `dbe_pldeveloper.gs_source.status='f'` | 已实测 | **编译失败的对象也记录**，树中红色标记（对标 Oracle INVALID） |
| 源码查看增强 | `dbe_pldeveloper.gs_source.src` | 已实测 | **存原始 CREATE 全文**（含失败对象），优于 gs_package 规范化文本；应优先取它、gs_package 兜底 |
| 作业（A 模式） | `pg_job` / `gs_job_attribute` / `gs_job_argument` | 已实测+手册 | DBMS_JOB 体系；节点含启停/手动触发/下次执行时间 |
| 事件（B 模式） | `CREATE EVENT`（仅 sql_compatibility='B'） | 手册 | MySQL 风格 EVENT 调度器，与 pg_job 并存，按模式显示 |
| 类型 | `pg_type`（typtype 'a'=对象类型，CREATE TYPE AS OBJECT 可用） | 已实测 | 类型节点（对象类型/复合类型） |
| 增量物化视图 | `CREATE INCREMENTAL MATERIALIZED VIEW`，`GS_MATVIEW` | 手册 | openGauss 特有，支持增量刷新；MV 节点区分增量/全量 |
| 回收站 | `gs_recyclebin` + `TIMECAPSULE TABLE` 闪回语法 | 手册 | Oracle 风格回收站节点：还原/彻底清除 |
| 目录对象 | `CREATE DIRECTORY` / `pg_directory` | 手册 | |
| 数据源 | `CREATE DATA SOURCE` | 手册 | SQL on Hadoop/外部数据源 |
| 模型（DB4AI） | `CREATE MODEL`，`gs_model_warehouse`/`gs_opt_model` | 手册+实测（目录在） | 库内训练 logistic/linear/svm/kmeans 模型 |
| 发布/订阅 | `CREATE PUBLICATION/SUBSCRIPTION` | 手册 | 逻辑复制管理 |
| 资源池/负载 | `CREATE RESOURCE POOL`，`GS_WLM_*` | 手册 | lite 版无 `gs_resource_pool`（目录探测须兜底——已实测） |
| 安全对象（只读展示） | `GS_AUDITING_*` `GS_MASKING_*` `PG_RLSPOLICIES` `GS_CLIENT_GLOBAL_KEYS/COLUMN_KEYS` | 手册 | 审计策略/动态脱敏/行级安全/全密态密钥 |

## 二、执行与编辑器体验（P0）

1. **JDBC 内嵌**：默认走官方 `org.opengauss.Driver`，根治 sha256 认证；连接框同时保留原生协议选项。
2. **兼容模式感知**：连接后探测 `sql_compatibility`（A/B/C/PG/M），驱动：方言 YAML 选择、树节点显隐（EVENT vs JOB）、编辑器语法高亮（dolphin=B 增强、shark=M/SQLServer 风格）。
3. **DBMS_OUTPUT 输出面板**：执行后自动抓取 `gms_output.get_lines`（已实测扩展可装）；显示 RAISE NOTICE/INFO 等消息流。
4. **编译错误行定位**：CREATE PACKAGE/FUNCTION 报错含 `LINE n`，映射到编辑器行标记（错误信息里还附 QUERY 全文，已实测）。
5. **EXPLAIN 可视化**：复用 dbx 的计划图，加 openGauss 的 `EXPLAIN PERFORMANCE` / 算子级统计（`dbe_perf.get_global_operator_*`）。

## 三、差异化杀手锏（P1）

1. **PL/SQL 图形调试器**（最高价值）
   - API：`dbe_pldebugger` Schema（`attach / turn_on(local_debug_server_info) / add_breakpoint / step / next / continue / finish / info_locals / info_code / print_var / set_var / backtrace / info_breakpoints / enable_disable_breakpoint / abort`）——已在 7.0 实例确认全部函数存在。
   - 官方特性自 1.0 引入，5.1.0 起支持匿名块调试（手册《支持存储过程调试.md》）。
   - 形态：编辑器内打断点 → 调试会话面板（变量表/调用栈/单步）→ 双连接模型（调试端 attach + 被调端执行）。
   - 参考文档：`SQLReference/DBE_PLDEBUGGER-Schema.md`。
2. **PL Profiler**：`gms_profiler` 扩展（手册 ExtensionReference 有完整使用文档），生成逐行耗时报告。
3. **会话/锁/慢 SQL 监控面板**：`dbe_perf`（get_global_locks / get_global_operator_history 等，已实测函数存在）+ `GS_WLM_SESSION_INFO` / `GS_SQL_COUNT`。
4. **SQL Patch 管理**：`GS_SQL_PATCH`（计划级 hint 注入）查看/启停。

## 四、数据与生态（P2）

1. **DataVec 向量**：`vector` 类型、向量索引（datavec/spqplugin）、BM25 全文检索（手册 DataVec 分册）——网格渲染 + 相似度查询模板。
2. **Apache AGE 图**：`age` 扩展已在 7.0 可用扩展列表（已实测）——cypher 查询结果图渲染。
3. **gms_* 高级包补全**：gms_output/gms_lob/gms_raw/gms_sql/gms_utility/gms_compress/gms_i18n/gms_stats 等的签名补全与悬浮文档（7.0 扩展清单已实测）。
4. **全密态/审计/脱敏**的管理界面（安全对象见一）。

## 五、dbx 已有可直接复用（无需重做）

- 序列（含 large sequence L/Z relkind 变体）——dbx 已有补丁
- 表 DDL 反显 `pg_get_tabledef`——列存 orientation/全局临时表反显已实测正确
- 物化视图基础展示（relkind 'm' 已实测）
- MV/表/视图/函数/过程/触发器树节点
- 扩展管理节点（前端 `group-extensions` 现成）

## 实施顺序建议

1. ~~裁剪定型~~ ✅ 已完成
2. ~~JDBC 内嵌~~ ✅ 已完成（默认官方 JDBC 驱动，自动下载，真机验证）
3. ~~兼容模式感知~~ ✅ 已完成（datcompatibility 探测 → 树节点显隐/编辑器方言/信息面板；A/PG 规则已真机验证，B/M 按手册实现——注意：openGauss-lite 7.0.0-RC3 镜像连接 B 模式库会崩溃，无法真机验证 B）
4. P0 树补齐（包内层级 → 无效标记 → gs_source 源码 → JOB → 其余节点）
5. DBMS_OUTPUT 面板 + 编译错误行定位
6. 调试器（技术预研已在真机验证 API 齐全）→ 7. Profiler/监控 → 8. 打包
