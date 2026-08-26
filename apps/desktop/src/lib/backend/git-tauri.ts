import { invoke } from "@tauri-apps/api/core";
import type { GitBranchInfo, GitCloneRequest, GitFileDiff, GitStatusInfo } from "@/types/git";

export async function gitIsRepo(path: string): Promise<boolean> {
  return invoke("git_is_repo", { path });
}

export async function gitClone(request: GitCloneRequest): Promise<string> {
  return invoke("git_clone", { request });
}

export async function gitStatus(repoPath: string): Promise<GitStatusInfo> {
  return invoke("git_status", { repoPath });
}

export async function gitBranches(repoPath: string): Promise<GitBranchInfo> {
  return invoke("git_branches", { repoPath });
}

export async function gitCheckout(repoPath: string, branch: string, create: boolean): Promise<void> {
  return invoke("git_checkout", { repoPath, branch, create });
}

export async function gitStage(repoPath: string, paths: string[]): Promise<void> {
  return invoke("git_stage", { repoPath, paths });
}

export async function gitUnstage(repoPath: string, paths: string[]): Promise<void> {
  return invoke("git_unstage", { repoPath, paths });
}

export async function gitCommit(repoPath: string, message: string): Promise<void> {
  return invoke("git_commit", { repoPath, message });
}

export async function gitPull(repoPath: string): Promise<string> {
  return invoke("git_pull", { repoPath });
}

export async function gitPush(repoPath: string): Promise<string> {
  return invoke("git_push", { repoPath });
}

export async function gitFileDiff(repoPath: string, path: string, staged: boolean): Promise<GitFileDiff> {
  return invoke("git_file_diff", { repoPath, path, staged });
}
