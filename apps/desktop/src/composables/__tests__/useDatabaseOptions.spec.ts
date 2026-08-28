import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseOptionsForConnection, fetchNamespaceOptionsForConnection, fetchSqlFileTargetOptions, useDatabaseOptions } from "@/composables/useDatabaseOptions";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  listDatabases: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
  }),
}));

describe("namespace options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves listDatabases and visible database filtering", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "analytics" }, { name: "postgres" }]);

    const options = await fetchNamespaceOptionsForConnection("connection-2", {
      db_type: "postgres",
      database: "app",
      visible_databases: ["analytics"],
    });

    expect(options).toEqual(["analytics"]);
    expect(mocks.listDatabases).toHaveBeenCalledWith("connection-2");
  });

  it("preserves visible database filtering for transfer options", () => {
    expect(
      databaseOptionsForConnection(["app", "analytics", "postgres"], {
        db_type: "postgres",
        visible_databases: ["analytics"],
      }),
    ).toEqual(["analytics"]);
  });

  it("propagates metadata loading errors", async () => {
    const error = new Error("database metadata failed");
    mocks.listDatabases.mockRejectedValue(error);

    await expect(
      fetchNamespaceOptionsForConnection("connection-1", {
        db_type: "opengauss",
        database: "app",
      }),
    ).rejects.toBe(error);
  });

  it("keeps the SQL file target on the shared namespace loader", async () => {
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "analytics" }]);

    await expect(
      fetchSqlFileTargetOptions("connection-1", {
        db_type: "opengauss",
        database: "app",
      }),
    ).resolves.toEqual(["app", "analytics"]);
  });
});

describe("database options loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads databases through the shared API", async () => {
    mocks.getConfig.mockReturnValue({ db_type: "opengauss" });
    mocks.listDatabases.mockResolvedValue([{ name: "app" }, { name: "analytics" }]);
    const options = useDatabaseOptions();

    await options.loadDatabaseOptions("connection-1");

    expect(options.databaseOptions.value["connection-1"]).toEqual(["app", "analytics"]);
    expect(mocks.listDatabases).toHaveBeenCalledWith("connection-1");
  });
});
