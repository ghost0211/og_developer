// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DatabaseIcon from "./DatabaseIcon.vue";

describe("DatabaseIcon", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders openGauss icon asset", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon, { dbType: "opengauss" });
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/database/opengauss.svg");
    app.unmount();
  });

  it("renders PostgreSQL icon asset", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(DatabaseIcon, { dbType: "postgres" });
    app.mount(container);
    await nextTick();

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/database/postgres.svg");
    app.unmount();
  });
});
