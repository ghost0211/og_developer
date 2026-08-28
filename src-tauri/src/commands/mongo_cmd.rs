use dbx_core::connection::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn mongo_list_databases(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Vec<dbx_core::types::DatabaseInfo>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_list_collections(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<Vec<dbx_core::types::TableInfo>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn vector_collection_detail(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
) -> Result<dbx_core::types::VectorCollectionDetail, String> {
    Err("Vector collections not supported".to_string())
}

#[tauri::command]
pub async fn mongo_create_database(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<(), String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_drop_database(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<(), String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_drop_collection(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
) -> Result<(), String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_rename_collection(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _new_name: String,
) -> Result<(), String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_parse_shell_command(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _command: String,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_find_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _offset: Option<u64>,
    _limit: Option<i64>,
    _filter_json: Option<String>,
    _sort_json: Option<String>,
    _projection_json: Option<String>,
    _execution_id: Option<String>,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_find_one(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: Option<String>,
    _projection_json: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_count_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: Option<String>,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_server_version(_state: State<'_, Arc<AppState>>, _connection_id: String) -> Result<String, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_collection_stats(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_aggregate_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _pipeline_json: String,
    _execution_id: Option<String>,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_distinct(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _field: String,
    _filter_json: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_create_index(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _keys_json: String,
    _options_json: Option<String>,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_drop_indexes(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _indexes_json: Option<String>,
    _single: bool,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_insert_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _document_json: String,
) -> Result<serde_json::Value, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_insert_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _documents_json: String,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_update_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
    _update_json: String,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_update_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
    _update_json: String,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_delete_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_delete_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
) -> Result<u64, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_find_one_and_update(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
    _update_json: String,
    _options_json: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_find_one_and_replace(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
    _replacement_json: String,
    _options_json: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    Err("MongoDB is not supported".to_string())
}

#[tauri::command]
pub async fn mongo_find_one_and_delete(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter_json: String,
    _options_json: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    Err("MongoDB is not supported".to_string())
}
