import type { ChangelogLang, ChangelogRelease } from "@/lib/app/changelog";

const BUNDLED_RELEASES_CN: ChangelogRelease[] = [
  {
    tag: "v0.3.5",
    name: "OG Developer v0.3.5",
    date: "2026-11-23",
    sections: [
      {
        type: "improved",
        title: "改进",
        items: [
          { title: "SQL 标签执行状态", desc: "SQL 或 EXPLAIN 执行时，标签显示浅绿色底色和旋转图标，切到其他标签后也能看见。黑色星号用于提示未保存" },
          { title: "编辑菜单图标", desc: "格式化 SQL 使用和编辑器工具栏一致的文本排版图标" },
          { title: "更新入口和说明", desc: "手动检查更新集中到帮助菜单，更新说明使用文档图标" },
        ],
      },
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "快速打开按钮重叠", desc: "命令模式与关闭按钮并排显示，窄窗口也能分别点击" }],
      },
    ],
  },
  {
    tag: "v0.3.4",
    name: "OG Developer v0.3.4",
    date: "2026-11-20",
    sections: [
      {
        type: "improved",
        title: "改进",
        items: [{ title: "SQL 书签图标与右键管理菜单升级", desc: "升级为清晰端正的琥珀金矢量书签丝带并随字号缩放，子菜单新增数量徽章、行号标签、逐项删除及清空全部功能" }],
      },
      {
        type: "fixed",
        title: "问题修复",
        items: [
          { title: "SQL 悬浮 DDL 卡片穿透与遮挡修复", desc: "修复悬浮宿主在 KeepAlive 切换/弹窗中退化导致被结果工具栏穿透和表头遮挡的问题，提升浮窗层级并约束高度溢出" },
          { title: "前置未封口片段合并及选区连击塌缩修复", desc: "修复非关键字前置残留文本吞并后续 SELECT 语句导致执行报错的问题，并避免双击/三击及行尾空白点击把选区折叠回单光标" },
        ],
      },
    ],
  },
  {
    tag: "v0.3.3",
    name: "OG Developer v0.3.3",
    date: "2026-11-19",
    sections: [
      {
        type: "added",
        title: "新功能",
        items: [
          { title: "结果集选区多维实时统计", desc: "状态栏摘要支持实时聚合与弹出统计面板（非空、NULL、去重、SUM、AVG、MIN、MAX 及一键复制）" },
          { title: "Quick Open 对象补齐与 > 命令面板", desc: "支持同义词/触发器/作业/调度任务/函数签名、已打开标签页跳转，以及 > 前缀直达 13 个工具命令" },
          { title: "openGauss EXPLAIN PERFORMANCE 与索引推荐", desc: "支持 EXPLAIN PERFORMANCE 性能剖析与事务沙箱回滚，并在计划面板内置 gs_index_advise 索引推荐抽屉" },
          { title: "表空间、死元组膨胀与无用索引体检", desc: "新增存储占用、表膨胀评估（VACUUM/REINDEX 脚本生成与受护 ANALYZE）及零扫描冗余索引顾问面板" },
          { title: "openGauss 运行参数 (GUC) 助手", desc: "支持按生效上下文与常用预设筛选 pg_settings，生成 SET / ALTER SYSTEM SET / gs_guc 命令" },
          { title: "内置更新说明 (Release Notes)", desc: "检查更新弹窗、关于弹窗与设置关于页均支持展示各版本更新内容与历史版本日志" },
        ],
      },
      {
        type: "improved",
        title: "改进",
        items: [
          { title: "环境色与生产环境防误触强化", desc: "标签页、工具栏、数据浏览与管理页增加 2px 顶部警戒色带与环境圆点标识" },
          { title: "帮助菜单与发布链路升级", desc: "帮助菜单直达检查更新，发布流程自动提取 CHANGELOG 写入 GitHub Release 与热更新清单" },
          { title: "遗留死组件清理", desc: "全仓引用核查后安全移除 5 个零引用遗留组件" },
        ],
      },
    ],
  },
  {
    tag: "v0.3.2",
    name: "OG Developer v0.3.2",
    date: "2026-11-18",
    sections: [
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "SQL 悬浮 DDL 弹窗背景与内边距", desc: "恢复悬浮提示卡片的不透明背景色与舒适内边距，避免与底层代码重叠看不清" }],
      },
    ],
  },
  {
    tag: "v0.3.1",
    name: "OG Developer v0.3.1",
    date: "2026-11-18",
    sections: [
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "跨 Schema / 同义词 DDL 悬浮触发与视口溢出", desc: "统一对象名悬停识别规则并约束浮窗最大尺寸，避免超出编辑器边界" }],
      },
    ],
  },
  {
    tag: "v0.3.0",
    name: "OG Developer v0.3.0",
    date: "2026-11-17",
    sections: [
      {
        type: "added",
        title: "新功能",
        items: [
          { title: "SQL 语法检查与诊断跳转", desc: "保守式语法 Lint、快速修复、F8 跳转诊断与全角分号/逗号执行兼容" },
          { title: "sql_compatibility 徽章", desc: "状态栏按库显示 openGauss SQL 兼容模式（A / PG / B 等）" },
          { title: "语义化执行计划与沙箱回滚", desc: "支持估算 / EXPLAIN ANALYZE / 事务沙箱自动回滚，并在标签页标注未提交事务" },
          { title: "openGauss 分区表与存储特性", desc: "表结构编辑器补齐分区定义、ASTORE/USTORE、行/列存、压缩及 CHECK 约束" },
          { title: "PL/SQL 符号大纲与格式化增强", desc: "程序窗口支持左侧符号大纲、快速调试入口及 PACKAGE 格式化" },
          { title: "回收站与 TIMECAPSULE 闪回", desc: "支持浏览回收站并执行闪回恢复及 PURGE 清理" },
          { title: "绑定参数记忆与可执行 SQL 复制", desc: "保留历史参数预设，一键预览或替换为完整可执行 SQL" },
          { title: "锁等待链树状可视化", desc: "Root Blocker 阻塞树与环路检测、idle in transaction 提醒" },
        ],
      },
      {
        type: "improved",
        title: "改进",
        items: [{ title: "对象树搜索、欢迎页与工具栏精简", desc: "扩展包/过程/函数/序列检索、欢迎页快捷入口及界面去重" }],
      },
    ],
  },
  {
    tag: "v0.2.53",
    name: "OG Developer v0.2.53",
    date: "2026-10-14",
    sections: [
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "视图 DDL 与物化视图列表修复", desc: "补全视图定义与注释展示并恢复物化视图对象加载" }],
      },
    ],
  },
  {
    tag: "v0.2.52",
    name: "OG Developer v0.2.52",
    date: "2026-10-14",
    sections: [
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "同义词 DDL 与目标展开修复", desc: "展示同义词定义及目标对象 DDL" }],
      },
    ],
  },
  {
    tag: "v0.2.51",
    name: "OG Developer v0.2.51",
    date: "2026-10-13",
    sections: [
      {
        type: "added",
        title: "新功能",
        items: [{ title: "过程化代码格式化与多对象重命名", desc: "支持 openGauss 存储过程/函数/包格式化与更多对象类型重命名" }],
      },
    ],
  },
  {
    tag: "v0.2.50",
    name: "OG Developer v0.2.50",
    date: "2026-10-12",
    sections: [
      {
        type: "fixed",
        title: "问题修复",
        items: [{ title: "SQL 格式化选项去重", desc: "清理重复的定宽关键词对齐设置" }],
      },
    ],
  },
  {
    tag: "v0.2.49",
    name: "OG Developer v0.2.49",
    date: "2026-10-12",
    sections: [
      {
        type: "added",
        title: "新功能",
        items: [{ title: "SQL 关键词左右对齐", desc: "新增整段查询关键词左对齐与右对齐格式化风格" }],
      },
    ],
  },
  {
    tag: "v0.2.48",
    name: "OG Developer v0.2.48",
    date: "2026-10-12",
    sections: [
      {
        type: "added",
        title: "新功能",
        items: [{ title: "JOIN 与 FROM/WHERE 行内对齐", desc: "支持 JOIN 跟随 FROM 对齐及行内子句布局" }],
      },
    ],
  },
];

