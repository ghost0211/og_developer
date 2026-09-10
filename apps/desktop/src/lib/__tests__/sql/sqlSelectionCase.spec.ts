import { describe, expect, it } from "vitest";
import { convertSqlSelectionCase } from "@/lib/sql/sqlSelectionCase";

describe("convertSqlSelectionCase", () => {
  it("converts SQL text without changing string literals", () => {
    const sql = "SELECT Code FROM Orders WHERE Code = 'ABC001' AND Note = 'It''s Ready'";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower")).toBe("select code from orders where code = 'ABC001' and note = 'It''s Ready'");
  });

  it("preserves string literals when converting to uppercase", () => {
    const sql = "select code from orders where code = 'abc001'";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "upper")).toBe("SELECT CODE FROM ORDERS WHERE CODE = 'abc001'");
  });

  it("preserves the selected fragment when the selection is inside a string literal", () => {
    const sql = "select * from orders where code = 'AbC001'";
    const from = sql.indexOf("bC");

    expect(convertSqlSelectionCase(sql, { from, to: from + 2 }, "lower")).toBe("bC");
  });

  it("preserves PostgreSQL dollar-quoted string literals", () => {
    const sql = "select $tag$Mixed Value$tag$ as label";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "upper", "postgres")).toBe("SELECT $tag$Mixed Value$tag$ AS LABEL");
  });

  it("converts dollar-quoted routine bodies while preserving inner string literals", () => {
    const sql = "CREATE OR REPLACE FUNCTION DBO.GET_DICT_ITEM_NAME(P_DICT_CODE CHARACTER VARYING)\n" + "RETURNS TABLE(ITEM_CODE CHARACTER VARYING)\n" + "LANGUAGE SQL\n" + "AS $function$\n" + "  SELECT item_code FROM dbo.app_dict_item WHERE item_name = 'Mixed Value'\n" + "$function$;";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower", "postgres")).toBe(
      "create or replace function dbo.get_dict_item_name(p_dict_code character varying)\n" + "returns table(item_code character varying)\n" + "language sql\n" + "as $function$\n" + "  select item_code from dbo.app_dict_item where item_name = 'Mixed Value'\n" + "$function$;",
    );
  });

  it("converts lowercase routine bodies to uppercase without touching inner string literals", () => {
    const sql = "create function f() returns void language sql as $$\n  select 'Keep Me';\n$$;";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "upper", "postgres")).toBe("CREATE FUNCTION F() RETURNS VOID LANGUAGE SQL AS $$\n  SELECT 'Keep Me';\n$$;");
  });

  it("converts a selection inside a routine body", () => {
    const sql = "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $body$\n  SELECT MixedCaseColumn FROM t;\n$body$;";
    const from = sql.indexOf("SELECT MixedCaseColumn");
    const to = sql.indexOf(";", from);

    expect(convertSqlSelectionCase(sql, { from, to }, "lower", "postgres")).toBe("select mixedcasecolumn from t");
  });

  it("continues converting comments and quoted identifiers", () => {
    const sql = 'select "MixedName" -- Keep Comment\nfrom users';

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower")).toBe('select "mixedname" -- keep comment\nfrom users');
  });
});
