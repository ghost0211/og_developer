import { ref } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";

export type AppCloseAction = "quit";
type AppCloseRequestTarget = "settings" | "quit";

export interface AppCloseRequestOptions {
  requireCloseActionChoice?: boolean;
}

interface AppCloseRequestPayload {
  payload?: AppCloseRequestTarget;
}

// 系统托盘已移除：关闭窗口只有"退出"一种行为，不再弹最小化/退出选择。
export function useCloseActionPrompt(options: { requestClose: (action: AppCloseAction, requestOptions?: AppCloseRequestOptions) => void }) {
  const showCloseActionPrompt = ref(false);
  const unlistenHandles: Array<() => void> = [];

  async function performCloseAction(_action: AppCloseAction) {
    if (!isTauriRuntime()) return;
    await api.completeAppClose();
  }

  function handleCloseRequest(target: AppCloseRequestTarget = "settings") {
    options.requestClose("quit", { requireCloseActionChoice: target === "settings" });
  }

  function cancelCloseActionPrompt() {
    showCloseActionPrompt.value = false;
  }

  function chooseQuit() {
    showCloseActionPrompt.value = false;
    options.requestClose("quit", { requireCloseActionChoice: false });
  }

  async function setupCloseActionPromptListener() {
    if (!isTauriRuntime()) return;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<AppCloseRequestPayload>("dbx-app-close-requested", (event) => {
        handleCloseRequest(event.payload?.payload ?? "settings");
      });
      unlistenHandles.push(unlisten);
    } catch {
      // 事件监听失败时保持默认行为（直接退出）。
    }
  }

  function cleanupCloseActionPromptListener() {
    for (const unlisten of unlistenHandles.splice(0)) {
      try {
        unlisten();
      } catch {
        // ignore
      }
    }
  }

  return {
    showCloseActionPrompt,
    chooseQuit,
    cancelCloseActionPrompt,
    performCloseAction,
    setupCloseActionPromptListener,
    cleanupCloseActionPromptListener,
  };
}
