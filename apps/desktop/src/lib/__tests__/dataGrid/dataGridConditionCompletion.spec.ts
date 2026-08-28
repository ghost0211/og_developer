import { describe, expect, it } from "vitest";
import { dataGridConditionColumnOptions, dataGridConditionIdentifierQuote } from "@/lib/dataGrid/dataGridConditionCompletion";

describe("dataGridConditionColumnOptions", () => {
  it("reuses PostgreSQL completion quoting while preserving display metadata", () => {
    expect(dataGridConditionColumnOptions([{ name: "OrderId", comment: "Mixed case" }, { name: "order", comment: null }, { name: "article", comment: "Safe identifier" }, { name: 'has"quote' }], "postgres")).toEqual([
      { name: "OrderId", comment: "Mixed case", insertText: '"OrderId"' },
      { name: "order", comment: null, insertText: '"order"' },
      { name: "article", comment: "Safe identifier", insertText: "article" },
      { name: 'has"quote', insertText: '"has""quote"' },
    ]);
  });

  it("reuses openGauss completion quoting while preserving display metadata", () => {
    expect(dataGridConditionColumnOptions([{ name: "OrderId", comment: "Mixed case" }, { name: "order", comment: null }, { name: "article", comment: "Safe identifier" }, { name: 'has"quote' }], "opengauss")).toEqual([
      { name: "OrderId", comment: "Mixed case", insertText: '"OrderId"' },
      { name: "order", comment: null, insertText: '"order"' },
      { name: "article", comment: "Safe identifier", insertText: "article" },
      { name: 'has"quote', insertText: '"has""quote"' },
    ]);
  });

  it("uses the active dialect identifier quote while preserving runtime overrides", () => {
    expect(dataGridConditionIdentifierQuote("postgres")).toBe('"');
    expect(dataGridConditionIdentifierQuote("opengauss")).toBe('"');
    expect(dataGridConditionIdentifierQuote("jdbc")).toBe('"');
    expect(dataGridConditionIdentifierQuote("opengauss", "`")).toBe("`");
  });
});
