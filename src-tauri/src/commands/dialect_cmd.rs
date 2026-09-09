#[tauri::command]
pub async fn list_dialect_data_types(dialect_name: String) -> Vec<String> {
    ogdeveloper_core::sql_dialect::dialect_types::list_dialect_type_names(&dialect_name)
}
