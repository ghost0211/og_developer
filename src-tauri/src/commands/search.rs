//! 桌面端搜索与文件系统命令（菜单栏"搜索"与"项目"功能）。

use std::sync::Arc;

use tauri::State;

use dbx_core::connection::AppState;

#[tauri::command]
pub async fn search_files(
    _state: State<'_, Arc<AppState>>,
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
pub async fn list_database_search_scope_targets(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<dbx_core::search::DatabaseSearchScopeTarget>, String> {
    Ok(dbx_core::search::list_database_search_scope_targets(&state).await)
}

#[tauri::command]
pub async fn search_metadata(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
    targets: Option<Vec<dbx_core::search::DatabaseSearchScopeTarget>>,
) -> Result<Vec<dbx_core::search::MetadataSearchHit>, String> {
    Ok(dbx_core::search::search_metadata_for_targets(&state, &query, limit.unwrap_or(200), targets.as_deref()).await)
}

#[tauri::command]
pub async fn search_object_definitions(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<usize>,
    targets: Option<Vec<dbx_core::search::DatabaseSearchScopeTarget>>,
) -> Result<Vec<dbx_core::search::DefinitionSearchHit>, String> {
    Ok(dbx_core::search::search_object_definitions_for_targets(
        &state,
        &query,
        limit.unwrap_or(100),
        targets.as_deref(),
    )
    .await)
}

#[tauri::command]
pub fn list_directories(path: String) -> Result<Vec<String>, String> {
    dbx_core::search::list_directories(&path)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    dbx_core::search::read_text_file(&path)
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    dbx_core::search::write_text_file(&path, &content)
}

#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    dbx_core::search::ensure_directory(&path)
}

#[tauri::command]
pub fn default_projects_root() -> Result<String, String> {
    Ok(dbx_core::search::default_projects_root())
}
