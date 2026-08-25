export type DebugSnapshotPhase = "starting" | "running" | "finished" | "error" | "stopped";

/**
 * A finished debugger frame can disappear on the server and be reported as an
 * empty snapshot. Preserve the last visible state only for terminal phases;
 * while running, an empty array is a real update and must clear stale rows.
 */
export function mergeDebugSnapshot<T>(current: T[], next: T[], phase: DebugSnapshotPhase): T[] {
  if (next.length > 0 || (phase !== "finished" && phase !== "stopped")) return next;
  return current;
}
