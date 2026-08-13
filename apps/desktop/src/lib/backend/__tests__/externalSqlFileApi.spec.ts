import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import { readExternalSqlFile } from "@/lib/backend/tauri";

describe("external SQL file API", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("reads the file content through the search/fs command", async () => {
    mocks.invoke.mockResolvedValue("select 1;");

    await expect(readExternalSqlFile("/tmp/demo.sql")).resolves.toBe("select 1;");
    expect(mocks.invoke).toHaveBeenCalledWith("read_text_file", { path: "/tmp/demo.sql" });
  });
});
