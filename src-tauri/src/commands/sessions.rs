//! 桌面端会话管理命令。

use std::sync::Arc;

use tauri::State;

use ogdeveloper_core::connection::AppState;

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ogdeveloper_core::sessions::SessionInfo>, String> {
    Ok(ogdeveloper_core::sessions::list_sessions(&state).await)
}

#[tauri::command]
pub async fn kill_session(state: State<'_, Arc<AppState>>, connection_id: String, pid: i64) -> Result<(), String> {
    ogdeveloper_core::sessions::kill_session(&state, &connection_id, pid).await
}
