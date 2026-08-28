// SPDX-License-Identifier: Apache-2.0
//
// og developer — openGauss & PostgreSQL schema metadata provider.

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
pub use crate::types::{
    unpaged_object_list, CompletionAssistantCandidate, CompletionAssistantSearchParams, ObjectListOutcome,
    ObjectReferenceInfo, ObjectSourceKind, ObjectStatisticsInfo, SynonymTargetInfo, TableNameFilter, TypeAttributeInfo,
};

pub async fn opengauss_metadata_postgres_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
    pool_key: &str,
) -> Result<Option<deadpool_postgres::Pool>, String> {
    let _ =
        state.get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) }).await;
    let connections = state.connections.read().await;
    match connections.get(pool_key).or_else(|| connections.get(connection_id)) {
        Some(PoolKind::Postgres(p)) => Ok(Some(p.clone())),
        _ => Ok(None),
    }
}

pub fn table_name_filter_matches(name: &str, filter: Option<&TableNameFilter>) -> bool {
    let Some(filter) = filter else {
        return true;
    };
    if filter.exact {
        name == filter.pattern
    } else {
        name.to_lowercase().contains(&filter.pattern.to_lowercase())
    }
}

pub fn is_opengauss_family_config(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Opengauss)
}

pub fn is_doris_family_catalog_capable_config(_config: &ConnectionConfig) -> bool {
    false
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn pg_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn agent_metadata_timeout(config: Option<&ConnectionConfig>) -> Option<std::time::Duration> {
    let Some(config) = config else {
        return Some(std::time::Duration::from_secs(60));
    };
    match config.effective_query_timeout_secs() {
        0 => None,
        seconds => Some(std::time::Duration::from_secs(seconds.max(60))),
    }
}

async fn get_schema_pool(state: &AppState, connection_id: &str, database: &str) -> Result<PoolKind, String> {
    let pool_key =
        state.get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) }).await?;
    let connections = state.connections.read().await;
    connections
        .get(&pool_key)
        .or_else(|| connections.get(connection_id))
        .cloned()
        .ok_or_else(|| "Connection not found".to_string())
}

async fn get_schema_session_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
    client_session_id: Option<&str>,
) -> Result<PoolKind, String> {
    let pool_key = state
        .get_or_create_pool_for_session(
            connection_id,
            if database.trim().is_empty() { None } else { Some(database) },
            client_session_id,
        )
        .await?;
    let connections = state.connections.read().await;
    connections
        .get(&pool_key)
        .or_else(|| connections.get(connection_id))
        .cloned()
        .ok_or_else(|| "Connection not found".to_string())
}

