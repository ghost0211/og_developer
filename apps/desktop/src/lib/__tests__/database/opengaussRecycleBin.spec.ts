import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildPurgeAllRecycleBinSql,
  buildPurgeRecycleBinItemSql,
  buildTimecapsuleRestoreSql,
  classifyRecycleBinObjectType,
  isRecycleBinCatalogUnavailableError,
  isRecycleBinFallbackCandidateError,
  isRelationAlreadyExistsError,
  normalizeRecycleBinOperation,
  OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND,
  OPENGAUSS_ENABLE_RECYCLEBIN_SQL,
  OPENGAUSS_RECYCLEBIN_FALLBACK_SQL,
  OPENGAUSS_RECYCLEBIN_LIST_SQL,
  parseEnableRecycleBinResult,
  parseNamespaceOidMap,
  parseRecycleBinRows,
} from "@/lib/database/opengaussRecycleBin";

function makeResult(columns: string[], rows: (string | number | boolean | null)[][], extra?: Partial<QueryResult>): QueryResult {
  return {
    columns,
    rows,
    affected_rows: 0,
    execution_time_ms: 1,
    ...extra,
  };
}

describe("openGauss recycle bin SQL constants", () => {
  it("exposes catalog queries, GUC command, and fallback query", () => {
    expect(OPENGAUSS_ENABLE_RECYCLEBIN_SQL).toBe("SHOW enable_recyclebin");
    expect(OPENGAUSS_ENABLE_RECYCLEBIN_GUC_COMMAND).toBe('gs_guc reload -N all -I all -c "enable_recyclebin = on"');
    expect(OPENGAUSS_RECYCLEBIN_LIST_SQL).toContain("FROM pg_catalog.gs_recyclebin r");
    expect(OPENGAUSS_RECYCLEBIN_LIST_SQL).toContain("LEFT JOIN pg_catalog.pg_namespace n ON n.oid = r.rcynamespace");
    expect(OPENGAUSS_RECYCLEBIN_LIST_SQL).toContain("LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = r.rcytablespace");
    expect(OPENGAUSS_RECYCLEBIN_LIST_SQL).toContain("pg_catalog.pg_get_userbyid(r.rcyowner)");
    expect(OPENGAUSS_RECYCLEBIN_FALLBACK_SQL).toBe("SELECT rcyname, rcyoriginname, rcyoperation, rcytype, rcyrecycletime, rcynamespace, rcycanrestore, rcycanpurge FROM pg_catalog.gs_recyclebin ORDER BY rcyrecycletime DESC");
  });
});

describe("parseEnableRecycleBinResult", () => {
  it("parses truthy GUC representations (on / true / 1 / t / yes)", () => {
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["on"]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["ON "]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["true"]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [[true]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["1"]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [[1]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["t"]]))).toBe(true);
    expect(parseEnableRecycleBinResult(makeResult(["name", "setting"], [["enable_recyclebin", "on"]]))).toBe(true);
  });

  it("parses falsy GUC representations (off / false / 0 / f / no)", () => {
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["off"]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["OFF"]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["false"]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [[false]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["0"]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [[0]]))).toBe(false);
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["f"]]))).toBe(false);
  });

  it("returns null for empty, errored, or unrecognized results", () => {
    expect(parseEnableRecycleBinResult(null)).toBeNull();
    expect(parseEnableRecycleBinResult(undefined)).toBeNull();
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], []))).toBeNull();
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["on"]], { execution_error: true }))).toBeNull();
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [[null]]))).toBeNull();
    expect(parseEnableRecycleBinResult(makeResult(["enable_recyclebin"], [["unknown"]]))).toBeNull();
  });
});

