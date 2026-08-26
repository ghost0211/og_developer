import { describe, expect, it } from "vitest";
import { buildGitInlineDiff, categorizeGitEntries, formatGitErrorMessage, getFileGitColorClass, getFileGitStatus, getGitStatusBadge, normalizeRelativePath } from "@/lib/git/gitUtils";
import type { GitStatusEntry } from "@/types/git";

describe("gitUtils", () => {
  describe("categorizeGitEntries", () => {
    it("splits entries into staged and unstaged groups", () => {
      const entries: GitStatusEntry[] = [
        { path: "src/a.ts", status: "modified", staged: true },
        { path: "src/b.ts", status: "untracked", staged: false },
        { path: "src/c.ts", status: "deleted", staged: true },
        { path: "src/d.ts", status: "modified", staged: false },
      ];

      const { staged, unstaged } = categorizeGitEntries(entries);
      expect(staged).toHaveLength(2);
      expect(staged.map((e) => e.path)).toEqual(["src/a.ts", "src/c.ts"]);
      expect(unstaged).toHaveLength(2);
      expect(unstaged.map((e) => e.path)).toEqual(["src/b.ts", "src/d.ts"]);
    });

    it("handles empty array cleanly", () => {
      const { staged, unstaged } = categorizeGitEntries([]);
      expect(staged).toEqual([]);
      expect(unstaged).toEqual([]);
    });
  });

  describe("getGitStatusBadge", () => {
    it("returns correct badges and colors for all statuses", () => {
      expect(getGitStatusBadge("modified").letter).toBe("M");
      expect(getGitStatusBadge("modified").colorClass).toContain("amber");

      expect(getGitStatusBadge("added").letter).toBe("A");
      expect(getGitStatusBadge("added").colorClass).toContain("emerald");

      expect(getGitStatusBadge("untracked").letter).toBe("U");
      expect(getGitStatusBadge("untracked").colorClass).toContain("emerald");

      expect(getGitStatusBadge("deleted").letter).toBe("D");
      expect(getGitStatusBadge("deleted").colorClass).toContain("red");

      expect(getGitStatusBadge("renamed").letter).toBe("R");
      expect(getGitStatusBadge("renamed").colorClass).toContain("sky");

      expect(getGitStatusBadge("conflicted").letter).toBe("C");
      expect(getGitStatusBadge("conflicted").colorClass).toContain("rose");
    });
  });

  describe("normalizeRelativePath", () => {
    it("normalizes path separators and extracts relative paths", () => {
      expect(normalizeRelativePath("/workspace/project/src/index.ts", "/workspace/project")).toBe("src/index.ts");
      expect(normalizeRelativePath("C:\\Users\\dev\\project\\src\\main.rs", "C:/Users/dev/project")).toBe("src/main.rs");
      expect(normalizeRelativePath("/workspace/project", "/workspace/project")).toBe("");
      expect(normalizeRelativePath("other/path.ts", "/workspace/project")).toBe("other/path.ts");
    });
  });

  describe("getFileGitStatus", () => {
    const entries: GitStatusEntry[] = [
      { path: "src/utils.ts", status: "modified", staged: false },
      { path: "src/new.ts", status: "untracked", staged: false },
      { path: "src/deleted.ts", status: "deleted", staged: true },
    ];

    it("finds matching file status by absolute or relative path", () => {
      expect(getFileGitStatus("/repo/src/utils.ts", "/repo", entries)).toBe("modified");
      expect(getFileGitStatus("/repo/src/new.ts", "/repo", entries)).toBe("untracked");
      expect(getFileGitStatus("/repo/src/deleted.ts", "/repo", entries)).toBe("deleted");
      expect(getFileGitStatus("/repo/src/clean.ts", "/repo", entries)).toBeUndefined();
    });
  });

  describe("getFileGitColorClass", () => {
    it("returns correct color classes for modified, added, untracked, deleted", () => {
      expect(getFileGitColorClass("modified")).toContain("text-amber-500");
      expect(getFileGitColorClass("added")).toContain("text-emerald-600");
      expect(getFileGitColorClass("untracked")).toContain("text-emerald-600");
      expect(getFileGitColorClass("deleted")).toContain("text-red-500");
      expect(getFileGitColorClass(undefined)).toBe("");
    });
  });

  describe("formatGitErrorMessage", () => {
    const t = (key: string) => (key === "git.notFound" ? "Git not found on PATH" : key);

    it("translates GIT_NOT_FOUND error strings", () => {
      expect(formatGitErrorMessage("GIT_NOT_FOUND: git executable not found", t)).toBe("Git not found on PATH");
      expect(formatGitErrorMessage(new Error("GIT_NOT_FOUND: command not found"), t)).toBe("Git not found on PATH");
    });

    it("falls back to backend error translation for other errors", () => {
      expect(formatGitErrorMessage("Some fatal git error", t)).toBe("Some fatal git error");
    });
  });

  describe("buildGitInlineDiff", () => {
    it("builds insert rows for new files", () => {
      const rows = buildGitInlineDiff("", "line 1\nline 2", true, false);
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe("insert");
      expect(rows[0].newLineNumber).toBe(1);
      expect(rows[0].content).toBe("line 1");
      expect(rows[1].type).toBe("insert");
      expect(rows[1].newLineNumber).toBe(2);
      expect(rows[1].content).toBe("line 2");
    });

    it("builds delete rows for deleted files", () => {
      const rows = buildGitInlineDiff("line 1\nline 2", "", false, true);
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe("delete");
      expect(rows[0].oldLineNumber).toBe(1);
      expect(rows[0].content).toBe("line 1");
      expect(rows[1].type).toBe("delete");
      expect(rows[1].oldLineNumber).toBe(2);
      expect(rows[1].content).toBe("line 2");
    });

    it("builds inline diff with equal, delete, insert rows and char segments", () => {
      const oldText = "const a = 1;\nconst b = 2;\nconst c = 3;";
      const newText = "const a = 1;\nconst b = 20;\nconst c = 3;";
      const rows = buildGitInlineDiff(oldText, newText);

      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows[0].type).toBe("equal");
      expect(rows[0].content).toBe("const a = 1;");

      const deleteRow = rows.find((r) => r.type === "delete");
      const insertRow = rows.find((r) => r.type === "insert");
      expect(deleteRow).toBeDefined();
      expect(insertRow).toBeDefined();
      expect(deleteRow?.content).toBe("const b = 2;");
      expect(insertRow?.content).toBe("const b = 20;");
    });
  });
});
