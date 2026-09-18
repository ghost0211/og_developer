import { describe, expect, it } from "vitest";
import { analyzeRoutineHealth } from "./routineHealthAnalysis";
import { buildRoutineHealthReport } from "./routineHealthReport";
import type { RoutineHealthSnapshot } from "@/lib/backend/api";

function fixture(source: string): RoutineHealthSnapshot {
  return {
    routines: [
      { id: "1", schema: "app", name: "subject", objectType: "FUNCTION", signature: "p_id integer", language: "plpgsql", source },
      { id: "2", schema: "app", name: "existing_fn", objectType: "FUNCTION", signature: "integer", language: "plpgsql", source: null },
      { id: "3", schema: "pg_catalog", name: "count", objectType: "FUNCTION", signature: "", language: "internal", source: null },
    ],
    relations: [
      { schema: "app", name: "users", kind: "r", columns: ["id", "name"] },
      { schema: "public", name: "users", kind: "r", columns: ["public_id"] },
    ],
    indexes: [{ schema: "app", name: "users_pkey", tableSchema: "app", tableName: "users" }],
    searchPath: ["pg_catalog", "app", "public"],
    invalidObjects: [],
    warnings: [],
  };
}
function findings(source: string) {
  return analyzeRoutineHealth(fixture(source))[0]!.findings;
}
function errors(source: string) {
  return findings(source).filter((f) => f.severity === "error");
}

