import { describe, expect, it } from "vitest";
import { apiUrl, apiWebSocketUrl, ogdeveloperWebBasePath, webPath } from "@/lib/common/webPath";

describe("webPath", () => {
  it("keeps root deployments on root-relative API paths", () => {
    expect(ogdeveloperWebBasePath("/", "/")).toBe("");
    expect(apiUrl("/api/auth/check", "")).toBe("/api/auth/check");
  });

  it("uses an explicit build base path", () => {
    expect(ogdeveloperWebBasePath("/", "/dbx/")).toBe("/dbx");
    expect(webPath("/login", "/dbx")).toBe("/dbx/login");
    expect(webPath("/", "/dbx")).toBe("/dbx/");
    expect(webPath("/icons/database/mysql.svg", "/dbx")).toBe("/dbx/icons/database/mysql.svg");
    expect(webPath("/icons/ai/openai.svg", "/dbx")).toBe("/dbx/icons/ai/openai.svg");
    expect(apiUrl("/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("/api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
    expect(apiUrl("api/auth/check", "/dbx")).toBe("/dbx/api/auth/check");
  });

  it("infers the runtime base path from the login URL for relative builds", () => {
    expect(ogdeveloperWebBasePath("/dbx/login", "./")).toBe("/dbx");
    expect(ogdeveloperWebBasePath("/tools/dbx/login", "./")).toBe("/tools/dbx");
  });

  it("infers the runtime base path from a mounted relative build", () => {
    expect(ogdeveloperWebBasePath("/dbx/", "./")).toBe("/dbx");
    expect(ogdeveloperWebBasePath("/tools/dbx/", "./")).toBe("/tools/dbx");
  });

  it("builds websocket URLs with the configured base path", () => {
    expect(apiWebSocketUrl("/redis/session/123", "/dbx", { protocol: "https:", host: "example.test" })).toBe("wss://example.test/dbx/api/redis/session/123");
  });
});