pub async fn list_databases_core(state: &AppState, connection_id: &str) -> Result<Vec<db::DatabaseInfo>, String> {
    let pool = get_schema_pool(state, connection_id, "").await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_databases(&p).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::DatabaseInfo>>(
                    "listDatabases",
                    serde_json::json!({ "connection": config.as_ref() }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_database_storage_core(
    state: &AppState,
    connection_id: &str,
) -> Result<Vec<crate::types::DatabaseStorageInfo>, String> {
    let pool = get_schema_pool(state, connection_id, "").await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_database_storage(&p, &[]).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn list_sqlserver_linked_servers_core(
    _state: &AppState,
    _connection_id: &str,
) -> Result<Vec<crate::types::LinkedServerInfo>, String> {
    Ok(Vec::new())
}

pub async fn get_sqlserver_completion_context_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
) -> Result<Option<serde_json::Value>, String> {
    Ok(None)
}

pub async fn list_sqlserver_linked_server_catalogs_core(
    _state: &AppState,
    _connection_id: &str,
    _server: &str,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub async fn list_sqlserver_linked_server_schemas_core(
    _state: &AppState,
    _connection_id: &str,
    _server: &str,
    _catalog: &str,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub async fn list_sqlserver_linked_server_tables_core(
    _state: &AppState,
    _connection_id: &str,
    _server: &str,
    _catalog: &str,
    _schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_doris_catalogs_core(
    _state: &AppState,
    _connection_id: &str,
) -> Result<Vec<crate::types::CatalogInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_doris_catalog_databases_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
) -> Result<Vec<db::DatabaseInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_doris_catalog_tables_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
) -> Result<Vec<db::TableInfo>, String> {
    Ok(Vec::new())
}

pub async fn get_doris_catalog_columns_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    Ok(Vec::new())
}

pub async fn get_doris_catalog_table_ddl_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<String, String> {
    Ok(String::new())
}

pub async fn list_doris_catalog_indexes_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::IndexInfo>, String> {
    Ok(Vec::new())
}

pub async fn get_doris_catalog_table_comment_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Option<String>, String> {
    Ok(None)
}

pub async fn list_doris_catalog_foreign_keys_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_doris_catalog_triggers_core(
    _state: &AppState,
    _connection_id: &str,
    _catalog: &str,
    _database: &str,
    _table: &str,
) -> Result<Vec<db::TriggerInfo>, String> {
    Ok(Vec::new())
}

pub async fn resolve_external_doris_catalog(
    _state: &AppState,
    _connection_id: &str,
    _catalog: Option<&str>,
) -> Option<String> {
    None
}

pub async fn list_schemas_core(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    list_schemas_core_with_visible_filter(state, connection_id, database, None, None).await
}

pub async fn list_schemas_core_with_visible_filter(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _visible: Option<&[String]>,
    _catalog: Option<&str>,
) -> Result<Vec<String>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schemas(&p).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<String>>(
                    "listSchemas",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_schema_infos_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _catalog: Option<&str>,
) -> Result<Vec<db::SchemaInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schema_infos(&p).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::SchemaInfo>>(
                    "listSchemaInfos",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_data_types_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    _catalog: Option<&str>,
) -> Result<Vec<String>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => {
            let sql = format!(
                "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = {}",
                sql_string(schema)
            );
            let res = db::postgres::execute_query(&p, &sql).await?;
            Ok(res
                .rows
                .into_iter()
                .filter_map(|r| r.into_iter().next())
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect())
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<String>>(
                    "listDataTypes",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_tables_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    filter: Option<&TableNameFilter>,
    _object_types: Option<&[String]>,
    _catalog: Option<&str>,
    _page: Option<usize>,
    _limit: Option<usize>,
) -> Result<Vec<db::TableInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    let tables = match pool {
        PoolKind::Postgres(p) => db::postgres::list_tables(&p, schema).await?,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::TableInfo>>(
                    "listTables",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?
        }
    };

    if let Some(f) = filter {
        Ok(tables.into_iter().filter(|t| table_name_filter_matches(&t.name, Some(f))).collect())
    } else {
        Ok(tables)
    }
}

pub async fn list_vector_collections_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
) -> Result<Vec<crate::types::VectorCollectionInfo>, String> {
    Ok(Vec::new())
}

pub async fn get_vector_collection_detail_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
) -> Result<Option<crate::types::VectorCollectionDetail>, String> {
    Ok(None)
}

pub async fn get_table_comment_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
    _schema: &str,
    _table: &str,
    _catalog: Option<&str>,
) -> Result<Option<String>, String> {
    Ok(None)
}

pub async fn list_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    _object_types: Option<&[String]>,
    _filter: Option<&str>,
    _catalog: Option<&str>,
    _page: Option<usize>,
    _limit: Option<usize>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_objects(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                    "listObjects",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_object_statistics_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    _catalog: Option<&str>,
) -> Result<Vec<ObjectStatisticsInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_object_statistics(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<ObjectStatisticsInfo>>(
                    "listObjectStatistics",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_completion_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    _catalog: Option<&str>,
) -> Result<Vec<db::ObjectInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_objects(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                    "listObjects",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn completion_assistant_search_core(
    _state: &AppState,
    _params: &CompletionAssistantSearchParams,
) -> Result<Vec<CompletionAssistantCandidate>, String> {
    Ok(Vec::new())
}

pub async fn get_columns_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    get_columns_core_for_session(state, connection_id, database, schema, table, None, None).await
}

pub async fn get_columns_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ColumnInfo>, String> {
    let pool = get_schema_session_pool(state, connection_id, database, client_session_id).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::get_columns(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::ColumnInfo>>(
                    "getColumns",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema, "table": table }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn get_all_columns_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _schema: &str,
    _catalog: Option<&str>,
) -> Result<Vec<db::ColumnInfo>, String> {
    let _pool = get_schema_pool(state, connection_id, database).await?;
    Ok(Vec::new())
}

pub async fn list_indexes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    catalog: Option<&str>,
) -> Result<Vec<db::IndexInfo>, String> {
    list_indexes_core_for_session(state, connection_id, database, schema, table, catalog, None).await
}

pub async fn list_indexes_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
    client_session_id: Option<&str>,
) -> Result<Vec<db::IndexInfo>, String> {
    let pool = get_schema_session_pool(state, connection_id, database, client_session_id).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_indexes(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::IndexInfo>>(
                    "listIndexes",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema, "table": table }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_foreign_keys_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    catalog: Option<&str>,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    list_foreign_keys_core_for_session(state, connection_id, database, schema, table, catalog, None).await
}

pub async fn list_foreign_keys_core_for_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
    client_session_id: Option<&str>,
) -> Result<Vec<db::ForeignKeyInfo>, String> {
    let pool = get_schema_session_pool(state, connection_id, database, client_session_id).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_foreign_keys(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::ForeignKeyInfo>>(
                    "listForeignKeys",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema, "table": table }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_triggers_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
) -> Result<Vec<db::TriggerInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_triggers(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::TriggerInfo>>(
                    "listTriggers",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema, "table": table }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_constraints_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _schema: &str,
    _table: &str,
) -> Result<Vec<db::ConstraintInfo>, String> {
    let _pool = get_schema_pool(state, connection_id, database).await?;
    Ok(Vec::new())
}

pub async fn list_partitions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _schema: &str,
    _table: &str,
) -> Result<Vec<db::PartitionInfo>, String> {
    let _pool = get_schema_pool(state, connection_id, database).await?;
    Ok(Vec::new())
}

