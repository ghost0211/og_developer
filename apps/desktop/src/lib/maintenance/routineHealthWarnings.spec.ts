import { describe, expect, it } from "vitest";
import { routineHealthWarningText } from "./routineHealthWarnings";

const MESSAGES: Record<string, string> = {
  "routineHealth.warnings.call_scope": "例程调用按名称核对，不校验重载参数类型。",
  "routineHealth.warnings.source_fallback": "无法获取完整例程定义：{detail}",
};
const te = (key: string) => key in MESSAGES;
const t = (key: string, params?: Record<string, string>) => (MESSAGES[key] ?? key).replace("{detail}", params?.detail ?? "");

describe("routineHealthWarningText", () => {
  it("localizes known codes without detail", () => {
    expect(routineHealthWarningText({ code: "call_scope" }, te, t)).toBe("例程调用按名称核对，不校验重载参数类型。");
  });

  it("interpolates technical detail into the localized template", () => {
    expect(routineHealthWarningText({ code: "source_fallback", detail: "timeout" }, te, t)).toBe("无法获取完整例程定义：timeout");
  });

  it("degrades unknown codes to the raw detail instead of a blank line", () => {
    expect(routineHealthWarningText({ code: "future_code", detail: "raw server context" }, te, t)).toBe("raw server context");
    expect(routineHealthWarningText({ code: "future_code" }, te, t)).toBe("future_code");
  });
});
