import { describe, expect, it } from "vitest";
import { editorCursorLocation, formatOpenGaussCompatibilityBadge, sqlLineEnding, statusBarConnectionLabel } from "@/lib/app/bottomStatusBar";

describe("bottomStatusBar", () => {
  it("formats openGauss sql_compatibility modes cleanly without channel noise", () => {
    expect(formatOpenGaussCompatibilityBadge(undefined)).toBeUndefined();
    expect(formatOpenGaussCompatibilityBadge("  ")).toBeUndefined();
    expect(formatOpenGaussCompatibilityBadge("a")).toEqual({
      code: "A",
      label: "A (Oracle)",
      tooltipKey: "statusBar.compatTooltipA",
    });
    expect(formatOpenGaussCompatibilityBadge("B")).toEqual({
      code: "B",
      label: "B (MySQL)",
      tooltipKey: "statusBar.compatTooltipB",
    });
    expect(formatOpenGaussCompatibilityBadge("C")).toEqual({
      code: "C",
      label: "C (TD)",
      tooltipKey: "statusBar.compatTooltipC",
    });
    expect(formatOpenGaussCompatibilityBadge("pg")).toEqual({
      code: "PG",
      label: "PG",
      tooltipKey: "statusBar.compatTooltipPG",
    });
    expect(formatOpenGaussCompatibilityBadge("M")).toEqual({
      code: "M",
      label: "M (MySQL)",
      tooltipKey: "statusBar.compatTooltipM",
    });
  });

  it("computes cursor line/column and line endings accurately", () => {
    expect(editorCursorLocation("SELECT 1;\nSELECT 2;", 10)).toEqual({ line: 2, column: 1 });
    expect(sqlLineEnding("SELECT 1;\r\nSELECT 2;")).toBe("CRLF");
    expect(sqlLineEnding("SELECT 1;\nSELECT 2;")).toBe("LF");
  });

  it("formats openGauss connection label", () => {
    expect(
      statusBarConnectionLabel({
        id: "1",
        name: "prod-og",
        db_type: "opengauss",
        host: "127.0.0.1",
        port: 5432,
        database_info: { productName: "openGauss", productVersion: "6.0.0" },
      }),
    ).toBe("prod-og · openGauss 6.0.0");
  });
});
