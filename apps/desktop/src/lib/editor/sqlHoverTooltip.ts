import type { Extension, Text } from "@codemirror/state";
import { EditorView, ViewPlugin, closeHoverTooltips, hoverTooltip, tooltips, type Tooltip, type TooltipView } from "@codemirror/view";

export const SQL_HOVER_TOOLTIP_MAX_WIDTH = "min(760px, calc(100vw - 24px))";
export const SQL_DIAGNOSTIC_TOOLTIP_MAX_WIDTH = "min(448px, calc(100vw - 24px))";

export function computeSqlTooltipSpace(view: EditorView): { top: number; left: number; bottom: number; right: number } {
  const docElt = view.dom.ownerDocument.documentElement;
  const clientWidth = docElt.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0);
  const clientHeight = docElt.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 0);
  if (clientWidth <= 0 || clientHeight <= 0) {
    return { top: 0, left: 0, bottom: clientHeight, right: clientWidth };
  }
  const marginX = Math.min(12, Math.floor(clientWidth / 8));
  const marginY = Math.min(12, Math.floor(clientHeight / 8));
  return {
    top: marginY,
    left: marginX,
    bottom: Math.max(marginY, clientHeight - marginY),
    right: Math.max(marginX, clientWidth - marginX),
  };
}

interface HoverRange {
  from: number;
  to: number;
}

export interface SqlHoverDomOptions {
  title: string;
  detail: string;
  sqlContent?: string;
  rows?: string[];
  isDark?: boolean;
  highlighter?: (sql: string, mode: "dark" | "light") => string;
  editorId?: string;
}

export interface SqlHoverControllerOptions {
  editorId?: string;
  isActive?: () => boolean;
  getTooltipHost?: () => HTMLElement | null;
  dismissDelayMs?: number;
}

/** An interactive, owned hover section, portaled outside the editor by CodeMirror. */
export function createSqlHoverDom(options: SqlHoverDomOptions): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "max-w-[min(760px,calc(100vw-24px))] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md select-text";
  dom.dataset.queryEditorHoverTooltip = "true";
  if (options.editorId) dom.dataset.queryEditorId = options.editorId;
  dom.style.pointerEvents = "auto";
  dom.style.maxWidth = SQL_HOVER_TOOLTIP_MAX_WIDTH;
  dom.style.boxSizing = "border-box";

  const heading = document.createElement("div");
  heading.className = "font-medium select-text break-words";
  heading.textContent = options.title;
  dom.appendChild(heading);

  const detail = document.createElement("div");
  detail.className = "mt-1 text-muted-foreground select-text break-words";
  detail.textContent = options.detail;
  dom.appendChild(detail);

  if (options.sqlContent) {
    const separator = document.createElement("div");
    separator.className = "mt-2 border-t border-border/60";
    dom.appendChild(separator);

    const sql = document.createElement("div");
    sql.className = "mt-1.5 max-h-64 max-w-full overflow-x-auto overflow-y-auto text-[11px] leading-5 whitespace-pre font-mono select-text cursor-text";
    sql.style.pointerEvents = "auto";
    if (options.highlighter) {
      sql.innerHTML = options.highlighter(options.sqlContent, options.isDark ? "dark" : "light");
    } else {
      sql.className += " text-muted-foreground";
      sql.textContent = options.sqlContent;
    }
    dom.appendChild(sql);
  }

  for (const row of options.rows ?? []) {
    const rowNode = document.createElement("div");
    rowNode.className = "mt-1 font-mono text-muted-foreground select-text break-words";
    rowNode.textContent = row;
    dom.appendChild(rowNode);
  }
  return dom;
}

export interface SqlDiagnosticHoverAction {
  label: string;
  primary?: boolean;
  onSelect: () => void;
}

export interface SqlDiagnosticHoverDomOptions {
  title: string;
  message: string;
  severity?: "error" | "warning";
  actions?: SqlDiagnosticHoverAction[];
  editorId?: string;
}

/** Interactive hover card for SQL syntax/semantic diagnostics with optional one-click quick-fix actions. */
export function createSqlDiagnosticHoverDom(options: SqlDiagnosticHoverDomOptions): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "max-w-[min(448px,calc(100vw-24px))] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md select-text";
  dom.dataset.queryEditorHoverTooltip = "true";
  dom.dataset.queryEditorDiagnosticTooltip = "true";
  if (options.editorId) dom.dataset.queryEditorId = options.editorId;
  dom.style.pointerEvents = "auto";
  dom.style.maxWidth = SQL_DIAGNOSTIC_TOOLTIP_MAX_WIDTH;
  dom.style.boxSizing = "border-box";

  const isWarning = options.severity === "warning";
  const heading = document.createElement("div");
  heading.className = `flex items-center gap-1.5 font-medium select-text ${isWarning ? "text-amber-500" : "text-destructive"}`;
  const dot = document.createElement("span");
  dot.className = `inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isWarning ? "bg-amber-500" : "bg-destructive"}`;
  heading.appendChild(dot);
  const titleSpan = document.createElement("span");
  titleSpan.textContent = options.title;
  heading.appendChild(titleSpan);
  dom.appendChild(heading);

  const detail = document.createElement("div");
  detail.className = "mt-1 leading-relaxed text-foreground/90 select-text whitespace-pre-wrap";
  detail.textContent = options.message;
  dom.appendChild(detail);

  if (options.actions && options.actions.length > 0) {
    const actionsBar = document.createElement("div");
    actionsBar.className = "mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2";
    for (const action of options.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.diagnosticQuickFix = "true";
      button.className = action.primary
        ? "inline-flex items-center rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer"
        : "inline-flex items-center rounded border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted cursor-pointer";
      button.textContent = action.label;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onSelect();
      });
      actionsBar.appendChild(button);
    }
    dom.appendChild(actionsBar);
  }

  return dom;
}

