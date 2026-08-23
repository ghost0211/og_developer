import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadProjectStore() {
  vi.resetModules();
  const module = await import("@/stores/projectStore");
  return module.useProjectStore();
}

describe("projectStore", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  it("persists the active project and its metadata", async () => {
    const store = await loadProjectStore();
    const project = store.addProject(" Core ", "/workspace/core", {
      connectionId: "conn-1",
      description: "Core database project",
    });
    await nextTick();

    expect(project.name).toBe("Core");
    expect(store.activeProject.value?.id).toBe(project.id);

    const freshStore = await loadProjectStore();
    expect(freshStore.activeProjectId.value).toBe(project.id);
    expect(freshStore.activeProject.value).toMatchObject({
      name: "Core",
      connectionId: "conn-1",
      description: "Core database project",
    });
  });

  it("updates and normalizes project properties", async () => {
    const store = await loadProjectStore();
    const first = store.addProject("First", "/workspace/first");
    const second = store.addProject("Second", "/workspace/second");
    const duplicate = store.addProject("Other name", "/workspace/second/");

    expect(duplicate.id).toBe(second.id);
    expect(store.projects.value).toHaveLength(2);

    const updated = store.updateProject(first.id, { name: " First renamed ", path: " /workspace/renamed " });
    expect(updated).toMatchObject({ name: "First renamed", path: "/workspace/renamed" });
    expect(store.projects.value).toHaveLength(2);
    expect(store.projects.value.find((project) => project.id === second.id)?.path).toBe("/workspace/second");
  });

  it("selects a remaining project after removing the active project", async () => {
    const store = await loadProjectStore();
    const first = store.addProject("First", "/workspace/first");
    const second = store.addProject("Second", "/workspace/second");
    store.setActiveProject(first.id);
    store.removeProject(first.id);
    await nextTick();

    expect(store.activeProjectId.value).toBe(second.id);
    expect(store.projects.value.map((project) => project.id)).toEqual([second.id]);
  });
});
