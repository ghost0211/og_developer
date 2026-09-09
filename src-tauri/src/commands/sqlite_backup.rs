use ogdeveloper_core::connection::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn backup_sqlite_database(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _destination_path: String,
) -> Result<(), String> {
    Err("SQLite backup is not supported".to_string())
}
