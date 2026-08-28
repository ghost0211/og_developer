import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { externalSqlFileOpenErrorMessage, readBrowserSqlFile } from "@/lib/sql/sqlFileOpen";

function isSqlFilePath(path: string): boolean {
  return /\.sql$/i.test(path);
}

export function useFileDrop() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const { toast } = useToast();

  async function openDroppedSqlFile(name: string, content: string, path?: string) {
    const connectionId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = connection?.database || "";
    if (path) {
      queryStore.openExternalSqlFile(connectionId, database, path, content);
    } else {
      const tabId = queryStore.createTab(connectionId, database, name, "query");
      queryStore.updateSql(tabId, content);
    }
    toast(t("welcome.fileOpened", { name }));
  }

  async function setupFileDrop() {
    if (isTauriRuntime()) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const webview = getCurrentWebview();
      await webview.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        for (const path of event.payload.paths) {
          const name = path.split("/").pop()?.split("\\").pop() || path;
          if (!isSqlFilePath(path)) continue;
          try {
            const content = await api.readExternalSqlFile(path);
            await openDroppedSqlFile(name, content, path);
          } catch (e: any) {
            toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
          }
        }
      });
    } else {
      document.addEventListener("drop", (event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!isSqlFilePath(file.name)) continue;
          void readBrowserSqlFile(file)
            .then((content) => openDroppedSqlFile(file.name, content))
            .catch((e: any) => {
              toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
            });
        }
      });
      document.addEventListener("dragover", (event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        for (let i = 0; i < files.length; i++) {
          if (isSqlFilePath(files[i].name)) {
            event.preventDefault();
            return;
          }
        }
      });
    }
  }

  return { setupFileDrop };
}
