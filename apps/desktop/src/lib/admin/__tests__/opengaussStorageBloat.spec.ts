import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildDropIndexSql,
  buildRelationStorageTopQuery,
  buildSystemSchemaExclusionSql,
  buildTableBloatQuery,
  buildTablespacesFallbackQuery,
  buildTablespacesQuery,
  buildUnusedIndexesQuery,
  buildUserSchemasQuery,
  buildVacuumSql,
  classifyBloatSeverity,
  escapeSqlLiteral,
  formatStorageBytes,
  formatStorageCount,
  isSystemSchemaName,
  parseRelationStorageRows,
  parseTableBloatRows,
  parseTablespaceRows,
  parseUnusedIndexRows,
  parseUserSchemaRows,
  quotePgIdent,
  quoteQualifiedPgIdent,
} from "@/lib/admin/opengaussStorageBloat";

function makeResult(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("system schema exclusion and SQL escaping", () => {
  it("excludes openGauss and PostgreSQL built-in schemas", () => {
    const predicate = buildSystemSchemaExclusionSql("n.nspname");
    for (const schema of ["pg_catalog", "information_schema", "pg_toast", "blockchain", "coverage", "cstore", "db4ai", "pkg_service", "snapshot", "sqladvisor", "xmltype"]) {
      expect(predicate).toContain(`'${schema}'`);
      expect(isSystemSchemaName(schema)).toBe(true);
    }
    expect(predicate).toContain("NOT LIKE 'dbe~_%' ESCAPE '~'");
    expect(predicate).toContain("NOT LIKE 'pg~_temp~_%' ESCAPE '~'");
    expect(predicate).toContain("NOT LIKE 'pg~_toast~_%' ESCAPE '~'");

    expect(isSystemSchemaName("dbe_perf")).toBe(true);
    expect(isSystemSchemaName("dbe_pldeveloper")).toBe(true);
    expect(isSystemSchemaName("pg_temp_3")).toBe(true);
    expect(isSystemSchemaName("pg_toast_temp_1")).toBe(true);
    expect(isSystemSchemaName("public")).toBe(false);
    expect(isSystemSchemaName("dbex_app")).toBe(false);
    expect(isSystemSchemaName("sales")).toBe(false);
  });

  it("escapes single quotes in SQL literals", () => {
    expect(escapeSqlLiteral("sales")).toBe("'sales'");
    expect(escapeSqlLiteral("o'reilly")).toBe("'o''reilly'");
    expect(escapeSqlLiteral("a'; DROP TABLE x; --")).toBe("'a''; DROP TABLE x; --'");
  });

  it("quotes PostgreSQL/openGauss identifiers safely", () => {
    expect(quotePgIdent("orders")).toBe('"orders"');
    expect(quotePgIdent('bad"name')).toBe('"bad""name"');
    expect(quoteQualifiedPgIdent("public", "orders")).toBe('"public"."orders"');
    expect(quoteQualifiedPgIdent("", "orders")).toBe('"orders"');
    expect(quoteQualifiedPgIdent("  ", 'weird"tbl')).toBe('"weird""tbl"');
  });
});

describe("SQL query builders", () => {
  it("builds user schemas query sorted alphabetically", () => {
    const sql = buildUserSchemasQuery();
    expect(sql).toContain("FROM pg_catalog.pg_namespace n");
    expect(sql).toContain("pg_catalog");
    expect(sql).toContain("dbe~_%");
    expect(sql).toContain("ORDER BY n.nspname ASC");
  });

  it("builds primary and fallback tablespace queries", () => {
    const primary = buildTablespacesQuery();
    expect(primary).toContain("FROM pg_catalog.pg_tablespace t");
    expect(primary).toContain("pg_catalog.pg_tablespace_size(t.oid)");
    expect(primary).toContain("pg_catalog.pg_tablespace_location(t.oid)");
    expect(primary).toContain("pg_catalog.pg_get_userbyid(t.spcowner)");

    const fallback = buildTablespacesFallbackQuery();
    expect(fallback).toContain("FROM pg_catalog.pg_tablespace t");
    expect(fallback).toContain("NULL::bigint AS size_bytes");
    expect(fallback).not.toContain("pg_tablespace_size");
  });

  it("builds top relation storage query with optional schema filter and clamped limit", () => {
    const unfiltered = buildRelationStorageTopQuery(100);
    expect(unfiltered).toContain("c.relkind IN ('r','p','m')");
    expect(unfiltered).toContain("pg_catalog.pg_total_relation_size(c.oid)");
    expect(unfiltered).toContain("pg_catalog.pg_relation_size(c.oid)");
    expect(unfiltered).toContain("pg_catalog.pg_indexes_size(c.oid)");
    expect(unfiltered).toContain("ORDER BY pg_catalog.pg_total_relation_size(c.oid) DESC");
    expect(unfiltered).toContain("LIMIT 100");
    expect(unfiltered).not.toContain("n.nspname = ");

    const filtered = buildRelationStorageTopQuery(5000, "o'reilly");
    expect(filtered).toContain("n.nspname = 'o''reilly'");
    expect(filtered).toContain("LIMIT 1000");

    const zeroLimit = buildRelationStorageTopQuery(0, "   ");
    expect(zeroLimit).toContain("LIMIT 1");
    expect(zeroLimit).not.toContain("n.nspname = ");
  });

  it("builds table bloat query with dead ratio formula and ordering", () => {
    const sql = buildTableBloatQuery(150, "app_data");
    expect(sql).toContain("FROM pg_catalog.pg_stat_user_tables s");
    expect(sql).toContain("JOIN pg_catalog.pg_class c ON c.oid = s.relid");
    expect(sql).toContain("JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace");
    expect(sql).toContain("GREATEST(COALESCE(s.n_live_tup, 0) + COALESCE(s.n_dead_tup, 0), 1)");
    expect(sql).toContain("AS dead_ratio_pct");
    expect(sql).toContain("n.nspname = 'app_data'");
    expect(sql).toContain("ORDER BY n_dead_tup DESC NULLS LAST, total_bytes DESC");
    expect(sql).toContain("LIMIT 150");

    expect(buildTableBloatQuery(Number.NaN)).toContain("LIMIT 150");
  });

  it("builds unused indexes query with primary/unique toggles", () => {
    const nonUniqueOnly = buildUnusedIndexesQuery(150, undefined, false);
    expect(nonUniqueOnly).toContain("FROM pg_catalog.pg_stat_user_indexes s");
    expect(nonUniqueOnly).toContain("JOIN pg_catalog.pg_index x ON x.indexrelid = s.indexrelid");
    expect(nonUniqueOnly).toContain("NOT x.indisprimary");
    expect(nonUniqueOnly).toContain("NOT x.indisunique");
    expect(nonUniqueOnly).toContain("ORDER BY idx_scan ASC NULLS FIRST, index_bytes DESC");
    expect(nonUniqueOnly).toContain("LIMIT 150");

    const withUnique = buildUnusedIndexesQuery(50, "billing", true);
    expect(withUnique).toContain("NOT x.indisprimary");
    expect(withUnique).not.toContain("NOT x.indisunique");
    expect(withUnique).toContain("n.nspname = 'billing'");
    expect(withUnique).toContain("LIMIT 50");
  });
});

describe("row parsers", () => {
  it("parses user schema rows defensively and deduplicates", () => {
    const schemas = parseUserSchemaRows(makeResult(["NSPNAME"], [[" public "], ["app"], ["public"], [null], [""]]));
    expect(schemas).toEqual(["public", "app"]);
    expect(parseUserSchemaRows(null)).toEqual([]);
  });

  it("parses tablespace rows case-insensitively and preserves null sizeBytes", () => {
    const rows = parseTablespaceRows(
      makeResult(
        ["NAME", "OWNER", "LOCATION", "SIZE_BYTES"],
        [
          ["pg_default", "omm", "", "10485760"],
          ["fast_ts", "dba", "/data/fast_ts", null],
          ["bad_num", "dba", "/data/x", "not-a-number"],
        ],
      ),
    );
    expect(rows).toEqual([
      { name: "pg_default", owner: "omm", location: "", sizeBytes: 10485760 },
      { name: "fast_ts", owner: "dba", location: "/data/fast_ts", sizeBytes: null },
      { name: "bad_num", owner: "dba", location: "/data/x", sizeBytes: null },
    ]);

    const omittedSize = parseTablespaceRows(makeResult(["spcname", "owner", "location"], [["pg_global", "omm", ""]]));
    expect(omittedSize).toEqual([{ name: "pg_global", owner: "omm", location: "", sizeBytes: null }]);
    expect(parseTablespaceRows(undefined)).toEqual([]);
  });

  it("parses relation storage rows with numeric string coercion", () => {
    const rows = parseRelationStorageRows(
      makeResult(
        ["SCHEMA_NAME", "RELNAME", "RELKIND", "TABLESPACE", "TOTAL_BYTES", "TABLE_BYTES", "INDEX_BYTES", "TOAST_BYTES", "ESTIMATED_ROWS"],
        [
          ["public", "orders", "r", "pg_default", "5242880", "4194304", "1048576", null, "125000"],
          ["analytics", "mv_daily", "m", null, 2048, 1024, 512, 512, -10],
        ],
      ),
    );
    expect(rows).toEqual([
      {
        schema: "public",
        name: "orders",
        relkind: "r",
        tablespace: "pg_default",
        totalBytes: 5242880,
        tableBytes: 4194304,
        indexBytes: 1048576,
        toastBytes: 0,
        estimatedRows: 125000,
      },
      {
        schema: "analytics",
        name: "mv_daily",
        relkind: "m",
        tablespace: "",
        totalBytes: 2048,
        tableBytes: 1024,
        indexBytes: 512,
        toastBytes: 512,
        estimatedRows: 0,
      },
    ]);
    expect(parseRelationStorageRows(makeResult([], []))).toEqual([]);
  });

  it("parses table bloat rows, falls back deadRatioPct when missing, and assigns severity", () => {
    const rows = parseTableBloatRows(
      makeResult(
        ["SCHEMA_NAME", "RELNAME", "N_LIVE_TUP", "N_DEAD_TUP", "DEAD_RATIO_PCT", "TOTAL_BYTES", "SEQ_SCAN", "IDX_SCAN", "LAST_VACUUM", "LAST_AUTOVACUUM", "LAST_ANALYZE", "LAST_AUTOANALYZE"],
        [
          ["public", "events", "10000", "6000", "37.50", "104857600", "12", "4500", null, "2026-11-18 10:00:00", "2026-11-19 01:00:00", null],
          ["public", "sessions", "18000", "2000", null, "4096000", "3", "90", "", "", "", ""],
          ["public", "config", "100", "5", "4.76", "8192", "50", "0", null, null, null, null],
        ],
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      schema: "public",
      name: "events",
      liveTuples: 10000,
      deadTuples: 6000,
      deadRatioPct: 37.5,
      totalBytes: 104857600,
      seqScan: 12,
      idxScan: 4500,
      lastVacuum: "",
      lastAutovacuum: "2026-11-18 10:00:00",
      lastAnalyze: "2026-11-19 01:00:00",
      lastAutoanalyze: "",
      severity: "critical",
    });
    // Fallback deadRatioPct = 2000 * 100 / 20000 = 10% -> warning
    expect(rows[1].deadRatioPct).toBe(10);
    expect(rows[1].severity).toBe("warning");
    expect(rows[2].severity).toBe("healthy");
  });

  it("parses unused index rows across boolean representations", () => {
    const rows = parseUnusedIndexRows(
      makeResult(
        ["SCHEMA_NAME", "TABLE_NAME", "INDEX_NAME", "IDX_SCAN", "IDX_TUP_READ", "IDX_TUP_FETCH", "INDEX_BYTES", "IS_UNIQUE", "INDEX_DEF"],
        [
          ["public", "orders", "idx_orders_note", "0", "0", "0", "8388608", "f", "CREATE INDEX idx_orders_note ON public.orders USING btree (note)"],
          ["public", "users", "uq_users_legacy", 2, "10", "5", 65536, "t", "CREATE UNIQUE INDEX uq_users_legacy ON public.users USING btree (legacy_code)"],
        ],
      ),
    );
    expect(rows).toEqual([
      {
        schema: "public",
        tableName: "orders",
        indexName: "idx_orders_note",
        idxScan: 0,
        idxTupRead: 0,
        idxTupFetch: 0,
        indexBytes: 8388608,
        isUnique: false,
        indexDef: "CREATE INDEX idx_orders_note ON public.orders USING btree (note)",
      },
      {
        schema: "public",
        tableName: "users",
        indexName: "uq_users_legacy",
        idxScan: 2,
        idxTupRead: 10,
        idxTupFetch: 5,
        indexBytes: 65536,
        isUnique: true,
        indexDef: "CREATE UNIQUE INDEX uq_users_legacy ON public.users USING btree (legacy_code)",
      },
    ]);
    expect(parseUnusedIndexRows(null)).toEqual([]);
  });
});

describe("severity classification, formatting, and SQL script generators", () => {
  it("classifies bloat severity at all thresholds", () => {
    expect(classifyBloatSeverity(100_000, 0.5)).toBe("critical");
    expect(classifyBloatSeverity(5_000, 20)).toBe("critical");
    expect(classifyBloatSeverity(4_999, 90)).toBe("warning");
    expect(classifyBloatSeverity(1_000, 10)).toBe("warning");
    expect(classifyBloatSeverity(20_000, 1)).toBe("warning");
    expect(classifyBloatSeverity(999, 50)).toBe("healthy");
    expect(classifyBloatSeverity(19_999, 9.99)).toBe("healthy");
    expect(classifyBloatSeverity(0, 0)).toBe("healthy");
    expect(classifyBloatSeverity(Number.NaN, Number.NaN)).toBe("healthy");
  });

  it("formats storage bytes across B / KB / MB / GB / TB", () => {
    expect(formatStorageBytes(null)).toBe("-");
    expect(formatStorageBytes(undefined)).toBe("-");
    expect(formatStorageBytes(Number.NaN)).toBe("-");
    expect(formatStorageBytes(-1)).toBe("-");
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(1024)).toBe("1 KB");
    expect(formatStorageBytes(1536)).toBe("1.5 KB");
    expect(formatStorageBytes(1024 ** 2)).toBe("1 MB");
    expect(formatStorageBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
    expect(formatStorageBytes(3 * 1024 ** 4)).toBe("3 TB");
  });

  it("formats integer counts with thousands separators", () => {
    expect(formatStorageCount(1234567)).toBe("1,234,567");
    expect(formatStorageCount(42)).toBe("42");
    expect(formatStorageCount(null)).toBe("-");
  });

  it("builds multi-line vacuum/analyze/reindex scripts with appropriate lock warnings", () => {
    const targets = [
      { schema: "public", table: "orders" },
      { schema: "public", table: "orders" }, // duplicate should be deduped
      { schema: 'app"s', table: 'line"items' },
    ];

    const vacAnalyze = buildVacuumSql(targets, "vacuum_analyze");
    expect(vacAnalyze).not.toContain("ACCESS EXCLUSIVE");
    expect(vacAnalyze).toContain('VACUUM ANALYZE "public"."orders";');
    expect(vacAnalyze).toContain('VACUUM ANALYZE "app""s"."line""items";');
    expect(vacAnalyze.match(/VACUUM ANALYZE "public"\."orders";/g)).toHaveLength(1);

    const analyze = buildVacuumSql(targets, "analyze");
    expect(analyze).not.toContain("ACCESS EXCLUSIVE");
    expect(analyze).toContain('ANALYZE "public"."orders";');

    const vacFull = buildVacuumSql(targets, "vacuum_full");
    expect(vacFull.split("\n")[0]).toContain("ACCESS EXCLUSIVE");
    expect(vacFull).toContain('VACUUM FULL ANALYZE "public"."orders";');

    const reindex = buildVacuumSql(targets, "reindex");
    expect(reindex.split("\n")[0]).toContain("ACCESS EXCLUSIVE");
    expect(reindex).toContain('REINDEX TABLE "public"."orders";');

    expect(buildVacuumSql([], "analyze")).toBe("");
  });

  it("builds DROP INDEX statements with and without CONCURRENTLY", () => {
    expect(buildDropIndexSql("public", "idx_orders_created")).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_created";');
    expect(buildDropIndexSql("public", "idx_orders_created", true)).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_orders_created";');
    expect(buildDropIndexSql("public", "idx_orders_created", false)).toBe('DROP INDEX IF EXISTS "public"."idx_orders_created";');
    expect(buildDropIndexSql("", 'bad"idx')).toBe('DROP INDEX CONCURRENTLY IF EXISTS "bad""idx";');
  });
});