pub async fn list_subpartitions_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
    _schema: &str,
    _table: &str,
    _partition_name: &str,
) -> Result<Vec<db::SubpartitionInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_functions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_functions(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::FunctionInfo>>(
                    "listFunctions",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_opengauss_package_subprograms_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    package_name: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_opengauss_package_subprograms(&p, schema, package_name).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn list_sequences_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::SequenceInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_sequences(&p, schema, true).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<Vec<db::SequenceInfo>>(
                    "listSequences",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn list_rules_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    _table: &str,
) -> Result<Vec<db::RuleInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_rules(&p, schema).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn list_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_extensions(&p, schema).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn list_available_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<Vec<db::ExtensionInfo>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_available_extensions(&p).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn resolve_synonym_target_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _schema: &str,
    _synonym_name: &str,
) -> Result<Option<SynonymTargetInfo>, String> {
    let _pool = get_schema_pool(state, connection_id, database).await?;
    Ok(None)
}

pub async fn list_type_attributes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    _schema: &str,
    _type_name: &str,
) -> Result<Vec<TypeAttributeInfo>, String> {
    let _pool = get_schema_pool(state, connection_id, database).await?;
    Ok(Vec::new())
}

pub async fn list_object_references_core(
    _state: &AppState,
    _connection_id: &str,
    _database: &str,
    _schema: &str,
    _name: &str,
    _object_type: &ObjectSourceKind,
) -> Result<Vec<ObjectReferenceInfo>, String> {
    Ok(Vec::new())
}

pub async fn list_owners_core(state: &AppState, connection_id: &str, database: &str) -> Result<Vec<String>, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => {
            db::postgres::list_owners(&p, "").await.map(|list| list.into_iter().map(|o| o.owner).collect())
        }
        _ => Ok(Vec::new()),
    }
}

pub async fn get_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
) -> Result<String, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => opengauss_table_ddl(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<String>(
                    "getTableDdl",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema, "table": table }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
    }
}

pub async fn get_table_display_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    catalog: Option<&str>,
) -> Result<String, String> {
    get_table_ddl_core(state, connection_id, database, schema, table, catalog).await
}

pub async fn get_object_source_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: &ObjectSourceKind,
    _signature: Option<&str>,
    _catalog: Option<&str>,
) -> Result<crate::types::ObjectSource, String> {
    let pool = get_schema_pool(state, connection_id, database).await?;
    let source = match pool {
        PoolKind::Postgres(p) => postgres_object_source(&p, schema, name, kind).await?,
        PoolKind::ExternalDriver { config, session, .. } => {
            session
                .invoke_with_timeout::<String>(
                    "getObjectSource",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "name": name,
                        "kind": format!("{kind:?}")
                    }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?
        }
    };

    Ok(crate::types::ObjectSource {
        name: name.to_string(),
        object_type: kind.clone(),
        schema: Some(schema.to_string()),
        source,
        editable: Some(true),
    })
}

