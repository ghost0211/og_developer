import { describe, expect, it } from "vitest";
import { parseSqlErrorLocation } from "@/lib/sql/sqlDiagnostics";

describe("parseSqlErrorLocation", () => {
  it("parses psql-style LINE context synthesized from an internal error position", () => {
    // Shape produced by the backend for openGauss PL compile errors.
    const message = 'ERROR: "v" is not a known variable (SQLSTATE 42703)\nLINE 2:   select no_col into v from no_tbl;\n                     ^';
    const location = parseSqlErrorLocation(message);
    expect(location).toEqual({ line: 1, column: 21, internal: true });
  });

  it("leaves line/column formats as absolute locations", () => {
    const location = parseSqlErrorLocation("Msg 102, Level 15, State 1, Line 5, Column 3\nIncorrect syntax");
    expect(location).toEqual({ line: 4, column: 2 });
    expect(location?.internal).toBeUndefined();
  });

  it("ignores LINE text without a caret line", () => {
    expect(parseSqlErrorLocation("ERROR: bad\nLINE 2: select 1;")).toBeNull();
  });
});
