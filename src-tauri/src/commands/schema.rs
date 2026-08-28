use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;

#[tauri::command]
pub async fn list_databases(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    dbx_core::schema::list_databases_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn list_database_storage(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    _databases: Vec<String>,
) -> Result<Vec<db::DatabaseStorageInfo>, String> {
    dbx_core::schema::list_database_storage_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn get_sqlserver_completion_context(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
) -> Result<Option<serde_json::Value>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn list_doris_catalogs(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Vec<db::CatalogInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_doris_catalog_databases(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _catalog: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_sqlserver_linked_servers(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Vec<db::LinkedServerInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_catalogs(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _server: String,
) -> Result<Vec<db::DatabaseInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_schemas(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _server: String,
    _catalog: String,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_sqlserver_linked_server_tables(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _server: String,
    _catalog: String,
    _schema: String,
    _filter: Option<String>,
    _limit: Option<usize>,
    _offset: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    _apply_visible_filter: Option<bool>,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_schemas_core_with_visible_filter(&state, &connection_id, &database, None, None).await
}

#[tauri::command]
pub async fn list_schema_infos(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<db::SchemaInfo>, String> {
    dbx_core::schema::list_schema_infos_core(&state, &connection_id, &database, None).await
}

#[tauri::command]
pub async fn list_data_types(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    dbx_core::schema::list_data_types_core(&state, &connection_id, &database, "public", None).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_tables(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    catalog: Option<String>,
    _filter: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<Vec<String>>,
    table_name_filter: Option<dbx_core::types::TableNameFilter>,
) -> Result<Vec<db::TableInfo>, String> {
    dbx_core::schema::list_tables_core(
        &state,
        &connection_id,
        &database,
        &schema,
        table_name_filter.as_ref(),
        object_types.as_deref(),
        catalog.as_deref(),
        offset,
        limit,
    )
    .await
}

#[tauri::command]
pub async fn get_table_comment(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Option<String>, String> {
    dbx_core::schema::get_table_comment_core(&state, &connection_id, &database, &schema, &table, None).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    catalog: Option<String>,
    filter: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    object_types: Option<Vec<String>>,
) -> Result<Vec<db::ObjectInfo>, String> {
    dbx_core::schema::list_objects_core(
        &state,
        &connection_id,
        &database,
        &schema,
        object_types.as_deref(),
        filter.as_deref(),
        catalog.as_deref(),
        offset,
        limit,
    )
    .await
}

#[tauri::command]
pub async fn list_object_statistics(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectStatisticsInfo>, String> {
    dbx_core::schema::list_object_statistics_core(&state, &connection_id, &database, &schema, None).await
}

#[tauri::command]
pub async fn list_completion_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::ObjectInfo>, String> {
    dbx_core::schema::list_completion_objects_core(&state, &connection_id, &database, &schema, None).await
}

#[tauri::command]
pub async fn completion_assistant_search(
    state: State<'_, Arc<AppState>>,
    request: dbx_core::types::CompletionAssistantRequest,
) -> Result<dbx_core::types::CompletionAssistantResponse, String> {
    let candidates = dbx_core::schema::completion_assistant_search_core(&state, &request).await?;
    Ok(dbx_core::types::CompletionAssistantResponse { candidates, fallback_used: false, incomplete: false })
}

#[tauri::command]
pub async fn get_object_source(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
    object_type: db::ObjectSourceKind,
    signature: Option<String>,
    catalog: Option<String>,
) -> Result<db::ObjectSource, String> {
    dbx_core::schema::get_object_source_core(
        &state,
        &connection_id,
        &database,
        &schema,
        &name,
        &object_type,
        signature.as_deref(),
        catalog.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_columns(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    client_session_id: Option<String>,
) -> Result<Vec<db::ColumnInfo>, String> {
    dbx_core::schema::get_columns_core_for_session(
        &state,
        &connection_id,
        &database,
        &schema,
        &table,
        None,
        client_session_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_all_columns(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _schema: String,
) -> Result<Vec<dbx_core::types::TableColumnsResult>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::IndexInfo>, String> {
    dbx_core::schema::list_indexes_core(&state, &connection_id, &database, &schema, &table, None).await
}

#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    dbx_core::schema::list_foreign_keys_core(&state, &connection_id, &database, &schema, &table, None).await
}

#[tauri::command]
pub async fn list_triggers(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::TriggerInfo>, String> {
    dbx_core::schema::list_triggers_core(&state, &connection_id, &database, &schema, &table, None).await
}

#[tauri::command]
pub async fn list_constraints(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::ConstraintInfo>, String> {
    dbx_core::schema::list_constraints_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_partitions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
) -> Result<Vec<db::PartitionInfo>, String> {
    dbx_core::schema::list_partitions_core(&state, &connection_id, &database, &schema, &table).await
}

#[tauri::command]
pub async fn list_subpartitions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    partition_name: Option<String>,
) -> Result<Vec<db::SubpartitionInfo>, String> {
    dbx_core::schema::list_subpartitions_core(
        &state,
        &connection_id,
        &database,
        &schema,
        &table,
        partition_name.as_deref().unwrap_or(""),
    )
    .await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: String,
    display: Option<bool>,
    _object_type: Option<db::ObjectSourceKind>,
) -> Result<String, String> {
    if display.unwrap_or(false) {
        dbx_core::schema::get_table_display_ddl_core(&state, &connection_id, &database, &schema, &table, None).await
    } else {
        dbx_core::schema::get_table_ddl_core(&state, &connection_id, &database, &schema, &table, None).await
    }
}

#[tauri::command]
pub async fn list_functions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
) -> Result<Vec<db::FunctionInfo>, String> {
    dbx_core::schema::list_functions_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_opengauss_package_subprograms(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    package_name: String,
) -> Result<Vec<db::FunctionInfo>, String> {
    dbx_core::schema::list_opengauss_package_subprograms_core(&state, &connection_id, &database, &schema, &package_name)
        .await
}

#[tauri::command]
pub async fn list_sequences(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    _with_last_values: Option<bool>,
) -> Result<Vec<db::SequenceInfo>, String> {
    dbx_core::schema::list_sequences_core(&state, &connection_id, &database, &schema).await
}

#[tauri::command]
pub async fn list_rules(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    table: Option<String>,
) -> Result<Vec<db::RuleInfo>, String> {
    dbx_core::schema::list_rules_core(&state, &connection_id, &database, &schema, table.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub async fn list_owners(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    _schema: Option<String>,
) -> Result<Vec<dbx_core::types::OwnerInfo>, String> {
    let owners = dbx_core::schema::list_owners_core(&state, &connection_id, &database).await?;
    Ok(owners
        .into_iter()
        .map(|o| dbx_core::types::OwnerInfo { object_name: "".to_string(), object_type: "".to_string(), owner: o })
        .collect())
}

#[tauri::command]
pub async fn list_extensions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    dbx_core::schema::list_extensions_core(&state, &connection_id, &database, schema.as_deref()).await
}

#[tauri::command]
pub async fn list_available_extensions(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<Vec<db::ExtensionInfo>, String> {
    dbx_core::schema::list_available_extensions_core(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn resolve_synonym_target(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    synonym_name: String,
) -> Result<Option<dbx_core::schema::SynonymTargetInfo>, String> {
    dbx_core::schema::resolve_synonym_target_core(&state, &connection_id, &database, &schema, &synonym_name).await
}

#[tauri::command]
pub async fn list_type_attributes(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
) -> Result<Vec<db::ColumnInfo>, String> {
    let attrs = dbx_core::schema::list_type_attributes_core(&state, &connection_id, &database, &schema, &name).await?;
    Ok(attrs
        .into_iter()
        .map(|a| db::ColumnInfo {
            name: a.name,
            data_type: a.data_type,
            is_nullable: true,
            is_primary_key: false,
            column_default: None,
            extra: None,
            comment: None,
            ..Default::default()
        })
        .collect())
}

#[tauri::command]
pub async fn list_object_references(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    name: String,
    object_type: String,
    direction: Option<String>,
) -> Result<Vec<dbx_core::schema::ObjectReferenceInfo>, String> {
    dbx_core::schema::list_object_references_core(
        &state,
        &connection_id,
        &database,
        &schema,
        &object_type,
        &name,
        direction.as_deref().unwrap_or("references"),
    )
    .await
}

#[tauri::command]
pub async fn list_invalid_objects(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<dbx_core::opengauss_maintenance::InvalidObjectInfo>, String> {
    dbx_core::opengauss_maintenance::list_invalid_objects_core(&state, &connection_id, &database, schema.as_deref())
        .await
}

#[tauri::command]
pub async fn recompile_object(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    object_name: String,
    object_type: String,
) -> Result<dbx_core::opengauss_maintenance::RecompileObjectResult, String> {
    dbx_core::opengauss_maintenance::recompile_object_core(
        &state,
        &connection_id,
        &database,
        &schema,
        &object_name,
        &object_type,
    )
    .await
}

#[tauri::command]
pub async fn opengauss_profiler_status(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<dbx_core::opengauss_profiler::ProfilerStatus, String> {
    dbx_core::opengauss_profiler::check_profiler_status_core(&state, &connection_id, &database).await
}

#[tauri::command]
pub async fn opengauss_profiler_run(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    call_sql: String,
    comment: String,
) -> Result<dbx_core::opengauss_profiler::ProfilerRunResult, String> {
    dbx_core::opengauss_profiler::run_profiler_core(
        &state,
        &connection_id,
        &database,
        schema.as_deref(),
        &call_sql,
        &comment,
    )
    .await
}

#[tauri::command]
pub async fn get_sqlserver_column_metadata(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
    _database: String,
    _schema: String,
    _table: String,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}
