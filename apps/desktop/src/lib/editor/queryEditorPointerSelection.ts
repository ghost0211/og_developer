export interface QueryEditorPointerEvent {
  altKey: boolean;
  button: number;
}

export interface QueryEditorObjectNavigationModifierEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface QueryEditorSelectionDragPointerEvent {
  altKey: boolean;
  button: number;
  detail: number;
  shiftKey: boolean;
}

export function canStartQueryEditorSelectionDrag(event: QueryEditorSelectionDragPointerEvent): boolean {
  return event.button === 0 && event.detail <= 1 && !event.altKey && !event.shiftKey;
}

export function startsQueryEditorRectangularSelection(event: QueryEditorPointerEvent): boolean {
  return event.altKey || event.button === 1;
}

export function usesQueryEditorObjectNavigationModifier(event: QueryEditorObjectNavigationModifierEvent): boolean {
  return !event.altKey && (event.metaKey || event.ctrlKey);
}
