import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { SqlParameterInput, SqlParameterValueKind } from "@/lib/sql/sqlParameters";

const STORAGE_KEY = "ogdeveloper-sql-parameter-history";
const PRESETS_STORAGE_KEY = "ogdeveloper-sql-parameter-presets";

export const MAX_SQL_PARAMETER_HISTORY = 8;
export const MAX_SQL_PARAMETER_PRESETS = 30;

const VALID_PARAMETER_KINDS = new Set<SqlParameterValueKind>(["string", "number", "boolean", "null", "raw"]);
const NUMERIC_LITERAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const RAW_SQL_EXPRESSION_RE = /^(?:current_date|current_time|current_timestamp|localtimestamp|localtime|now\s*\(\s*\)|sysdate(?:\s*\(\s*\))?|getdate\s*\(\s*\)|gen_random_uuid\s*\(\s*\)|uuid\s*\(\s*\))$/i;

interface StoredSqlParameterHistory {
  version: 1;
  parameters: Record<string, SqlParameterInput[]>;
}

export interface SqlParameterPreset {
  id: string;
  name: string;
  updatedAt: number;
  sqlSignature?: string;
  values: Record<string, SqlParameterInput>;
  matchedCount?: number;
}

interface StoredSqlParameterPresets {
  version: 1;
  presets: SqlParameterPreset[];
}

function emptyHistory(): StoredSqlParameterHistory {
  return { version: 1, parameters: {} };
}

function readHistory(): StoredSqlParameterHistory {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSqlParameterHistory>;
    if (parsed.version !== 1 || !parsed.parameters || typeof parsed.parameters !== "object") return emptyHistory();
    return { version: 1, parameters: parsed.parameters };
  } catch {
    return emptyHistory();
  }
}

function writeHistory(history: StoredSqlParameterHistory) {
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(history));
}

function normalizeParameterName(name: string): string {
  return name.trim().toLowerCase();
}

function isValidParameterKind(kind: unknown): kind is SqlParameterValueKind {
  return typeof kind === "string" && VALID_PARAMETER_KINDS.has(kind as SqlParameterValueKind);
}

function normalizeInput(input: SqlParameterInput): SqlParameterInput | null {
  if (input.kind === "null") return { kind: "null", value: "NULL" };
  const value = input.value.trim();
  if (!value) return null;
  return { kind: input.kind, value };
}

function normalizePresetInput(input: unknown): SqlParameterInput | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<SqlParameterInput>;
  if (!isValidParameterKind(candidate.kind)) return null;
  if (candidate.kind === "null") return { kind: "null", value: "NULL" };
  const rawValue = typeof candidate.value === "string" ? candidate.value : "";
  return {
    kind: candidate.kind,
    value: candidate.kind === "string" ? rawValue : rawValue.trim(),
  };
}

function sanitizePresetValues(values: Record<string, SqlParameterInput>): Record<string, SqlParameterInput> {
  const sanitized: Record<string, SqlParameterInput> = {};
  for (const [rawKey, rawInput] of Object.entries(values)) {
    const key = rawKey.trim();
    if (!key) continue;
    const normalized = normalizePresetInput(rawInput);
    if (normalized) {
      sanitized[key] = normalized;
    }
  }
  return sanitized;
}

