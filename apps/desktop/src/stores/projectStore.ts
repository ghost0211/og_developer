import { computed, ref, watch } from "vue";
import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { uuid } from "@/lib/common/utils";

/**
 * OG Developer: 项目（工作区）— a named local directory used as the default
 * root for file search, queries, scripts, and bound database connections.
 */
export interface SqlProject {
  id: string;
  name: string;
  path: string;
  description?: string;
  /** 绑定的数据库连接（新建查询时使用该连接）。 */
  connectionId?: string;
  defaultDatabase?: string;
  defaultSchema?: string;
  createdAt?: number;
  updatedAt?: number;
}

const STORAGE_KEY = "dbx-sql-projects-v1";
const ACTIVE_PROJECT_STORAGE_KEY = "dbx-sql-active-project-v1";

export function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function loadProjects(): SqlProject[] {
  try {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SqlProject[]) : [];
    return parsed.filter((project) => project && typeof project.path === "string" && project.path.trim()).map((project) => ({ ...project, path: normalizeProjectPath(project.path) }));
  } catch {
    return [];
  }
}

const projects = ref<SqlProject[]>(loadProjects());
const storedActiveProjectId = safeLocalStorageGet(ACTIVE_PROJECT_STORAGE_KEY) || undefined;
const hasStoredActiveProject = !!storedActiveProjectId && projects.value.some((project) => project.id === storedActiveProjectId);
const activeProjectId = ref<string | undefined>(hasStoredActiveProject ? storedActiveProjectId : undefined);
if (storedActiveProjectId && !hasStoredActiveProject) safeLocalStorageRemove(ACTIVE_PROJECT_STORAGE_KEY);

watch(
  projects,
  (value) => {
    safeLocalStorageSet(STORAGE_KEY, JSON.stringify(value));
    if (activeProjectId.value && !value.some((project) => project.id === activeProjectId.value)) {
      activeProjectId.value = undefined;
    }
  },
  { deep: true },
);

watch(activeProjectId, (value) => {
  if (value) safeLocalStorageSet(ACTIVE_PROJECT_STORAGE_KEY, value);
  else safeLocalStorageRemove(ACTIVE_PROJECT_STORAGE_KEY);
});

export function useProjectStore() {
  const activeProject = computed(() => projects.value.find((project) => project.id === activeProjectId.value));

  function addProject(name: string, path: string, options?: { connectionId?: string; description?: string; defaultDatabase?: string; defaultSchema?: string } | string): SqlProject {
    const trimmed = normalizeProjectPath(path);
    const opts = typeof options === "string" ? { connectionId: options } : options;
    const existing = projects.value.find((project) => project.path === trimmed);
    if (existing) {
      if (opts?.connectionId !== undefined) existing.connectionId = opts.connectionId;
      if (opts?.description !== undefined) existing.description = opts.description;
      if (opts?.defaultDatabase !== undefined) existing.defaultDatabase = opts.defaultDatabase;
      if (opts?.defaultSchema !== undefined) existing.defaultSchema = opts.defaultSchema;
      existing.updatedAt = Date.now();
      activeProjectId.value = existing.id;
      return existing;
    }
    const project: SqlProject = {
      id: uuid(),
      name: name.trim() || trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed,
      path: trimmed,
      connectionId: opts?.connectionId,
      description: opts?.description,
      defaultDatabase: opts?.defaultDatabase,
      defaultSchema: opts?.defaultSchema,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    projects.value = [...projects.value, project];
    activeProjectId.value = project.id;
    return project;
  }

  function updateProject(id: string, updates: Partial<SqlProject>): SqlProject | undefined {
    const idx = projects.value.findIndex((p) => p.id === id);
    if (idx === -1) return undefined;
    const existing = projects.value[idx];
    const updated: SqlProject = {
      ...existing,
      ...updates,
      name: updates.name?.trim() || existing.name,
      path: updates.path ? normalizeProjectPath(updates.path) || existing.path : existing.path,
      updatedAt: Date.now(),
    };
    const next = [...projects.value];
    next[idx] = updated;
    projects.value = next;
    return updated;
  }

  function removeProject(id: string) {
    projects.value = projects.value.filter((project) => project.id !== id);
    if (activeProjectId.value === id) {
      activeProjectId.value = projects.value[0]?.id;
    }
  }

  function setActiveProject(id: string | undefined) {
    activeProjectId.value = id && projects.value.some((project) => project.id === id) ? id : undefined;
  }

  /** Default root for file search: the active project or the first one. */
  function defaultSearchRoot(): string | undefined {
    return activeProject.value?.path ?? projects.value[0]?.path;
  }

  /** 项目下默认存放 SQL 的目录。 */
  function sqlDirectory(project: SqlProject): string {
    const root = normalizeProjectPath(project.path);
    if (root === "/") return "/sql";
    const base = /^[A-Za-z]:[\\/]$/.test(root) ? root.slice(0, -1) : root;
    const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
    return `${base}${separator}sql`;
  }

  /** 首次使用时创建默认的 general 项目（HOME/ogdeveloper-projects/general）。 */
  async function ensureDefaultProject(api: { defaultProjectsRoot: () => Promise<string>; ensureDirectory: (path: string) => Promise<void> }) {
    if (projects.value.length > 0) return;
    try {
      const root = await api.defaultProjectsRoot();
      const path = `${root}/general`;
      await api.ensureDirectory(`${path}/sql`);
      addProject("general", path);
    } catch {
      // 目录不可用时保持空项目列表，由用户手动创建。
    }
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    addProject,
    updateProject,
    removeProject,
    setActiveProject,
    defaultSearchRoot,
    sqlDirectory,
    ensureDefaultProject,
  };
}
