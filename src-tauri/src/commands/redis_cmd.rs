use dbx_core::connection::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn redis_list_databases(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Vec<u32>, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_scan_keys(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _cursor: u64,
    _pattern: String,
    _count: Option<usize>,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_scan_keys_batch(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _cursor: u64,
    _pattern: String,
    _count: usize,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_scan_values(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _cursor: u64,
    _pattern: String,
    _count: usize,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_value(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_ttl(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
) -> Result<i64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_stream_entries(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _start: Option<String>,
    _end: Option<String>,
    _count: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_stream_groups(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_stream_consumers(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _group: String,
) -> Result<Vec<serde_json::Value>, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_get_stream_pending(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _group: String,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_set_string(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _value: String,
    _ttl: Option<i64>,
) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_delete_key(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
) -> Result<bool, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_hash_set(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _field: String,
    _value: String,
) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_hash_del(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _fields: Vec<String>,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_list_push(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _values: Vec<String>,
    _direction: String,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_list_set(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _index: i64,
    _value: String,
) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_list_remove(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _count: i64,
    _value: String,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_set_add(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _members: Vec<String>,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_set_remove(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _members: Vec<String>,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_zadd(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _score: f64,
    _member: String,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_zrem(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _members: Vec<String>,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_zset_update(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _old_member: String,
    _new_member: String,
    _new_score: f64,
) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_stream_add(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _id: String,
    _fields: Vec<(String, String)>,
) -> Result<String, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_json_set(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _path: String,
    _value: String,
) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_check_json_module(_state: State<'_, Arc<AppState>>, _connection_id: String) -> Result<bool, String> {
    Ok(false)
}
#[tauri::command]
pub async fn redis_set_ttl(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _ttl: i64,
) -> Result<bool, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_set_expire_at(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _timestamp: i64,
) -> Result<bool, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_delete_keys(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _keys: Vec<String>,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_flush_db(_state: State<'_, Arc<AppState>>, _connection_id: String) -> Result<(), String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_execute_command(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _command: String,
    _args: Vec<String>,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_load_more(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _key: String,
    _cursor: Option<u64>,
    _count: Option<usize>,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_pubsub_publish(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _channel: String,
    _message: String,
) -> Result<u64, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_slowlog_get(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _count: Option<usize>,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
#[tauri::command]
pub async fn redis_cluster_master_nodes(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<serde_json::Value, String> {
    Err("Redis not supported".to_string())
}
