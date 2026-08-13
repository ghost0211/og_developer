// @vitest-environment happy-dom

import { createApp, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryResultViewSwitcher from "@/components/layout/QueryResultViewSwitcher.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe("QueryResultViewSwitcher output view", () => {
  let app: App | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  function mount(props: Record<string, unknown>) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    app = createApp(QueryResultViewSwitcher, props);
    app.mount(host);
    return host;
  }

  it("renders the 输出 button between 数据 and 执行摘要 and follows canShowOutput", () => {
    const host = mount({
      activeView: "result",
      canShowResult: true,
      canShowOutput: true,
      canShowSummary: true,
      canShowChart: false,
    });
    const buttons = [...host.querySelectorAll("button")];
    const labels = buttons.map((button) => button.textContent?.trim() ?? "");
    expect(labels).toEqual(["tabs.tableData", "tabs.output", "tabs.executionSummary", "chart.title"]);
    expect(buttons[1].getAttribute("aria-pressed")).toBe("false");
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the 输出 button when there are no messages", () => {
    const host = mount({
      activeView: "result",
      canShowResult: true,
      canShowOutput: false,
      canShowSummary: true,
      canShowChart: false,
    });
    const outputButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "tabs.output");
    expect((outputButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("marks the output view active and emits selectView", async () => {
    const host = mount({
      activeView: "output",
      canShowResult: true,
      canShowOutput: true,
      canShowSummary: true,
      canShowChart: false,
    });
    const outputButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "tabs.output");
    expect(outputButton?.getAttribute("aria-pressed")).toBe("true");

    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const emitted: string[] = [];
    const app2 = createApp(QueryResultViewSwitcher, {
      activeView: "result",
      canShowResult: true,
      canShowOutput: true,
      canShowSummary: true,
      canShowChart: false,
      onSelectView: (view: string) => emitted.push(view),
    });
    app2.mount(host2);
    const button = [...host2.querySelectorAll("button")].find((item) => item.textContent?.trim() === "tabs.output")!;
    (button as HTMLButtonElement).click();
    expect(emitted).toEqual(["output"]);
    app2.unmount();
    host2.remove();
  });
});
