//! 桌面端搜索与文件系统命令（菜单栏"搜索"与"项目"功能）。

use std::sync::Arc;

use tauri::State;

use dbx_core::connection::AppState;

#[tauri::command]
pub async fn search_files(
    state: State<'_, Arc<AppState>>,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<dbx_core::search::FileSearchHit>, String> {
    let root = root.clone();
    let query = query.clone();
    let limit = limit.unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || dbx_core::search::search_files(&root, &query, limit))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_metadata(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<dbx_core::search::MetadataSearchHit>, String> {
    Ok(dbx_core::search::search_metadata(&state, &query, limit.unwrap_or(200)).await)
}

#[tauri::command]
pub async fn search_object_definitions(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<dbx_core::search::DefinitionSearchHit>, String> {
    Ok(dbx_core::search::search_object_definitions(&state, &query, limit.unwrap_or(100)).await)
}

#[tauri::command]
pub fn list_directories(path: String) -> Result<Vec<String>, String> {
    dbx_core::search::list_directories(&path)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    dbx_core::search::read_text_file(&path)
}
