import { describe, expect, it } from "vitest";
import { menuSearchTableDdlTarget } from "../../apps/desktop/src/lib/search/menuSearchObjectNavigation.ts";

const base = {
  connectionId: "conn-1",
  database: "app",
  schema: "public",
};

describe("menu search object navigation", () => {
  it("opens table results through the table-DDL protocol without an object source kind", () => {
    expect(menuSearchTableDdlTarget({ ...base, objectType: "TABLE", name: "orders" })).toEqual({
      ...base,
      tableName: "orders",
      objectType: undefined,
    });
  });

  it("opens column results at their parent table without sending COLUMN to the DDL command", () => {
    expect(menuSearchTableDdlTarget({ ...base, objectType: "COLUMN", name: "orders.customer_id" })).toEqual({
      ...base,
      tableName: "orders",
      objectType: undefined,
    });
  });

  it("rejects malformed column results that do not identify a parent table", () => {
    expect(menuSearchTableDdlTarget({ ...base, objectType: "COLUMN", name: "customer_id" })).toBeUndefined();
  });
});
