import { describe, expect, it } from "vitest";
import { sqlBeginEndPairs, sqlBeginEndTokens, sqlBlockMatchRanges } from "@/lib/editor/codemirrorSqlBlockMatching";

function keywordPositions(sql: string, word: "BEGIN" | "END") {
  return [...sql.matchAll(new RegExp(`\\b${word}\\b`, "gi"))].map((match) => ({
    from: match.index ?? -1,
    to: (match.index ?? -1) + word.length,
  }));
}

describe("SQL BEGIN/END editor matching", () => {
  it("pairs nested blocks in lexical order", () => {
    const sql = "BEGIN\n  BEGIN\n    SELECT 1;\n  END;\nEND;";
    const [outer, inner] = sqlBeginEndPairs(sql).sort((left, right) => left.begin.from - right.begin.from);
    const begins = keywordPositions(sql, "BEGIN");
    const ends = keywordPositions(sql, "END");

    expect(outer).toMatchObject({ begin: begins[0], end: ends[1] });
    expect(inner).toMatchObject({ begin: begins[1], end: ends[0] });
  });

  it("ignores strings, quoted identifiers, and comments", () => {
    const sql = "SELECT 'BEGIN END', [BEGIN], /* BEGIN END */ -- END\nBEGIN\nEND;";
    expect(sqlBeginEndTokens(sql)).toHaveLength(2);
    expect(sqlBeginEndPairs(sql)).toHaveLength(1);
  });

  it("does not confuse CASE or END IF/LOOP with a BEGIN block terminator", () => {
    const sql = "BEGIN\n  IF ready THEN\n    SELECT CASE WHEN ready THEN 'Y' ELSE 'N' END;\n  END IF;\n  LOOP\n    EXIT;\n  END LOOP;\nEND;";
    const pairs = sqlBeginEndPairs(sql);
    const beginPair = pairs.find((pair) => pair.begin.word === "BEGIN");
    const casePair = pairs.find((pair) => pair.begin.word === "CASE");
    expect(beginPair?.begin.from).toBe(sql.indexOf("BEGIN"));
    expect(beginPair?.end.from).toBe(sql.lastIndexOf("END"));
    expect(casePair?.begin.from).toBe(sql.indexOf("CASE"));
    expect(casePair?.end.from).toBe(sql.indexOf("END", sql.indexOf("CASE")));
  });

  it("supports TRY/CATCH blocks and ignores transaction BEGIN statements", () => {
    const sql = "BEGIN;\nSELECT 1;\nBEGIN TRY\n  SELECT 2;\nEND TRY\nBEGIN CATCH\n  SELECT 3;\nEND CATCH;";
    const pairs = sqlBeginEndPairs(sql);
    expect(pairs.map((pair) => [pair.begin.word, pair.end.word])).toHaveLength(2);
    expect(pairs.every((pair) => pair.begin.word === "BEGIN")).toBe(true);
    expect(pairs[0]?.begin.from).toBe(sql.indexOf("BEGIN TRY"));
    expect(pairs[1]?.begin.from).toBe(sql.indexOf("BEGIN CATCH"));
  });

  it("only returns the pair next to an empty cursor", () => {
    const sql = "BEGIN\n  SELECT 1;\nEND;";
    const begin = sql.indexOf("BEGIN");
    const end = sql.indexOf("END");
    expect(sqlBlockMatchRanges(sql, [begin])).toMatchObject([
      { from: begin, to: begin + 5 },
      { from: end, to: end + 3 },
    ]);
    expect(sqlBlockMatchRanges(sql, [sql.indexOf("SELECT")])).toEqual([]);
  });
});

