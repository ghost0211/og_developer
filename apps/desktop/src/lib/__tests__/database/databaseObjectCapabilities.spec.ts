import { describe, expect, it } from "vitest";
import { normalizeSidebarObjectKind, sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

describe("databaseObjectCapabilities", () => {
  it("exposes packages and synonyms for openGauss", () => {
    expect(sidebarObjectKindsForDatabase("opengauss")).toEqual(expect.arrayContaining(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY"]));
    expect(sidebarObjectKindsForDatabase("postgres")).not.toContain("PACKAGE");
    expect(sidebarObjectKindsForDatabase("postgres")).not.toContain("SYNONYM");
  });

  it("scopes openGauss packages to A compatibility mode", () => {
    // Live-verified: CREATE PACKAGE succeeds only in A mode; synonyms work everywhere.
    expect(sidebarObjectKindsForDatabase("opengauss", "A")).toContain("PACKAGE");
    expect(sidebarObjectKindsForDatabase("opengauss", "A")).toContain("SYNONYM");
    for (const mode of ["B", "C", "M", "PG"]) {
      expect(sidebarObjectKindsForDatabase("opengauss", mode)).not.toContain("PACKAGE");
      expect(sidebarObjectKindsForDatabase("opengauss", mode)).not.toContain("PACKAGE_BODY");
      expect(sidebarObjectKindsForDatabase("opengauss", mode)).toContain("SYNONYM");
    }
    // Unknown mode keeps every group visible as a safe fallback.
    expect(sidebarObjectKindsForDatabase("opengauss", undefined)).toContain("PACKAGE");
  });

  it("exposes pg_job scheduled jobs for openGauss in every compatibility mode", () => {
    for (const mode of ["A", "B", "C", "M", "PG", undefined]) {
      expect(sidebarObjectKindsForDatabase("opengauss", mode)).toContain("JOB");
    }
    expect(sidebarObjectKindsForDatabase("postgres")).not.toContain("JOB");
  });

  it("normalizes space separated materialized view types", () => {
    expect(normalizeSidebarObjectKind("MATERIALIZED VIEW")).toBe("MATERIALIZED_VIEW");
  });
});
