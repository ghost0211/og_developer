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
