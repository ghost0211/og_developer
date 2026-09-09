import { ref, type Ref } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export function usePanelResize() {
  const sidebarWidth = ref(Number(safeLocalStorageGet("ogdeveloper-sidebar-width")) || 260);
  const aiPanelWidth = ref(Number(safeLocalStorageGet("ogdeveloper-ai-panel-width")) || 360);
  const historyWidth = ref(Number(safeLocalStorageGet("ogdeveloper-history-width")) || 288);
  const sqlLibraryWidth = ref(Number(safeLocalStorageGet("ogdeveloper-sql-library-width")) || 288);
  const sqlFilePanelWidth = ref(Number(safeLocalStorageGet("ogdeveloper-sql-file-panel-width")) || 288);
  const projectFilePanelWidth = ref(Number(safeLocalStorageGet("ogdeveloper-project-file-panel-width")) || 288);
  const gitPanelWidth = ref(Number(safeLocalStorageGet("ogdeveloper-git-panel-width")) || 288);

  function startPanelResize(widthRef: Ref<number>, storageKey: string, direction: "left" | "right") {
    return (e: MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.value;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        widthRef.value = Math.max(180, Math.min(800, startWidth + (direction === "right" ? delta : -delta)));
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        safeLocalStorageSet(storageKey, String(widthRef.value));
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };
  }

  const startSidebarResize = startPanelResize(sidebarWidth, "ogdeveloper-sidebar-width", "right");
  const startAiPanelResize = startPanelResize(aiPanelWidth, "ogdeveloper-ai-panel-width", "left");
  const startHistoryResize = startPanelResize(historyWidth, "ogdeveloper-history-width", "left");
  const startSqlLibraryResize = startPanelResize(sqlLibraryWidth, "ogdeveloper-sql-library-width", "left");
  const startSqlFilePanelResize = startPanelResize(sqlFilePanelWidth, "ogdeveloper-sql-file-panel-width", "left");
  const startProjectFilePanelResize = startPanelResize(projectFilePanelWidth, "ogdeveloper-project-file-panel-width", "left");
  const startGitPanelResize = startPanelResize(gitPanelWidth, "ogdeveloper-git-panel-width", "left");

  return {
    sidebarWidth,
    aiPanelWidth,
    historyWidth,
    sqlLibraryWidth,
    sqlFilePanelWidth,
    projectFilePanelWidth,
    gitPanelWidth,
    startSidebarResize,
    startAiPanelResize,
    startHistoryResize,
    startSqlLibraryResize,
    startSqlFilePanelResize,
    startProjectFilePanelResize,
    startGitPanelResize,
  };
}
