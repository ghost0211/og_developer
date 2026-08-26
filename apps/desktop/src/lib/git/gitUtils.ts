import { diffChars, diffLines } from "diff";
import type { GitChangeStatus, GitStatusEntry } from "@/types/git";
import { translateBackendError } from "@/i18n/backend-errors";

export interface CategorizedGitEntries {
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
}

/**
 * Split git status entries into staged and unstaged groups.
 */
export function categorizeGitEntries(entries: GitStatusEntry[]): CategorizedGitEntries {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (entry.staged) {
      staged.push(entry);
    } else {
      unstaged.push(entry);
    }
  }
  return { staged, unstaged };
}

export interface GitStatusBadgeInfo {
  letter: string;
  colorClass: string;
  bgClass: string;
  labelKey: string;
}

/**
 * Return display badge info (letter, styling, i18n label) for a git change status.
 */
export function getGitStatusBadge(status: GitChangeStatus): GitStatusBadgeInfo {
  switch (status) {
    case "modified":
      return { letter: "M", colorClass: "text-amber-500", bgClass: "bg-amber-500/10 text-amber-500 border-amber-500/30", labelKey: "git.statusModified" };
    case "added":
      return { letter: "A", colorClass: "text-emerald-500", bgClass: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", labelKey: "git.statusAdded" };
    case "untracked":
      return { letter: "U", colorClass: "text-emerald-500", bgClass: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30", labelKey: "git.statusUntracked" };
    case "deleted":
      return { letter: "D", colorClass: "text-red-500", bgClass: "bg-red-500/10 text-red-500 border-red-500/30", labelKey: "git.statusDeleted" };
    case "renamed":
      return { letter: "R", colorClass: "text-sky-500", bgClass: "bg-sky-500/10 text-sky-500 border-sky-500/30", labelKey: "git.statusRenamed" };
    case "conflicted":
      return { letter: "C", colorClass: "text-rose-500", bgClass: "bg-rose-500/10 text-rose-500 border-rose-500/30", labelKey: "git.statusConflicted" };
    default:
      return { letter: "?", colorClass: "text-muted-foreground", bgClass: "bg-muted text-muted-foreground", labelKey: "git.statusUnknown" };
  }
}

/**
 * Normalize and convert an absolute file path into a repo-relative path.
 */
export function normalizeRelativePath(filePath: string, repoPath: string): string {
  const normFile = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normRepo = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normFile === normRepo) return "";
  if (normFile.startsWith(normRepo + "/")) {
    return normFile.slice(normRepo.length + 1);
  }
  return normFile;
}

/**
 * Find the Git status of a file path in the status entries.
 */
export function getFileGitStatus(filePath: string, repoPath: string, entries: GitStatusEntry[]): GitChangeStatus | undefined {
  if (!entries || entries.length === 0) return undefined;
  const relPath = normalizeRelativePath(filePath, repoPath);
  const matching = entries.filter((e) => e.path.replace(/\\/g, "/") === relPath);
  if (matching.length === 0) return undefined;
  // If multiple (e.g. staged + unstaged changes), unstaged modified/conflicted takes display priority
  const unstaged = matching.find((e) => !e.staged);
  return unstaged ? unstaged.status : matching[0].status;
}

/**
 * Return Tailwind text color class based on Git change status for ProjectFilesPanel tree items.
 */
export function getFileGitColorClass(status?: GitChangeStatus): string {
  if (!status) return "";
  switch (status) {
    case "modified":
      return "text-amber-500 dark:text-amber-400";
    case "added":
    case "untracked":
      return "text-emerald-600 dark:text-emerald-400";
    case "deleted":
      return "text-red-500 dark:text-red-400";
    case "renamed":
      return "text-sky-500 dark:text-sky-400";
    case "conflicted":
      return "text-rose-500 dark:text-rose-400";
    default:
      return "";
  }
}

/**
 * Format Git errors: checks for GIT_NOT_FOUND prefix and returns user-friendly message.
 */
export function formatGitErrorMessage(error: unknown, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (typeof error === "string") {
    if (error.startsWith("GIT_NOT_FOUND")) {
      return t("git.notFound");
    }
    return translateBackendError(t, error);
  }
  if (error && typeof error === "object") {
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    if (message.startsWith("GIT_NOT_FOUND")) {
      return t("git.notFound");
    }
    return translateBackendError(t, error);
  }
  return translateBackendError(t, error);
}

// ---------------------------------------------------------------------------
// Git Diff Builder
// ---------------------------------------------------------------------------

export interface GitDiffSegment {
  value: string;
  changed: boolean;
}

export interface GitDiffRow {
  id: string;
  type: "equal" | "delete" | "insert";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
  segments: GitDiffSegment[];
}

function normalizeDiffText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitDiffLines(text: string): string[] {
  const normalized = normalizeDiffText(text);
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function computeInlineCharSegments(oldLine: string, newLine: string): { oldSegs: GitDiffSegment[]; newSegs: GitDiffSegment[] } {
  const chars = diffChars(oldLine, newLine);
  const oldSegs: GitDiffSegment[] = [];
  const newSegs: GitDiffSegment[] = [];
  for (const c of chars) {
    if (c.removed) {
      oldSegs.push({ value: c.value, changed: true });
    } else if (c.added) {
      newSegs.push({ value: c.value, changed: true });
    } else {
      oldSegs.push({ value: c.value, changed: false });
      newSegs.push({ value: c.value, changed: false });
    }
  }
  return {
    oldSegs: oldSegs.length ? oldSegs : [{ value: oldLine, changed: false }],
    newSegs: newSegs.length ? newSegs : [{ value: newLine, changed: false }],
  };
}

/**
 * Build inline diff rows for Git Diff Viewer.
 */
export function buildGitInlineDiff(oldText: string, newText: string, isNew = false, isDeleted = false): GitDiffRow[] {
  let rowId = 0;
  const nextId = () => `git-diff-${++rowId}`;

  if (isNew) {
    const lines = splitDiffLines(newText);
    return lines.map((line, idx) => ({
      id: nextId(),
      type: "insert",
      oldLineNumber: null,
      newLineNumber: idx + 1,
      content: line,
      segments: [{ value: line, changed: true }],
    }));
  }

  if (isDeleted) {
    const lines = splitDiffLines(oldText);
    return lines.map((line, idx) => ({
      id: nextId(),
      type: "delete",
      oldLineNumber: idx + 1,
      newLineNumber: null,
      content: line,
      segments: [{ value: line, changed: true }],
    }));
  }

  const changes = diffLines(normalizeDiffText(oldText), normalizeDiffText(newText));
  const rows: GitDiffRow[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const lines = change.value.replace(/\n$/, "").split("\n");

    if (!change.added && !change.removed) {
      for (const line of lines) {
        rows.push({
          id: nextId(),
          type: "equal",
          oldLineNumber: oldLineNum++,
          newLineNumber: newLineNum++,
          content: line,
          segments: [{ value: line, changed: false }],
        });
      }
      continue;
    }

    if (change.removed) {
      const nextChange = changes[i + 1];
      if (nextChange?.added) {
        const nextLines = nextChange.value.replace(/\n$/, "").split("\n");
        const maxLen = Math.max(lines.length, nextLines.length);
        for (let j = 0; j < maxLen; j++) {
          const oldLine = lines[j];
          const newLine = nextLines[j];
          if (oldLine !== undefined && newLine !== undefined) {
            const { oldSegs, newSegs } = computeInlineCharSegments(oldLine, newLine);
            rows.push({
              id: nextId(),
              type: "delete",
              oldLineNumber: oldLineNum++,
              newLineNumber: null,
              content: oldLine,
              segments: oldSegs,
            });
            rows.push({
              id: nextId(),
              type: "insert",
              oldLineNumber: null,
              newLineNumber: newLineNum++,
              content: newLine,
              segments: newSegs,
            });
          } else if (oldLine !== undefined) {
            rows.push({
              id: nextId(),
              type: "delete",
              oldLineNumber: oldLineNum++,
              newLineNumber: null,
              content: oldLine,
              segments: [{ value: oldLine, changed: true }],
            });
          } else if (newLine !== undefined) {
            rows.push({
              id: nextId(),
              type: "insert",
              oldLineNumber: null,
              newLineNumber: newLineNum++,
              content: newLine,
              segments: [{ value: newLine, changed: true }],
            });
          }
        }
        i++; // skip nextChange
      } else {
        for (const line of lines) {
          rows.push({
            id: nextId(),
            type: "delete",
            oldLineNumber: oldLineNum++,
            newLineNumber: null,
            content: line,
            segments: [{ value: line, changed: true }],
          });
        }
      }
      continue;
    }

    if (change.added) {
      for (const line of lines) {
        rows.push({
          id: nextId(),
          type: "insert",
          oldLineNumber: null,
          newLineNumber: newLineNum++,
          content: line,
          segments: [{ value: line, changed: true }],
        });
      }
    }
  }

  return rows;
}
