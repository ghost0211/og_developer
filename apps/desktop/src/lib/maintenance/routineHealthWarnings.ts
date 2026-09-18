import type { RoutineHealthWarning } from "@/lib/backend/api";

type Te = (key: string) => boolean;
type T = (key: string, params?: Record<string, string>) => string;

/** Backend coverage notes are stable codes + optional technical detail so the
 * panel can localize them; unknown codes degrade to the raw detail instead of
 * leaking untranslated English or an empty line. */
export function routineHealthWarningText(warning: RoutineHealthWarning, te: Te, t: T): string {
  const key = `routineHealth.warnings.${warning.code}`;
  if (!te(key)) return warning.detail ?? warning.code;
  return warning.detail ? t(key, { detail: warning.detail }) : t(key);
}