describe("procedural SQL branch matching", () => {
  it("matches nested IF blocks independently of BEGIN and exception subblocks", () => {
    const sql = `BEGIN
  IF p_is_choosed IS NULL OR p_is_choosed NOT IN (0, 1) THEN
    RAISE EXCEPTION 'invalid';
  END IF;
  BEGIN
    SELECT r.role_id INTO v_role_id FROM app.app_role r;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'missing';
  END;
  IF v_role_source IS DISTINCT FROM 'CUSTOM' THEN
    IF (v_delete_flag <> 0) THEN
      NULL;
    ELSIF ready THEN
      NULL;
    ELSE
      NULL;
    END IF;
  ELSE
    NULL;
  END IF;
END;`;
    const pairs = sqlBeginEndPairs(sql);
    expect(pairs).toHaveLength(5);
    const outerIf = pairs.find((pair) => pair.begin.from === sql.indexOf("IF v_role_source"))!;
    const nestedIf = pairs.find((pair) => pair.begin.from === sql.indexOf("IF (v_delete_flag"))!;
    expect(outerIf.end.from).toBe(sql.lastIndexOf("END IF"));
    expect(nestedIf.end.from).toBe(sql.indexOf("END IF", nestedIf.begin.to));
    expect(nestedIf.branches?.map((token) => token.word)).toEqual(["ELSIF", "ELSE"]);
    expect(sqlBlockMatchRanges(sql, [nestedIf.end.to - 1]).map((token) => sql.slice(token.from, token.to))).toEqual(["IF", "ELSIF", "ELSE", "END IF"]);
    expect(sqlBlockMatchRanges(sql, [nestedIf.branches![0]!.from])).toEqual(sqlBlockMatchRanges(sql, [nestedIf.begin.from]));
  });

  it("pairs IF, CASE and FOR/WHILE LOOP without consuming each other's END", () => {
    const sql = `BEGIN
  FOR r IN SELECT * FROM app.roles LOOP
    WHILE ready LOOP
      IF CASE WHEN ready THEN true ELSE false END THEN
        CASE r.kind
          WHEN 'a' THEN NULL;
          ELSE NULL;
        END CASE;
      END IF;
    END LOOP;
  END LOOP;
END;`;
    const pairs = sqlBeginEndPairs(sql);
    expect(pairs.map((pair) => pair.begin.word).sort()).toEqual(["BEGIN", "CASE", "CASE", "IF", "LOOP", "LOOP"]);
    expect(pairs.filter((pair) => pair.begin.word === "LOOP").map((pair) => sql.slice(pair.end.from, pair.end.to))).toEqual(["END LOOP", "END LOOP"]);
    const statementCase = pairs.find((pair) => pair.begin.from === sql.indexOf("CASE r.kind"))!;
    expect(sqlBlockMatchRanges(sql, [statementCase.end.to - 2]).map((token) => sql.slice(token.from, token.to))).toEqual(["CASE", "WHEN", "ELSE", "END CASE"]);
    expect(pairs.find((pair) => pair.begin.word === "BEGIN")?.end.from).toBe(sql.lastIndexOf("END"));
  });

  it("ignores SQL IF functions, DDL guards, strings and nested comments", () => {
    const sql = `BEGIN
  SELECT IF(ready, 1, 0), app.if(ready, 1, 0), CASE WHEN ready THEN 1 ELSE 0 END;
  CREATE TABLE IF NOT EXISTS tmp (id integer);
  SELECT 'IF THEN END IF', "IF", $$IF ready THEN END IF$$;
  /* IF ready THEN /* END IF */ END IF */
  IF ready /* THEN END IF */ THEN
    SELECT 1;
  END /* comment */ IF;
END;`;
    const pairs = sqlBeginEndPairs(sql);
    expect(pairs.map((pair) => pair.begin.word).sort()).toEqual(["BEGIN", "CASE", "IF"]);
    expect(sql.slice(pairs.find((pair) => pair.begin.word === "IF")!.end.from, pairs.find((pair) => pair.begin.word === "IF")!.end.to)).toBe("END /* comment */ IF");
  });

  it("scans dollar-quoted routine bodies but skips dollar-quoted values inside them", () => {
    const sql = `CREATE FUNCTION app.test() RETURNS void AS $body$
BEGIN
  IF ready THEN
    PERFORM $message$BEGIN IF x THEN END IF END$message$;
  END IF;
END;
$body$ LANGUAGE plpgsql;`;
    expect(sqlBeginEndPairs(sql).map((pair) => pair.begin.word)).toEqual(["IF", "BEGIN"]);
    const anonymous = "DO $$ BEGIN IF ready THEN NULL; END IF; END; $$";
    expect(sqlBeginEndPairs(anonymous).map((pair) => pair.begin.word)).toEqual(["IF", "BEGIN"]);
  });

  it("does not match an incomplete IF to an unrelated bare END", () => {
    const sql = "BEGIN IF ready THEN NULL; END;";
    expect(sqlBeginEndPairs(sql)).toEqual([]);
    expect(sqlBlockMatchRanges(sql, [sql.indexOf("IF")])).toEqual([]);
  });
});
