import assert from "node:assert/strict";
import { test } from "vitest";
import { schemaOptionsForConnection } from "../../apps/desktop/src/composables/useSchemaOptions.ts";



test("schema options respect visible schemas for OceanBase Oracle mode", () => {
  assert.deepEqual(
    schemaOptionsForConnection(
      ["ORAAUDITOR", "APP", "SYS"],
      {
        db_type: "oceanbase-oracle",
        visible_schemas: { SYS: ["ORAAUDITOR"] },
      },
      "SYS",
    ),
    ["ORAAUDITOR"],
  );
});