/** Cancels stale asynchronous hovers and owns listeners/DOM for one editor only. */
export class SqlHoverController {
  readonly editorId: string;
  private requestId = 0;
  private requestDoc: Text | undefined;
  private pendingRange: HoverRange | null = null;
  private activeTooltip: { dom: HTMLElement; view: EditorView; range: HoverRange } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private hoverAllowed = true;
  private paused = false;
  private destroyed = false;
  private viewDestroyed = false;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private listenersCleanup: (() => void) | null = null;

  constructor(private readonly options: SqlHoverControllerOptions = {}) {
    this.editorId = options.editorId ?? `query-editor-${Math.random().toString(36).slice(2, 9)}`;
  }

  isActive(): boolean {
    return !this.destroyed && !this.paused && (this.options.isActive?.() ?? true);
  }

  beginRequest(_pos: number, range?: HoverRange, view?: EditorView): number {
    this.requestId++;
    this.pendingRange = range ?? null;
    this.requestDoc = view?.state.doc;
    this.clearDismissTimer();
    // Blur/window-leave must cancel the request even before a tooltip mounts.
    if (view) this.attachListeners(view);
    return this.requestId;
  }

  cancelPending(_reason?: string): void {
    this.requestId++;
    this.pendingRange = null;
    this.requestDoc = undefined;
    if (!this.activeTooltip) this.detachListeners();
  }

  updatePointerPosition(coords: { x: number; y: number } | null): void {
    this.pointer = coords;
    this.hoverAllowed = coords !== null;
  }

  hasActiveTooltip(): boolean {
    return this.activeTooltip !== null;
  }

  isInActiveTooltip(target: Node | null): boolean {
    return !!target && !!this.activeTooltip?.dom.contains(target);
  }

  private isOverRange(view: EditorView, range: HoverRange, coords: { x: number; y: number }): boolean {
    try {
      const pos = view.posAtCoords(coords);
      return pos !== null && pos >= range.from && pos <= range.to;
    } catch {
      return false;
    }
  }

  isValid(requestId: number, view?: EditorView, range?: HoverRange): boolean {
    if (requestId !== this.requestId || !this.isActive()) return false;
    if (view && (this.viewDestroyed || !view.dom.isConnected || (this.requestDoc && view.state.doc !== this.requestDoc))) return false;
    return !view || !range || !this.pointer || this.isOverRange(view, range, this.pointer);
  }

  attachTooltipView(view: EditorView, dom: HTMLElement, range: HoverRange): TooltipView {
    dom.dataset.queryEditorId = this.editorId;
    dom.dataset.queryEditorHoverTooltip = "true";
    const onLeave = (event: MouseEvent) => {
      if (this.isInActiveTooltip(event.relatedTarget as Node | null)) return;
      if (!event.relatedTarget) {
        this.dismiss(view);
      } else if (!view.dom.contains(event.relatedTarget as Node) || !this.isOverRange(view, range, { x: event.clientX, y: event.clientY })) {
        this.scheduleDismiss(view);
      }
    };
    return {
      dom,
      mount: (currentView) => {
        this.clearDismissTimer();
        this.pendingRange = null;
        this.requestDoc = undefined;
        this.activeTooltip = { dom, view: currentView, range };
        this.attachListeners(currentView);
        dom.addEventListener("mouseleave", onLeave);
      },
      destroy: () => {
        dom.removeEventListener("mouseleave", onLeave);
        // CodeMirror can mount a replacement before destroying the old section.
        if (this.activeTooltip?.dom === dom) {
          this.activeTooltip = null;
          this.clearDismissTimer();
          if (!this.pendingRange) this.detachListeners();
        }
      },
    };
  }

  private clearDismissTimer(): void {
    if (this.dismissTimer !== null) clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
  }

  private scheduleDismiss(view: EditorView): void {
    if (this.dismissTimer !== null) return;
    this.dismissTimer = setTimeout(
      () => {
        this.dismissTimer = null;
        this.dismiss(view);
      },
      Math.max(50, this.options.dismissDelayMs ?? 120),
    );
  }

