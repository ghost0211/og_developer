import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.resolve(relativePath), "utf8");
}

test("keeps JDBC outside the database picker and exposes a dedicated entry", () => {
  const content = source("apps/desktop/src/components/connection/ConnectionDialog.vue");
  const optionsStart = content.indexOf("const dbOptions: DbOption[] = [");
  const optionsEnd = content.indexOf("const dbCategories", optionsStart);
  const pickerToolbar = content.indexOf("sm:justify-between");
  const searchInput = content.indexOf('v-model="dbSearchQuery"', pickerToolbar);
  const jdbcEntry = content.indexOf("data-jdbc-connection-entry", pickerToolbar);

  assert.notEqual(optionsStart, -1);
  assert.notEqual(optionsEnd, -1);
  assert.equal(content.slice(optionsStart, optionsEnd).includes('{ value: "jdbc"'), false);
  assert.ok(pickerToolbar < searchInput && searchInput < jdbcEntry);
  assert.match(content.slice(jdbcEntry, jdbcEntry + 400), /goToConnectionStep\('jdbc'\)/);
});

test("driver management page has been removed from the connection flow", () => {
  const connectionDialog = source("apps/desktop/src/components/connection/ConnectionDialog.vue");
  const app = source("apps/desktop/src/App.vue");

  // 驱动管理页面入口已彻底移除：连接对话框不再发出 openDriverStore，
  // 也没有指向驱动管理页的按钮（提示文案里的纯文本保留）。
  assert.equal(connectionDialog.includes("openDriverStore"), false);
  assert.equal(/@click="[^"]*openDriverStore/.test(connectionDialog), false);
  assert.equal(app.includes("DriverStoreDialog"), false);
  assert.equal(app.includes("openDriverStorePage"), false);
});

test("driver store page state is gone from the app shell", () => {
  const app = source("apps/desktop/src/App.vue");
  assert.equal(app.indexOf("function closeDriverStorePage() {"), -1);
  assert.equal(app.includes("driverStoreActiveTab"), false);
});
