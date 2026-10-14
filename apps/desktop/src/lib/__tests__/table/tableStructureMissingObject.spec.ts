import { describe, expect, it } from "vitest";

import { shouldCheckEmptyColumnsObjectExistence } from "@/lib/table/tableStructureMissingObject";

describe("tableStructureMissingObject", () => {
  it("checks empty openGauss and PostgreSQL column metadata", () => {
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "opengauss" })).toBe(true);
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "postgres" })).toBe(true);
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "jdbc", driver_profile: "opengauss-jdbc" })).toBe(true);
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "jdbc", driver_profile: " GaussDB " })).toBe(true);
  });

  it("does not add a DDL round trip for other databases or real non-empty metadata", () => {
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "mysql" })).toBe(false);
    expect(shouldCheckEmptyColumnsObjectExistence({ db_type: "jdbc", driver_profile: "dm" })).toBe(false);
    expect(shouldCheckEmptyColumnsObjectExistence(undefined)).toBe(false);
  });
});
