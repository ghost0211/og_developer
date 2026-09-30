import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Web-route coverage guard.
 *
 * The web backend (ogdeveloper-web) once lacked the whole /api/agents/* group:
 * the connection dialog calls those endpoints before testing/saving, so web
 * mode failed with a bare "Backend request failed" (empty 405 body) while
 * desktop worked. This test statically aligns every static API path the web
 * HTTP client can call with the routes registered in the axum main router.
 */

const httpSource = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
const gitHttpSource = readFileSync(new URL("../git-http.ts", import.meta.url), "utf8");
const mainRsSource = readFileSync(new URL("../../../../../../crates/ogdeveloper-web/src/main.rs", import.meta.url), "utf8");

/** Static (or single-template-param) API literals referenced by the web client. */
function extractClientPaths(source: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    // get/post/put/del("/api/...") or apiUrl("/api/...")
    /(?:get|post|put|del|apiUrl)\(\s*`(\/api\/[^`]+)`/g,
    /(?:get|post|put|del|apiUrl)\(\s*"(\/api\/[^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

/** Registered axum routes, normalized to `{param}` segments. */
function extractServerRoutes(source: string): Set<string> {
  const routes = new Set<string>();
  for (const match of source.matchAll(/\.route\(\s*"([^"]+)"/g)) {
    routes.add(match[1].replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}"));
  }
  return routes;
}

/** Convert a client path template to the `{param}` form axum uses. */
function normalizeClientPath(path: string): string {
  // Cut the query string first: templates like `/api/schema/tables?${qs({...})}`
  // capture raw JS expressions up to the closing backtick.
  const withoutQuery = path.split("?", 1)[0];
  return withoutQuery.replace(/\$\{[^}]+\}/g, "{}");
}

function pathCovered(clientPath: string, serverRoutes: Set<string>): boolean {
  const normalized = normalizeClientPath(clientPath).replace(/^\/api/, "");
  // `/api/update/check${query}` style: a trailing template param may be the
  // query string glued without a literal '?'.
  const candidates = [normalized];
  if (normalized.endsWith("{}")) candidates.push(normalized.slice(0, -2));
  for (const candidate of candidates) {
    if (serverRoutes.has(candidate)) return true;
    // Fall back to a segment-wise wildcard comparison for `{param}` segments.
    const clientSegments = candidate.split("/");
    for (const route of serverRoutes) {
      const routeSegments = route.split("/");
      if (routeSegments.length !== clientSegments.length) continue;
      const matches = routeSegments.every((segment, index) => {
        const isParam = segment.startsWith("{") && segment.endsWith("}");
        return isParam || segment === clientSegments[index] || clientSegments[index] === "{}";
      });
      if (matches) return true;
    }
  }
  return false;
}

describe("web API route coverage", () => {
  it("registers all Codex account authorization routes", () => {
    const routes = extractServerRoutes(mainRsSource);
    for (const action of ["begin", "poll", "cancel", "status", "disconnect"]) {
      expect(routes.has(`/ai/codex-auth/${action}`)).toBe(true);
    }
  });
  it("reports the full gap list (kept informative on failure)", () => {
    const serverRoutes = extractServerRoutes(mainRsSource);
    expect(serverRoutes.size).toBeGreaterThan(50);
    const clientPaths = [...extractClientPaths(httpSource), ...extractClientPaths(gitHttpSource)];
    expect(clientPaths.length).toBeGreaterThan(50);
    const missing = clientPaths.filter((path) => !pathCovered(path, serverRoutes)).sort();
    // The agents/* group must be covered (regression for this bug).
    expect(missing.filter((path) => path.startsWith("/api/agents"))).toEqual([]);
    // Any other gap is a desktop-only feature (allowlisted below after audit).
    expect(missing).toEqual([]);
  });
});