describe("normalizeRecycleBinOperation and classifyRecycleBinObjectType", () => {
  it("normalizes single-char and word operation values", () => {
    expect(normalizeRecycleBinOperation("d")).toBe("DROP");
    expect(normalizeRecycleBinOperation("D ")).toBe("DROP");
    expect(normalizeRecycleBinOperation("DROP")).toBe("DROP");
    expect(normalizeRecycleBinOperation("drop")).toBe("DROP");
    expect(normalizeRecycleBinOperation("t")).toBe("TRUNCATE");
    expect(normalizeRecycleBinOperation("T")).toBe("TRUNCATE");
    expect(normalizeRecycleBinOperation("TRUNCATE")).toBe("TRUNCATE");
    expect(normalizeRecycleBinOperation("truncate")).toBe("TRUNCATE");
    expect(normalizeRecycleBinOperation("x")).toBe("UNKNOWN");
  });

  it("classifies rcytype codes into human-readable kinds", () => {
    expect(classifyRecycleBinObjectType(0)).toEqual({ rcytype: 0, objectKind: "TABLE", typeLabel: "TABLE" });
    expect(classifyRecycleBinObjectType("1")).toEqual({ rcytype: 1, objectKind: "INDEX", typeLabel: "INDEX" });
    expect(classifyRecycleBinObjectType(2)).toEqual({ rcytype: 2, objectKind: "TOAST", typeLabel: "TOAST" });
    expect(classifyRecycleBinObjectType(3)).toEqual({ rcytype: 3, objectKind: "TOAST_INDEX", typeLabel: "TOAST INDEX" });
    expect(classifyRecycleBinObjectType(4)).toEqual({ rcytype: 4, objectKind: "PARTITION", typeLabel: "PARTITION" });
    expect(classifyRecycleBinObjectType(7)).toEqual({ rcytype: 7, objectKind: "OTHER", typeLabel: "TYPE 7" });
  });
});

describe("parseRecycleBinRows", () => {
  const fullColumns = ["rcyname", "rcyoriginname", "rcyoperation", "rcytype", "rcyrecycletime", "rcyrecyclecsn", "rcynamespace", "schema_name", "owner_name", "tablespace_name", "rcycanrestore", "rcycanpurge"];

  it("maps joined gs_recyclebin rows and enforces table/index restore & purge rules", () => {
    const res = makeResult(fullColumns, [
      ["BIN$3EB644E9FD0$4975288==$0", "orders_2025", "d", 0, "2026-11-17 10:15:30+08", "8829104", "2200", "public", "omm", "", "t", "t"],
      ["BIN$3EB644E9FD0$4975289==$0", "idx_orders_2025_customer", "DROP", 1, "2026-11-17 10:15:30+08", "8829104", "2200", "public", "omm", "pg_default", true, true],
      ["BIN$3EB644E9FD0$4975290==$0", "pg_toast_16420", "d", 2, "2026-11-17 10:15:30+08", "8829104", "99", "pg_toast", "omm", null, false, true],
      ["BIN$3EB644E9FD0$4975300==$0", "daily_ledger", "t", 0, "2026-11-17 11:00:00+08", "8829200", "16385", "finance", "fin_admin", "fast_ssd", true, true],
    ]);

    const items = parseRecycleBinRows(res);
    expect(items).toHaveLength(4);

    // 1. Dropped table -> restorable & purgeable
    expect(items[0]).toEqual({
      rcyname: "BIN$3EB644E9FD0$4975288==$0",
      originName: "orders_2025",
      operation: "DROP",
      rawOperation: "d",
      rcytype: 0,
      objectKind: "TABLE",
      typeLabel: "TABLE",
      recycleTime: "2026-11-17 10:15:30+08",
      recycleCsn: "8829104",
      namespaceOid: "2200",
      schema: "public",
      owner: "omm",
      tablespace: null,
      rcycanrestore: true,
      rcycanpurge: true,
      canRestore: true,
      canPurge: true,
    });

    // 2. Index (rcytype = 1) -> NOT directly TIMECAPSULE restorable, even if rcycanrestore were true; IS purgeable via PURGE INDEX
    expect(items[1]?.objectKind).toBe("INDEX");
    expect(items[1]?.operation).toBe("DROP");
    expect(items[1]?.canRestore).toBe(false);
    expect(items[1]?.canPurge).toBe(true);

    // 3. TOAST table (rcytype = 2) -> neither directly restorable nor directly purgeable
    expect(items[2]?.objectKind).toBe("TOAST");
    expect(items[2]?.canRestore).toBe(false);
    expect(items[2]?.canPurge).toBe(false);

    // 4. Truncated table -> restorable & purgeable
    expect(items[3]?.operation).toBe("TRUNCATE");
    expect(items[3]?.schema).toBe("finance");
    expect(items[3]?.tablespace).toBe("fast_ssd");
    expect(items[3]?.canRestore).toBe(true);
    expect(items[3]?.canPurge).toBe(true);
  });

  it("parses fallback query results and resolves schema from namespaceMap or OID 2200", () => {
    const fallbackCols = ["rcyname", "rcyoriginname", "rcyoperation", "rcytype", "rcyrecycletime", "rcynamespace", "rcycanrestore", "rcycanpurge"];
    const fallbackRes = makeResult(fallbackCols, [
      ["BIN$AAA$1==$0", "t_public", "d", 0, "2026-11-17 09:00:00", 2200, "t", "t"],
      ["BIN$BBB$2==$0", "t_billing", "TRUNCATE", "0", "2026-11-17 09:05:00", 16500, "true", "f"],
    ]);

    const nsMap = parseNamespaceOidMap(makeResult(["oid", "nspname"], [["16500", "billing"]]));
    const items = parseRecycleBinRows(fallbackRes, { namespaceMap: nsMap });

    expect(items[0]?.schema).toBe("public");
    expect(items[0]?.owner).toBeNull();
    expect(items[0]?.canRestore).toBe(true);
    expect(items[0]?.canPurge).toBe(true);

    expect(items[1]?.schema).toBe("billing");
    expect(items[1]?.operation).toBe("TRUNCATE");
    expect(items[1]?.canRestore).toBe(true);
    expect(items[1]?.canPurge).toBe(false);
  });

  it("returns empty array for null, undefined, or errored results", () => {
    expect(parseRecycleBinRows(null)).toEqual([]);
    expect(parseRecycleBinRows(undefined)).toEqual([]);
    expect(parseRecycleBinRows(makeResult(fullColumns, [], { execution_error: true }))).toEqual([]);
  });
});

