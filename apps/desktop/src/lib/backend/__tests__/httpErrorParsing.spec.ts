import { describe, expect, test, vi } from "vitest";
import { backendResponseError, importAgentDriver, installJdbcPluginLocal } from "@/lib/backend/http";
import { BackendErrorException } from "@/lib/backend/errorUtils";

const envelope = {
  version: 1,
  code: "DBX-JDBC-4001",
  messageKey: "backendErrors.jdbc.sqlFailed",
  messageParams: { stage: "execute" },
  source: "jdbcAgent",
  operationOutcome: "unknown",
  detail: "Incorrect syntax near SELECT",
} as const;

describe("HTTP backend error parsing", () => {
  test.each([
    ["direct envelope", JSON.stringify(envelope), envelope],
    ["nested envelope", JSON.stringify({ error: envelope }), envelope],
    ["legacy text", "relation missing_table does not exist", undefined],
    ["malformed JSON text", "{not-json", undefined],
  ])("preserves %s body diagnostics", async (_name, body, expected) => {
    const error = await backendResponseError(new Response(body, { status: 500 }));
    if (expected) {
      expect(error.backendError).toEqual(expected);
    } else {
      expect(error.backendError.code).toBe("DBX-LEGACY-0001");
      expect(error.backendError.detail).toBe(body);
    }
  });

  test("attaches status and URL when the error body is empty", async () => {
    const error = await backendResponseError(new Response("", { status: 503 }));
    expect(error.backendError.code).toBe("DBX-WEB-0002");
    expect(error.backendError.messageKey).toBe("backendErrors.emptyErrorResponse");
    expect(error.backendError.messageParams.status).toBe(503);
  });

  // 回归：web 端版本不匹配/反代未转发 /api 时，API 请求会收到 index.html，
  // 不能把整个 HTML 页面当作错误详情展示，要转成可诊断的结构化错误。
  test.each([
    ["doctype", '<!doctype html>\n<html lang="zh-CN"><head><title>OG Developer</title></head></html>'],
    ["html tag with leading whitespace", "\n  <html><head></head><body></body></html>"],
  ])("converts an HTML %s body into a structured diagnostic instead of raw markup", async (_name, body) => {
    const error = await backendResponseError(new Response(body, { status: 404 }));
    expect(error.backendError.code).toBe("DBX-WEB-0001");
    expect(error.backendError.messageKey).toBe("backendErrors.htmlResponse");
    expect(error.backendError.messageParams.status).toBe(404);
    expect(error.backendError.detail).toBeUndefined();
    expect(error.message).not.toContain("<html");
  });

  test("keeps a safe SQL diagnostic in a JSON envelope unchanged", async () => {
    const error = await backendResponseError(new Response(JSON.stringify(envelope), { status: 400 }));
    expect(error.backendError.detail).toBe("Incorrect syntax near SELECT");
  });

  test.each([
    ["JDBC plugin upload", () => installJdbcPluginLocal(new File(["plugin"], "plugin.zip"))],
    ["Agent driver upload", () => importAgentDriver("postgres", new File(["driver"], "driver.zip"))],
  ])("normalizes %s multipart failures through the nested backend envelope", async (_name, upload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: envelope }), { status: 400 })));

    const error = await upload().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BackendErrorException);
    expect(error).toMatchObject({
      backendError: expect.objectContaining({ code: envelope.code, detail: envelope.detail }),
    });

    vi.unstubAllGlobals();
  });

  test.each([
    ["JDBC plugin upload", () => installJdbcPluginLocal(new File(["plugin"], "plugin.zip"))],
    ["Agent driver upload", () => importAgentDriver("postgres", new File(["driver"], "driver.zip"))],
  ])("normalizes %s multipart failures through the direct backend envelope", async (_name, upload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 400 })));

    const error = await upload().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BackendErrorException);
    expect(error).toMatchObject({
      backendError: expect.objectContaining({ code: envelope.code, detail: envelope.detail }),
    });

    vi.unstubAllGlobals();
  });
});
