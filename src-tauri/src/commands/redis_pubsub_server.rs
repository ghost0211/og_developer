use dbx_core::connection::AppState;
use std::sync::Arc;

pub struct PubSubServerState;

impl PubSubServerState {
    pub async fn shutdown(&self, _timeout: std::time::Duration) {}
}

pub fn start_pubsub_server(_state: Arc<AppState>) -> PubSubServerState {
    PubSubServerState
}

#[tauri::command]
pub async fn redis_pubsub_server_port() -> Result<u16, String> {
    Err("Redis not supported".to_string())
}