describe("buildTimecapsuleRestoreSql", () => {
  it("builds TIMECAPSULE TO BEFORE DROP referencing exact system rcyname", () => {
    const sql = buildTimecapsuleRestoreSql({
      schema: "public",
      rcyname: "BIN$3EB644E9FD0$4975288==$0",
      originName: "orders_2025",
      operation: "DROP",
      rcytype: 0,
    });
    expect(sql).toBe('TIMECAPSULE TABLE "public"."BIN$3EB644E9FD0$4975288==$0" TO BEFORE DROP');
  });

  it("builds TIMECAPSULE TO BEFORE DROP RENAME TO when renameTo is provided", () => {
    const sqlWithOptions = buildTimecapsuleRestoreSql(
      {
        schema: "public",
        rcyname: "BIN$3EB644E9FD0$4975288==$0",
        originName: "orders_2025",
        operation: "d",
        rcytype: 0,
      },
      { renameTo: "orders_2025_restored" },
    );
    expect(sqlWithOptions).toBe('TIMECAPSULE TABLE "public"."BIN$3EB644E9FD0$4975288==$0" TO BEFORE DROP RENAME TO "orders_2025_restored"');

    const sqlWithShorthand = buildTimecapsuleRestoreSql(
      {
        schema: "public",
        rcyname: "BIN$3EB644E9FD0$4975288==$0",
        originName: "orders_2025",
        operation: "DROP",
      },
      "orders_side_by_side",
    );
    expect(sqlWithShorthand).toBe('TIMECAPSULE TABLE "public"."BIN$3EB644E9FD0$4975288==$0" TO BEFORE DROP RENAME TO "orders_side_by_side"');
  });

  it("builds TIMECAPSULE TO BEFORE TRUNCATE referencing live originName", () => {
    const sql = buildTimecapsuleRestoreSql({
      schema: "finance",
      rcyname: "BIN$3EB644E9FD0$4975300==$0",
      originName: "daily_ledger",
      operation: "TRUNCATE",
      rcytype: 0,
    });
    expect(sql).toBe('TIMECAPSULE TABLE "finance"."daily_ledger" TO BEFORE TRUNCATE');
  });

  it("escapes embedded double quotes in schema, rcyname, originName, and renameTo", () => {
    const dropSql = buildTimecapsuleRestoreSql(
      {
        schema: 'my"schema',
        rcyname: 'BIN$WEIRD"NAME$0',
        originName: 'orig"table',
        operation: "DROP",
      },
      { renameTo: 'restored"table' },
    );
    expect(dropSql).toBe('TIMECAPSULE TABLE "my""schema"."BIN$WEIRD""NAME$0" TO BEFORE DROP RENAME TO "restored""table"');

    const truncateSql = buildTimecapsuleRestoreSql({
      schema: 'fin"ance',
      rcyname: "BIN$123",
      originName: 'audit"log',
      operation: "t",
    });
    expect(truncateSql).toBe('TIMECAPSULE TABLE "fin""ance"."audit""log" TO BEFORE TRUNCATE');
  });

  it("omits schema prefix cleanly when schema is blank", () => {
    const sql = buildTimecapsuleRestoreSql({
      schema: "",
      rcyname: "BIN$NO_SCHEMA$0",
      originName: "plain_table",
      operation: "DROP",
    });
    expect(sql).toBe('TIMECAPSULE TABLE "BIN$NO_SCHEMA$0" TO BEFORE DROP');
  });

  it("rejects non-table rcytype, non-restorable entries, or RENAME TO on TRUNCATE", () => {
    expect(() =>
      buildTimecapsuleRestoreSql({
        schema: "public",
        rcyname: "BIN$IDX$0",
        originName: "idx_orders",
        operation: "DROP",
        rcytype: 1,
      }),
    ).toThrow(/rcytype = 0/);

    expect(() =>
      buildTimecapsuleRestoreSql({
        schema: "public",
        rcyname: "BIN$TBL$0",
        originName: "orders",
        operation: "DROP",
        canRestore: false,
      }),
    ).toThrow(/not restorable/);

    expect(() =>
      buildTimecapsuleRestoreSql(
        {
          schema: "public",
          rcyname: "BIN$TBL$0",
          originName: "orders",
          operation: "TRUNCATE",
        },
        { renameTo: "orders_copy" },
      ),
    ).toThrow(/does not support RENAME TO/);
  });
});

