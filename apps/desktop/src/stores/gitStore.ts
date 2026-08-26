import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { useProjectStore } from "@/stores/projectStore";
import type { GitBranchInfo, GitCloneRequest, GitFileDiff, GitStatusEntry, GitStatusInfo } from "@/types/git";

export const useGitStore = defineStore("gitStore", () => {
  const projectStore = useProjectStore();

  const isRepo = ref(false);
  const status = ref<GitStatusInfo | null>(null);
  const branches = ref<GitBranchInfo | null>(null);
  const loading = ref(false);
  const mutating = ref(false);
  const error = ref<string | null>(null);

  // Diff dialog state
  const diffModalOpen = ref(false);
  const diffFile = ref<{ path: string; staged: boolean } | null>(null);
  const diffData = ref<GitFileDiff | null>(null);
  const diffLoading = ref(false);
  const diffError = ref<string | null>(null);

  // Clone dialog state
  const cloneDialogOpen = ref(false);

  const repoPath = computed(() => projectStore.activeProject.value?.path || "");
  const currentBranch = computed(() => status.value?.branch || branches.value?.current || "");
  const ahead = computed(() => status.value?.ahead ?? 0);
  const behind = computed(() => status.value?.behind ?? 0);
  const hasUpstream = computed(() => status.value?.hasUpstream ?? false);
  const entries = computed<GitStatusEntry[]>(() => status.value?.entries ?? []);
  const stagedEntries = computed(() => entries.value.filter((e) => e.staged));
  const unstagedEntries = computed(() => entries.value.filter((e) => !e.staged));

  async function refresh(): Promise<void> {
    if (!isTauriRuntime()) {
      isRepo.value = false;
      status.value = null;
      branches.value = null;
      loading.value = false;
      return;
    }

    const currentPath = repoPath.value;
    if (!currentPath) {
      isRepo.value = false;
      status.value = null;
      branches.value = null;
      loading.value = false;
      error.value = null;
      return;
    }

    loading.value = true;
    error.value = null;

    try {
      const isGit = await api.gitIsRepo(currentPath);
      if (repoPath.value !== currentPath) return;
      isRepo.value = isGit;

      if (isGit) {
        const [statusRes, branchRes] = await Promise.all([api.gitStatus(currentPath), api.gitBranches(currentPath)]);
        if (repoPath.value !== currentPath) return;
        status.value = statusRes;
        branches.value = branchRes;
      } else {
        status.value = null;
        branches.value = null;
      }
    } catch (e: unknown) {
      if (repoPath.value !== currentPath) return;
      error.value = e instanceof Error ? e.message : String(e);
      isRepo.value = false;
      status.value = null;
      branches.value = null;
    } finally {
      if (repoPath.value === currentPath) {
        loading.value = false;
      }
    }
  }

  async function clone(request: GitCloneRequest): Promise<string> {
    mutating.value = true;
    try {
      const clonedPath = await api.gitClone(request);
      return clonedPath;
    } finally {
      mutating.value = false;
    }
  }

  async function stage(paths: string[]): Promise<void> {
    if (!repoPath.value || paths.length === 0) return;
    mutating.value = true;
    try {
      await api.gitStage(repoPath.value, paths);
      await refresh();
    } finally {
      mutating.value = false;
    }
  }

  async function unstage(paths: string[]): Promise<void> {
    if (!repoPath.value || paths.length === 0) return;
    mutating.value = true;
    try {
      await api.gitUnstage(repoPath.value, paths);
      await refresh();
    } finally {
      mutating.value = false;
    }
  }

  async function stageAll(): Promise<void> {
    const paths = unstagedEntries.value.map((e) => e.path);
    if (paths.length > 0) {
      await stage(paths);
    }
  }

  async function unstageAll(): Promise<void> {
    const paths = stagedEntries.value.map((e) => e.path);
    if (paths.length > 0) {
      await unstage(paths);
    }
  }

  async function commit(message: string): Promise<void> {
    if (!repoPath.value || !message.trim()) return;
    mutating.value = true;
    try {
      await api.gitCommit(repoPath.value, message.trim());
      await refresh();
    } finally {
      mutating.value = false;
    }
  }

  async function pull(): Promise<string> {
    if (!repoPath.value) return "";
    mutating.value = true;
    try {
      const output = await api.gitPull(repoPath.value);
      await refresh();
      return output;
    } finally {
      mutating.value = false;
    }
  }

  async function push(): Promise<string> {
    if (!repoPath.value) return "";
    mutating.value = true;
    try {
      const output = await api.gitPush(repoPath.value);
      await refresh();
      return output;
    } finally {
      mutating.value = false;
    }
  }

  async function checkout(branch: string, create = false): Promise<void> {
    if (!repoPath.value || !branch) return;
    mutating.value = true;
    try {
      await api.gitCheckout(repoPath.value, branch, create);
      await refresh();
    } finally {
      mutating.value = false;
    }
  }

  async function createBranch(branchName: string): Promise<void> {
    await checkout(branchName, true);
  }

  async function openDiff(path: string, staged: boolean): Promise<void> {
    if (!repoPath.value) return;
    diffFile.value = { path, staged };
    diffModalOpen.value = true;
    diffLoading.value = true;
    diffError.value = null;
    diffData.value = null;

    try {
      const data = await api.gitFileDiff(repoPath.value, path, staged);
      diffData.value = data;
    } catch (e: unknown) {
      diffError.value = e instanceof Error ? e.message : String(e);
    } finally {
      diffLoading.value = false;
    }
  }

  function closeDiff(): void {
    diffModalOpen.value = false;
    diffFile.value = null;
    diffData.value = null;
    diffError.value = null;
    diffLoading.value = false;
  }

  function openCloneDialog(): void {
    cloneDialogOpen.value = true;
  }

  function closeCloneDialog(): void {
    cloneDialogOpen.value = false;
  }

  watch(
    () => projectStore.activeProject.value?.path,
    () => {
      void refresh();
    },
    { immediate: true },
  );

  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => {
      if (isRepo.value) void refresh();
    });
  }

  return {
    isRepo,
    status,
    branches,
    loading,
    mutating,
    error,
    repoPath,
    currentBranch,
    ahead,
    behind,
    hasUpstream,
    entries,
    stagedEntries,
    unstagedEntries,
    diffModalOpen,
    diffFile,
    diffData,
    diffLoading,
    diffError,
    cloneDialogOpen,
    refresh,
    clone,
    stage,
    unstage,
    stageAll,
    unstageAll,
    commit,
    pull,
    push,
    checkout,
    createBranch,
    openDiff,
    closeDiff,
    openCloneDialog,
    closeCloneDialog,
  };
});
