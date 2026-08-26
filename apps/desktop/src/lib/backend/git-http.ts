import type { GitBranchInfo, GitCloneRequest, GitFileDiff, GitStatusInfo } from "@/types/git";

export async function gitIsRepo(_path: string): Promise<boolean> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitClone(_request: GitCloneRequest): Promise<string> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitStatus(_repoPath: string): Promise<GitStatusInfo> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitBranches(_repoPath: string): Promise<GitBranchInfo> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitCheckout(_repoPath: string, _branch: string, _create: boolean): Promise<void> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitStage(_repoPath: string, _paths: string[]): Promise<void> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitUnstage(_repoPath: string, _paths: string[]): Promise<void> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitCommit(_repoPath: string, _message: string): Promise<void> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitPull(_repoPath: string): Promise<string> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitPush(_repoPath: string): Promise<string> {
  throw new Error("Git features are only available in the desktop app");
}

export async function gitFileDiff(_repoPath: string, _path: string, _staged: boolean): Promise<GitFileDiff> {
  throw new Error("Git features are only available in the desktop app");
}
