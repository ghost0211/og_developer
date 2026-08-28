import { describe, expect, it } from "vitest";
import { dataGridPreviewLabelKey } from "@/lib/dataGrid/dataGridSaveUi";

describe("dataGridPreviewLabelKey", () => {
  it("keeps the SQL wording for SQL databases", () => {
    expect(dataGridPreviewLabelKey("postgres")).toBe("toolbar.previewSql");
    expect(dataGridPreviewLabelKey("opengauss")).toBe("toolbar.previewSql");
  });

  it("falls back to the SQL wording when the database type is unknown", () => {
    expect(dataGridPreviewLabelKey(undefined)).toBe("toolbar.previewSql");
  });
});
