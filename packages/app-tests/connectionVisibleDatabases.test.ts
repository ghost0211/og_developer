import assert from "node:assert/strict";
import { test } from "vitest";
import { appendVisibleDatabaseSelection, buildDraftVisibleDatabasesConnectionId, connectionCanChooseVisibleDatabases, visibleDatabaseSelectionIsStale, visibleObjectFiltersNeedReset, initialVisibleDatabaseSelection } from "../../apps/desktop/src/lib/connection/connectionVisibleDatabases.ts";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterDatabaseNamesForVisiblePicker, filterSchemaNamesForConnection, filterSchemaNamesForVisiblePicker, normalizeVisibleSchemaSelection } from "../../apps/desktop/src/lib/database/visibleDatabases.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "conn",
    name: "Local",
    db_type: "mysql",
    driver_profile: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: undefined,
    visible_databases: undefined,
    transport_layers: [],
    connect_timeout_secs: 5,
    query_timeout_secs: 30,
    idle_timeout_secs: 60,
    ssl: false,
    ca_cert_path: "",
    client_cert_path: "",
    client_key_path: "",
    sysdba: false,
    jdbc_driver_paths: [],
    redis_sentinel_master: "",
    redis_sentinel_nodes: "",
    redis_sentinel_username: "",
    redis_sentinel_password: "",
    redis_sentinel_tls: false,
    redis_cluster_nodes: "",
    etcd_endpoints: "",
    ...overrides,
  };
}

test("draft visible database connection ids are namespaced", () => {
  assert.equal(buildDraftVisibleDatabasesConnectionId("abc"), "__visible_draft_abc");
});

test("initial selection uses configured visible databases when available", () => {
  assert.deepEqual(initialVisibleDatabaseSelection(["app", "analytics", "billing"], ["billing", "missing"]), ["billing"]);
});



test("Redis visible database picker keeps every database and initial selection uses saved filters", () => {
  const databaseNames = ["0", "1", "2"];
  const connection = config({ db_type: "redis", driver_profile: "redis", visible_databases: ["0"] });
  assert.deepEqual(filterDatabaseNamesForVisiblePicker(databaseNames, connection), ["0", "1", "2"]);
  assert.deepEqual(initialVisibleDatabaseSelection(databaseNames, connection.visible_databases, connection), ["0"]);
});

test("connection database filtering still applies saved visible database filters for sidebar display", () => {
  assert.deepEqual(filterDatabaseNamesForConnection(["app", "analytics", "mysql", "sys"], config({ visible_databases: ["app"] })), ["app"]);
});

test("append visible database selection only when filter is enabled", () => {
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], "analytics"), ["app", "analytics"]);
  assert.deepEqual(appendVisibleDatabaseSelection(["app", "analytics"], "analytics"), ["app", "analytics"]);
  assert.equal(appendVisibleDatabaseSelection(undefined, "analytics"), undefined);
});

test("append visible database selection trims new database names and ignores empty names", () => {
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], " analytics "), ["app", "analytics"]);
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], "   "), ["app"]);
});





test("Vastbase schema filters preserve ordinary schemas and explicit empty selections", () => {
  const schemas = ["public", "app"];
  assert.deepEqual(filterSchemaNamesForConnection(schemas, config({ db_type: "vastbase", database: "vastbase" }), "vastbase"), schemas);
  assert.deepEqual(filterSchemaNamesForConnection(schemas, config({ db_type: "vastbase", database: "vastbase", visible_schemas: { vastbase: [] } }), "vastbase"), []);
  assert.deepEqual(normalizeVisibleSchemaSelection([], schemas), []);
  assert.deepEqual(normalizeVisibleSchemaSelection(["app", "missing", "app", "public"], schemas), ["app", "public"]);
});


test("Dameng explicit schema filters can keep SYSDBA visible", () => {
  const connection = config({ db_type: "dameng", username: "APP", visible_schemas: { "": ["APP", "SYSDBA"] } });
  assert.deepEqual(filterSchemaNamesForConnection(["APP", "SYS", "SYSDBA"], connection, ""), ["APP", "SYSDBA"]);
});


test("visible database selection is stale when connection target changes", () => {
  const previous = config({ host: "db.internal", visible_databases: ["app"] });
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db.internal" })), false);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db2.internal" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ username: "readonly" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ database: "admin" })), true);
});

test("visible schema filters reset when the connection target changes", () => {
  const previous = config({ host: "db.internal", visible_schemas: { "": ["APP"] } });
  assert.equal(visibleObjectFiltersNeedReset(previous, config({ host: "db.internal", visible_schemas: { "": ["APP"] } })), false);
  assert.equal(visibleObjectFiltersNeedReset(previous, config({ host: "db2.internal", visible_schemas: { "": ["APP"] } })), true);
  assert.equal(visibleObjectFiltersNeedReset(previous, config({ host: "db2.internal" })), false);
});