function readPresets(): SqlParameterPreset[] {
  const raw = safeLocalStorageGet(PRESETS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSqlParameterPresets>;
    if (parsed.version !== 1 || !Array.isArray(parsed.presets)) return [];
    const result: SqlParameterPreset[] = [];
    for (const item of parsed.presets) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
      if (!id || !name || !item.values || typeof item.values !== "object" || Array.isArray(item.values)) continue;
      const values = sanitizePresetValues(item.values);
      const sqlSignature = typeof item.sqlSignature === "string" && item.sqlSignature.trim() ? item.sqlSignature.trim() : undefined;
      result.push({
        id,
        name,
        updatedAt,
        ...(sqlSignature ? { sqlSignature } : {}),
        values,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function writePresets(presets: SqlParameterPreset[]) {
  const cleanPresets: SqlParameterPreset[] = presets.slice(0, MAX_SQL_PARAMETER_PRESETS).map((preset) => ({
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt,
    ...(preset.sqlSignature ? { sqlSignature: preset.sqlSignature } : {}),
    values: preset.values,
  }));
  safeLocalStorageSet(PRESETS_STORAGE_KEY, JSON.stringify({ version: 1, presets: cleanPresets }));
}

function createPresetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function countMatchingParameters(presetValues: Record<string, SqlParameterInput>, normalizedParameterKeys: readonly string[]): number {
  if (!normalizedParameterKeys.length) return 0;
  const presetKeySet = new Set(Object.keys(presetValues).map(normalizeParameterName));
  let matched = 0;
  for (const key of normalizedParameterKeys) {
    if (presetKeySet.has(key)) matched += 1;
  }
  return matched;
}

export function loadSqlParameterHistory(name: string): SqlParameterInput[] {
  return (readHistory().parameters[normalizeParameterName(name)] ?? []).slice(0, MAX_SQL_PARAMETER_HISTORY);
}

export function rememberSqlParameterValue(name: string, input: SqlParameterInput): SqlParameterInput[] {
  const normalized = normalizeInput(input);
  if (!normalized) return loadSqlParameterHistory(name);

  const history = readHistory();
  const key = normalizeParameterName(name);
  const previous = history.parameters[key] ?? [];
  history.parameters[key] = [normalized, ...previous.filter((entry) => entry.value !== normalized.value || entry.kind !== normalized.kind)].slice(0, MAX_SQL_PARAMETER_HISTORY);
  writeHistory(history);
  return history.parameters[key];
}

export function rememberSqlParameterValues(values: Record<string, SqlParameterInput>): Record<string, SqlParameterInput[]> {
  const result: Record<string, SqlParameterInput[]> = {};
  for (const [name, input] of Object.entries(values)) {
    result[name] = rememberSqlParameterValue(name, input);
  }
  return result;
}

export function removeSqlParameterHistoryEntry(name: string, entry: SqlParameterInput): SqlParameterInput[] {
  const history = readHistory();
  const key = normalizeParameterName(name);
  const previous = history.parameters[key] ?? [];
  if (!previous.length) return [];

  const targetValue = entry.kind === "null" ? "NULL" : entry.value.trim();
  const next = previous.filter((item) => item.kind !== entry.kind || item.value !== targetValue).slice(0, MAX_SQL_PARAMETER_HISTORY);
  if (next.length > 0) {
    history.parameters[key] = next;
  } else {
    delete history.parameters[key];
  }
  writeHistory(history);
  return next;
}

export function loadSqlParameterPresets(parameterKeys?: readonly string[]): SqlParameterPreset[] {
  const presets = readPresets().slice(0, MAX_SQL_PARAMETER_PRESETS);
  if (!parameterKeys) {
    return presets.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const normalizedKeys = Array.from(new Set(parameterKeys.map(normalizeParameterName).filter(Boolean)));
  return presets
    .map((preset) => ({
      ...preset,
      matchedCount: countMatchingParameters(preset.values, normalizedKeys),
    }))
    .sort((a, b) => (b.matchedCount ?? 0) - (a.matchedCount ?? 0) || b.updatedAt - a.updatedAt);
}

export function saveSqlParameterPreset(name: string, values: Record<string, SqlParameterInput>, sqlSignature?: string): SqlParameterPreset[] {
  const trimmedName = name.trim();
  if (!trimmedName) return loadSqlParameterPresets();

  const existingPresets = readPresets();
  const maxExistingUpdatedAt = existingPresets.reduce((max, item) => Math.max(max, item.updatedAt), 0);
  const now = Date.now();
  const updatedAt = maxExistingUpdatedAt >= now && maxExistingUpdatedAt - now < 1000 ? maxExistingUpdatedAt + 1 : now;

  const sanitizedValues = sanitizePresetValues(values);
  const normalizedTargetName = trimmedName.toLowerCase();
  const existingIndex = existingPresets.findIndex((item) => item.name.trim().toLowerCase() === normalizedTargetName);
  const existing = existingIndex >= 0 ? existingPresets[existingIndex] : undefined;
  const resolvedSignature = sqlSignature !== undefined ? sqlSignature.trim() || undefined : existing?.sqlSignature;

  const nextPreset: SqlParameterPreset = {
    id: existing?.id ?? createPresetId(),
    name: trimmedName,
    updatedAt,
    ...(resolvedSignature ? { sqlSignature: resolvedSignature } : {}),
    values: sanitizedValues,
  };

  const remaining = existingPresets.filter((_, index) => index !== existingIndex);
  const merged = [nextPreset, ...remaining].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SQL_PARAMETER_PRESETS);
  writePresets(merged);
  return merged;
}

export function deleteSqlParameterPreset(id: string): SqlParameterPreset[] {
  const next = readPresets()
    .filter((preset) => preset.id !== id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SQL_PARAMETER_PRESETS);
  writePresets(next);
  return next;
}

export function inferSqlParameterKind(rawValue: string): SqlParameterValueKind {
  const trimmed = rawValue.trim();
  if (!trimmed) return "string";

  const lower = trimmed.toLowerCase();
  if (lower === "null") return "null";
  if (lower === "true" || lower === "false") return "boolean";
  if (trimmed !== "-0" && NUMERIC_LITERAL_RE.test(trimmed)) return "number";
  if (RAW_SQL_EXPRESSION_RE.test(trimmed)) return "raw";
  return "string";
}
