use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct SchemaQuery {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub server: Option<String>,
    pub catalog: Option<String>,
    pub filter: Option<String>,
    pub limit: Option<usize>,
    pub name: Option<String>,
    pub direction: Option<String>,
    pub object_type_name: Option<String>,
    pub offset: Option<usize>,
    pub object_type: Option<dbx_core::db::ObjectSourceKind>,
    pub signature: Option<String>,
    pub relation_name: Option<String>,
    pub object_types: Option<String>,
    pub table_name_filter: Option<String>,
    pub apply_visible_filter: Option<bool>,
    pub client_session_id: Option<String>,
    pub include_postgres_access: Option<bool>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct DatabaseStorageRequest {
    pub connection_id: String,
    pub databases: Vec<String>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::schema::list_databases_core(&state.app, &q.connection_id).await.map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_database_storage(
    State(state): State<Arc<WebState>>,
    Json(request): Json<DatabaseStorageRequest>,
) -> Result<Json<Vec<dbx_core::db::DatabaseStorageInfo>>, AppError> {
    let result = dbx_core::schema::list_database_storage_core(&state.app, &request.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_sqlserver_completion_context(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Option<serde_json::Value>>, AppError> {
    Ok(Json(None))
}

pub async fn list_doris_catalogs(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::CatalogInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_doris_catalog_databases(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::DatabaseInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_sqlserver_linked_servers(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::LinkedServerInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_sqlserver_linked_server_catalogs(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::DatabaseInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_sqlserver_linked_server_schemas(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_sqlserver_linked_server_tables(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::TableInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn get_sqlserver_column_metadata(
    _state: State<Arc<WebState>>,
    Query(_q): Query<SchemaQuery>,
) -> Result<Json<Vec<dbx_core::types::ColumnInfo>>, AppError> {
    Ok(Json(Vec::new()))
}

pub async fn list_schemas(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result =
        dbx_core::schema::list_schemas_core_with_visible_filter(&state.app, &q.connection_id, database, None, None)
            .await
            .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_tables(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let object_types = q.object_types.as_ref().map(|value| {
        value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
    });
    let table_name_filter = q
        .table_name_filter
        .as_deref()
        .and_then(|value| serde_json::from_str::<dbx_core::types::TableNameFilter>(value).ok());
    let result = dbx_core::schema::list_tables_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        table_name_filter.as_ref(),
        object_types.as_deref(),
        q.catalog.as_deref(),
        q.offset,
        q.limit,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let object_types = q.object_types.as_ref().map(|value| {
        value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
    });
    let result = dbx_core::schema::list_objects_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        object_types.as_deref(),
        q.filter.as_deref(),
        q.catalog.as_deref(),
        q.offset,
        q.limit,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_object_statistics(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_object_statistics_core(&state.app, &q.connection_id, database, schema, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_completion_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_completion_objects_core(&state.app, &q.connection_id, database, schema, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn completion_assistant_search(
    State(state): State<Arc<WebState>>,
    Json(request): Json<dbx_core::types::CompletionAssistantRequest>,
) -> Result<Json<dbx_core::types::CompletionAssistantResponse>, AppError> {
    let candidates =
        dbx_core::schema::completion_assistant_search_core(&state.app, &request).await.map_err(AppError::from)?;
    Ok(Json(dbx_core::types::CompletionAssistantResponse { candidates, fallback_used: false, incomplete: false }))
}

pub async fn get_object_source(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<dbx_core::db::ObjectSource>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let name = q.name.as_deref().or(q.table.as_deref()).unwrap_or("");
    let object_type = q.object_type.ok_or_else(|| AppError::from("Missing object_type".to_string()))?;
    let result = dbx_core::schema::get_object_source_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        name,
        &object_type,
        q.signature.as_deref(),
        q.relation_name.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_columns_core_for_session(
        &state.app,
        &q.connection_id,
        database,
        schema,
        table,
        None,
        q.client_session_id.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_all_columns(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::get_all_columns_core(&state.app, &q.connection_id, database, schema, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_data_types(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_data_types_core(&state.app, &q.connection_id, database, "public", None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_indexes(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_indexes_core(&state.app, &q.connection_id, database, schema, table, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_foreign_keys(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_foreign_keys_core(&state.app, &q.connection_id, database, schema, table, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_triggers(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_triggers_core(&state.app, &q.connection_id, database, schema, table, None)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_constraints(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_constraints_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_partitions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_partitions_core(&state.app, &q.connection_id, database, schema, table)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_subpartitions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_subpartitions_core(&state.app, &q.connection_id, database, schema, table, "")
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn get_ddl(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<String>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let table = q.table.as_deref().unwrap_or("");
    let result = if q.include_postgres_access.unwrap_or(false) {
        dbx_core::schema::get_table_display_ddl_core(&state.app, &q.connection_id, database, schema, table, None)
            .await
            .map_err(AppError::from)?
    } else {
        dbx_core::schema::get_table_ddl_core(&state.app, &q.connection_id, database, schema, table, None)
            .await
            .map_err(AppError::from)?
    };
    Ok(Json(result))
}

pub async fn list_functions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_functions_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(Deserialize)]
pub struct OpengaussPackageSubprogramsQuery {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub package: Option<String>,
}

pub async fn list_opengauss_package_subprograms(
    State(state): State<Arc<WebState>>,
    Query(q): Query<OpengaussPackageSubprogramsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let package = q.package.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_opengauss_package_subprograms_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        package,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct SequenceQuery {
    pub connection_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub with_last_values: Option<bool>,
}

pub async fn list_sequences(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SequenceQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_sequences_core(&state.app, &q.connection_id, database, schema)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_rules(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_rules_core(&state.app, &q.connection_id, database, schema, "")
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_owners(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let owners =
        dbx_core::schema::list_owners_core(&state.app, &q.connection_id, database).await.map_err(AppError::from)?;
    let result: Vec<dbx_core::types::OwnerInfo> = owners
        .into_iter()
        .map(|o| dbx_core::types::OwnerInfo { object_name: "".to_string(), object_type: "".to_string(), owner: o })
        .collect();
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_extensions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_extensions_core(&state.app, &q.connection_id, database, q.schema.as_deref())
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn resolve_synonym_target(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let synonym = q.name.as_deref().ok_or_else(|| AppError::from("name is required".to_string()))?;
    let result = dbx_core::schema::resolve_synonym_target_core(&state.app, &q.connection_id, database, schema, synonym)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_type_attributes(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let type_name = q.name.as_deref().ok_or_else(|| AppError::from("name is required".to_string()))?;
    let result = dbx_core::schema::list_type_attributes_core(&state.app, &q.connection_id, database, schema, type_name)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_object_references(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let schema = q.schema.as_deref().unwrap_or("");
    let object_name = q.name.as_deref().ok_or_else(|| AppError::from("name is required".to_string()))?;
    let object_type = q.object_type_name.as_deref().unwrap_or(match q.object_type {
        Some(dbx_core::types::ObjectSourceKind::Procedure) => "procedure",
        Some(dbx_core::types::ObjectSourceKind::Function) => "function",
        Some(dbx_core::types::ObjectSourceKind::Package) => "package",
        Some(dbx_core::types::ObjectSourceKind::PackageBody) => "package_body",
        Some(dbx_core::types::ObjectSourceKind::View) => "view",
        Some(dbx_core::types::ObjectSourceKind::MaterializedView) => "materialized_view",
        Some(dbx_core::types::ObjectSourceKind::Sequence) => "sequence",
        Some(dbx_core::types::ObjectSourceKind::Type) => "type",
        Some(dbx_core::types::ObjectSourceKind::Synonym) => "synonym",
        _ => "view",
    });
    let direction = q.direction.as_deref().unwrap_or("references");
    let result = dbx_core::schema::list_object_references_core(
        &state.app,
        &q.connection_id,
        database,
        schema,
        object_type,
        object_name,
        direction,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn list_available_extensions(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::schema::list_available_extensions_core(&state.app, &q.connection_id, database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

#[derive(Deserialize)]
pub struct RecompileObjectRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub object_name: String,
    pub object_type: String,
}

#[derive(Deserialize)]
pub struct ProfilerRunRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub call_sql: String,
    #[serde(default)]
    pub comment: String,
}

pub async fn list_invalid_objects(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::opengauss_maintenance::list_invalid_objects_core(
        &state.app,
        &q.connection_id,
        database,
        q.schema.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn recompile_object(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RecompileObjectRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::opengauss_maintenance::recompile_object_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.schema,
        &req.object_name,
        &req.object_type,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn opengauss_profiler_status(
    State(state): State<Arc<WebState>>,
    Query(q): Query<SchemaQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let database = q.database.as_deref().unwrap_or("");
    let result = dbx_core::opengauss_profiler::check_profiler_status_core(&state.app, &q.connection_id, database)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}

pub async fn opengauss_profiler_run(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ProfilerRunRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let result = dbx_core::opengauss_profiler::run_profiler_core(
        &state.app,
        &req.connection_id,
        &req.database,
        req.schema.as_deref(),
        &req.call_sql,
        &req.comment,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::to_value(result).map_err(|e| AppError::from(e.to_string()))?))
}
