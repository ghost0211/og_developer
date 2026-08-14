//! 桌面端会话管理命令。

use std::sync::Arc;

use tauri::State;

use dbx_core::connection::AppState;

#[tauri::command]
pub async fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<dbx_core::sessions::SessionInfo>, String> {
    Ok(dbx_core::sessions::list_sessions(&state).await)
}

#[tauri::command]
pub async fn kill_session(state: State<'_, Arc<AppState>>, connection_id: String, pid: i64) -> Result<(), String> {
    dbx_core::sessions::kill_session(&state, &connection_id, pid).await
}
