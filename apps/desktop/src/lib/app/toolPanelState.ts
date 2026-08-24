export const TOOL_PANEL_IDS = ["ai", "history", "sqlLibrary", "sqlFile"] as const;
export type ToolPanelId = (typeof TOOL_PANEL_IDS)[number];
export type ToolPanelState = Record<ToolPanelId, boolean>;

export interface ToolPanelSession {
  open: ToolPanelState;
  active: ToolPanelId | null;
  activationOrder: ToolPanelId[];
}

function normalizeOrder(open: ToolPanelState, order: readonly string[]): ToolPanelId[] {
  const result: ToolPanelId[] = [];
  for (const candidate of order) {
    if (!TOOL_PANEL_IDS.includes(candidate as ToolPanelId)) continue;
    const panelId = candidate as ToolPanelId;
    if (open[panelId] && !result.includes(panelId)) result.push(panelId);
  }
  for (const panelId of TOOL_PANEL_IDS) {
    if (open[panelId] && !result.includes(panelId)) result.push(panelId);
  }
  return result;
}

export function createToolPanelSession(open: ToolPanelState, storedActive?: string | null, storedOrder: readonly string[] = [], selectFallback = true): ToolPanelSession {
  const activationOrder = normalizeOrder(open, storedOrder);
  const active = storedActive && TOOL_PANEL_IDS.includes(storedActive as ToolPanelId) && open[storedActive as ToolPanelId] ? (storedActive as ToolPanelId) : selectFallback ? (activationOrder[activationOrder.length - 1] ?? null) : null;
  if (active) {
    const index = activationOrder.indexOf(active);
    if (index >= 0) activationOrder.splice(index, 1);
    activationOrder.push(active);
  }
  return { open: { ...open }, active, activationOrder };
}

export function setToolPanelOpen(session: ToolPanelSession, panelId: ToolPanelId, open: boolean): ToolPanelSession {
  const nextOpen = { ...session.open, [panelId]: open };
  const activationOrder = session.activationOrder.filter((candidate) => candidate !== panelId && nextOpen[candidate]);
  if (open) activationOrder.push(panelId);
  const active = open ? panelId : session.active === panelId ? (activationOrder[activationOrder.length - 1] ?? null) : session.active;
  return { open: nextOpen, active, activationOrder };
}

export function toggleToolPanelSession(session: ToolPanelSession, panelId: ToolPanelId): ToolPanelSession {
  if (session.open[panelId] && session.active !== panelId) return setToolPanelOpen(session, panelId, true);
  return setToolPanelOpen(session, panelId, !session.open[panelId]);
}
