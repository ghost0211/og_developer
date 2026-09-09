/** Legacy keys are consumed only after the new value is persisted. Removing both
 * names prevents cleared preferences from reappearing on the next launch. */
function storageKeys(key: string): [string, string | undefined] {
  if (/^dbx[-:]/.test(key)) return [key.replace(/^dbx/, "ogdeveloper"), key];
  if (/^ogdeveloper[-:]/.test(key)) return [key, key.replace(/^ogdeveloper/, "dbx")];
  return [key, undefined];
}

export function safeLocalStorageGet(key: string): string | null {
  const [current, legacy] = storageKeys(key);
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const value = storage.getItem(current);
    if (value !== null) {
      if (legacy) {
        try {
          storage.removeItem(legacy);
        } catch {}
      }
      return value;
    }
    const oldValue = legacy ? storage.getItem(legacy) : null;
    if (oldValue !== null) {
      try {
        storage.setItem(current, oldValue);
        storage.removeItem(legacy!);
      } catch {}
    }
    return oldValue;
  } catch {
    return null;
  }
}

export function safeLocalStorageSet(key: string, value: string) {
  const [current, legacy] = storageKeys(key);
  try {
    const storage = globalThis.localStorage;
    storage?.setItem(current, value);
    if (legacy) storage?.removeItem(legacy);
  } catch {
    /* Storage may be unavailable or full. */
  }
}

export function safeLocalStorageRemove(key: string) {
  const [current, legacy] = storageKeys(key);
  try {
    const storage = globalThis.localStorage;
    // Remove the fallback first, so an interrupted clear cannot resurrect it.
    if (legacy) storage?.removeItem(legacy);
    storage?.removeItem(current);
  } catch {
    /* Keep the current value if removing its fallback failed. */
  }
}
