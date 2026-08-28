import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiresDatabaseSelection, useSqlExecution } from "../useSqlExecution";
import { useConnectionStore } from "@/stores/connectionStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("vue-i18n", () => ({
  createI18n: () => ({ global: { locale: { value: "en" }, setLocaleMessage: vi.fn() } }),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(),
  saveHistory: vi.fn(),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: "conn-1",
    name: "Local",
    db_type: dbType,
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  };
}

function queryTab(database = ""): QueryTab {
  return {
    id: "tab-1",
    connectionId: "conn-1",
    database,
    schema: undefined,
    title: "SQL",
    sql: "",
    mode: "query",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
  };
}

describe("requiresDatabaseSelection", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("allows JDBC with default database (empty string) to execute queries", () => {
    expect(requiresDatabaseSelection(queryTab(""), connection("jdbc"), "SELECT * FROM users")).toBe(false);
  });

  it("allows PostgreSQL with default database (empty string) to execute queries", () => {
    expect(requiresDatabaseSelection(queryTab(""), connection("postgres"), "SELECT * FROM public.users")).toBe(false);
  });
});

describe("useSqlExecution", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("passes the selected statement's editor offset to the query store", async () => {
    const fullSql = "SELECT * FROM users;\nSELECT * FROM users;";
    const selectionFrom = fullSql.lastIndexOf("SELECT");
    const selectedSql = fullSql.slice(selectionFrom, -1);
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql: fullSql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => selectedSql),
      resolveExecutableSql: async () => selectedSql,
      activeOutputView,
    });

    await execution.tryExecute({ fullSql, selectedSql, cursorPos: selectionFrom, selectionFrom, selectionTo: fullSql.length - 1 });

    expect(executeCurrentSql).toHaveBeenCalledWith(selectedSql, { sourceOffset: selectionFrom });
  });

  it("opens the execution summary for a multi-statement batch", async () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(activeOutputView.value).toBe("summary");
  });

  it("forwards execute-in-new-result-tab intent to the query store", async () => {
    const sql = "SELECT * FROM users";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { openInNewResultTab: true });
  });

  it("does not record or refresh when a new-result execution restores the prior run", async () => {
    const result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), result });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockResolvedValue(false);
    const addHistory = vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(useConnectionStore(), "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "CREATE TABLE users (id INT)"),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(addHistory).not.toHaveBeenCalled();
    expect(refreshObjects).not.toHaveBeenCalled();
  });

  it("keeps the new-result-tab intent through SQL parameter input", async () => {
    const sql = "SELECT * FROM users WHERE id = :id";
    const resolvedSql = "SELECT * FROM users WHERE id = 7";
    const activeTab = ref<QueryTab | undefined>({ ...queryTab("app"), sql });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["id"], rows: [[7]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(execution.showSqlParameterDialog.value).toBe(true);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onSqlParametersConfirm(resolvedSql);

    expect(executeCurrentSql).toHaveBeenCalledWith(resolvedSql, { openInNewResultTab: true });
  });

  it("sends native SET variables without client-side expansion", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(
        () => `
          set @date_start = '2026-07-04 00:00:00';

          select * from sa_access_decision_log AS fp
          where fp.create_at < @date_start;
        `,
      ),
      activeOutputView,
    });

    await execution.tryExecute();

    const executedSql = executeCurrentSql.mock.calls[0]?.[0] ?? "";
    expect(executedSql).toContain("set @date_start = '2026-07-04 00:00:00'");
    expect(executedSql).toContain("where fp.create_at < @date_start");
  });

  it("sends Doris STRUCT DDL unchanged without opening the parameter dialog", async () => {
    const sql = `
      create table \`events\` (
        \`field0\` int not null comment 'field 0',
        \`field_list\` array<struct<field1:smallint, field2:int, field3:decimal(16,5), field4:varchar(255)>> comment 'field list'
      )
      engine = olap
      properties ("replication_num" = "1");
    `;
    const activeTab = ref<QueryTab | undefined>(queryTab("analytics"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("doris"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    vi.spyOn(useConnectionStore(), "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(execution.showSqlParameterDialog.value).toBe(false);
    expect(execution.sqlParameterNames.value).toEqual([]);
    expect(executeCurrentSql).toHaveBeenCalledWith(sql, {});
  });

  it("records a later PostgreSQL batch error and skips metadata refresh", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    const connectionStore = useConnectionStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      const tab = activeTab.value;
      if (!tab) return;
      const successfulResult = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
      tab.result = successfulResult;
      tab.results = [successfulResult, { columns: ["Error"], execution_error: true, rows: [["relation missing_table does not exist"]], affected_rows: 0, execution_time_ms: 1 }];
      tab.activeResultIndex = 0;
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);
    const refreshObjects = vi.spyOn(connectionStore, "refreshObjectListTreeNode").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "BEGIN; SELECT 1 AS value; SELECT * FROM missing_table"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "relation missing_table does not exist", affected_rows: undefined }));
    expect(refreshObjects).not.toHaveBeenCalled();
  });

  it("does not treat an unmarked PostgreSQL Error alias as a failure", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("postgres"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const historyStore = useHistoryStore();
    vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["Error"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 };
    });
    const addHistory = vi.spyOn(historyStore, "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "SELECT 2 AS Error"),
      activeOutputView,
    });

    await execution.tryExecute();

    expect(addHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true, error: undefined }));
  });

  it("keeps the full dangerous script and new-result-tab intent through confirmation", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("app"));
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const sql = Array.from({ length: 40_000 }, (_, index) => `${index === 0 ? "DROP TABLE IF EXISTS t;" : ""} INSERT INTO t VALUES (${index});`).join("\n");
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: [], rows: [], affected_rows: 40_000, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => sql),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();

    expect(execution.showDangerDialog.value).toBe(true);
    expect(execution.pendingDangerSql.value).toBe(sql);
    expect(executeCurrentSql).not.toHaveBeenCalled();

    await execution.onDangerConfirm();

    expect(executeCurrentSql).toHaveBeenCalledWith(sql, { openInNewResultTab: true });
  });

  it("keeps the active retained result when a new-result dangerous prompt is cancelled", async () => {
    const result = { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    const activeTab = ref<QueryTab | undefined>({
      ...queryTab("app"),
      result,
      resultRuns: [{ id: "run-1", title: "Run 1", sequence: 1, sql: "SELECT 1", createdAt: 1, result }],
      activeResultRunId: "run-1",
    });
    const activeConnection = ref<ConnectionConfig | undefined>(connection("mysql"));
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql");

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "DROP TABLE users"),
      activeOutputView,
    });

    await execution.tryExecuteInNewResultTab();
    expect(execution.showDangerDialog.value).toBe(true);

    execution.showDangerDialog.value = false;
    await Promise.resolve();

    expect(executeCurrentSql).not.toHaveBeenCalled();
    expect(activeTab.value?.activeResultRunId).toBe("run-1");
    expect(activeTab.value?.result).toEqual(result);
  });

  it("requires production confirmation even when ordinary danger prompts are disabled", async () => {
    const activeTab = ref<QueryTab | undefined>(queryTab("prod_app"));
    const activeConnection = ref<ConnectionConfig | undefined>({ ...connection("mysql"), production_databases: ["prod_app"] });
    const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
    const queryStore = useQueryStore();
    const settingsStore = useSettingsStore();
    const productionSafetyStore = useProductionSafetyStore();
    const executeCurrentSql = vi.spyOn(queryStore, "executeCurrentSql").mockImplementation(async () => {
      if (activeTab.value) activeTab.value.result = { columns: ["ok"], rows: [[1]], affected_rows: 1, execution_time_ms: 1 };
    });
    vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
    settingsStore.editorSettings.confirmDangerousSqlExecution = false;

    const execution = useSqlExecution({
      activeTab: computed(() => activeTab.value),
      activeConnection: computed(() => activeConnection.value),
      executableSql: computed(() => "UPDATE users SET active = 1 WHERE id = 7"),
      activeOutputView,
    });

    const pendingExecution = execution.tryExecute();
    await Promise.resolve();
    expect(productionSafetyStore.pending?.sql).toContain("UPDATE users");
    expect(executeCurrentSql).not.toHaveBeenCalled();

    productionSafetyStore.confirm();
    await pendingExecution;
    expect(executeCurrentSql).toHaveBeenCalledTimes(1);
  });
});