describe("routine health dependency analysis", () => {
  it("checks nested predicates against their own source instead of the outer relation", () => {
    const data = fixture("BEGIN SELECT * FROM app.users WHERE EXISTS (SELECT 1 FROM app.audit WHERE event = 'x'); END;");
    data.relations.push({ schema: "app", name: "audit", kind: "r", columns: ["event"] });
    expect(analyzeRoutineHealth(data)[0]!.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
  it("resolves repeated aliases in separate subqueries independently", () => {
    const data = fixture("BEGIN SELECT (SELECT a.id FROM app.users a), (SELECT a.event FROM app.audit a); END;");
    data.relations.push({ schema: "app", name: "audit", kind: "r", columns: ["event"] });
    expect(analyzeRoutineHealth(data)[0]!.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("finds qualified and unqualified missing tables with original lines", () => {
    const results = findings("BEGIN\n SELECT * FROM app.absent;\n SELECT * FROM absent2; END;");
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_relation", objectName: "app.absent", line: 2 }), expect.objectContaining({ code: "missing_relation", objectName: "absent2", line: 3 })]));
  });
  it("checks alias columns inside nested control flow", () => {
    expect(errors("BEGIN IF p_id > 0 THEN BEGIN SELECT u.absent INTO v FROM app.users u; END; END IF; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "u.absent" })]));
  });
  it("does not treat SELECT INTO variables as tables or fields", () => {
    expect(errors("DECLARE v_id integer; v_name text; BEGIN SELECT u.id, u.name INTO v_id, v_name FROM app.users u WHERE u.id=p_id; END;")).toEqual([]);
  });
  it("ignores comments and strings including nested comments", () => {
    expect(findings("BEGIN /* outer /* SELECT * FROM bad; */ more */ RAISE NOTICE 'SELECT q.absent FROM ghost q;'; -- CALL missing();\n END;")).toEqual([]);
  });
  it("unwraps dollar quoted DDL and retains source lines", () => {
    expect(findings("CREATE FUNCTION app.subject(p_id integer) RETURNS int AS $body$\nBEGIN\nSELECT missing FROM app.users;\nRETURN 1; END;\n$body$ LANGUAGE plpgsql;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", line: 3, objectName: "missing" })]));
  });
  it("checks INSERT and UPDATE target columns", () => {
    const result = errors("BEGIN INSERT INTO app.users(id, bad) VALUES (1, 2); UPDATE app.users SET missing=1 WHERE id=1; END;");
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ objectName: "app.users.bad" }), expect.objectContaining({ objectName: "app.users.missing" })]));
    expect(result.filter((f) => f.objectName === "app.users.missing")).toHaveLength(1);
  });
  it("checks unambiguous bare predicate columns on a single row source", () => {
    const result = errors("BEGIN SELECT * FROM app.users WHERE absent = 1; END;");
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "absent", line: 1 })]));
  });
  it("checks bare columns in UPDATE and DELETE predicates against the single target", () => {
    expect(errors("BEGIN UPDATE app.users SET name = 'x' WHERE absent = 1; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "absent" })]));
    expect(errors("BEGIN DELETE FROM app.users WHERE absent IS NOT NULL; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "absent" })]));
  });
  it("distinguishes variables from names absent from every visible source", () => {
    expect(errors("DECLARE v_id integer; BEGIN SELECT * FROM app.users WHERE id = v_id; END;")).toEqual([]);
    expect(errors("BEGIN SELECT * FROM app.users u, public.users p WHERE absent = 1; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "absent" })]));
    expect(errors("BEGIN SELECT * FROM app.users u, public.users p WHERE public_id = 1; END;")).toEqual([]);
  });
  it("does not treat casts, builtin calls or existing columns in predicates as missing", () => {
    expect(errors("BEGIN IF p_id > 0 THEN SELECT u.id::numeric FROM app.users u WHERE coalesce(u.name, '') <> '' AND u.id IS NOT NULL; END IF; END;")).toEqual([]);
  });
  it("resolves CTE and derived wildcard columns without treating aliases as tables", () => {
    expect(errors("BEGIN WITH x AS (SELECT * FROM app.users) SELECT x.id FROM x; SELECT z.name FROM (SELECT * FROM app.users) z; END;")).toEqual([]);
    expect(errors("BEGIN SELECT z.absent FROM (SELECT * FROM app.users) z; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "z.absent" })]));
  });
  it("recognizes existing and missing function calls", () => {
    const result = findings("BEGIN PERFORM app.existing_fn(1); PERFORM app.no_fn(1); END;");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ code: "missing_routine", objectName: "app.no_fn" });
  });
  it("recognizes FROM functions without reporting them as missing relations", () => {
    expect(findings("BEGIN SELECT * FROM app.existing_fn(1) f; END;")).toEqual([]);
  });
  it("flags package-qualified calls for review instead of assuming health", () => {
    const result = findings("BEGIN PERFORM app.pkg.do_work(1); END;");
    expect(result).toEqual([expect.objectContaining({ code: "unresolved_package_call", severity: "warning" })]);
  });
  it("checks explicit index references but no speculative query indexes", () => {
    expect(errors("BEGIN REINDEX INDEX app.users_pkey; SELECT * FROM app.users; END;")).toEqual([]);
    expect(errors("BEGIN ALTER INDEX app.missing_idx RENAME TO other; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_index", objectName: "app.missing_idx" })]));
    expect(errors("BEGIN DROP INDEX IF EXISTS app.missing_idx; END;")).toEqual([]);
  });
  it("reports dynamic SQL as incomplete without scanning its string", () => {
    const result = findings("BEGIN EXECUTE 'SELECT missing FROM ghost'; END;");
    expect(result.map((f) => f.code)).toEqual(["dynamic_sql"]);
  });
  it("does not infer fields of temporary tables", () => {
    const result = findings("BEGIN CREATE TEMP TABLE temp_result(x int); SELECT t.x FROM temp_result t; END;");
    expect(result.some((f) => f.code === "temporary_relation")).toBe(true);
    expect(result.filter((f) => f.severity === "error")).toEqual([]);
  });
  it("honors search path order and quoted identifier case", () => {
    expect(errors("BEGIN SELECT u.public_id FROM users u; END;")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column" })]));
    expect(errors('BEGIN SELECT * FROM app."Users"; END;')).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_relation" })]));
    const data = fixture("BEGIN SELECT u.public_id FROM users u; END;");
    data.routines[0]!.searchPath = ["public", "app"];
    expect(analyzeRoutineHealth(data)[0]!.findings).toEqual([]);
  });
  it("skips unqualified missing claims with unresolved search_path", () => {
    const data = fixture("BEGIN SELECT * FROM absent; SELECT * FROM app.missing; END;");
    data.routines[0]!.searchPath = [];
    const result = analyzeRoutineHealth(data)[0]!.findings;
    expect(result.filter((f) => f.code === "missing_relation").map((f) => f.objectName)).toEqual(["app.missing"]);
    expect(result.some((f) => f.code === "unresolved_search_path")).toBe(true);
  });
  it("does not classify standard PL/SQL constructs and aggregates as unknown functions", () => {
    expect(findings("BEGIN IF (p_id IN (1,2)) THEN SELECT count(*) FROM app.users; RAISE NOTICE '%', coalesce(p_id,0); END IF; END;")).toEqual([]);
  });
  it("does not treat keyword-parenthesized clauses as routine calls", () => {
    // Regression: WHERE (…), AND (…), OR (…), FROM (…), UNION (…) were flagged
    // as missing routines named where/and/from.
    const source = "BEGIN WITH RECURSIVE tree AS (SELECT m.* FROM app.users m WHERE (p_id IS NULL AND (m.id IS NULL OR m.id = 0)) OR (p_id IS NOT NULL AND m.id = p_id) UNION SELECT c.* FROM app.users c JOIN tree t ON c.id = t.id) SELECT t.id FROM tree t; END;";
    const result = findings(source);
    expect(result.filter((f) => f.code === "missing_routine")).toEqual([]);
    expect(result.filter((f) => f.severity === "error")).toEqual([]);
  });
  it("does not treat table-source alias column lists as routine calls", () => {
    // FROM (…) u(a,b), FROM f() AS x(a) and FROM t x(a) are aliases with column
    // lists, not calls to routines named u/x/t.
    const result = findings("BEGIN SELECT * FROM (SELECT id, name FROM app.users) u(a, b); SELECT * FROM app.existing_fn(1) AS x(v); SELECT * FROM app.users t(id2, name2); END;");
    expect(result.filter((f) => f.code === "missing_routine")).toEqual([]);
  });
  it("still flags genuinely missing routines after clause keywords", () => {
    const result = findings("BEGIN SELECT * FROM app.users WHERE no_fn(id) > 0; END;");
    expect(result.filter((f) => f.code === "missing_routine")).toEqual([expect.objectContaining({ objectName: "no_fn" })]);
  });
  it("resolves schema and public synonyms instead of reporting missing relations", () => {
    const schemaSynonym = fixture("BEGIN SELECT u.id FROM def_user u; END;");
    schemaSynonym.relations.push({ schema: "app", name: "def_user", kind: "synonym", columns: ["id"] });
    expect(analyzeRoutineHealth(schemaSynonym)[0]!.findings).toEqual([]);
    // PUBLIC synonyms are visible regardless of the routine search_path.
    const publicSynonym = fixture("BEGIN SELECT u.id FROM def_user u; END;");
    publicSynonym.relations.push({ schema: "public", name: "def_user", kind: "synonym", columns: ["id"] });
    publicSynonym.routines[0]!.searchPath = ["pg_catalog", "app"];
    expect(analyzeRoutineHealth(publicSynonym)[0]!.findings).toEqual([]);
  });
  it("checks columns through synonyms and treats dangling synonyms as unknown", () => {
    const known = fixture("BEGIN SELECT u.absent FROM def_user u; END;");
    known.relations.push({ schema: "app", name: "def_user", kind: "synonym", columns: ["id"] });
    expect(analyzeRoutineHealth(known)[0]!.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "u.absent" })]));
    // A dangling synonym (target gone) keeps the reference valid but its
    // columns unknown: no missing-relation error and no per-column noise.
    const dangling = fixture("BEGIN SELECT u.anything FROM def_user u; END;");
    dangling.relations.push({ schema: "app", name: "def_user", kind: "synonym", columns: null });
    expect(analyzeRoutineHealth(dangling)[0]!.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
  it("checks DML targets through synonyms with known columns", () => {
    const data = fixture("BEGIN UPDATE def_user SET absent = 1 WHERE id = 1; END;");
    data.relations.push({ schema: "app", name: "def_user", kind: "synonym", columns: ["id"] });
    expect(analyzeRoutineHealth(data)[0]!.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_column", objectName: "def_user.absent" })]));
  });
  it("reports unsupported languages rather than claiming checked", () => {
    const data = fixture("return 1");
    data.routines[0]!.language = "plpythonu";
    expect(analyzeRoutineHealth(data)[0]!.findings[0]!.code).toBe("unsupported_language");
  });
  it("keeps compiler records separate from same-name overloads", () => {
    const data = fixture("BEGIN RETURN 1; END;");
    data.routines.push({ ...data.routines[0]!, id: "4", signature: "p_id text" });
    data.invalidObjects = [{ schema: "app", name: "subject", objectType: "FUNCTION", source: "bad ddl" }];
    const rows = buildRoutineHealthReport(data);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows.filter((r) => r.origin === "compilation")[0]!.findings[0]!.code).toBe("compilation_failed");
  });
});
