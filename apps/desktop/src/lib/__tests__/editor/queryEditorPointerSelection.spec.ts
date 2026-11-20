import { describe, expect, it } from "vitest";
import { canStartQueryEditorSelectionDrag, startsQueryEditorRectangularSelection, usesQueryEditorObjectNavigationModifier } from "@/lib/editor/queryEditorPointerSelection";

describe("query editor pointer selection", () => {
  it("allows selection drag only for unmodified primary single-clicks", () => {
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 0, detail: 1, shiftKey: false })).toBe(true);
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 0, detail: 0, shiftKey: false })).toBe(true);
  });

  it("does not intercept double-click, triple-click, modifier clicks, or non-primary buttons", () => {
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 0, detail: 2, shiftKey: false })).toBe(false);
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 0, detail: 3, shiftKey: false })).toBe(false);
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 0, detail: 1, shiftKey: true })).toBe(false);
    expect(canStartQueryEditorSelectionDrag({ altKey: true, button: 0, detail: 1, shiftKey: false })).toBe(false);
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 1, detail: 1, shiftKey: false })).toBe(false);
    expect(canStartQueryEditorSelectionDrag({ altKey: false, button: 2, detail: 1, shiftKey: false })).toBe(false);
  });

  it("starts rectangular selection for Alt+left drag", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: true, button: 0 })).toBe(true);
  });

  it("starts rectangular selection for middle-button drag", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: false, button: 1 })).toBe(true);
  });

  it("leaves ordinary left clicks to the normal cursor handler", () => {
    expect(startsQueryEditorRectangularSelection({ altKey: false, button: 0 })).toBe(false);
  });

  it("uses Cmd or Ctrl without Alt for object navigation", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("leaves Alt+Cmd and Alt+Ctrl to multi-cursor selection", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: true, ctrlKey: false, metaKey: true })).toBe(false);
    expect(usesQueryEditorObjectNavigationModifier({ altKey: true, ctrlKey: true, metaKey: false })).toBe(false);
  });

  it("does not treat an unmodified pointer event as object navigation", () => {
    expect(usesQueryEditorObjectNavigationModifier({ altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });
});
