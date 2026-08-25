import { describe, expect, it } from "vitest";

import { mergeDebugSnapshot } from "@/lib/debug/debugSnapshot";

describe("mergeDebugSnapshot", () => {
  it("retains the last visible values when a finished frame disappears", () => {
    const current = [{ name: "answer", value: "42" }];

    expect(mergeDebugSnapshot(current, [], "finished")).toBe(current);
    expect(mergeDebugSnapshot(current, [], "stopped")).toBe(current);
  });

  it("applies an empty snapshot while execution is still active", () => {
    const current = [{ name: "stale", value: "1" }];

    expect(mergeDebugSnapshot(current, [], "running")).toEqual([]);
  });

  it("always applies a non-empty terminal snapshot", () => {
    const current = [{ name: "old", value: "1" }];
    const next = [{ name: "new", value: "2" }];

    expect(mergeDebugSnapshot(current, next, "finished")).toBe(next);
  });
});
