import { describe, expect, it } from "vitest";
import { createToolPanelSession, setToolPanelOpen, toggleToolPanelSession, type ToolPanelState } from "@/lib/app/toolPanelState";

const closed = (): ToolPanelState => ({ ai: false, history: false, sqlLibrary: false, sqlFile: false });

describe("toolPanelState", () => {
  it("opens an entry and makes it active", () => {
    const next = toggleToolPanelSession(createToolPanelSession(closed()), "sqlFile");
    expect(next.open.sqlFile).toBe(true);
    expect(next.active).toBe("sqlFile");
  });

  it("switches to an already-open background entry without closing others", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "sqlFile", true);
    session = setToolPanelOpen(session, "ai", true);
    const next = toggleToolPanelSession(session, "sqlFile");
    expect(next.open).toMatchObject({ sqlFile: true, ai: true });
    expect(next.active).toBe("sqlFile");
  });

  it("closes the active entry and returns to the most recently active open entry", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "ai", true);
    session = setToolPanelOpen(session, "sqlFile", true);
    session = setToolPanelOpen(session, "history", true);
    session = toggleToolPanelSession(session, "sqlFile");
    session = toggleToolPanelSession(session, "sqlFile");
    expect(session.open.sqlFile).toBe(false);
    expect(session.active).toBe("history");
  });

  it("uses a valid persisted active entry and tolerates stale values", () => {
    const open = { ...closed(), ai: true, history: true };
    expect(createToolPanelSession(open, "history", ["history", "ai"]).active).toBe("history");
    expect(createToolPanelSession(open, "missing", ["history", "ai"]).active).toBe("ai");
  });

  it("returns null after the final entry closes", () => {
    const opened = setToolPanelOpen(createToolPanelSession(closed()), "ai", true);
    const next = toggleToolPanelSession(opened, "ai");
    expect(next.active).toBeNull();
    expect(next.open.ai).toBe(false);
  });
});
