import type { DatabaseType } from "@/types/database";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";

export interface BuildRoutineExecutionSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
}

export type RoutineParameterMode = "IN" | "OUT" | "INOUT" | "RETURN" | "UNKNOWN";

export interface RoutineParameter {
  name: string;
  dataType: string;
  mode: RoutineParameterMode;
  ordinal: number;
  hasDefault?: boolean;
  defaultValue?: string | null;
}

export interface RoutineParameterValue extends RoutineParameter {
  value: string;
  useNull?: boolean;
  useDefault?: boolean;
}

export function qualifiedRoutineName(options: BuildRoutineExecutionSqlOptions): string {
  const { databaseType, schema, routineName } = options;
  if (databaseType === "databend") return routineName;
  if (isSchemaAware(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, routineName)}`;
  }
  return quoteTableIdentifier(databaseType, routineName);
}

export function buildProcedureExecutionSql(options: BuildRoutineExecutionSqlOptions): string {
  return buildProcedureExecutionSqlFromValues({ ...options, parameters: [] });
}

export function buildProcedureExecutionSqlFromValues(options: BuildRoutineExecutionSqlOptions & { parameters: RoutineParameterValue[] }): string {
  const routine = qualifiedRoutineName(options);
  const sortedParameters = [...options.parameters].sort((a, b) => a.ordinal - b.ordinal);
  if (options.databaseType === "sqlserver") {
    return buildSqlServerProcedureExecutionSql(routine, sortedParameters);
  }
  if (options.databaseType === "mysql") {
    return buildMySqlProcedureExecutionSql(routine, sortedParameters);
  }
  const values = sortedParameters.filter((parameter) => shouldIncludeParameter(parameter));
  const useNamedArguments = shouldUseNamedArguments(options.databaseType, sortedParameters);
  if (options.databaseType === "oracle" || options.databaseType === "dameng" || options.databaseType === "oceanbase-oracle") {
    return `BEGIN\n  ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});\nEND;`;
  }
  if (options.databaseType === "databend") {
    return `CALL PROCEDURE ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
  }
  return `CALL ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
}

export function shouldIncludeParameter(parameter: RoutineParameterValue): boolean {
  if (parameter.useDefault && parameter.hasDefault) return false;
  return acceptsRoutineInput(parameter);
}

export function acceptsRoutineInput(parameter: Pick<RoutineParameterValue, "mode">): boolean {
  return parameter.mode === "IN" || parameter.mode === "INOUT" || parameter.mode === "UNKNOWN";
}

export function routineParameterSqlValue(databaseType: DatabaseType | undefined, parameter: RoutineParameterValue): string {
  if (parameter.useNull) return "NULL";
  const raw = parameter.value;
  if (raw.trim() === "") return "NULL";
  if (looksLikeNumericType(parameter.dataType)) return raw.trim();
  if (looksLikeBooleanType(parameter.dataType)) return normalizeBooleanLiteral(raw, databaseType);
  return quoteSqlString(raw);
}

function sqlServerParameterName(name: string): string {
  return name.startsWith("@") ? name : `@${name}`;
}

function buildMySqlProcedureExecutionSql(routine: string, sortedParameters: RoutineParameterValue[]): string {
  const outputBindings = new Map<RoutineParameterValue, { variableName: string; alias: string }>();
  const initializations: string[] = [];

  sortedParameters.forEach((parameter, index) => {
    if (!returnsRoutineOutput(parameter)) return;
    const variableName = `@dbx_output_${index + 1}`;
    const initialValue = parameter.mode === "INOUT" ? routineParameterSqlValue("mysql", parameter) : "NULL";
    initializations.push(`SET ${variableName} = ${initialValue};`);
    outputBindings.set(parameter, {
      variableName,
      alias: quoteTableIdentifier("mysql", parameter.name.replace(/^@/, "") || `output_${index + 1}`),
    });
  });

  const args = sortedParameters.flatMap((parameter) => {
    const outputBinding = outputBindings.get(parameter);
    if (outputBinding) return [outputBinding.variableName];
    if (!shouldIncludeParameter(parameter)) return [];
    return [routineParameterSqlValue("mysql", parameter)];
  });
  const statements = [...initializations, `CALL ${routine}(${args.join(", ")});`];
  if (outputBindings.size > 0) {
    statements.push(`SELECT ${[...outputBindings.values()].map(({ variableName, alias }) => `${variableName} AS ${alias}`).join(", ")};`);
  }
  return statements.join("\n");
}

function buildSqlServerProcedureExecutionSql(routine: string, sortedParameters: RoutineParameterValue[]): string {
  const outputBindings = new Map<RoutineParameterValue, { variableName: string; alias: string }>();
  const declarations: string[] = [];

  sortedParameters.forEach((parameter, index) => {
    if (!returnsRoutineOutput(parameter)) return;
    if (parameter.mode === "INOUT" && parameter.useDefault && parameter.hasDefault) return;
    const declarationType = parameter.dataType.trim();
    if (!declarationType) return;

    const variableName = `@dbx_output_${index + 1}`;
    const initialValue = parameter.mode === "INOUT" ? ` = ${routineParameterSqlValue("sqlserver", parameter)}` : "";
    declarations.push(`DECLARE ${variableName} ${declarationType}${initialValue};`);
    outputBindings.set(parameter, {
      variableName,
      alias: quoteTableIdentifier("sqlserver", parameter.name.replace(/^@/, "") || `output_${index + 1}`),
    });
  });

  const args = sortedParameters.flatMap((parameter) => {
    const outputBinding = outputBindings.get(parameter);
    if (outputBinding) {
      return [`${sqlServerParameterName(parameter.name)} = ${outputBinding.variableName} OUTPUT`];
    }
    if (returnsRoutineOutput(parameter) || !shouldIncludeParameter(parameter)) return [];
    return [`${sqlServerParameterName(parameter.name)} = ${routineParameterSqlValue("sqlserver", parameter)}`];
  });
  const statements = [...declarations, args.length > 0 ? `EXEC ${routine} ${args.join(", ")};` : `EXEC ${routine};`];

  if (outputBindings.size > 0) {
    statements.push(`SELECT ${[...outputBindings.values()].map(({ variableName, alias }) => `${variableName} AS ${alias}`).join(", ")};`);
  }
  return statements.join("\n");
}

function returnsRoutineOutput(parameter: Pick<RoutineParameterValue, "mode">): boolean {
  return parameter.mode === "OUT" || parameter.mode === "INOUT";
}

// ---------------------------------------------------------------------------
// OG Developer: openGauss graphical routine invocation (PL/SQL Developer style)
// ---------------------------------------------------------------------------

/**
 * Quotes an identifier only when it actually needs quoting (mixed case,
 * special characters, reserved words). Lowercase snake_case names stay bare —
 * blanket "..." quoting implies case-sensitive objects that were never
 * created that way.
 */
const OPENGAUSS_BARE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const OPENGAUSS_ROUTINE_RESERVED_WORDS = new Set(["begin", "end", "if", "else", "elsif", "declare", "select", "insert", "update", "delete", "table", "function", "procedure", "package", "type", "loop", "while", "for", "case", "return", "raise", "then", "do", "call", "user", "default"]);

function quoteOpenGaussIdentifierWhenNeeded(part: string): string {
  if (OPENGAUSS_BARE_IDENTIFIER.test(part) && !OPENGAUSS_ROUTINE_RESERVED_WORDS.has(part)) return part;
  return quoteTableIdentifier("opengauss", part);
}

/** Quotes each dotted segment so package members (pkg.proc) qualify correctly. */
function qualifiedOpenGaussRoutineName(options: BuildRoutineExecutionSqlOptions): string {
  const parts = options.routineName.split(".").filter(Boolean);
  const qualified = options.schema ? [options.schema, ...parts] : parts;
  return qualified.map(quoteOpenGaussIdentifierWhenNeeded).join(".");
}

/** openGauss/Postgres routine return-shape probe result (pg_get_function_result + proretset). */
export interface RoutineReturnInfo {
  returnType: string;
  isSetof: boolean;
}

/** Variable name for a routine parameter: the parameter name itself
 *  (quoted only when it would not round-trip bare), v_arg_N for unnamed args. */
function routineVariableName(parameter: RoutineParameterValue): string {
  const raw = (parameter.name || "").trim();
  if (!raw) return `v_arg_${parameter.ordinal}`;
  return quoteOpenGaussIdentifierWhenNeeded(raw);
}

/** Initializer clause for a DECLAREd variable: ` := value` when the user
 *  entered a value, ` := NULL` when NULL was requested, empty otherwise. */
function routineVariableInitializer(databaseType: DatabaseType | undefined, parameter: RoutineParameterValue): string {
  if (parameter.useNull) return " := NULL";
  if (parameter.value.trim() === "") return "";
  return ` := ${routineParameterSqlValue(databaseType, parameter)}`;
}

/**
 * Builds the execution script shown in the graphical call dialog:
 * - function → SELECT * FROM schema.func(...) (grid shows the return value)
 * - procedure → PL/SQL anonymous block (DECLARE...BEGIN...END, PL/SQL
 *   Developer test-window style): every passed parameter is declared as a
 *   typed variable named after the parameter; OUT/INOUT values are printed
 *   afterwards via RAISE NOTICE with [DBX_OUT] tags for client-side parsing.
 */
export function buildOpenGaussRoutineExecutionSql(options: BuildRoutineExecutionSqlOptions & { parameters: RoutineParameterValue[]; isFunction?: boolean; functionReturn?: RoutineReturnInfo | null }): string {
  const routine = qualifiedOpenGaussRoutineName(options);
  const sorted = [...options.parameters].sort((a, b) => a.ordinal - b.ordinal);

  if (options.isFunction) {
    const functionReturn = options.functionReturn;
    const returnsSet = !!functionReturn && (functionReturn.isSetof || /^SETOF\b/i.test(functionReturn.returnType) || /^TABLE\s*\(/i.test(functionReturn.returnType) || functionReturn.returnType === "record");
    // 探测失败、返回结果集/record/void 的函数保持 SELECT 形式（结果进网格）。
    if (!functionReturn || returnsSet || functionReturn.returnType === "void") {
      const args = sorted.filter(shouldIncludeParameter).map((parameter) => routineParameterSqlValue("opengauss", parameter));
      return `SELECT * FROM ${routine}(${args.join(", ")});`;
    }
    // 标量返回函数：与过程一致的测试窗口风格——参数声明为变量，
    // 返回值用变量接收后 RAISE NOTICE 回显。
    const declarations: string[] = [];
    const args: string[] = [];
    for (const parameter of sorted) {
      if (!shouldIncludeParameter(parameter)) continue;
      const variable = routineVariableName(parameter);
      declarations.push(`${variable} ${parameter.dataType || "text"}${routineVariableInitializer("opengauss", parameter)};`);
      args.push(variable);
    }
    let resultVar = "v_result";
    if (sorted.some((parameter) => (parameter.name || "").trim().toLowerCase() === resultVar)) resultVar = "v_return_value";
    declarations.push(`${resultVar} ${functionReturn.returnType};`);
    return `DECLARE\n  ${declarations.join("\n  ")}\nBEGIN\n  ${resultVar} := ${routine}(${args.join(", ")});\n\n  RAISE NOTICE '[DBX_OUT] result=%', ${resultVar};\nEND;`;
  }

  // PL/SQL Developer 测试窗口风格：所有参数都在 DECLARE 中定义为变量
  // （变量名即参数名），BEGIN 中以变量调用；未输入值的 IN/INOUT 变量不带
  // 初始化子句（即为 NULL），useDefault 的参数省略以让 DEFAULT 生效；
  // OUT/INOUT 执行后用 RAISE NOTICE 回显。
  const declarations: string[] = [];
  const noticePrints: string[] = [];
  const args: string[] = [];
  for (const parameter of sorted) {
    const variable = routineVariableName(parameter);
    if (parameter.mode === "OUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"};`);
      noticePrints.push(`RAISE NOTICE '[DBX_OUT] ${parameter.name}=%', ${variable};`);
      args.push(variable);
      continue;
    }
    if (parameter.mode === "INOUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"}${routineVariableInitializer("opengauss", parameter)};`);
      noticePrints.push(`RAISE NOTICE '[DBX_OUT] ${parameter.name}=%', ${variable};`);
      args.push(variable);
      continue;
    }
    if (!shouldIncludeParameter(parameter)) continue;
    declarations.push(`${variable} ${parameter.dataType || "text"}${routineVariableInitializer("opengauss", parameter)};`);
    args.push(variable);
  }

  const bodyParts = [`  ${routine}(${args.join(", ")});`];
  if (noticePrints.length > 0) {
    bodyParts.push("");
    bodyParts.push(`  -- Output variable capture`);
    bodyParts.push(...noticePrints.map((p) => `  ${p}`));
  }

  const body = `BEGIN\n${bodyParts.join("\n")}\nEND;`;
  return declarations.length > 0 ? `DECLARE\n  ${declarations.join("\n  ")}\n${body}` : body;
}

/**
 * Builds the anonymous PL/SQL block used for debugging. The debuggee must run
 * the routine inside the debugger-marked session; an anonymous block is more
 * permissive than CALL (which rejects some argument forms) and matches how
 * PL/SQL tools invoke routines. OUT/INOUT parameters cannot take NULL
 * placeholders inside a block, so they are bound to DECLAREd variables.
 */
export function buildOpenGaussRoutineDebugCallSql(options: BuildRoutineExecutionSqlOptions & { parameters: RoutineParameterValue[] }): string {
  const routine = qualifiedOpenGaussRoutineName(options);
  const sorted = [...options.parameters].sort((a, b) => a.ordinal - b.ordinal);
  const declarations: string[] = [];
  const args = sorted.map((parameter) => {
    const variable = `v_arg_${parameter.ordinal}`;
    if (parameter.mode === "OUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"};`);
      return variable;
    }
    if (parameter.mode === "INOUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"} := ${routineParameterSqlValue("opengauss", parameter)};`);
      return variable;
    }
    return shouldIncludeParameter(parameter) ? routineParameterSqlValue("opengauss", parameter) : "NULL";
  });
  const body = `BEGIN\n  ${routine}(${args.join(", ")});\nEND;`;
  return declarations.length > 0 ? `DECLARE\n  ${declarations.join("\n  ")}\n${body}` : body;
}

function routineArgumentSql(databaseType: DatabaseType | undefined, parameter: RoutineParameterValue, useNamedArguments: boolean): string {
  const value = routineParameterSqlValue(databaseType, parameter);
  if (!useNamedArguments) return value;
  return `${quoteTableIdentifier(databaseType, parameter.name)} => ${value}`;
}

function shouldUseNamedArguments(databaseType: DatabaseType | undefined, sortedParameters: RoutineParameterValue[]): boolean {
  if (databaseType !== "postgres" && databaseType !== "oracle" && databaseType !== "dameng" && databaseType !== "oceanbase-oracle") {
    return false;
  }
  let omittedDefault = false;
  for (const parameter of sortedParameters) {
    if (parameter.useDefault && parameter.hasDefault && acceptsRoutineInput(parameter)) {
      omittedDefault = true;
      continue;
    }
    if (omittedDefault && shouldIncludeParameter(parameter)) return sortedParameters.every((item) => !!item.name);
  }
  return false;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function looksLikeNumericType(dataType: string): boolean {
  return /\b(bigint|int|integer|smallint|tinyint|serial|number|numeric|decimal|dec|float|double|real|money)\b/i.test(dataType);
}

function looksLikeBooleanType(dataType: string): boolean {
  return /\b(bool|boolean|bit)\b/i.test(dataType);
}

function normalizeBooleanLiteral(value: string, databaseType: DatabaseType | undefined): string {
  const normalized = value.trim().toLowerCase();
  const truthy = normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y" || normalized === "1";
  const falsy = normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n" || normalized === "0";
  if (!truthy && !falsy) return quoteSqlString(value);
  if (databaseType === "sqlserver") return truthy ? "1" : "0";
  return truthy ? "TRUE" : "FALSE";
}
