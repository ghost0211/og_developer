import { describe, expect, it } from "vitest";
import { createToolPanelSession, setToolPanelOpen, toggleToolPanelSession, type ToolPanelState } from "@/lib/app/toolPanelState";

const closed = (): ToolPanelState => ({ ai: false, history: false, sqlLibrary: false, sqlFile: false, projectFile: false, git: false });

describe("toolPanelState", () => {
  it("opens one tool", () => {
    const next = setToolPanelOpen(createToolPanelSession(closed()), "sqlFile", true);
    expect(next.open).toEqual({ ...closed(), sqlFile: true });
    expect(next.active).toBe("sqlFile");
  });

  it("switches tools instead of keeping multiple tools open", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "sqlFile", true);
    session = setToolPanelOpen(session, "ai", true);
    expect(session.open).toEqual({ ...closed(), ai: true });
    expect(session.active).toBe("ai");
  });

  it("closes the active tool when its button is clicked again", () => {
    const opened = setToolPanelOpen(createToolPanelSession(closed()), "history", true);
    const next = toggleToolPanelSession(opened, "history");
    expect(next.open).toEqual(closed());
    expect(next.active).toBeNull();
  });

  it("normalizes legacy multi-open state to the persisted active tool", () => {
    const open = { ...closed(), ai: true, history: true };
    const restored = createToolPanelSession(open, "history");
    expect(restored.open).toEqual({ ...closed(), history: true });
    expect(restored.active).toBe("history");
  });

  it("falls back deterministically when the persisted active tool is stale", () => {
    const open = { ...closed(), ai: true, sqlFile: true };
    const restored = createToolPanelSession(open, "missing");
    expect(restored.open).toEqual({ ...closed(), ai: true });
    expect(restored.active).toBe("ai");
  });
});