  private attachListeners(view: EditorView): void {
    this.detachListeners();
    const onMove = (event: PointerEvent) => {
      const coords = { x: event.clientX, y: event.clientY };
      const target = event.target as Node | null;
      this.pointer = coords;
      if (this.isInActiveTooltip(target)) {
        this.clearDismissTimer();
      } else if (this.activeTooltip) {
        if (view.dom.contains(target) && this.isOverRange(view, this.activeTooltip.range, coords)) this.clearDismissTimer();
        else this.scheduleDismiss(view);
      } else if (this.pendingRange && (!view.dom.contains(target) || !this.isOverRange(view, this.pendingRange, coords))) {
        this.cancelPending();
      }
    };
    const onBlur = () => this.dismiss(view);
    const onWindowLeave = (event: MouseEvent) => {
      if (!event.relatedTarget) this.dismiss(view);
    };
    // domEventHandlers are attached to contentDOM, whereas CodeMirror's
    // native hover mouseleave listener watches the whole editor root.
    const onEditorLeave = (event: MouseEvent) => {
      if (!this.isInActiveTooltip(event.relatedTarget as Node | null)) {
        this.cancelPending();
        this.updatePointerPosition(null);
      }
    };
    const onScroll = () => this.dismiss(view);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.dismiss(view);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("mouseleave", onWindowLeave, true);
    window.addEventListener("blur", onBlur);
    view.dom.addEventListener("mouseleave", onEditorLeave);
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    this.listenersCleanup = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("mouseleave", onWindowLeave, true);
      window.removeEventListener("blur", onBlur);
      view.dom.removeEventListener("mouseleave", onEditorLeave);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }

  private detachListeners(): void {
    this.listenersCleanup?.();
    this.listenersCleanup = null;
  }

  dismiss(view?: EditorView | null): void {
    this.cancelPending();
    this.hoverAllowed = false;
    this.clearDismissTimer();
    this.detachListeners();
    const targetView = view ?? this.activeTooltip?.view;
    if (targetView && !this.viewDestroyed) {
      try {
        targetView.dispatch({ effects: closeHoverTooltips });
      } catch {
        this.cleanupHostTooltips();
      }
    }
    this.activeTooltip = null;
  }

  pause(view?: EditorView | null): void {
    this.paused = true;
    this.dismiss(view);
    this.cleanupHostTooltips();
  }

  resume(): void {
    this.paused = false;
    this.pointer = null;
  }

  cleanupHostTooltips(): void {
    const host = this.options.getTooltipHost?.();
    if (!host) return;
    for (const node of host.querySelectorAll<HTMLElement>('[data-query-editor-hover-tooltip="true"]')) {
      if (node.dataset.queryEditorId !== this.editorId) continue;
      const wrapper = node.closest(".cm-tooltip");
      if (wrapper && wrapper !== node && host.contains(wrapper) && wrapper.children.length === 1) wrapper.remove();
      else node.remove();
    }
  }

  destroy(view?: EditorView | null): void {
    this.destroyed = true;
    this.pause(view);
  }

  createExtension(hoverTooltipFn: typeof hoverTooltip, source: (view: EditorView, pos: number, side: -1 | 1) => Promise<Tooltip | null> | Tooltip | null, options?: { hoverTime?: number }): Extension[] {
    return [
      tooltips({ tooltipSpace: computeSqlTooltipSpace }),
      hoverTooltipFn(
        async (view, pos, side) => {
          if (!this.isActive() || !this.hoverAllowed) return null;
          const doc = view.state.doc;
          const pending = source(view, pos, side);
          const requestId = this.requestId;
          try {
            const tooltip = await pending;
            if (!this.isValid(requestId, view) || view.state.doc !== doc) return null;
            return tooltip;
          } finally {
            if (requestId === this.requestId && !this.activeTooltip) {
              this.pendingRange = null;
              this.requestDoc = undefined;
              this.detachListeners();
            }
          }
        },
        { hideOnChange: true, hoverTime: options?.hoverTime ?? 300 },
      ),
      EditorView.domEventHandlers({
        mousemove: (event, currentView) => {
          this.updatePointerPosition({ x: event.clientX, y: event.clientY });
          if (this.pendingRange && !this.isOverRange(currentView, this.pendingRange, this.pointer!)) this.cancelPending();
          return false;
        },
        mouseleave: (event) => {
          if (!this.isInActiveTooltip(event.relatedTarget as Node | null)) {
            this.cancelPending();
            this.updatePointerPosition(null);
          }
          return false;
        },
      }),
      // Use the public plugin lifecycle, not EditorView's private destroyed flag.
      ViewPlugin.define(() => ({
        destroy: () => {
          this.viewDestroyed = true;
          this.cancelPending();
          this.clearDismissTimer();
          this.detachListeners();
          this.activeTooltip = null;
          this.cleanupHostTooltips();
        },
      })),
    ];
  }
}

export function createSqlHoverController(options: SqlHoverControllerOptions = {}): SqlHoverController {
  return new SqlHoverController(options);
}
