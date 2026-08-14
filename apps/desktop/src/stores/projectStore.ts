import { computed, ref, watch } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { uuid } from "@/lib/common/utils";

/**
 * ogdeveloper: 项目（工作区）— a named local directory used as the default
 * root for file search. Persisted in localStorage; the directory itself is
 * host-local (web builds resolve paths through the backend server).
 */
export interface SqlProject {
  id: string;
  name: string;
  path: string;
  /** 绑定的数据库连接（新建查询时使用该连接）。 */
  connectionId?: string;
}

const STORAGE_KEY = "dbx-sql-projects-v1";

function loadProjects(): SqlProject[] {
  try {
    const raw = safeLocalStorageGet(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SqlProject[]) : [];
    return parsed.filter((project) => project && typeof project.path === "string" && project.path.trim());
  } catch {
    return [];
  }
}

const projects = ref<SqlProject[]>(loadProjects());
const activeProjectId = ref<string | undefined>(undefined);

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

export function useProjectStore() {
  const activeProject = computed(() => projects.value.find((project) => project.id === activeProjectId.value));

  function addProject(name: string, path: string, connectionId?: string): SqlProject {
    const trimmed = path.trim();
    const existing = projects.value.find((project) => project.path === trimmed);
    if (existing) {
      if (connectionId) existing.connectionId = connectionId;
      activeProjectId.value = existing.id;
      return existing;
    }
    const project: SqlProject = {
      id: uuid(),
      name: name.trim() || trimmed.split(/[\/]/).filter(Boolean).pop() || trimmed,
      path: trimmed,
      connectionId,
    };
    projects.value = [...projects.value, project];
    activeProjectId.value = project.id;
    return project;
  }

  function removeProject(id: string) {
    projects.value = projects.value.filter((project) => project.id !== id);
  }

  function setActiveProject(id: string | undefined) {
    activeProjectId.value = id;
  }

  /** Default root for file search: the active project or the first one. */
  function defaultSearchRoot(): string | undefined {
    return activeProject.value?.path ?? projects.value[0]?.path;
  }

  /** 项目下默认存放 SQL 的目录。 */
  function sqlDirectory(project: SqlProject): string {
    return `${project.path.replace(/[\\/]+$/, "")}/sql`;
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

  return { projects, activeProjectId, activeProject, addProject, removeProject, setActiveProject, defaultSearchRoot, sqlDirectory, ensureDefaultProject };
}
