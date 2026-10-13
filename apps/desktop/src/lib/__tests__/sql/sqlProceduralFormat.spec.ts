import { describe, expect, it } from "vitest";
import { formatSqlText } from "@/lib/sql/sqlFormatter";
import { formatProceduralSqlBlocks } from "@/lib/sql/sqlProceduralFormat";

const userProcedure = `CREATE OR REPLACE PROCEDURE app.add_role_user(
  p_role_id integer, p_user_ids integer[], p_operator_by integer,
  p_remark_txt text, o_added_cnt OUT integer, o_skipped_cnt OUT integer
)
SET search_path TO app
AS DECLARE
  v_counts integer[];
BEGIN
  SELECT app.add_role_user_core(p_role_id, p_user_ids, p_operator_by, p_remark_txt)
    INTO v_counts;
  o_added_cnt := v_counts[1];
  o_skipped_cnt := v_counts[2];
END;`;

describe("sqlProceduralFormat", () => {
  it("puts DECLARE variables and BEGIN...END bodies on indented lines in openGauss procedures", async () => {
    const formatted = await formatSqlText(userProcedure, "postgres");

    expect(formatted).toBe(
      [
        "CREATE OR REPLACE PROCEDURE app.add_role_user (",
        "  p_role_id integer,",
        "  p_user_ids INTEGER[],",
        "  p_operator_by integer,",
        "  p_remark_txt text,",
        "  o_added_cnt OUT integer,",
        "  o_skipped_cnt OUT integer",
        ")",
        "SET",
        "  search_path TO app",
        "AS DECLARE",
        "  v_counts INTEGER[];",
        "BEGIN",
        "  SELECT",
        "    app.add_role_user_core (",
        "      p_role_id,",
        "      p_user_ids,",
        "      p_operator_by,",
        "      p_remark_txt",
        "    ) INTO v_counts;",
        "  o_added_cnt := v_counts[1];",
        "  o_skipped_cnt := v_counts[2];",
        "END;",
      ].join("\n"),
    );
  });

  it("applies the same declaration and body layout to functions", async () => {
    const formatted = await formatSqlText(
      `CREATE OR REPLACE FUNCTION app.f(a integer) RETURNS integer
AS DECLARE
  v integer;
BEGIN
  RETURN a;
END;`,
      "postgres",
    );

    expect(formatted).toContain("RETURNS integer\nAS DECLARE\n  v integer;\nBEGIN\n  RETURN a;\nEND;");
  });

  it("keeps every anonymous-block declaration in the DECLARE section", async () => {
    const formatted = await formatSqlText(
      `DECLARE
  a integer;
  b text;
BEGIN
  SELECT 1 INTO a;
  IF a = 1 THEN
    b := 'x';
  ELSE
    b := 'y';
  END IF;
END;`,
      "postgres",
    );

    expect(formatted).toBe(["DECLARE", "  a integer;", "  b text;", "BEGIN", "  SELECT", "    1 INTO a;", "  IF a = 1 THEN b := 'x';", "  ELSE b := 'y';", "  END IF;", "END;"].join("\n"));
  });

  it("indents nested blocks without mistaking CASE, END IF, or END LOOP for the outer END", async () => {
    const formatted = await formatSqlText(
      `BEGIN
  SELECT CASE WHEN ready THEN 'Y' ELSE 'N' END INTO value;
  IF value = 'Y' THEN
    BEGIN
      LOOP
        EXIT;
      END LOOP;
    END;
  END IF;
END;`,
      "postgres",
    );

    expect(formatted).toContain("BEGIN\n  SELECT\n    CASE\n      WHEN ready THEN 'Y'");
    expect(formatted).toContain("    END INTO value;");
    expect(formatted).toContain("  IF value = 'Y' THEN\n  BEGIN");
    expect(formatted).toContain("    LOOP EXIT;");
    expect(formatted).toContain("    END LOOP;");
    expect(formatted).toContain("  END IF;");
    expect(formatted.endsWith("END;")).toBe(true);
    expect(formatted).not.toContain("\nEND LOOP;\nEND;");
  });

  it("does not rewrite opaque dollar-quoted PostgreSQL routine bodies", async () => {
    const body = `DECLARE
  v integer;
BEGIN
  RETURN 1;
END;`;
    const formatted = await formatSqlText(`CREATE FUNCTION app.f() RETURNS integer AS $$\n${body}\n$$ LANGUAGE plpgsql;`, "postgres");

    expect(formatted).toContain(`AS $$\n${body}\n$$ LANGUAGE plpgsql;`);
  });

  it("does not treat a top-level cursor declaration or transaction BEGIN as a procedural block", async () => {
    await expect(formatSqlText("DECLARE cur CURSOR FOR SELECT * FROM app.t;", "postgres")).resolves.toBe(["DECLARE cur CURSOR FOR", "SELECT", "  *", "FROM", "  app.t;"].join("\n"));
    await expect(formatSqlText("BEGIN; SELECT 1; COMMIT;", "postgres")).resolves.toBe(["BEGIN;", "", "SELECT", "  1;", "", "COMMIT;"].join("\n"));
  });

  it("pairs BEGIN blocks nested inside CASE branches", () => {
    const formatterOutput = ["BEGIN", "CASE ready", "WHEN 1 THEN", "BEGIN", "SELECT 1;", "END;", "END CASE;", "END;"].join("\n");
    const formatted = formatProceduralSqlBlocks(formatterOutput, {}, "postgres");

    expect(formatted).toBe(["BEGIN", "  CASE ready", "  WHEN 1 THEN", "  BEGIN", "    SELECT 1;", "  END;", "  END CASE;", "END;"].join("\n"));
  });

  it("never consumes comments between structural keywords", async () => {
    const formatted = await formatSqlText(
      `DECLARE /* variables */ v integer;
BEGIN /* body */
  NULL;
END;`,
      "postgres",
    );

    expect(formatted).toContain("DECLARE /* variables */ v integer;");
    expect(formatted).toContain("BEGIN /* body */ NULL;");
    expect(formatted.endsWith("END;")).toBe(true);
  });

  it("preserves structural-looking words in literals, identifiers, and comments", async () => {
    const formatted = await formatSqlText(
      `BEGIN
  SELECT 'BEGIN\nEND' AS text_value, "BEGIN" AS quoted_identifier;
  /* BEGIN END */
  NULL;
END;`,
      "postgres",
    );

    expect(formatted).toContain("'BEGIN\nEND'");
    expect(formatted).toContain('"BEGIN" AS quoted_identifier');
    expect(formatted).toContain("  /* BEGIN END */");
    expect(formatted.endsWith("END;")).toBe(true);
  });

  it("splits compact blocks and honors tab indentation", async () => {
    const compact = await formatSqlText("BEGIN NULL; END;", "postgres", { useTabs: true });
    expect(compact).toBe(["BEGIN", "\tNULL;", "END;"].join("\n"));
  });

  it("composes with query alignment and FROM/WHERE inline layout inside blocks", async () => {
    const sql = `BEGIN
  SELECT a FROM app.t WHERE a = 1;
END;`;

    await expect(formatSqlText(sql, "postgres", { keywordCase: "lower", keywordAlignment: "left" })).resolves.toBe(["begin", "  select", "    a", "  from app.t", "  where a = 1;", "end;"].join("\n"));
    await expect(formatSqlText(sql, "postgres", { keywordCase: "upper", clauseInline: true })).resolves.toBe(["BEGIN", "  SELECT", "    a", "  FROM app.t", "  WHERE a = 1;", "END;"].join("\n"));
  });

  it("is stable when the complete formatting pipeline runs twice", async () => {
    const once = await formatSqlText(userProcedure, "postgres");
    const twice = await formatSqlText(once, "postgres");

    expect(twice).toBe(once);
  });
});
