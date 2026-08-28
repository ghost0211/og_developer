use dbx_core::connection::AppState;
use dbx_core::driver_runtime::DriverRuntimeSummary;
use dbx_core::DownloadSource;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentUpdateBlocker {
    pub db_type: String,
    pub label: String,
}

#[tauri::command]
pub async fn list_installed_agents_local(_state: State<'_, Arc<AppState>>) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_installed_agents(
    _state: State<'_, Arc<AppState>>,
    _source: Option<DownloadSource>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn is_agent_installed(_state: State<'_, Arc<AppState>>, _db_type: String) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn get_driver_store_usage(_state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub async fn clear_driver_download_cache(_state: State<'_, Arc<AppState>>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn get_driver_runtime_summary(state: State<'_, Arc<AppState>>) -> Result<DriverRuntimeSummary, String> {
    Ok(dbx_core::driver_runtime::collect_driver_runtime_summary(state.inner().as_ref()).await)
}

#[tauri::command]
pub async fn stop_driver_runtime(state: State<'_, Arc<AppState>>, runtime_id: String) -> Result<(), String> {
    dbx_core::driver_runtime::stop_driver_runtime(state.inner().as_ref(), &runtime_id).await
}

#[tauri::command]
pub async fn restart_driver_runtime(state: State<'_, Arc<AppState>>, runtime_id: String) -> Result<(), String> {
    dbx_core::driver_runtime::restart_driver_runtime(state.inner().as_ref(), &runtime_id).await
}

#[tauri::command]
pub async fn install_agent(
    _app: tauri::AppHandle,
    _state: State<'_, Arc<AppState>>,
    _db_type: String,
    _source: Option<DownloadSource>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn upgrade_all_agents(
    _app: tauri::AppHandle,
    _state: State<'_, Arc<AppState>>,
    _source: Option<DownloadSource>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub async fn uninstall_agent(_state: State<'_, Arc<AppState>>, _db_type: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn import_agent_jar_cmd(_state: State<'_, Arc<AppState>>, _path: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn invalidate_agent_registry_cache(_state: State<'_, Arc<AppState>>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn import_agents_from_zip(_state: State<'_, Arc<AppState>>, _path: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn import_agent_driver_cmd(
    _state: State<'_, Arc<AppState>>,
    _db_type: String,
    _path: String,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn set_agent_java_runtime_config(
    _state: State<'_, Arc<AppState>>,
    _config: serde_json::Value,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn uninstall_jre(_state: State<'_, Arc<AppState>>, _jre_key: Option<String>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn reinstall_jre(
    _app: tauri::AppHandle,
    _state: State<'_, Arc<AppState>>,
    _key: String,
    _source: Option<DownloadSource>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn check_agent_update_blockers(
    _state: State<'_, Arc<AppState>>,
    _db_types: Vec<String>,
) -> Result<Vec<AgentUpdateBlocker>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn check_jre_installed(_state: State<'_, Arc<AppState>>, _jre_key: Option<String>) -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub async fn get_agent_java_runtime_config(_state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}
