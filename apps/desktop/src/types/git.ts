export interface GitCloneRequest {
  url: string;
  targetDir: string;
  username?: string;
  token?: string;
  branch?: string;
}

export type GitChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitStatusEntry {
  path: string;
  status: GitChangeStatus;
  staged: boolean;
  oldPath?: string;
}

export interface GitStatusInfo {
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  entries: GitStatusEntry[];
}

export interface GitBranchInfo {
  current: string;
  local: string[];
  remote: string[];
}

export interface GitFileDiff {
  oldText: string;
  newText: string;
  isNew: boolean;
  isDeleted: boolean;
}
