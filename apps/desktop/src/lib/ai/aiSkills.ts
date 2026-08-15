import type { AiAction } from "@/lib/ai/ai";

export type AiSkillRiskPolicy = "readonly" | "readonly_preferred" | "confirmed_write" | "sample_write";
export type AiSkillContextNeed = "currentSql" | "schema" | "indexes" | "foreignKeys" | "lastError" | "lastResultPreview" | "databaseDialect";

export interface LocalizedAiSkillText {
  en: string;
  zh: string;
}

export interface LocalizedAiSkillLines {
  en: string[];
  zh: string[];
}

export interface AiSkillDefinition {
  id: string;
  action: AiAction;
  title: LocalizedAiSkillText;
  riskPolicy: AiSkillRiskPolicy;
  contextNeeds: AiSkillContextNeed[];
  userInstruction: LocalizedAiSkillText;
  systemRules: LocalizedAiSkillLines;
  outputContract: LocalizedAiSkillLines;
}

export const AI_SKILL_DEFINITIONS: AiSkillDefinition[] = [
  {
    id: "general",
    action: "general",
    title: {
      en: "General",
      zh: "通用问答",
    },
    riskPolicy: "readonly",
    contextNeeds: [],
    userInstruction: {
      en: "Answer the user's question directly and naturally. Use your general knowledge and the database schema context when relevant.",
      zh: "直接、自然地回答用户的问题。使用你的通用知识，涉及数据库时可参考 Schema 上下文。",
    },
    systemRules: {
      en: ["Answer naturally and helpfully. Adapt to the user's intent — whether that's a greeting, a conceptual question, or a database-related inquiry."],
      zh: ["自然、有帮助地回答。根据用户意图灵活应对——无论是问候、概念性问题还是数据库相关咨询。"],
    },
    outputContract: {
      en: ["Provide a clear, helpful answer adapted to the user's question."],
      zh: ["根据用户问题提供清晰、有帮助的回答。"],
    },
  },
  {
    id: "generate_sql",
    action: "generate",
    title: {
      en: "Generate SQL",
      zh: "生成 SQL",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["schema", "indexes", "foreignKeys", "databaseDialect"],
    userInstruction: {
      en: "Generate a SQL query that satisfies the user's request. Return the SQL in a ```sql code block first, followed by a brief note if needed. Use foreign key relationships from the schema to infer correct JOIN conditions.",
      zh: "根据用户请求生成 SQL。先在 ```sql 代码块中返回 SQL，必要时附简短说明。利用 Schema 中的外键关系推断正确的 JOIN 条件。",
    },
    systemRules: {
      en: ["Use foreign key relationships to infer JOIN conditions. Return the SQL first and avoid long explanations."],
      zh: ["利用外键关系推断 JOIN 条件。生成操作优先返回 SQL，避免长篇解释。"],
    },
    outputContract: {
      en: ["Output format: put only the final recommended SQL in the first ```sql code block; add at most 3 practical notes after it. If required information is missing, ask one clarifying question first."],
      zh: ["输出格式：第一个 ```sql 代码块只放最终推荐 SQL；SQL 后最多 3 条实用说明。信息不足时先提出一个澄清问题。"],
    },
  },
  {
    id: "explain_sql",
    action: "explain",
    title: {
      en: "Explain SQL",
      zh: "解释 SQL",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys", "lastResultPreview"],
    userInstruction: {
      en: "Explain the current SQL step by step. Point out risky operations, implicit assumptions, and potential performance issues. Reference index and foreign key info from the schema when relevant.",
      zh: "逐步解释当前 SQL。指出危险操作、隐含假设和潜在性能问题。结合 Schema 中的索引和外键信息分析。",
    },
    systemRules: {
      en: [
        "Explain what the SQL does without changing it. Reference schema, indexes, foreign keys, result preview, and risky assumptions when relevant.",
        "When explaining execution plans, read them like a performance engineer: call out full table scans (Seq Scan), missing index access paths, join order issues, and plan-level anomalies.",
        "For openGauss/GaussDB plans, also note column-store vs row-store effects, distribution-key mismatches that force redistribution (Streaming/Redistribute), and hash-memory pressure on Hash Join; suggest concrete fixes (index, distribution key, partition pruning).",
      ],
      zh: [
        "解释当前 SQL 的作用，不要改写 SQL。必要时结合 Schema、索引、外键、结果预览和风险假设说明。",
        "解读执行计划时像性能工程师一样：指出全表扫描（Seq Scan）、缺少索引驱动的访问路径、连接顺序问题及计划级异常。",
        "openGauss/GaussDB 计划还需关注：列存/行存差异、分布键不匹配导致的重新分布（Streaming/Redistribute）、Hash Join 的哈希内存压力；给出具体改进建议（索引、分布键、分区裁剪）。",
      ],
    },
    outputContract: {
      en: ["Output format: summarize the SQL purpose first, then explain execution logic, risks, and performance notes step by step."],
      zh: ["输出格式：先概括 SQL 目的，再按步骤解释执行逻辑、风险点和性能注意事项。"],
    },
  },
  {
    id: "optimize_sql",
    action: "optimize",
    title: {
      en: "Optimize SQL",
      zh: "优化 SQL",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys"],
    userInstruction: {
      en: "Rewrite or suggest improvements for the current SQL. Return the improved SQL in a ```sql code block first, followed by short notes explaining the changes. Use the index information in the schema to suggest index-aware optimizations (e.g., avoid full table scans, leverage existing indexes).",
      zh: "重写或优化当前 SQL。先在 ```sql 代码块中返回优化后的 SQL，然后简要说明改动。利用 Schema 中的索引信息建议索引友好的优化（如避免全表扫描、利用现有索引）。",
    },
    systemRules: {
      en: ["Use the index information in the schema to suggest optimizations. Point out which conditions hit indexes and which cause full table scans."],
      zh: ["利用 Schema 中的索引信息建议优化。指出哪些查询条件可以命中索引、哪些会导致全表扫描。"],
    },
    outputContract: {
      en: ["Output format: provide the optimized SQL first, then explain the key changes in at most 3 notes."],
      zh: ["输出格式：先给优化后的 SQL，再用最多 3 条说明解释关键改动。"],
    },
  },
  {
    id: "fix_sql",
    action: "fix",
    title: {
      en: "Fix SQL",
      zh: "修复 SQL",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["currentSql", "schema", "lastError", "lastResultPreview", "databaseDialect"],
    userInstruction: {
      en: "Fix the current SQL using the provided error message and result context. Return the corrected SQL in a ```sql code block first, followed by a brief explanation of the root cause.",
      zh: "根据报错信息和结果上下文修复当前 SQL。先在 ```sql 代码块中返回修正后的 SQL，再简要说明根因。",
    },
    systemRules: {
      en: ["Carefully analyze the error message to identify the root cause. Return the corrected SQL first, then briefly explain."],
      zh: ["仔细分析错误信息，定位根因。先返回修正后的 SQL，再简要解释。"],
    },
    outputContract: {
      en: ["Output format: corrected SQL, error cause, change notes."],
      zh: ["输出格式：修复后的 SQL、错误原因、改动说明。"],
    },
  },
  {
    id: "convert_sql",
    action: "convert",
    title: {
      en: "Convert SQL Dialect",
      zh: "转换 SQL 方言",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["currentSql", "schema", "databaseDialect"],
    userInstruction: {
      en: "Convert the current SQL to the target dialect requested by the user. Return the converted SQL in a ```sql code block first. Note any syntax differences or incompatibilities.",
      zh: "将当前 SQL 转换为用户指定的目标方言。先在 ```sql 代码块中返回转换后的 SQL，再说明语法差异。",
    },
    systemRules: {
      en: ["Convert only to the target dialect requested by the user. Preserve the query intent and call out syntax that cannot be converted safely."],
      zh: ["只转换到用户指定的目标方言。保持查询意图，并指出无法安全转换的语法。"],
    },
    outputContract: {
      en: ["Output format: provide the converted SQL first, then note important target-dialect syntax differences or incompatibilities."],
      zh: ["输出格式：先给转换后的 SQL，再说明目标方言下的重要语法差异或不兼容点。"],
    },
  },
  {
    id: "sample_data",
    action: "sampleData",
    title: {
      en: "Generate Sample Data",
      zh: "生成样例数据",
    },
    riskPolicy: "sample_write",
    contextNeeds: ["schema", "databaseDialect"],
    userInstruction: {
      en: "Generate safe sample INSERT statements or mock data for the current schema. Do not use real production data. Return SQL in a ```sql code block.",
      zh: "为当前 Schema 生成安全的示例 INSERT 语句或模拟数据。不使用真实生产数据。在 ```sql 代码块中返回 SQL。",
    },
    systemRules: {
      en: [
        "Generate mock data only. Do not use or imply real production data, credentials, personal data, or secrets.",
        "When the schema contains sensitive-looking columns (phone, mobile, id_card, email, name, address, bank, etc.), use masked placeholders (e.g. 138****1234, a***@example.com) so the sample never resembles real personal data.",
      ],
      zh: ["只生成模拟数据。不要使用或暗示真实生产数据、凭据、个人数据或密钥。", "当 Schema 包含敏感字段（手机号、身份证、邮箱、姓名、地址、银行等）时，使用脱敏占位值（如 138****1234、a***@example.com），确保样例数据不接近真实个人信息。"],
    },
    outputContract: {
      en: ["Output format: provide safe sample SQL first, then explain which values are mock data."],
      zh: ["输出格式：先给安全的示例 SQL，再说明哪些值是模拟数据。"],
    },
  },
  {
    id: "query_data",
    action: "query",
    title: {
      en: "Query Data",
      zh: "查询数据",
    },
    riskPolicy: "readonly",
    contextNeeds: ["schema", "indexes", "foreignKeys", "databaseDialect"],
    userInstruction: {
      en: "Query or aggregate data per the user's request. Confirm structure via the schema or list_tables/get_columns, then call execute_query to run a read-only query and obtain real results, then answer based on the actual data. Do not stop after merely outputting SQL text.",
      zh: "根据用户请求查询或统计数据。先用 Schema 或 list_tables/get_columns 确认结构，然后调用 execute_query 执行只读查询获取真实结果，最后基于真实结果回答用户。不要只输出 SQL 文本就停止。",
    },
    systemRules: {
      en: ["You MUST obtain real data via the execute_query tool before answering; do not stop at SQL text only.", "If safe execution requirements are not met, explain why first, then provide a read-only preview or a clarifying question."],
      zh: ["必须通过 execute_query 工具获取真实数据后再回答，不要只生成 SQL 文本。", "如果安全执行条件不满足，先说明原因，再给只读预览或澄清问题。"],
    },
    outputContract: {
      en: ["Output format: lead with a one-sentence conclusion based on real data, then include the SQL used in a ```sql code block. When safe execution is not possible, state the reason and ask one clarifying question."],
      zh: ["输出格式：先给一句基于真实数据的结论，再附上所用的 SQL（放在 ```sql 代码块中）。无法安全执行时，说明原因并提出一个澄清问题。"],
    },
  },
  {
    id: "explore_schema",
    action: "exploreSchema",
    title: {
      en: "Inspect Schema",
      zh: "查看表结构",
    },
    riskPolicy: "readonly",
    contextNeeds: ["schema", "databaseDialect"],
    userInstruction: {
      en: "Help the user understand the database or table structure. Prefer the loaded schema context; call list_tables / get_columns for more complete or authoritative definitions, then clearly summarize the structure.",
      zh: "帮助用户了解数据库或表的结构。优先使用已加载的 Schema 上下文；需要更完整或权威的定义时调用 list_tables / get_columns，然后清晰总结结构。",
    },
    systemRules: {
      en: ["Never invent tables or columns not present in the schema context.", "Use get_columns for authoritative column definitions; do not guess."],
      zh: ["不要编造 Schema 中不存在的表或列。", "需要权威列定义时使用 get_columns，不要猜测。"],
    },
    outputContract: {
      en: ["Output format: summarize the key structural points first, then list relevant tables/columns and their purpose. If further exploration helps, include a read-only metadata query."],
      zh: ["输出格式：先概括结构要点，再列出相关表/列及其用途。如需进一步探索，附一个只读元数据查询。"],
    },
  },
  {
    id: "execute_and_explain",
    action: "executeAndExplain",
    title: {
      en: "Run & Explain",
      zh: "执行并解释",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys", "lastResultPreview", "databaseDialect"],
    userInstruction: {
      en: "Execute the current SQL and explain the results. First call execute_query to run the current SQL, then explain the query meaning, data characteristics, and notable points based on the real results.",
      zh: "执行当前的 SQL 并解释结果。先调用 execute_query 运行当前 SQL，再基于真实结果解释查询含义、数据特征和值得注意的点。",
    },
    systemRules: {
      en: [
        "If the current SQL is a write operation, first put its exact text in one ```sql code block and ask the user for explicit confirmation (e.g., 'Should I execute this SQL?') instead of executing immediately. After confirmation, execute that code-block SQL verbatim without rewriting, reformatting, or adding statements. Do not execute writes without user confirmation.",
        "Base explanations on real execution results; do not speculate about data.",
      ],
      zh: [
        "如果当前 SQL 是写操作，先在一个 ```sql 代码块中给出其精确文本，并在回复末尾明确询问用户是否确认执行（例如'需要我执行这条 SQL 吗？'），不要直接执行。确认后必须原样执行该代码块中的 SQL，不得改写、重新格式化或补充语句。禁止不经确认直接执行写入。",
        "解释要基于真实执行结果，不要凭空推测数据。",
      ],
    },
    outputContract: {
      en: ["Output format: lead with an execution-result summary, then step through the key data and its meaning."],
      zh: ["输出格式：先给执行结果概要，再逐步解释关键数据和含义。"],
    },
  },
  {
    id: "generate_plsql",
    action: "generatePlsql",
    title: {
      en: "Generate PL/SQL",
      zh: "生成 PL/SQL",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["schema", "databaseDialect", "currentSql"],
    userInstruction: {
      en: "Generate openGauss PL/SQL (procedures, functions, packages, triggers, anonymous blocks) that satisfies the user's request. Return the code in a ```sql code block first, followed by a brief note if needed.",
      zh: "根据用户需求生成 openGauss 的 PL/SQL 代码（存储过程、函数、包、触发器、匿名块）。先把代码放在 ```sql 代码块中，再视需要附简短说明。",
    },
    systemRules: {
      en: [
        "Target openGauss A-compatible (Oracle-style) PL/SQL unless the user asks otherwise: CREATE OR REPLACE PROCEDURE/FUNCTION/PACKAGE, BEGIN...END blocks, %TYPE/%ROWTYPE, explicit cursors, and EXCEPTION handlers.",
        "Use openGauss packages: gms_output (DBMS_OUTPUT), gms_sql (dynamic SQL), gms_utility, gms_stats; never reference Oracle-only packages that openGauss lacks.",
        "Procedure parameters: IN/OUT/IN OUT with explicit data types; avoid relying on length for VARCHAR2 in OUT parameters (use VARCHAR2 with explicit size where required).",
        "For triggers, include CREATE OR REPLACE TRIGGER with BEFORE/AFTER, FOR EACH ROW and :NEW/:OLD where relevant.",
        "Keep anonymous blocks wrapped in BEGIN...END; include exception handling (WHEN OTHERS THEN) for anything that may fail.",
        "If the request is ambiguous about mode (A/B/C/M), prefer A-mode PL/SQL and note the assumption.",
      ],
      zh: [
        "除非用户另有要求，目标为 openGauss A 兼容（Oracle 风格）PL/SQL：CREATE OR REPLACE PROCEDURE/FUNCTION/PACKAGE、BEGIN...END 块、%TYPE/%ROWTYPE、显式游标、EXCEPTION 异常处理。",
        "使用 openGauss 的包：gms_output（对应 DBMS_OUTPUT）、gms_sql（动态 SQL）、gms_utility、gms_stats；不要引用 openGauss 没有的 Oracle 专属包。",
        "过程参数使用 IN/OUT/IN OUT 并给出明确数据类型；OUT 参数避免依赖省略长度的 VARCHAR2。",
        "触发器使用 CREATE OR REPLACE TRIGGER + BEFORE/AFTER、FOR EACH ROW，必要时使用 :NEW/:OLD。",
        "匿名块用 BEGIN...END 包裹，可能失败的地方包含 WHEN OTHERS THEN 异常处理。",
        "如果用户未说明兼容模式（A/B/C/M），默认按 A 模式生成 PL/SQL 并说明该假设。",
      ],
    },
    outputContract: {
      en: ["Output format: PL/SQL code in a ```sql code block first, then a short usage note (how to call it, what it does)."],
      zh: ["输出格式：先把 PL/SQL 代码放在 ```sql 代码块中，再附简短使用说明（如何调用、作用是什么）。"],
    },
  },
  {
    id: "fix_plsql_error",
    action: "fixPlsqlError",
    title: {
      en: "Fix PL/SQL Error",
      zh: "修复 PL/SQL 错误",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "lastError", "databaseDialect"],
    userInstruction: {
      en: "Diagnose the openGauss PL/SQL compile/runtime error in the context and provide the corrected code. Return the fixed code in a ```sql code block first, then briefly explain the root cause.",
      zh: "根据上下文中的 openGauss PL/SQL 编译/运行错误进行诊断，并给出修正后的代码。先把修正后的代码放在 ```sql 代码块中，再简要说明根因。",
    },
    systemRules: {
      en: [
        "Read the last error carefully (line/column numbers, error codes such as PLS- or GS-), locate the offending statement, and fix the root cause rather than masking it.",
        "Common openGauss PL/SQL pitfalls: OUT VARCHAR2 without size, missing exception handlers, implicit conversions, cursor state after CLOSE, and packages that do not exist in openGauss (use gms_* equivalents).",
        "If the error is missing (no lastError in context), ask the user to paste the error message or run the code first.",
      ],
      zh: [
        "仔细阅读最近的错误（行列号、PLS-/GS- 等错误码），定位出错语句并从根因修复，不要掩盖问题。",
        "openGauss PL/SQL 常见坑：OUT 参数 VARCHAR2 未指定长度、缺少异常处理、隐式类型转换、CLOSE 后游标状态、引用 openGauss 不存在的包（应改用 gms_* 等价包）。",
        "如果上下文中没有错误信息，先请用户粘贴错误信息或先执行代码。",
      ],
    },
    outputContract: {
      en: ["Output format: fixed PL/SQL code in a ```sql code block first, then the root cause and what changed."],
      zh: ["输出格式：先把修正后的 PL/SQL 代码放在 ```sql 代码块中，再说明根因和改动点。"],
    },
  },
];

export function aiSkillForAction(action: AiAction): AiSkillDefinition {
  const skill = AI_SKILL_DEFINITIONS.find((item) => item.action === action);
  if (!skill) throw new Error(`Missing AI skill definition for action: ${action}`);
  return skill;
}