const BUNDLED_RELEASES_EN: ChangelogRelease[] = [
  {
    tag: "v0.3.5",
    name: "OG Developer v0.3.5",
    date: "2026-11-23",
    sections: [
      {
        type: "improved",
        title: "Improved",
        items: [
          { title: "SQL tab execution status", desc: "Tabs with a running SQL or EXPLAIN statement show a light green background and a spinner, visible even after switching tabs. The asterisk indicates unsaved changes" },
          { title: "Edit menu icon", desc: "Format SQL uses the same text alignment icon as the SQL editor toolbar" },
          { title: "Update controls and release notes", desc: "Use Help to check for updates. Release notes use a document icon" },
        ],
      },
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "Overlapping Quick Open controls", desc: "The Commands and Close buttons have separate click targets even in narrow windows" }],
      },
    ],
  },
  {
    tag: "v0.3.4",
    name: "OG Developer v0.3.4",
    date: "2026-11-20",
    sections: [
      {
        type: "improved",
        title: "Improved",
        items: [{ title: "Upgraded SQL bookmark icon & management menu", desc: "Replaced tiny emoji markers with a crisp font-scaled amber SVG ribbon (22px gutter) and added count badges, line pills, per-item remove, and clear-all actions" }],
      },
      {
        type: "fixed",
        title: "Fixed",
        items: [
          { title: "SQL hover DDL layering & result-pane occlusion", desc: "Prevented tooltip portal fallback inside KeepAlive tabs/dialogs so hover DDL cards always render above result toolbars and grid headers with bounded scroll height" },
          { title: "Soft-statement isolation & multi-click selection collapse", desc: "Isolated statements following unterminated non-keyword fragments (preserving optimizer hints) and stopped selection drag from collapsing double/triple-clicks and trailing-space clicks" },
        ],
      },
    ],
  },
  {
    tag: "v0.3.3",
    name: "OG Developer v0.3.3",
    date: "2026-11-19",
    sections: [
      {
        type: "added",
        title: "Added",
        items: [
          { title: "Multi-dimensional DataGrid selection stats", desc: "Live footer aggregation summary with clickable Popover (non-null, NULLs, distinct, SUM, AVG, MIN, MAX) and one-click copy" },
          { title: "Expanded Quick Open & > Command Palette", desc: "Index synonyms (with target mapping), triggers, jobs, schedulers, routine signatures, open tabs, and 13 > commands" },
          { title: "openGauss EXPLAIN PERFORMANCE & Index Advisor", desc: "Profiling execution mode (DML auto-sandbox rollback) and built-in gs_index_advise recommendations with standard/CONCURRENTLY DDL" },
          { title: "Storage, Bloat & Unused Index Advisor", desc: "Inspect tablespaces, top relation sizes, dead-tuple bloat (VACUUM/REINDEX scripts & guarded ANALYZE), and zero-scan indexes" },
          { title: "openGauss GUC Parameter Helper", desc: "Browse pg_settings by context, preset filters, and modified-only state; generate SET / ALTER SYSTEM SET / gs_guc commands" },
          { title: "Built-in Release Notes Viewer", desc: "Show per-version release notes directly in Update Dialog, About Dialog, and Settings -> About with offline fallback + GitHub sync" },
        ],
      },
      {
        type: "improved",
        title: "Improved",
        items: [
          { title: "Environment & PROD visual guards", desc: "2px top accent bars and environment dots across tabs, toolbar, data headers, and admin panels" },
          { title: "Help menu & release pipeline", desc: "Added Check for Updates to Help menu and automated CHANGELOG extraction into GitHub Releases and latest.json" },
          { title: "Verified dead component cleanup", desc: "Removed 5 zero-reference legacy Vue components while keeping actively used components" },
        ],
      },
    ],
  },
  {
    tag: "v0.3.2",
    name: "OG Developer v0.3.2",
    date: "2026-11-18",
    sections: [
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "SQL hover DDL popover contrast", desc: "Restored opaque popover surface background and padding on editor DDL tooltips" }],
      },
    ],
  },
  {
    tag: "v0.3.1",
    name: "OG Developer v0.3.1",
    date: "2026-11-18",
    sections: [
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "Cross-schema / synonym hover triggers & overflow", desc: "Normalized object-name hover detection and constrained tooltip size inside the viewport" }],
      },
    ],
  },
  {
    tag: "v0.3.0",
    name: "OG Developer v0.3.0",
    date: "2026-11-17",
    sections: [
      {
        type: "added",
        title: "Added",
        items: [
          { title: "SQL / PL/SQL syntax diagnostics", desc: "Conservative lint diagnostics, quick fixes, F8 jump controls, and fullwidth semicolon/comma execution support" },
          { title: "sql_compatibility badge", desc: "Display per-database openGauss compatibility mode (A / PG / B) in status bar" },
          { title: "Semantic Explain modes & transaction guard", desc: "Split Estimate / ANALYZE / Transaction Sandbox rollback modes plus uncommitted transaction indicators on tabs" },
          { title: "openGauss partitions, storage options & CHECK constraints", desc: "Added partition configuration, ASTORE/USTORE, orientation, compression, fillfactor, and CHECK constraints in Table Structure Editor" },
          { title: "PL/SQL Outline & formatter enhancements", desc: "Symbol Outline sidebar with run/debug shortcuts and improved PACKAGE/procedural formatting" },
          { title: "Recycle Bin & TIMECAPSULE flashback", desc: "Browse Recycle Bin items and generate FLASHBACK / PURGE actions" },
          { title: "Bind parameter presets & executable SQL copy", desc: "Remember parameter values and preview/copy/replace bound SQL inline" },
          { title: "Lock waiting chain tree", desc: "Root Blocker tree visualization with cycle detection and idle-in-transaction alerts" },
        ],
      },
      {
        type: "improved",
        title: "Improved",
        items: [{ title: "Sidebar search scopes, welcome shortcuts & UI cleanup", desc: "Search packages/procedures/functions/sequences, welcome actions, and deduplicated toolbar items" }],
      },
    ],
  },
  {
    tag: "v0.2.53",
    name: "OG Developer v0.2.53",
    date: "2026-10-14",
    sections: [
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "View DDL & materialized view listing", desc: "Restored view definitions/comments and materialized view tree loading" }],
      },
    ],
  },
  {
    tag: "v0.2.52",
    name: "OG Developer v0.2.52",
    date: "2026-10-14",
    sections: [
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "Synonym DDL preview", desc: "Show full CREATE SYNONYM definition and target object DDL" }],
      },
    ],
  },
  {
    tag: "v0.2.51",
    name: "OG Developer v0.2.51",
    date: "2026-10-13",
    sections: [
      {
        type: "added",
        title: "Added",
        items: [{ title: "Procedural formatting & multi-object rename", desc: "Expanded openGauss procedural formatting and object rename support" }],
      },
    ],
  },
  {
    tag: "v0.2.50",
    name: "OG Developer v0.2.50",
    date: "2026-10-12",
    sections: [
      {
        type: "fixed",
        title: "Fixed",
        items: [{ title: "SQL formatter setting cleanup", desc: "Removed duplicate fixed-width alignment settings" }],
      },
    ],
  },
  {
    tag: "v0.2.49",
    name: "OG Developer v0.2.49",
    date: "2026-10-12",
    sections: [
      {
        type: "added",
        title: "Added",
        items: [{ title: "Left & right SQL keyword alignment", desc: "Whole-query left and right keyword alignment options in formatter" }],
      },
    ],
  },
  {
    tag: "v0.2.48",
    name: "OG Developer v0.2.48",
    date: "2026-10-12",
    sections: [
      {
        type: "added",
        title: "Added",
        items: [{ title: "JOIN & inline FROM/WHERE options", desc: "Align JOIN with FROM and format compact FROM/WHERE clauses" }],
      },
    ],
  },
];

export function getBundledChangelogReleases(lang: ChangelogLang): ChangelogRelease[] {
  const source = lang === "cn" ? BUNDLED_RELEASES_CN : BUNDLED_RELEASES_EN;
  return source.map((release) => ({
    ...release,
    sections: release.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item })),
    })),
  }));
}
