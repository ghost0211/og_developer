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
// ogdeveloper: openGauss graphical routine invocation (PL/SQL Developer style)
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

/**
 * Builds the execution script shown in the graphical call dialog:
 * - function → SELECT * FROM schema.func(...) (grid shows the return value)
 * - procedure without OUT/INOUT → CALL schema.proc(...)
 * - procedure with OUT/INOUT → PL/SQL anonymous block using local variables,
 *   routine invocation, and RAISE NOTICE with [DBX_OUT] tags so the client can
 *   parse and populate the output grid directly (PL/SQL Developer style).
 */
export function buildOpenGaussRoutineExecutionSql(options: BuildRoutineExecutionSqlOptions & { parameters: RoutineParameterValue[]; isFunction?: boolean }): string {
  const routine = qualifiedOpenGaussRoutineName(options);
  const sorted = [...options.parameters].sort((a, b) => a.ordinal - b.ordinal);

  if (options.isFunction) {
    const args = sorted.filter(shouldIncludeParameter).map((parameter) => routineParameterSqlValue("opengauss", parameter));
    return `SELECT * FROM ${routine}(${args.join(", ")});`;
  }

  const hasOutOrInOut = sorted.some((p) => p.mode === "OUT" || p.mode === "INOUT");
  if (!hasOutOrInOut) {
    const args = sorted.map((parameter) => (shouldIncludeParameter(parameter) ? routineParameterSqlValue("opengauss", parameter) : "NULL"));
    return `CALL ${routine}(${args.join(", ")});`;
  }

  // PL/SQL Developer style anonymous block with RAISE NOTICE output captures
  const declarations: string[] = [];
  const noticePrints: string[] = [];
  const args = sorted.map((parameter) => {
    const variable = `v_arg_${parameter.ordinal}`;
    if (parameter.mode === "OUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"};`);
      noticePrints.push(`RAISE NOTICE '[DBX_OUT] ${parameter.name}=%', ${variable};`);
      return variable;
    }
    if (parameter.mode === "INOUT") {
      declarations.push(`${variable} ${parameter.dataType || "text"} := ${routineParameterSqlValue("opengauss", parameter)};`);
      noticePrints.push(`RAISE NOTICE '[DBX_OUT] ${parameter.name}=%', ${variable};`);
      return variable;
    }
    return shouldIncludeParameter(parameter) ? routineParameterSqlValue("opengauss", parameter) : "NULL";
  });

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
