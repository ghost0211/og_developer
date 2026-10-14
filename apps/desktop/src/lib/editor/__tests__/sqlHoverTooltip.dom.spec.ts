// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { activateHover, EditorView, hasHoverTooltips, hoverTooltip, tooltips, type Tooltip } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlHoverController, createSqlHoverDom, type SqlHoverController } from "../sqlHoverTooltip";

describe("SQL Editor Hover Tooltip runtime & DOM lifecycle", () => {
  let hostElement: HTMLElement;
  let editorParent: HTMLElement;
  let view: EditorView | null = null;
  let controller: SqlHoverController | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="root">
        <div data-app>
          <div id="editor-container"></div>
        </div>
        <div id="ogdeveloper-query-editor-tooltip-root"></div>
      </div>
    `;
    hostElement = document.getElementById("ogdeveloper-query-editor-tooltip-root")!;
    editorParent = document.getElementById("editor-container")!;
  });

  afterEach(() => {
    controller?.destroy(view ?? undefined);
    view?.destroy();
    view = null;
    controller = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function setupEditor(doc = "SELECT * FROM users WHERE id = 1;") {
    controller = createSqlHoverController({
      editorId: "test-editor-1",
      getTooltipHost: () => hostElement,
      dismissDelayMs: 100,
    });

    view = new EditorView({
      parent: editorParent,
      state: EditorState.create({
        doc,
        extensions: [tooltips({ parent: hostElement })],
      }),
    });

    return { controller, view };
  }

  it("creates hover DOM preserving text selection, scrolling, and ownership metadata", () => {
    const dom = createSqlHoverDom({
      title: "users",
      detail: "table",
      sqlContent: "CREATE TABLE users (\n  id bigint PRIMARY KEY,\n  name text\n);",
      rows: ["Rows: 1000", "Engine: InnoDB"],
      editorId: "editor-abc",
    });

    expect(dom.dataset.queryEditorHoverTooltip).toBe("true");
    expect(dom.dataset.queryEditorId).toBe("editor-abc");
    expect(dom.className).toContain("select-text");
    expect(dom.style.pointerEvents).toBe("auto");

    const sqlContainer = dom.querySelector(".overflow-y-auto") as HTMLElement;
    expect(sqlContainer).not.toBeNull();
    expect(sqlContainer.textContent).toContain("CREATE TABLE users");
    expect(sqlContainer.className).toContain("select-text");
    expect(sqlContainer.style.pointerEvents).toBe("auto");

    const rows = dom.querySelectorAll(".font-mono");
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("cancels async hover request when superseded or cancelled before resolution (async hover race)", async () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 }; // 'users'

    const req1 = controller.beginRequest(range.from, range);
    expect(controller.isValid(req1, view, range)).toBe(true);

    // User moves mouse or triggers another request while DDL request is in-flight
    controller.cancelPending("user_moved");
    // Cancellation alone must invalidate it, even if no second hover starts.
    expect(controller.isValid(req1, view, range)).toBe(false);

    // Later the network promise resolves, but controller detects cancellation
    const req2 = controller.beginRequest(25, { from: 25, to: 30 });
    expect(controller.isValid(req1, view, range)).toBe(false);
    expect(controller.isValid(req2, view, { from: 25, to: 30 })).toBe(true);
  });

  it("cancels in-flight hover request early when pointer moves away during async load", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 }; // 'users'

    // Mock posAtCoords on view
    view.posAtCoords = vi.fn().mockImplementation((coords: { x: number; y: number }) => {
      // coords x=50, y=50 maps to pos 30 (outside range 14-19)
      if (coords.x === 50 && coords.y === 50) return 30;
      return 15;
    });

    const req = controller.beginRequest(15, range);
    controller.updatePointerPosition({ x: 50, y: 50 });

    // When isValid is checked upon async DDL arrival
    expect(controller.isValid(req, view, range)).toBe(false);
  });

  it("handles mouseleave on large tooltip overlay and dismisses after delay", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 };

    const dom = createSqlHoverDom({
      title: "users",
      detail: "table",
      sqlContent: "CREATE TABLE users (id int);",
      editorId: controller.editorId,
    });
    hostElement.appendChild(dom);

    const tooltipView = controller.attachTooltipView(view, dom, range);
    tooltipView.mount?.(view);
    expect(controller.hasActiveTooltip()).toBe(true);

    // Mouse leaves the large tooltip to an outside element (e.g. editor tab bar)
    const outsideTabBar = document.createElement("div");
    document.body.appendChild(outsideTabBar);

    dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: outsideTabBar }));

    // Still active during delay window (50ms)
    vi.advanceTimersByTime(50);
    expect(controller.hasActiveTooltip()).toBe(true);

    // Dismissed after delay window (100ms)
    vi.advanceTimersByTime(60);
    expect(controller.hasActiveTooltip()).toBe(false);
  });

  it("keeps tooltip visible while pointer interacts inside the tooltip, and dismisses when pointer moves away", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 };

    const dom = createSqlHoverDom({
      title: "users",
      detail: "table",
      sqlContent: "CREATE TABLE users (id int);",
      editorId: controller.editorId,
    });
    hostElement.appendChild(dom);

    const tooltipView = controller.attachTooltipView(view, dom, range);
    tooltipView.mount?.(view);

    expect(controller.hasActiveTooltip()).toBe(true);

    // Pointer moves inside the tooltip (e.g. user selecting SQL text)
    const sqlText = dom.querySelector(".overflow-y-auto")!;
    const eventInsideTooltip = new MouseEvent("pointermove", { clientX: 200, clientY: 200, bubbles: true });
    Object.defineProperty(eventInsideTooltip, "target", { value: sqlText });
    document.dispatchEvent(eventInsideTooltip);

    vi.advanceTimersByTime(200);
    // Tooltip must remain visible
    expect(controller.hasActiveTooltip()).toBe(true);

    // Pointer moves away to an unrelated UI element outside both editor and tooltip
    const outsideEl = document.createElement("button");
    document.body.appendChild(outsideEl);
    const eventOutside = new MouseEvent("pointermove", { clientX: 50, clientY: 50, bubbles: true });
    Object.defineProperty(eventOutside, "target", { value: outsideEl });
    document.dispatchEvent(eventOutside);

    // Within delay (50ms < 100ms), tooltip still active
    vi.advanceTimersByTime(50);
    expect(controller.hasActiveTooltip()).toBe(true);

    // After delay elapsed (100ms), tooltip is dismissed
    vi.advanceTimersByTime(60);
    expect(controller.hasActiveTooltip()).toBe(false);
  });

  it("immediately dismisses tooltip on window blur or document mouseleave", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 };

    const dom = createSqlHoverDom({ title: "users", detail: "table", editorId: controller.editorId });
    hostElement.appendChild(dom);

    const tooltipView = controller.attachTooltipView(view, dom, range);
    tooltipView.mount?.(view);
    expect(controller.hasActiveTooltip()).toBe(true);

    // Window loses focus (e.g. user Alt+Tabbed or clicked another window)
    window.dispatchEvent(new Event("blur"));
    expect(controller.hasActiveTooltip()).toBe(false);

    // Re-mount and test document mouseleave (pointer leaves browser window)
    const dom2 = createSqlHoverDom({ title: "orders", detail: "table", editorId: controller.editorId });
    hostElement.appendChild(dom2);
    const tooltipView2 = controller.attachTooltipView(view, dom2, range);
    tooltipView2.mount?.(view);
    expect(controller.hasActiveTooltip()).toBe(true);

    document.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: null }));
    expect(controller.hasActiveTooltip()).toBe(false);
  });

  it("immediately dismisses tooltip on Escape key and editor scroll", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 };

    const dom = createSqlHoverDom({ title: "users", detail: "table", editorId: controller.editorId });
    hostElement.appendChild(dom);

    const tooltipView = controller.attachTooltipView(view, dom, range);
    tooltipView.mount?.(view);
    expect(controller.hasActiveTooltip()).toBe(true);

    // Press Escape
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(controller.hasActiveTooltip()).toBe(false);

    // Re-mount and test editor scroll
    const dom2 = createSqlHoverDom({ title: "users", detail: "table", editorId: controller.editorId });
    hostElement.appendChild(dom2);
    const tooltipView2 = controller.attachTooltipView(view, dom2, range);
    tooltipView2.mount?.(view);
    expect(controller.hasActiveTooltip()).toBe(true);

    view.scrollDOM.dispatchEvent(new Event("scroll"));
    expect(controller.hasActiveTooltip()).toBe(false);
  });

  it("cleans up active tooltips and orphaned host DOM on KeepAlive deactivation (pause)", () => {
    let isActive = true;
    const testController = createSqlHoverController({
      editorId: "editor-keepalive-test",
      isActive: () => isActive,
      getTooltipHost: () => hostElement,
    });

    view = new EditorView({
      parent: editorParent,
      state: EditorState.create({
        doc: "SELECT * FROM users;",
        extensions: [tooltips({ parent: hostElement })],
      }),
    });

    const cmTooltipContainer = document.createElement("div");
    cmTooltipContainer.className = "cm-tooltip";
    const dom = createSqlHoverDom({ title: "users", detail: "table", editorId: "editor-keepalive-test" });
    cmTooltipContainer.appendChild(dom);
    hostElement.appendChild(cmTooltipContainer);

    expect(hostElement.contains(dom)).toBe(true);

    const req = testController.beginRequest(14, { from: 14, to: 19 });
    expect(testController.isValid(req, view, { from: 14, to: 19 })).toBe(true);

    // Tab is deactivated (KeepAlive pause)
    isActive = false;
    testController.pause(view);

    // Pending requests become invalid
    expect(testController.isValid(req, view, { from: 14, to: 19 })).toBe(false);
    // Residual DOM is cleaned up from global host
    expect(hostElement.contains(dom)).toBe(false);
    expect(hostElement.contains(cmTooltipContainer)).toBe(false);

    // When reactivated
    isActive = true;
    testController.resume();
    const reqAfterResume = testController.beginRequest(14, { from: 14, to: 19 });
    expect(testController.isValid(reqAfterResume, view, { from: 14, to: 19 })).toBe(true);
  });

  it("cleans up ONLY owned DDL hover DOM, without touching other editors or function signature tooltips", () => {
    const { controller, view } = setupEditor();

    // 1. Owned DDL tooltip
    const ownedCmTooltip = document.createElement("div");
    ownedCmTooltip.className = "cm-tooltip";
    const ownedDdlDom = createSqlHoverDom({ title: "users", detail: "table", editorId: controller.editorId });
    ownedCmTooltip.appendChild(ownedDdlDom);
    hostElement.appendChild(ownedCmTooltip);

    // 2. Function signature tooltip (no queryEditorHoverTooltip attribute)
    const signatureCmTooltip = document.createElement("div");
    signatureCmTooltip.className = "cm-tooltip";
    const signatureDom = document.createElement("div");
    signatureDom.className = "cm-signature-tooltip";
    signatureDom.textContent = "count(expression)";
    signatureCmTooltip.appendChild(signatureDom);
    hostElement.appendChild(signatureCmTooltip);

    // 3. Other editor's DDL tooltip
    const otherEditorCmTooltip = document.createElement("div");
    otherEditorCmTooltip.className = "cm-tooltip";
    const otherDdlDom = createSqlHoverDom({ title: "orders", detail: "table", editorId: "other-editor-999" });
    otherEditorCmTooltip.appendChild(otherDdlDom);
    hostElement.appendChild(otherEditorCmTooltip);

    expect(hostElement.children).toHaveLength(3);

    // Destroy current editor
    controller.destroy(view);

    // Owned DDL tooltip is removed
    expect(hostElement.contains(ownedCmTooltip)).toBe(false);
    expect(hostElement.contains(ownedDdlDom)).toBe(false);

    // Signature tooltip and other editor tooltip remain completely untouched
    expect(hostElement.contains(signatureCmTooltip)).toBe(true);
    expect(hostElement.contains(signatureDom)).toBe(true);
    expect(hostElement.contains(otherEditorCmTooltip)).toBe(true);
    expect(hostElement.contains(otherDdlDom)).toBe(true);
  });

  it("preserves interaction inside large tooltip overlay (scrolling, selecting, clicking)", () => {
    const { controller, view } = setupEditor();
    const range = { from: 14, to: 19 };

    const dom = createSqlHoverDom({
      title: "large_table",
      detail: "table",
      sqlContent: "CREATE TABLE large_table (\n" + Array.from({ length: 50 }, (_, i) => `  col_${i} varchar(255)`).join(",\n") + "\n);",
      editorId: controller.editorId,
    });
    hostElement.appendChild(dom);

    const tooltipView = controller.attachTooltipView(view, dom, range);
    tooltipView.mount?.(view);

    const sqlContainer = dom.querySelector(".overflow-y-auto") as HTMLElement;
    expect(sqlContainer).not.toBeNull();

    // Wheel event inside the scrollable container should be naturally accepted
    const wheelEvent = new WheelEvent("wheel", { deltaY: 100, bubbles: true });
    sqlContainer.dispatchEvent(wheelEvent);
    expect(controller.hasActiveTooltip()).toBe(true);

    // Mousedown and selection inside tooltip must be recognized as in-tooltip
    const mousedownEvent = new MouseEvent("mousedown", { clientX: 100, clientY: 100, bubbles: true });
    sqlContainer.dispatchEvent(mousedownEvent);
    expect(controller.isInActiveTooltip(sqlContainer)).toBe(true);
    expect(controller.hasActiveTooltip()).toBe(true);
  });

  async function flushHover() {
    // Source and the real CodeMirror HoverPlugin each await the async result.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function setupAsyncHover() {
    const range = { from: 14, to: 19 };
    let resolve!: (value: Tooltip) => void;
    const ddl = new Promise<Tooltip>((done) => {
      resolve = done;
    });
    controller = createSqlHoverController({ editorId: "runtime-editor", getTooltipHost: () => hostElement, dismissDelayMs: 100 });
    const owner = controller;
    const source = vi.fn((currentView: EditorView, pos: number) => {
      owner.beginRequest(pos, range, currentView);
      return ddl;
    });
    view = new EditorView({
      parent: editorParent,
      state: EditorState.create({ doc: "SELECT * FROM users;", extensions: [tooltips({ parent: hostElement }), ...owner.createExtension(hoverTooltip, source)] }),
    });
    view.posAtCoords = vi.fn().mockReturnValue(15);
    const currentView = view;
    const finish = async () => {
      resolve({ pos: range.from, end: range.to, create: (editor) => owner.attachTooltipView(editor, createSqlHoverDom({ title: "users", detail: "table", sqlContent: "CREATE TABLE users (id int);" }), range) });
      await flushHover();
    };
    return { owner, currentView, source, finish };
  }

  it("uses the real CodeMirror hover extension and does not start requests while deactivated", async () => {
    const { owner, currentView, source } = setupAsyncHover();
    owner.pause(currentView);
    activateHover(currentView, 15, 1);
    await flushHover();
    expect(source).not.toHaveBeenCalled();
    expect(hasHoverTooltips(currentView.state)).toBe(false);
  });

  it.each(["mouseleave", "blur", "pause-resume", "unmount", "view-destroy", "doc-change"] as const)("rejects a late DDL result after %s without another hover request", async (action) => {
    const { owner, currentView, source, finish } = setupAsyncHover();
    activateHover(currentView, 15, 1);
    expect(source).toHaveBeenCalledTimes(1);
    if (action === "mouseleave") currentView.dom.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: document.body }));
    if (action === "blur") window.dispatchEvent(new Event("blur"));
    if (action === "pause-resume") {
      owner.pause(currentView);
      owner.resume();
    }
    if (action === "unmount") owner.destroy(currentView);
    if (action === "view-destroy") currentView.destroy();
    if (action === "doc-change") currentView.dispatch({ changes: { from: 0, insert: "-- changed\n" } });
    await finish();
    expect(hasHoverTooltips(currentView.state)).toBe(false);
    expect(hostElement.querySelector('[data-query-editor-hover-tooltip="true"]')).toBeNull();
  });

  it("removes real portaled hover DOM on pointer leave, not just controller state", async () => {
    const { owner, currentView, finish } = setupAsyncHover();
    activateHover(currentView, 15, 1);
    await finish();
    expect(hasHoverTooltips(currentView.state)).toBe(true);
    expect(owner.hasActiveTooltip()).toBe(true);
    const sql = hostElement.querySelector<HTMLElement>(".overflow-y-auto")!;
    sql.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
    sql.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 20 }));
    vi.advanceTimersByTime(110);
    expect(hasHoverTooltips(currentView.state)).toBe(true);
    document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 500, clientY: 500 }));
    vi.advanceTimersByTime(110);
    expect(hasHoverTooltips(currentView.state)).toBe(false);
    expect(owner.hasActiveTooltip()).toBe(false);
    expect(hostElement.querySelector('[data-query-editor-hover-tooltip="true"]')).toBeNull();
  });

  it.each(["pause", "destroy"] as const)("removes a mounted portaled tooltip on %s", async (action) => {
    const { owner, currentView, finish } = setupAsyncHover();
    activateHover(currentView, 15, 1);
    await finish();
    expect(hasHoverTooltips(currentView.state)).toBe(true);
    if (action === "pause") {
      // Vue KeepAlive moves the editor into a detached storage container first.
      document.createElement("div").appendChild(editorParent);
    }
    owner[action](currentView);
    expect(hasHoverTooltips(currentView.state)).toBe(false);
    expect(hostElement.querySelector('[data-query-editor-hover-tooltip="true"]')).toBeNull();
  });
});
