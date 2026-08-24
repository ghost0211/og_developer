import { describe, expect, it } from "vitest";
import { createToolPanelSession, setToolPanelOpen, toggleToolPanelSession, type ToolPanelState } from "@/lib/app/toolPanelState";

const closed = (): ToolPanelState => ({ ai: false, history: false, sqlLibrary: false, sqlFile: false });

describe("toolPanelState", () => {
  it("opens and activates a tool without closing other open tools", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "sqlFile", true);
    session = setToolPanelOpen(session, "ai", true);
    expect(session.open).toMatchObject({ sqlFile: true, ai: true });
    expect(session.active).toBe("ai");
  });

  it("switches to an already-open background tool", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "sqlFile", true);
    session = setToolPanelOpen(session, "ai", true);
    const next = toggleToolPanelSession(session, "sqlFile");
    expect(next.open).toMatchObject({ sqlFile: true, ai: true });
    expect(next.active).toBe("sqlFile");
  });

  it("closes the active tool and returns to the most recently active open tool", () => {
    let session = setToolPanelOpen(createToolPanelSession(closed()), "ai", true);
    session = setToolPanelOpen(session, "history", true);
    session = toggleToolPanelSession(session, "ai");
    session = toggleToolPanelSession(session, "ai");
    expect(session.open.ai).toBe(false);
    expect(session.active).toBe("history");
  });

  it("keeps connections selected on startup when no active tool was persisted", () => {
    const open = { ...closed(), ai: true };
    expect(createToolPanelSession(open, null, [], false).active).toBeNull();
  });

  it("restores a valid persisted active tool and ignores stale values", () => {
    const open = { ...closed(), ai: true, history: true };
    expect(createToolPanelSession(open, "history", ["ai", "history"]).active).toBe("history");
    expect(createToolPanelSession(open, "missing", ["history", "ai"]).active).toBe("ai");
  });
});
