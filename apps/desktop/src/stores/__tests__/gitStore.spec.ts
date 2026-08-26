import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { useGitStore } from "@/stores/gitStore";
import * as api from "@/lib/backend/api";

const mockActiveProject = ref<{ id: string; name: string; path: string } | undefined>({
  id: "proj-1",
  name: "demo",
  path: "/workspace/demo",
});

vi.mock("@/stores/projectStore", () => ({
  useProjectStore: () => ({
    activeProject: mockActiveProject,
  }),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@/lib/backend/api", () => ({
  gitIsRepo: vi.fn(),
  gitClone: vi.fn(),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitCheckout: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  gitCommit: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitFileDiff: vi.fn(),
}));

describe("gitStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refreshes status and branches when project is a git repo", async () => {
    vi.mocked(api.gitIsRepo).mockResolvedValue(true);
    vi.mocked(api.gitStatus).mockResolvedValue({
      branch: "main",
      ahead: 1,
      behind: 2,
      hasUpstream: true,
      entries: [
        { path: "src/main.ts", status: "modified", staged: true },
        { path: "src/app.ts", status: "untracked", staged: false },
      ],
    });
    vi.mocked(api.gitBranches).mockResolvedValue({
      current: "main",
      local: ["main", "dev"],
      remote: ["origin/main"],
    });

    const store = useGitStore();
    await store.refresh();

    expect(store.isRepo).toBe(true);
    expect(store.currentBranch).toBe("main");
    expect(store.ahead).toBe(1);
    expect(store.behind).toBe(2);
    expect(store.stagedEntries).toHaveLength(1);
    expect(store.unstagedEntries).toHaveLength(1);
    expect(store.branches?.local).toEqual(["main", "dev"]);
  });

  it("handles non-git repo properly", async () => {
    vi.mocked(api.gitIsRepo).mockResolvedValue(false);

    const store = useGitStore();
    await store.refresh();

    expect(store.isRepo).toBe(false);
    expect(store.status).toBeNull();
    expect(store.branches).toBeNull();
  });

  it("performs stage, unstage, commit, checkout operations", async () => {
    vi.mocked(api.gitIsRepo).mockResolvedValue(true);
    vi.mocked(api.gitStatus).mockResolvedValue({
      branch: "main",
      ahead: 0,
      behind: 0,
      hasUpstream: false,
      entries: [],
    });
    vi.mocked(api.gitBranches).mockResolvedValue({ current: "main", local: ["main"], remote: [] });
    vi.mocked(api.gitStage).mockResolvedValue();
    vi.mocked(api.gitUnstage).mockResolvedValue();
    vi.mocked(api.gitCommit).mockResolvedValue();
    vi.mocked(api.gitCheckout).mockResolvedValue();

    const store = useGitStore();
    await store.stage(["src/main.ts"]);
    expect(api.gitStage).toHaveBeenCalledWith("/workspace/demo", ["src/main.ts"]);

    await store.unstage(["src/main.ts"]);
    expect(api.gitUnstage).toHaveBeenCalledWith("/workspace/demo", ["src/main.ts"]);

    await store.commit("feat: init");
    expect(api.gitCommit).toHaveBeenCalledWith("/workspace/demo", "feat: init");

    await store.checkout("dev", false);
    expect(api.gitCheckout).toHaveBeenCalledWith("/workspace/demo", "dev", false);
  });

  it("opens and closes file diff", async () => {
    vi.mocked(api.gitFileDiff).mockResolvedValue({
      oldText: "old content",
      newText: "new content",
      isNew: false,
      isDeleted: false,
    });

    const store = useGitStore();
    await store.openDiff("src/main.ts", false);

    expect(store.diffModalOpen).toBe(true);
    expect(store.diffFile).toEqual({ path: "src/main.ts", staged: false });
    expect(store.diffData).toEqual({
      oldText: "old content",
      newText: "new content",
      isNew: false,
      isDeleted: false,
    });

    store.closeDiff();
    expect(store.diffModalOpen).toBe(false);
    expect(store.diffFile).toBeNull();
  });
});
