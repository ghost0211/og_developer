use dbx_core::connection::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn document_list_databases(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Vec<dbx_core::types::DatabaseInfo>, String> {
    Err("Document store not supported".to_string())
}

#[tauri::command]
pub async fn document_list_collections(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<Vec<dbx_core::types::TableInfo>, String> {
    Err("Document store not supported".to_string())
}

#[tauri::command]
pub async fn document_find_documents(
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
    Err("Document store not supported".to_string())
}

#[tauri::command]
pub async fn elasticsearch_count_documents(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _index: String,
    _query_json: Option<String>,
) -> Result<u64, String> {
    Err("Elasticsearch not supported".to_string())
}

#[tauri::command]
pub async fn document_list_gridfs_buckets(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<Vec<String>, String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_create_gridfs_bucket(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
) -> Result<(), String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_delete_gridfs_bucket(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
) -> Result<(), String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_list_gridfs_files(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
    _page: Option<u32>,
    _page_size: Option<u32>,
    _filter_json: Option<String>,
) -> Result<serde_json::Value, String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_download_gridfs_file(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
    _file_id: String,
) -> Result<Vec<u8>, String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_upload_gridfs_file(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
    _file_name: String,
    _file_data: Vec<u8>,
) -> Result<String, String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_delete_gridfs_file(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _bucket: String,
    _file_id: String,
) -> Result<(), String> {
    Err("GridFS not supported".to_string())
}

#[tauri::command]
pub async fn document_insert_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _document: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Document store not supported".to_string())
}

#[tauri::command]
pub async fn document_update_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter: serde_json::Value,
    _update: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Document store not supported".to_string())
}

#[tauri::command]
pub async fn document_delete_document(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _collection: String,
    _filter: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Document store not supported".to_string())
}
