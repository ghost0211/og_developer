import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildGsGucCliCommand,
  buildGucAlterSystemSql,
  buildGucParametersFallbackQuery,
  buildGucParametersQuery,
  buildGucSessionSetSql,
  filterGucParameters,
  formatGucSqlValue,
  gucContextLevel,
  isGucParameterModified,
  isMissingGucColumnError,
  isValidGucName,
  OPENGAUSS_GUC_PRESETS,
  parseGucEnumVals,
  parseGucParametersRows,
  type OpenGaussGucParameter,
} from "@/lib/admin/opengaussGucParameters";

function makeResult(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

const FULL_COLUMNS = ["name", "setting", "unit", "category", "short_desc", "context", "vartype", "source", "boot_val", "reset_val", "min_val", "max_val", "enumvals", "pending_restart"];

describe("OPENGAUSS_GUC_PRESETS", () => {
  it("contains curated preset parameter lists", () => {
    expect(OPENGAUSS_GUC_PRESETS.memory_concurrency).toEqual(["shared_buffers", "work_mem", "maintenance_work_mem", "max_connections", "max_process_memory", "cstore_buffers", "temp_buffers", "effective_cache_size"]);
    expect(OPENGAUSS_GUC_PRESETS.compatibility).toEqual(["sql_compatibility", "behavior_compat_options", "search_path", "standard_conforming_strings", "statement_timeout", "idle_in_transaction_session_timeout", "lockwait_timeout"]);
    expect(OPENGAUSS_GUC_PRESETS.audit_perf).toEqual(["enable_stmt_track", "track_stmt_details_size", "track_activity_query_size", "log_min_duration_statement", "enable_recyclebin", "enable_wdr_snapshot", "enable_pbe_optimization"]);
  });
});

describe("GUC SQL query builders", () => {
  it("builds the full pg_settings query with pending_restart by default", () => {
    const sql = buildGucParametersQuery();
    expect(sql).toContain("FROM pg_catalog.pg_settings");
    expect(sql).toContain("COALESCE(unit, '') AS unit");
    expect(sql).toContain("min_val");
    expect(sql).toContain("max_val");
    expect(sql).toContain("enumvals::text AS enumvals");
    expect(sql).toContain("pending_restart");
    expect(sql).not.toContain("false AS pending_restart");
    expect(sql).toContain("ORDER BY name");
  });

  it("substitutes false AS pending_restart when includePendingRestart is false", () => {
    const sql = buildGucParametersQuery(false);
    expect(sql).toContain("false AS pending_restart");
    expect(sql).toContain("enumvals::text AS enumvals");
    expect(sql).toContain("ORDER BY name");
  });

  it("builds the fallback query for older openGauss builds", () => {
    expect(buildGucParametersFallbackQuery()).toBe("SELECT name, setting, COALESCE(unit, '') AS unit, category, short_desc, context, vartype, source, boot_val, reset_val FROM pg_catalog.pg_settings ORDER BY name");
  });

  it("detects missing-column errors across PostgreSQL and openGauss formats", () => {
    expect(isMissingGucColumnError('ERROR: column "pending_restart" does not exist')).toBe(true);
    expect(isMissingGucColumnError("SQLSTATE 42703: undefined column enumvals")).toBe(true);
    expect(isMissingGucColumnError("ERROR: permission denied for relation pg_settings")).toBe(false);
    expect(isMissingGucColumnError("connection refused")).toBe(false);
  });
});

describe("parseGucEnumVals", () => {
  it("handles JS arrays, Postgres array text, quoted strings, and empty values", () => {
    expect(parseGucEnumVals(["on", "off", "try"])).toEqual(["on", "off", "try"]);
    expect(parseGucEnumVals("{on,off,try}")).toEqual(["on", "off", "try"]);
    expect(parseGucEnumVals('{"read uncommitted","read committed","repeatable read","serializable"}')).toEqual(["read uncommitted", "read committed", "repeatable read", "serializable"]);
    expect(parseGucEnumVals('{"a\\"b","c\\\\d",NULL,plain}')).toEqual(['a"b', "c\\d", "plain"]);
    expect(parseGucEnumVals("{}")).toEqual([]);
    expect(parseGucEnumVals("")).toEqual([]);
    expect(parseGucEnumVals(null)).toEqual([]);
    expect(parseGucEnumVals(undefined)).toEqual([]);
    expect(parseGucEnumVals("a, b")).toEqual(["a", "b"]);
  });
});

describe("parseGucParametersRows", () => {
  it("parses full rows with enumvals, pendingRestart variants, and modified detection", () => {
    const res = makeResult(FULL_COLUMNS, [
      ["work_mem", "65536", "kB", "Resource Usage / Memory", "Sets maximum memory for query workspaces.", "user", "integer", "session", "4096", "65536", "64", "2147483647", null, false],
      ["sql_compatibility", "PG", "", "Client Connection Defaults", "SQL compatibility mode.", "postmaster", "enum", "configuration file", "A", "PG", null, null, "{A,B,C,PG}", "t"],
      ["shared_buffers", "131072", "8kB", "Resource Usage / Memory", "Shared memory buffers.", "postmaster", "integer", "configuration file", "16384", "16384", "16", "1073741823", null, 1],
      ["log_line_prefix", "%m [%p] ", "", "Reporting and Logging", "Controls log line prefix.", "sighup", "string", "default", "%m [%p] ", "%m [%p] ", null, null, null, "0"],
    ]);

    const parsed = parseGucParametersRows(res);
    expect(parsed).toHaveLength(4);

    expect(parsed[0]).toEqual({
      name: "work_mem",
      setting: "65536",
      unit: "kB",
      category: "Resource Usage / Memory",
      shortDesc: "Sets maximum memory for query workspaces.",
      context: "user",
      vartype: "integer",
      source: "session",
      bootVal: "4096",
      resetVal: "65536",
      minVal: "64",
      maxVal: "2147483647",
      enumVals: [],
      pendingRestart: false,
      modified: true,
    });

    expect(parsed[1]?.enumVals).toEqual(["A", "B", "C", "PG"]);
    expect(parsed[1]?.pendingRestart).toBe(true);
    expect(parsed[1]?.modified).toBe(true);

    expect(parsed[2]?.pendingRestart).toBe(true);
    expect(parsed[2]?.modified).toBe(true);

    // Trailing space in string setting is preserved and default source stays unmodified.
    expect(parsed[3]?.setting).toBe("%m [%p] ");
    expect(parsed[3]?.pendingRestart).toBe(false);
    expect(parsed[3]?.modified).toBe(false);
  });

  it("handles JS array enumvals and fallback rows without optional columns", () => {
    const fallbackResult = makeResult(["NAME", "SETTING", "UNIT", "CATEGORY", "SHORT_DESC", "CONTEXT", "VARTYPE", "SOURCE", "BOOT_VAL", "RESET_VAL"], [["enable_stmt_track", "on", "", "Statistics", "Track statements.", "sighup", "bool", "default", "on", "on"]]);
    const fallbackParsed = parseGucParametersRows(fallbackResult);
    expect(fallbackParsed).toEqual([
      {
        name: "enable_stmt_track",
        setting: "on",
        unit: "",
        category: "Statistics",
        shortDesc: "Track statements.",
        context: "sighup",
        vartype: "bool",
        source: "default",
        bootVal: "on",
        resetVal: "on",
        minVal: null,
        maxVal: null,
        enumVals: [],
        pendingRestart: false,
        modified: false,
      },
    ]);

    const arrayEnumResult = makeResult(FULL_COLUMNS, [
      ["default_transaction_isolation", "read committed", "", "Client Connection Defaults", "Isolation level.", "user", "enum", "default", "read committed", "read committed", null, null, ["read committed", "repeatable read", "serializable"] as unknown as string, "true"],
    ]);
    const arrayParsed = parseGucParametersRows(arrayEnumResult);
    expect(arrayParsed[0]?.enumVals).toEqual(["read committed", "repeatable read", "serializable"]);
    expect(arrayParsed[0]?.pendingRestart).toBe(true);
  });

  it("returns an empty array for null, undefined, or empty QueryResult", () => {
    expect(parseGucParametersRows(null)).toEqual([]);
    expect(parseGucParametersRows(undefined)).toEqual([]);
    expect(parseGucParametersRows(makeResult([], []))).toEqual([]);
  });
});

describe("isGucParameterModified", () => {
  it("returns false for default or empty source", () => {
    expect(isGucParameterModified({ source: "default", setting: "on", bootVal: "on" })).toBe(false);
    expect(isGucParameterModified({ source: "DEFAULT", setting: "100", bootVal: "50" })).toBe(false);
    expect(isGucParameterModified({ source: "default", setting: "foo", bootVal: null })).toBe(false);
    expect(isGucParameterModified({ source: "", setting: "foo", bootVal: "bar" })).toBe(false);
  });

  it("evaluates non-default sources accurately against bootVal", () => {
    expect(isGucParameterModified({ source: "session", setting: "64MB", bootVal: "4MB" })).toBe(true);
    expect(isGucParameterModified({ source: "configuration file", setting: "500", bootVal: "100" })).toBe(true);
    expect(isGucParameterModified({ source: "configuration file", setting: "100", bootVal: "100" })).toBe(false);
    expect(isGucParameterModified({ source: "database", setting: "UTC", bootVal: null })).toBe(true);
    expect(isGucParameterModified({ source: "user", setting: "off", bootVal: "on" })).toBe(true);
    expect(isGucParameterModified({ source: "override", setting: "/var/lib/og", bootVal: null })).toBe(true);
    expect(isGucParameterModified({ source: "command line", setting: "2048", bootVal: "1024" })).toBe(true);
  });
});

describe("gucContextLevel", () => {
  it("maps PostgreSQL / openGauss context strings to actionable levels", () => {
    expect(gucContextLevel("user")).toBe("session");
    expect(gucContextLevel("superuser")).toBe("session");
    expect(gucContextLevel(" USER ")).toBe("session");
    expect(gucContextLevel("sighup")).toBe("reload");
    expect(gucContextLevel("postmaster")).toBe("restart");
    expect(gucContextLevel("backend")).toBe("restart");
    expect(gucContextLevel("superuser-backend")).toBe("restart");
    expect(gucContextLevel("internal")).toBe("readonly");
    expect(gucContextLevel("")).toBe("readonly");
  });
});

describe("formatGucSqlValue", () => {
  it("formats boolean values to on/off and quotes unrecognized bool values", () => {
    expect(formatGucSqlValue("on", "bool")).toBe("on");
    expect(formatGucSqlValue("true", "bool")).toBe("on");
    expect(formatGucSqlValue("1", "bool")).toBe("on");
    expect(formatGucSqlValue("off", "bool")).toBe("off");
    expect(formatGucSqlValue("FALSE", "bool")).toBe("off");
    expect(formatGucSqlValue("0", "bool")).toBe("off");
    expect(formatGucSqlValue("invalid", "bool")).toBe("'invalid'");
  });

  it("leaves valid integer/real numbers unquoted and quotes unit-suffixed or non-numeric values", () => {
    expect(formatGucSqlValue("4096", "integer")).toBe("4096");
    expect(formatGucSqlValue("-1", "integer")).toBe("-1");
    expect(formatGucSqlValue("64MB", "integer")).toBe("'64MB'");
    expect(formatGucSqlValue("1.5", "real")).toBe("1.5");
    expect(formatGucSqlValue("-0.25", "real")).toBe("-0.25");
    expect(formatGucSqlValue("1e-3", "real")).toBe("1e-3");
    expect(formatGucSqlValue("NaN", "real")).toBe("'NaN'");
    expect(formatGucSqlValue("1; DROP TABLE x", "integer")).toBe("'1; DROP TABLE x'");
  });

  it("escapes single quotes in string and enum values", () => {
    expect(formatGucSqlValue('"$user", public', "string")).toBe("'$user\", public'".replace("'$user", "'\"$user"));
    expect(formatGucSqlValue("it's a test", "string")).toBe("'it''s a test'");
    expect(formatGucSqlValue("", "string")).toBe("''");
    expect(formatGucSqlValue("PG", "enum")).toBe("'PG'");
  });
});

describe("SQL and gs_guc command builders", () => {
  it("builds session SET statements with bare simple names and safe quoting for non-simple names", () => {
    expect(buildGucSessionSetSql("work_mem", "64MB", "integer")).toBe("SET work_mem = '64MB';");
    expect(buildGucSessionSetSql("work_mem", "65536", "integer")).toBe("SET work_mem = 65536;");
    expect(buildGucSessionSetSql("enable_pbe_optimization", "true", "bool")).toBe("SET enable_pbe_optimization = on;");
    expect(buildGucSessionSetSql("pg_stat_statements.max", "5000", "integer")).toBe("SET pg_stat_statements.max = 5000;");
    expect(buildGucSessionSetSql("DateStyle", "ISO, MDY", "string")).toBe("SET \"DateStyle\" = 'ISO, MDY';");
    expect(buildGucSessionSetSql('bad"name; --', "1", "integer")).toBe('SET "bad""name; --" = 1;');
  });

  it("builds ALTER SYSTEM SET statements with optional pg_reload_conf()", () => {
    expect(buildGucAlterSystemSql("track_stmt_details_size", "16384", "integer", true)).toBe("ALTER SYSTEM SET track_stmt_details_size = 16384;\nSELECT pg_reload_conf();");
    expect(buildGucAlterSystemSql("shared_buffers", "2GB", "integer", false)).toBe("ALTER SYSTEM SET shared_buffers = '2GB';");
    expect(buildGucAlterSystemSql("my-custom", "val'1", "string", false)).toBe("ALTER SYSTEM SET \"my-custom\" = 'val''1';");
  });

  it("builds gs_guc reload/set CLI commands with shell double-quote escaping", () => {
    expect(buildGsGucCliCommand("enable_recyclebin", "on", true)).toBe('gs_guc reload -N all -I all -c "enable_recyclebin=on"');
    expect(buildGsGucCliCommand("shared_buffers", "2GB", false)).toBe('gs_guc set -N all -I all -c "shared_buffers=2GB"');
    expect(buildGsGucCliCommand("search_path", '"$user", public', true)).toBe('gs_guc reload -N all -I all -c "search_path=\\"\\$user\\", public"');
    expect(buildGsGucCliCommand("log_line_prefix", "a\\b`c", true)).toBe('gs_guc reload -N all -I all -c "log_line_prefix=a\\\\b\\`c"');
  });
});

describe("isValidGucName", () => {
  it("accepts standard and extension-qualified names and rejects invalid names", () => {
    expect(isValidGucName("shared_buffers")).toBe(true);
    expect(isValidGucName("DateStyle")).toBe(true);
    expect(isValidGucName("pg_stat_statements.max")).toBe(true);
    expect(isValidGucName("_internal_1")).toBe(true);

    expect(isValidGucName("")).toBe(false);
    expect(isValidGucName("   ")).toBe(false);
    expect(isValidGucName("1work_mem")).toBe(false);
    expect(isValidGucName("work mem")).toBe(false);
    expect(isValidGucName("work-mem")).toBe(false);
    expect(isValidGucName("work_mem; DROP TABLE t")).toBe(false);
    expect(isValidGucName(".work_mem")).toBe(false);
    expect(isValidGucName("work_mem.")).toBe(false);
    expect(isValidGucName("a..b")).toBe(false);
  });
});

describe("filterGucParameters", () => {
  const sampleParams: OpenGaussGucParameter[] = [
    {
      name: "shared_buffers",
      setting: "131072",
      unit: "8kB",
      category: "Resource Usage / Memory",
      shortDesc: "Sets the number of shared memory buffers used by the server.",
      context: "postmaster",
      vartype: "integer",
      source: "configuration file",
      bootVal: "16384",
      resetVal: "131072",
      minVal: "16",
      maxVal: "1073741823",
      enumVals: [],
      pendingRestart: true,
      modified: true,
    },
    {
      name: "sql_compatibility",
      setting: "A",
      unit: "",
      category: "Client Connection Defaults",
      shortDesc: "SQL compatibility mode.",
      context: "postmaster",
      vartype: "enum",
      source: "default",
      bootVal: "A",
      resetVal: "A",
      minVal: null,
      maxVal: null,
      enumVals: ["A", "B", "C", "PG"],
      pendingRestart: false,
      modified: false,
    },
    {
      name: "enable_stmt_track",
      setting: "on",
      unit: "",
      category: "Statistics / Monitoring",
      shortDesc: "Enables full/slow SQL tracking.",
      context: "sighup",
      vartype: "bool",
      source: "default",
      bootVal: "on",
      resetVal: "on",
      minVal: null,
      maxVal: null,
      enumVals: [],
      pendingRestart: false,
      modified: false,
    },
    {
      name: "work_mem",
      setting: "65536",
      unit: "kB",
      category: "Resource Usage / Memory",
      shortDesc: "Sets maximum memory for query operations.",
      context: "user",
      vartype: "integer",
      source: "session",
      bootVal: "4096",
      resetVal: "65536",
      minVal: "64",
      maxVal: "2147483647",
      enumVals: [],
      pendingRestart: false,
      modified: true,
    },
    {
      name: "server_version",
      setting: "9.2.4",
      unit: "",
      category: "Preset Options",
      shortDesc: "Shows the server version.",
      context: "internal",
      vartype: "string",
      source: "default",
      bootVal: "9.2.4",
      resetVal: "9.2.4",
      minVal: null,
      maxVal: null,
      enumVals: [],
      pendingRestart: false,
      modified: false,
    },
  ];

  it("filters by search, preset, category, context level, and modifiedOnly", () => {
    expect(filterGucParameters(sampleParams, { preset: "all" })).toHaveLength(5);
    expect(filterGucParameters(sampleParams, { preset: "memory_concurrency" }).map((p) => p.name)).toEqual(["shared_buffers", "work_mem"]);
    expect(filterGucParameters(sampleParams, { preset: "compatibility" }).map((p) => p.name)).toEqual(["sql_compatibility"]);
    expect(filterGucParameters(sampleParams, { preset: "audit_perf" }).map((p) => p.name)).toEqual(["enable_stmt_track"]);
    expect(filterGucParameters(sampleParams, { preset: "restart" }).map((p) => p.name)).toEqual(["shared_buffers", "sql_compatibility"]);
    expect(filterGucParameters(sampleParams, { modifiedOnly: true }).map((p) => p.name)).toEqual(["shared_buffers", "work_mem"]);
    expect(filterGucParameters(sampleParams, { contextLevel: "readonly" }).map((p) => p.name)).toEqual(["server_version"]);
    expect(filterGucParameters(sampleParams, { category: "Statistics / Monitoring" }).map((p) => p.name)).toEqual(["enable_stmt_track"]);
    expect(filterGucParameters(sampleParams, { search: "slow sql" }).map((p) => p.name)).toEqual(["enable_stmt_track"]);
    expect(filterGucParameters(sampleParams, { search: "131072" }).map((p) => p.name)).toEqual(["shared_buffers"]);
    expect(filterGucParameters(sampleParams, { preset: "restart", modifiedOnly: true }).map((p) => p.name)).toEqual(["shared_buffers"]);
  });
});
