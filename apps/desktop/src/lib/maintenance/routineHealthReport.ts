import type { InvalidObjectInfo, RoutineHealthRoutine, RoutineHealthSnapshot } from "@/lib/backend/api";
import { analyzeRoutineHealth, type RoutineHealthFinding } from "@/lib/maintenance/routineHealthAnalysis";

export interface RoutineHealthReportRow {
  key: string;
  routine: RoutineHealthRoutine;
  origin: "analysis" | "compilation";
  findings: RoutineHealthFinding[];
  compilation?: InvalidObjectInfo;
}

/** Compiler records are kept distinct: schema/name alone cannot identify an overload. */
export function buildRoutineHealthReport(snapshot: RoutineHealthSnapshot): RoutineHealthReportRow[] {
  const rows: RoutineHealthReportRow[] = analyzeRoutineHealth(snapshot).map(({ routine, findings }) => ({
    key: `routine:${routine.id}`,
    routine,
    origin: "analysis",
    findings,
  }));
  snapshot.invalidObjects.forEach((record, index) => {
    rows.push({
      key: `compilation:${record.schema}:${record.name}:${record.objectType}:${index}`,
      routine: { id: "", schema: record.schema, name: record.name, objectType: record.objectType, signature: "", source: record.source ?? null, language: "" },
      origin: "compilation",
      compilation: record,
      findings: [{ code: "compilation_failed", severity: "error", line: record.errorLine ?? undefined, message: record.errorMessage || "" }],
    });
  });
  return rows.sort((a, b) => reportRowPriority(b) - reportRowPriority(a) || `${a.routine.schema}.${a.routine.name}`.localeCompare(`${b.routine.schema}.${b.routine.name}`));
}

export function reportRowPriority(row: RoutineHealthReportRow): number {
  return row.findings.some((finding) => finding.severity === "error") ? 2 : row.findings.length ? 1 : 0;
}