pub fn postgres_object_source_sql(schema: &str, name: &str, kind: &ObjectSourceKind) -> String {
    match kind {
        ObjectSourceKind::View => format!(
            "SELECT definition FROM pg_views WHERE schemaname = {} AND viewname = {}",
            sql_string(schema), sql_string(name)
        ),
        ObjectSourceKind::MaterializedView => format!(
            "SELECT definition FROM pg_matviews WHERE schemaname = {} AND matviewname = {}",
            sql_string(schema), sql_string(name)
        ),
        ObjectSourceKind::Procedure | ObjectSourceKind::Function => format!(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = {} AND p.proname = {}",
            sql_string(schema), sql_string(name)
        ),
        ObjectSourceKind::Trigger => format!(
            "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = {} AND t.tgname = {}",
            sql_string(schema), sql_string(name)
        ),
        _ => String::new(),
    }
}

pub async fn postgres_object_source(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    name: &str,
    kind: &ObjectSourceKind,
) -> Result<String, String> {
    let sql = postgres_object_source_sql(schema, name, kind);
    if sql.is_empty() {
        return Ok(String::new());
    }
    let res = db::postgres::execute_query(pool, &sql).await?;
    let source = res
        .rows
        .into_iter()
        .next()
        .and_then(|r| r.into_iter().next())
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    Ok(source)
}

pub async fn pg_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    opengauss_table_ddl(pool, schema, table).await
}

pub async fn opengauss_table_ddl(pool: &deadpool_postgres::Pool, schema: &str, table: &str) -> Result<String, String> {
    let columns = db::postgres::get_columns(pool, schema, table).await?;
    let indexes = db::postgres::list_indexes(pool, schema, table).await.unwrap_or_default();
    let foreign_keys = db::postgres::list_foreign_keys(pool, schema, table).await.unwrap_or_default();

    let mut col_defs = Vec::new();
    for col in &columns {
        let mut def = format!("{} {}", pg_ident(&col.name), col.data_type);
        if !col.is_nullable {
            def.push_str(" NOT NULL");
        }
        if let Some(ref default) = col.column_default {
            def.push_str(&format!(" DEFAULT {default}"));
        }
        col_defs.push(def);
    }
    for fk in &foreign_keys {
        col_defs.push(format!(
            "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({})",
            pg_ident(&fk.name),
            pg_ident(&fk.column),
            pg_ident(&fk.ref_table),
            pg_ident(&fk.ref_column)
        ));
    }

    let pks: Vec<String> = columns.iter().filter(|c| c.is_primary_key).map(|c| pg_ident(&c.name)).collect();
    if !pks.is_empty() {
        col_defs.push(format!("PRIMARY KEY ({})", pks.join(", ")));
    }

    let mut ddl = format!("CREATE TABLE {}.{} (\n  {}\n);", pg_ident(schema), pg_ident(table), col_defs.join(",\n  "));

    for idx in &indexes {
        if !idx.is_primary {
            let unique = if idx.is_unique { "UNIQUE " } else { "" };
            let cols = idx.columns.iter().map(|c| pg_ident(c)).collect::<Vec<_>>().join(", ");
            ddl.push_str(&format!(
                "\nCREATE {unique}INDEX {} ON {}.{} ({cols});",
                pg_ident(&idx.name),
                pg_ident(schema),
                pg_ident(table)
            ));
        }
    }

    Ok(ddl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_name_filter() {
        let filter = TableNameFilter { pattern: "user".to_string(), exact: false };
        assert!(table_name_filter_matches("users", Some(&filter)));
        assert!(table_name_filter_matches("USER_LOGS", Some(&filter)));
        assert!(!table_name_filter_matches("orders", Some(&filter)));
    }

    #[test]
    fn test_agent_metadata_timeout_defaults_and_honors_longer_config() {
        assert_eq!(agent_metadata_timeout(None), Some(std::time::Duration::from_secs(60)));

        let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1",
            "name": "c1",
            "db_type": "opengauss",
            "host": "localhost",
            "port": 5432,
            "username": "u",
            "password": "p",
            "query_timeout_secs": 10
        }))
        .unwrap();

        // Under 60s clamps to 60s
        assert_eq!(agent_metadata_timeout(Some(&config)), Some(std::time::Duration::from_secs(60)));

        // Over 60s uses configured value
        config.query_timeout_secs = 120;
        assert_eq!(agent_metadata_timeout(Some(&config)), Some(std::time::Duration::from_secs(120)));

        // 0 means no timeout (None)
        config.query_timeout_secs = 0;
        assert_eq!(agent_metadata_timeout(Some(&config)), None);
    }
}