describe("buildPurgeRecycleBinItemSql and buildPurgeAllRecycleBinSql", () => {
  it("builds PURGE TABLE for rcytype = 0 and PURGE INDEX for rcytype = 1", () => {
    expect(
      buildPurgeRecycleBinItemSql({
        schema: "public",
        rcyname: "BIN$3EB644E9FD0$4975288==$0",
        originName: "orders_2025",
        rcytype: 0,
      }),
    ).toBe('PURGE TABLE "public"."BIN$3EB644E9FD0$4975288==$0"');

    expect(
      buildPurgeRecycleBinItemSql({
        schema: "public",
        rcyname: "BIN$3EB644E9FD0$4975289==$0",
        originName: "idx_orders_2025",
        rcytype: 1,
      }),
    ).toBe('PURGE INDEX "public"."BIN$3EB644E9FD0$4975289==$0"');
  });

  it("escapes double quotes in PURGE identifiers and rejects unsupported rcytype", () => {
    expect(
      buildPurgeRecycleBinItemSql({
        schema: 's"1',
        rcyname: 'BIN$"99',
        rcytype: 1,
      }),
    ).toBe('PURGE INDEX "s""1"."BIN$""99"');

    expect(() =>
      buildPurgeRecycleBinItemSql({
        schema: "public",
        rcyname: "BIN$TOAST$0",
        rcytype: 2,
      }),
    ).toThrow(/Unsupported recycle bin object type/);

    expect(() =>
      buildPurgeRecycleBinItemSql({
        schema: "public",
        rcyname: "BIN$TBL$0",
        rcytype: 0,
        canPurge: false,
      }),
    ).toThrow(/not marked as purgeable/);
  });

  it("builds PURGE RECYCLEBIN for full purge", () => {
    expect(buildPurgeAllRecycleBinSql()).toBe("PURGE RECYCLEBIN");
  });
});

describe("error classification helpers", () => {
  it("distinguishes missing gs_recyclebin catalog from fallback-recoverable column errors and relation conflicts", () => {
    expect(isRecycleBinCatalogUnavailableError(new Error('ERROR: relation "pg_catalog.gs_recyclebin" does not exist'))).toBe(true);
    expect(isRecycleBinFallbackCandidateError(new Error('ERROR: relation "pg_catalog.gs_recyclebin" does not exist'))).toBe(false);
    expect(isRecycleBinFallbackCandidateError(new Error("ERROR: column r.rcyrecyclecsn does not exist"))).toBe(true);
    expect(isRelationAlreadyExistsError(new Error('ERROR: relation "orders_2025" already exists'))).toBe(true);
    expect(isRelationAlreadyExistsError(new Error("permission denied"))).toBe(false);
  });
});
