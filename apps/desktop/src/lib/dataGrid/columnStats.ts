import { isNumericColumnType } from "@/lib/dataGrid/dataGridColumnType";
import type { CellValue } from "@/lib/dataGrid/cellValue";

export interface DataGridColumnStatsInput {
  name: string;
  type?: string;
  columnIndex: number;
  rows: readonly (readonly CellValue[])[];
}

export interface DataGridColumnTopValue {
  value: string;
  count: number;
  percent: number;
}

export interface DataGridColumnStats {
  name: string;
  type?: string;
  total: number;
  nonNull: number;
  nullCount: number;
  distinctCount: number;
  isNumeric: boolean;
  min?: number;
  max?: number;
  sum?: number;
  avg?: number;
  topValues: DataGridColumnTopValue[];
}

function finiteNumericValue(value: CellValue | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;

  const text = value.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasExplicitType(type: string | undefined): boolean {
  return !!type?.trim();
}

export function computeDataGridColumnStats(input: DataGridColumnStatsInput): DataGridColumnStats {
  const total = input.rows.length;
  let nonNull = 0;
  let nullCount = 0;
  let numericValueCount = 0;
  let minNumber = Number.POSITIVE_INFINITY;
  let maxNumber = Number.NEGATIVE_INFINITY;
  let sumNumber = 0;
  const valueCounts = new Map<string, number>();

  for (const row of input.rows) {
    const value = row[input.columnIndex ?? 0];
    if (value === null || value === undefined) {
      nullCount++;
      continue;
    }

    nonNull++;
    const text = String(value);
    valueCounts.set(text, (valueCounts.get(text) ?? 0) + 1);

    const numericValue = finiteNumericValue(value);
    if (numericValue === undefined) continue;
    numericValueCount++;
    minNumber = Math.min(minNumber, numericValue);
    maxNumber = Math.max(maxNumber, numericValue);
    sumNumber += numericValue;
  }

  const typeIsNumeric = isNumericColumnType(input.type);
  const valuesAreNumeric = nonNull > 0 && numericValueCount === nonNull;
  // Prefer the database type when available. Without metadata, infer numeric
  // columns only when every non-NULL value is a finite number.
  const isNumeric = valuesAreNumeric && (typeIsNumeric || !hasExplicitType(input.type));
  const sum = isNumeric && Number.isFinite(sumNumber) ? sumNumber : undefined;
  const avg = sum !== undefined ? Math.round((sum / nonNull) * 100) / 100 : undefined;

  const topValues = [...valueCounts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => rightCount - leftCount || leftValue.localeCompare(rightValue))
    .slice(0, 8)
    .map(([value, count]) => ({
      value,
      count,
      // Percentages describe the non-NULL population; NULL has its own metric.
      percent: nonNull > 0 ? Math.round((count / nonNull) * 1000) / 10 : 0,
    }));

  return {
    name: input.name,
    type: input.type,
    total,
    nonNull,
    nullCount,
    distinctCount: valueCounts.size,
    isNumeric,
    min: isNumeric ? minNumber : undefined,
    max: isNumeric ? maxNumber : undefined,
    sum,
    avg,
    topValues,
  };
}
