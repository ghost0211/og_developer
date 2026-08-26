export const TOOL_PANEL_IDS = ["ai", "history", "sqlLibrary", "sqlFile", "projectFile", "git"] as const;
export type ToolPanelId = (typeof TOOL_PANEL_IDS)[number];
export type ToolPanelState = Record<ToolPanelId, boolean>;

export interface ToolPanelSession {
  open: ToolPanelState;
  active: ToolPanelId | null;
}

function closedToolPanels(): ToolPanelState {
  return { ai: false, history: false, sqlLibrary: false, sqlFile: false, projectFile: false, git: false };
}

export function createToolPanelSession(open: ToolPanelState, storedActive?: string | null): ToolPanelSession {
  const active = storedActive && TOOL_PANEL_IDS.includes(storedActive as ToolPanelId) && open[storedActive as ToolPanelId] ? (storedActive as ToolPanelId) : (TOOL_PANEL_IDS.find((panelId) => open[panelId]) ?? null);
  return { open: active ? { ...closedToolPanels(), [active]: true } : closedToolPanels(), active };
}

export function setToolPanelOpen(session: ToolPanelSession, panelId: ToolPanelId, open: boolean): ToolPanelSession {
  if (open) return { open: { ...closedToolPanels(), [panelId]: true }, active: panelId };
  if (session.active !== panelId) return session;
  return { open: closedToolPanels(), active: null };
}

export function toggleToolPanelSession(session: ToolPanelSession, panelId: ToolPanelId): ToolPanelSession {
  return setToolPanelOpen(session, panelId, session.active !== panelId);
}
