// SPDX-License-Identifier: Apache-2.0
//
// og developer — openGauss & PostgreSQL schema metadata provider.

use std::collections::{BTreeSet, HashSet};

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
pub use crate::types::{
    unpaged_object_list, CompletionAssistantCandidate, CompletionAssistantSearchParams, ObjectListOutcome,
    ObjectReferenceInfo, ObjectSourceKind, ObjectStatisticsInfo, SynonymTargetInfo, TableNameFilter, TypeAttributeInfo,
};

pub async fn connection_config(state: &AppState, connection_id: &str) -> Option<ConnectionConfig> {
    state.configs.read().await.get(connection_id).cloned()
}

pub fn is_opengauss_family_config(config: &ConnectionConfig) -> bool {
    if matches!(config.db_type, DatabaseType::Opengauss) {
        return true;
    }
    if let Some(profile) = config.driver_profile.as_deref() {
        if matches!(profile.trim().to_ascii_lowercase().as_str(), "opengauss" | "opengauss-jdbc" | "gaussdb") {
            return true;
        }
    }
    false
}

async fn native_postgres_metadata_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
    config: &ConnectionConfig,
) -> Result<Option<deadpool_postgres::Pool>, String> {
    let mut postgres_config = config.clone();
    if !database.trim().is_empty() {
        postgres_config.database = Some(database.to_string());
    }
    postgres_config.db_type = DatabaseType::Postgres;
    if let Err(e) = postgres_config.validate_native_url_params() {
        log::debug!("[schema][native_postgres_metadata_pool] validate_native_url_params: {e}");
        return Ok(None);
    }
    let (host, port) = match state.connection_host_port(connection_id, &postgres_config).await {
        Ok(hp) => hp,
        Err(e) => {
            log::debug!("[schema][native_postgres_metadata_pool] connection_host_port: {e}");
            return Ok(None);
        }
    };
    let url = postgres_config.connection_url_with_host(&host, port);
    let connect_timeout = std::time::Duration::from_secs(postgres_config.effective_connect_timeout_secs());
    match db::postgres::connect(&url, connect_timeout).await {
        Ok(pool) => {
            // Native metadata is available again; clear any earlier negative
            // memo so later calls keep using it.
            let memo_key = format!("{connection_id}:{}", database.trim());
            state.opengauss_native_metadata_unavailable.write().await.remove(&memo_key);
            // Reuse this pool across metadata calls instead of re-handshaking
            // for every object group expand.
            state.opengauss_native_metadata_pools.write().await.insert(memo_key, pool.clone());
            Ok(Some(pool))
        }
        Err(error) => {
            log::debug!(
                "[schema][native_postgres_metadata_pool] native connect failed (fallback to jdbc session): {error}"
            );
            // Remember the failure so subsequent metadata queries don't retry
            // the (possibly slow) native connect on every call.
            let memo_key = format!("{connection_id}:{}", database.trim());
            state.opengauss_native_metadata_unavailable.write().await.insert(memo_key);
            Ok(None)
        }
    }
}

pub async fn opengauss_metadata_postgres_pool(
    state: &AppState,
    connection_id: &str,
    database: &str,
    pool_key: &str,
) -> Result<Option<deadpool_postgres::Pool>, String> {
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    match connections.get(pool_key) {
        Some(PoolKind::Postgres(p)) => Ok(Some(p.clone())),
        Some(PoolKind::ExternalDriver { .. }) if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            let memo_key = format!("{connection_id}:{}", database.trim());
            // Reuse a previously established native metadata pool.
            if let Some(pool) = state.opengauss_native_metadata_pools.read().await.get(&memo_key) {
                return Ok(Some(pool.clone()));
            }
            // Skip the native connect attempt once it has failed for this
            // connection/database; the JDBC plugin session stays the metadata
            // source and the sidebar stays responsive.
            if state.opengauss_native_metadata_unavailable.read().await.contains(&memo_key) {
                drop(connections);
                return Ok(None);
            }
            let native_config = db_config.clone().expect("opengauss family config present");
            drop(connections);
            native_postgres_metadata_pool(state, connection_id, database, &native_config).await
        }
        _ => {
            drop(connections);
            let _ = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await;
            let connections = state.connections.read().await;
            match connections.get(pool_key).or_else(|| connections.get(connection_id)) {
                Some(PoolKind::Postgres(p)) => Ok(Some(p.clone())),
                _ => Ok(None),
            }
        }
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
            // openGauss/GaussDB official JDBC drivers only report the currently
            // connected database through DatabaseMetaData.getCatalogs(), so the
            // plugin's listDatabases would return just `postgres`. Enumerating
            // via SQL on the same session returns every connectable database.
            if crate::db_admin_sql::is_postgres_family_database(config.db_type) {
                let result: db::QueryResult = session
                    .invoke_with_timeout(
                        "executeQuery",
                        serde_json::json!({
                            "connection": config.as_ref(),
                            "database": config.effective_database().unwrap_or(""),
                            "sql": "SELECT datname FROM pg_database WHERE datallowconn = true ORDER BY datname",
                            "maxRows": 4096
                        }),
                        agent_metadata_timeout(Some(config.as_ref())),
                    )
                    .await?;
                return Ok(result
                    .rows
                    .iter()
                    .filter_map(|row| row.first().and_then(|value| value.as_str()).map(str::to_string))
                    .map(|name| db::DatabaseInfo { name })
                    .collect());
            }
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schemas(&p).await,
        PoolKind::ExternalDriver { config, session, .. }
            if db_config.as_ref().is_some_and(is_opengauss_family_config) =>
        {
            // The official openGauss JDBC driver's getSchemas() can report an
            // empty/limited list; load schemas through the native wire driver
            // when available, falling back to the plugin otherwise.
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            match opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                Ok(Some(p)) => db::postgres::list_schemas(&p).await,
                Ok(None) | Err(_) => {
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_schema_infos(&p).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            // The official openGauss JDBC plugin only exposes standard JDBC
            // metadata; schema comments live in pg_catalog, so load schema
            // infos through the native wire driver when available.
            let is_opengauss = db_config.as_ref().is_some_and(is_opengauss_family_config);
            if is_opengauss {
                let pool_key = state
                    .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                    .await?;
                if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                    return db::postgres::list_schema_infos(&p).await;
                }
            }
            // Fallback: the JDBC plugin supports listSchemas; wrap names into
            // SchemaInfo (comments unavailable on this path).
            let names = session
                .invoke_with_timeout::<Vec<String>>(
                    "listSchemas",
                    serde_json::json!({ "connection": config.as_ref(), "database": database }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?;
            Ok(names.into_iter().map(|name| db::SchemaInfo { name, comment: None }).collect())
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_objects(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. }
            if db_config.as_ref().is_some_and(is_opengauss_family_config) =>
        {
            // The official openGauss JDBC plugin only exposes standard JDBC
            // metadata; packages, synonyms and other openGauss-specific objects
            // live in openGauss catalogs, so enumerate through the native wire
            // driver when available.
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            match opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                Ok(Some(p)) => db::postgres::list_objects(&p, schema).await,
                Ok(None) | Err(_) => session
                    .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                        "listObjects",
                        serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                        agent_metadata_timeout(Some(config.as_ref())),
                    )
                    .await,
            }
        }
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_object_statistics(&p, schema).await,
        PoolKind::ExternalDriver { .. } if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            // openGauss JDBC plugin does not expose object statistics; load
            // them through the native wire driver when available.
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                db::postgres::list_object_statistics(&p, schema).await
            } else {
                Ok(Vec::new())
            }
        }
        PoolKind::ExternalDriver { .. } => Ok(Vec::new()),
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_objects(&p, schema).await,
        PoolKind::ExternalDriver { config, session, .. }
            if db_config.as_ref().is_some_and(is_opengauss_family_config) =>
        {
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            match opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                Ok(Some(p)) => db::postgres::list_objects(&p, schema).await,
                Ok(None) | Err(_) => session
                    .invoke_with_timeout::<Vec<db::ObjectInfo>>(
                        "listObjects",
                        serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                        agent_metadata_timeout(Some(config.as_ref())),
                    )
                    .await,
            }
        }
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_indexes(&p, schema, table).await,
        PoolKind::ExternalDriver { .. } if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            // openGauss JDBC plugin does not expose index metadata; load it
            // through the native wire driver when available.
            let pool_key =
                state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
            if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                db::postgres::list_indexes(&p, schema, table).await
            } else {
                Ok(Vec::new())
            }
        }
        PoolKind::ExternalDriver { .. } => Ok(Vec::new()),
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_foreign_keys(&p, schema, table).await,
        PoolKind::ExternalDriver { .. } if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            // openGauss JDBC plugin does not expose foreign key metadata; load
            // it through the native wire driver when available.
            let pool_key =
                state.get_or_create_metadata_pool_for_session(connection_id, Some(database), client_session_id).await?;
            if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                db::postgres::list_foreign_keys(&p, schema, table).await
            } else {
                Ok(Vec::new())
            }
        }
        PoolKind::ExternalDriver { .. } => Ok(Vec::new()),
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_triggers(&p, schema, table).await,
        PoolKind::ExternalDriver { .. } if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            // openGauss JDBC plugin does not expose trigger metadata; load it
            // through the native wire driver when available.
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                db::postgres::list_triggers(&p, schema, table).await
            } else {
                Ok(Vec::new())
            }
        }
        PoolKind::ExternalDriver { .. } => Ok(Vec::new()),
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
    let db_config = connection_config(state, connection_id).await;
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_functions(&p, schema).await,
        PoolKind::ExternalDriver { .. } if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            // openGauss JDBC plugin does not expose routine metadata beyond
            // standard JDBC; load it through the native wire driver when
            // available.
            let pool_key = state
                .get_or_create_pool(connection_id, if database.trim().is_empty() { None } else { Some(database) })
                .await?;
            if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                db::postgres::list_functions(&p, schema).await
            } else {
                Ok(Vec::new())
            }
        }
        PoolKind::ExternalDriver { .. } => Ok(Vec::new()),
    }
}

pub async fn list_opengauss_package_subprograms_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    package_name: &str,
) -> Result<Vec<db::FunctionInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    if let Some(p) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await? {
        return db::postgres::list_opengauss_package_subprograms(&p, schema, package_name).await;
    }
    Ok(Vec::new())
}

pub async fn list_sequences_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<Vec<db::SequenceInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    match connections.get(&pool_key) {
        Some(PoolKind::Postgres(p)) if db_config.as_ref().is_some_and(is_opengauss_family_config) => {
            let p = p.clone();
            drop(connections);
            db::postgres::list_opengauss_sequences(&p, schema, true).await
        }
        Some(PoolKind::Postgres(p)) => {
            let p = p.clone();
            drop(connections);
            db::postgres::list_sequences(&p, schema, true).await
        }
        Some(PoolKind::ExternalDriver { config, session, .. }) => {
            let config = config.clone();
            let session = session.clone();
            if db_config.as_ref().is_some_and(is_opengauss_family_config) {
                drop(connections);
                if let Ok(Some(p)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                    return db::postgres::list_opengauss_sequences(&p, schema, true).await;
                }
            } else {
                drop(connections);
            }
            session
                .invoke_with_timeout::<Vec<db::SequenceInfo>>(
                    "listSequences",
                    serde_json::json!({ "connection": config.as_ref(), "database": database, "schema": schema }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await
        }
        _ => Ok(Vec::new()),
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

fn opengauss_extensions_catalog_sql(schema: Option<&str>) -> String {
    let schema_filter = schema
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("WHERE n.nspname = '{}'", value.replace('\'', "''")));
    format!(
        "SELECT e.extname, COALESCE(e.extversion, '') AS extversion, d.description, n.nspname \
         FROM pg_catalog.pg_extension e \
         JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace \
         LEFT JOIN pg_catalog.pg_description d ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass \
         {} \
         ORDER BY n.nspname, e.extname",
        schema_filter.unwrap_or_default()
    )
}

fn opengauss_available_extensions_catalog_sql() -> &'static str {
    "SELECT name, default_version, installed_version, comment \
     FROM pg_catalog.pg_available_extensions \
     ORDER BY name"
}

fn extensions_from_query_result(result: db::QueryResult) -> Vec<db::ExtensionInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first()?.as_str()?.to_string();
            let version = row.get(1).and_then(|value| value.as_str()).unwrap_or("").to_string();
            let comment = row.get(2).and_then(|value| value.as_str()).map(str::to_string);
            let schema = row.get(3).and_then(|value| value.as_str()).map(str::to_string);
            Some(db::ExtensionInfo { name, version, comment, schema })
        })
        .collect()
}

pub async fn list_extensions_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<Vec<db::ExtensionInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
        if db_config.as_ref().is_some_and(is_opengauss_family_config) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if let Ok(Some(pool)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                return db::postgres::list_extensions(&pool, schema).await;
            }
            let result: db::QueryResult = session
                .invoke_with_timeout(
                    "executeQuery",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "sql": opengauss_extensions_catalog_sql(schema),
                        "maxRows": 10_000
                    }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?;
            return Ok(extensions_from_query_result(result));
        }
    }
    let pool = connections.get(&pool_key).cloned().ok_or_else(|| "Pool not found".to_string())?;
    drop(connections);
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
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let connections = state.connections.read().await;
    if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
        if db_config.as_ref().is_some_and(is_opengauss_family_config) {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            if let Ok(Some(pool)) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await {
                return db::postgres::list_available_extensions(&pool).await;
            }
            let result: db::QueryResult = session
                .invoke_with_timeout(
                    "executeQuery",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": null,
                        "sql": opengauss_available_extensions_catalog_sql(),
                        "maxRows": 10_000
                    }),
                    agent_metadata_timeout(Some(config.as_ref())),
                )
                .await?;
            return Ok(extensions_from_query_result(result));
        }
    }
    let pool = connections.get(&pool_key).cloned().ok_or_else(|| "Pool not found".to_string())?;
    drop(connections);
    match pool {
        PoolKind::Postgres(p) => db::postgres::list_available_extensions(&p).await,
        _ => Ok(Vec::new()),
    }
}

pub async fn resolve_synonym_target_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    synonym: &str,
) -> Result<Option<SynonymTargetInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let Some(p) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await? else {
        return Ok(None);
    };
    let client = db::postgres::checkout_postgres_client(&p, None, db::connection_timeout()).await?;

    let mut current_schema = schema.to_string();
    let mut current_name = synonym.to_string();
    for _ in 0..5 {
        let rows = client
            .query(db::postgres::opengauss_synonym_target_sql(), &[&current_name, &current_schema])
            .await
            .map_err(|e| e.to_string())?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let target_schema: String = row.get(0);
        let target_name: String = row.get(1);
        let kind_rows = client
            .query(db::postgres::opengauss_synonym_target_kind_sql(), &[&target_schema, &target_name])
            .await
            .map_err(|e| e.to_string())?;
        let kind: String = kind_rows.first().map(|row| row.get::<_, String>(0)).unwrap_or_default();
        if kind == "v" || kind == "m" || kind == "S" || kind == "r" || kind == "f" || kind == "p" {
            return Ok(Some(SynonymTargetInfo { target_schema, target_name, target_kind: kind }));
        }
        current_schema = target_schema;
        current_name = target_name;
        if kind_rows.is_empty() {
            return Ok(None);
        }
    }
    Ok(None)
}

pub async fn list_type_attributes_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    type_name: &str,
) -> Result<Vec<TypeAttributeInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let Some(p) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await? else {
        return Ok(Vec::new());
    };
    let client = db::postgres::checkout_postgres_client(&p, None, db::connection_timeout()).await?;
    let stmt = client.prepare_cached(db::postgres::opengauss_type_attributes_sql()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&type_name, &schema]).await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TypeAttributeInfo {
            name: row.try_get::<_, String>(0).unwrap_or_default(),
            data_type: row.try_get::<_, String>(1).unwrap_or_default(),
            is_nullable: row.try_get::<_, bool>(2).unwrap_or(true),
            comment: row.try_get::<_, Option<String>>(3).ok().flatten().filter(|c| !c.trim().is_empty()),
        })
        .collect())
}

async fn opengauss_fetch_raw_object_source(
    client: &deadpool_postgres::Client,
    schema: &str,
    name: &str,
    object_type: &str,
    has_gs_package: bool,
    has_gs_source: bool,
) -> Option<String> {
    let lower_type = object_type.to_lowercase();
    if lower_type == "package" {
        if has_gs_source {
            let sql = "SELECT s.src FROM dbe_pldeveloper.gs_source s \
                       JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                       WHERE n.nspname = $1 AND s.name = $2 AND s.type = 'package' \
                       ORDER BY s.id DESC LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        if !src.trim().is_empty() {
                            return Some(src);
                        }
                    }
                }
            }
        }
        if has_gs_package {
            let sql = "SELECT p.pkgspecsrc FROM pg_catalog.gs_package p \
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
                       WHERE n.nspname = $1 AND p.pkgname = $2 LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        return Some(src);
                    }
                }
            }
        }
    } else if lower_type == "package_body" || lower_type == "package-body" {
        if has_gs_source {
            let sql = "SELECT s.src FROM dbe_pldeveloper.gs_source s \
                       JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                       WHERE n.nspname = $1 AND s.name = $2 AND s.type = 'package body' \
                       ORDER BY s.id DESC LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        if !src.trim().is_empty() {
                            return Some(src);
                        }
                    }
                }
            }
        }
        if has_gs_package {
            let sql = "SELECT COALESCE(p.pkgbodydeclsrc, '') || E'\\n' || COALESCE(p.pkgbodyinitsrc, '') \
                       FROM pg_catalog.gs_package p \
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
                       WHERE n.nspname = $1 AND p.pkgname = $2 LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        return Some(src);
                    }
                }
            }
        }
    } else if lower_type == "procedure" || lower_type == "function" {
        if let Some((package, member)) = name.split_once('.') {
            let sql = "SELECT p.prosrc \
                       FROM pg_catalog.pg_proc p \
                       JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid \
                       JOIN pg_catalog.pg_namespace n ON n.oid = pkg.pkgnamespace \
                       WHERE n.nspname = $1 AND pkg.pkgname = $2 AND p.proname = $3 LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &package, &member]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        return Some(src);
                    }
                }
            }
        } else {
            if has_gs_source {
                let sql = "SELECT s.src FROM dbe_pldeveloper.gs_source s \
                           JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                           WHERE n.nspname = $1 AND s.name = $2 AND s.type IN ('procedure', 'function') \
                           ORDER BY s.id DESC LIMIT 1";
                if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                    if let Some(row) = rows.first() {
                        if let Ok(src) = row.try_get::<_, String>(0) {
                            if !src.trim().is_empty() {
                                return Some(src);
                            }
                        }
                    }
                }
            }
            let sql = "SELECT p.prosrc FROM pg_catalog.pg_proc p \
                       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                       WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1";
            if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
                if let Some(row) = rows.first() {
                    if let Ok(src) = row.try_get::<_, String>(0) {
                        return Some(src);
                    }
                }
            }
        }
    } else if lower_type == "view" || lower_type == "materialized_view" {
        let sql = "SELECT pg_get_viewdef(c.oid) FROM pg_catalog.pg_class c \
                   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = $1 AND c.relname = $2 LIMIT 1";
        if let Ok(rows) = client.query(sql, &[&schema, &name]).await {
            if let Some(row) = rows.first() {
                if let Ok(src) = row.try_get::<_, String>(0) {
                    return Some(src);
                }
            }
        }
    }
    None
}

fn plsql_candidate_identifiers(references: &crate::plsql_references::PlSqlCandidateReferences) -> Vec<String> {
    references
        .tables
        .iter()
        .chain(references.routines.iter())
        .chain(references.packages.iter())
        .chain(references.sequences.iter())
        .chain(references.types.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn plsql_candidate_schema_matches(
    references: &crate::plsql_references::PlSqlCandidateReferences,
    source_schema: &str,
    candidate_schema: &str,
    candidate_name: &str,
) -> bool {
    if candidate_schema.eq_ignore_ascii_case(source_schema) || candidate_schema.eq_ignore_ascii_case("public") {
        return true;
    }
    let candidate_name = candidate_name.to_lowercase();
    references.qualified_names.iter().any(|(qualifier, member)| {
        qualifier.eq_ignore_ascii_case(candidate_schema)
            && (member == &candidate_name
                || candidate_name.starts_with(&format!("{member}."))
                || candidate_name.ends_with(&format!(".{member}")))
    })
}

fn plsql_routine_candidate_is_self(
    source_schema: &str,
    object_name: &str,
    candidate_schema: &str,
    candidate_name: &str,
    candidate_package: Option<&str>,
) -> bool {
    if !candidate_schema.eq_ignore_ascii_case(source_schema) {
        return false;
    }
    let full_name = candidate_package.map(|package| format!("{package}.{candidate_name}"));
    full_name.as_deref().is_some_and(|name| name.eq_ignore_ascii_case(object_name))
        || (candidate_package.is_none() && candidate_name.eq_ignore_ascii_case(object_name))
}

fn plsql_candidate_is_self(
    source_schema: &str,
    object_type: &str,
    object_name: &str,
    candidate_schema: &str,
    candidate_name: &str,
) -> bool {
    if !candidate_schema.eq_ignore_ascii_case(source_schema) {
        return false;
    }
    if candidate_name.eq_ignore_ascii_case(object_name) {
        return true;
    }
    matches!(object_type, "package" | "package_body" | "package-body")
        && candidate_name.get(..object_name.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(object_name))
        && candidate_name.as_bytes().get(object_name.len()) == Some(&b'.')
}

async fn query_reference_rows(
    client: &deadpool_postgres::Client,
    sql: &str,
    object_name: &str,
    schema: &str,
) -> Result<Vec<ObjectReferenceInfo>, String> {
    let stmt = client.prepare_cached(sql).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[&object_name, &schema]).await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ObjectReferenceInfo {
            schema: row.try_get::<_, String>(0).unwrap_or_default(),
            name: row.try_get::<_, String>(1).unwrap_or_default(),
            object_type: row.try_get::<_, String>(2).unwrap_or_default(),
            detail: None,
        })
        .collect())
}

pub async fn list_object_references_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    object_type: &str,
    object_name: &str,
    direction: &str,
) -> Result<Vec<ObjectReferenceInfo>, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let Some(p) = opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await? else {
        return Ok(Vec::new());
    };
    let client = db::postgres::checkout_postgres_client(&p, None, db::connection_timeout()).await?;

    let has_gs_package = db::postgres::postgres_has_pg_catalog_relation(&client, "gs_package").await.unwrap_or(false);
    let has_pg_synonym = db::postgres::postgres_has_pg_catalog_relation(&client, "pg_synonym").await.unwrap_or(false);
    let has_gs_source =
        db::postgres::postgres_has_namespaced_relation(&client, "dbe_pldeveloper", "gs_source").await.unwrap_or(false);

    if direction == "referencedBy" {
        let mut results: Vec<ObjectReferenceInfo> = Vec::new();
        let mut seen_keys = HashSet::new();

        let oid_sql = match object_type {
            "sequence" => "SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relkind = 'S' AND c.relname = $1 AND c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)".to_string(),
            "type" => {
                "SELECT t.oid FROM pg_catalog.pg_type t WHERE t.typname = $1 AND t.typnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)".to_string()
            }
            "synonym" => {
                "SELECT s.synname FROM pg_catalog.pg_synonym s WHERE s.synname = $1 AND s.synnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)".to_string()
            }
            "function" | "procedure" => {
                if let Some((package, member)) = object_name.split_once('.') {
                    format!("SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid JOIN pg_catalog.pg_namespace n ON n.oid = pkg.pkgnamespace WHERE n.nspname = $2 AND pkg.pkgname = {} AND p.proname = {} LIMIT 1", sql_string(package), sql_string(member))
                } else {
                    "SELECT p.oid FROM pg_catalog.pg_proc p WHERE p.proname = $1 AND p.pronamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2) LIMIT 1".to_string()
                }
            }
            "package" | "package_body" if has_gs_package => {
                "SELECT p.oid FROM pg_catalog.gs_package p WHERE p.pkgname = $1 AND p.pkgnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2) LIMIT 1".to_string()
            }
            _ => {
                "SELECT c.oid FROM pg_catalog.pg_class c WHERE c.relname = $1 AND c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)".to_string()
            }
        };

        if object_type != "synonym" && object_type != "package" && object_type != "package_body" {
            if let Ok(oid_rows) = client.query(&oid_sql, &[&object_name, &schema]).await {
                if let Some(row) = oid_rows.first() {
                    let object_oid: u32 = row.get(0);
                    if let Ok(rows) = client.query(db::postgres::opengauss_referenced_by_sql(), &[&object_oid]).await {
                        for r in rows {
                            let ref_schema = r.try_get::<_, String>(0).unwrap_or_default();
                            let ref_name = r.try_get::<_, String>(1).unwrap_or_default();
                            let ref_kind = r.try_get::<_, String>(2).unwrap_or_default();
                            let detail = r.try_get::<_, String>(3).ok().filter(|d| !d.trim().is_empty());
                            let key = (ref_schema.clone(), ref_name.clone(), ref_kind.clone());
                            if !seen_keys.contains(&key) {
                                seen_keys.insert(key);
                                results.push(ObjectReferenceInfo {
                                    schema: ref_schema,
                                    name: ref_name,
                                    object_type: ref_kind,
                                    detail,
                                });
                            }
                        }
                    }
                }
            }
        }

        let target_ident = if let Some((_, member)) = object_name.split_once('.') { member } else { object_name };

        if !target_ident.trim().is_empty() {
            let search_proc_sql = db::postgres::opengauss_search_routine_prosrc_sql();
            if let Ok(proc_rows) = client.query(search_proc_sql, &[&target_ident]).await {
                for r in proc_rows {
                    let ref_schema: String = r.try_get(0).unwrap_or_default();
                    let proc_name: String = r.try_get(1).unwrap_or_default();
                    let routine_type: String = r.try_get(2).unwrap_or_default();
                    let prosrc: String = r.try_get(3).unwrap_or_default();
                    let pkg_name: Option<String> = r.try_get(4).ok().filter(|s: &String| !s.is_empty());

                    let full_name =
                        if let Some(ref pkg) = pkg_name { format!("{pkg}.{proc_name}") } else { proc_name.clone() };

                    if plsql_routine_candidate_is_self(
                        schema,
                        object_name,
                        &ref_schema,
                        &proc_name,
                        pkg_name.as_deref(),
                    ) {
                        continue;
                    }

                    if crate::plsql_references::plsql_source_references_object(&prosrc, object_type, object_name) {
                        let key = (ref_schema.clone(), full_name.clone(), routine_type.clone());
                        if !seen_keys.contains(&key) {
                            seen_keys.insert(key);
                            results.push(ObjectReferenceInfo {
                                schema: ref_schema,
                                name: full_name,
                                object_type: routine_type,
                                detail: Some("PL/SQL 过程/函数引用".to_string()),
                            });
                        }
                    }
                }
            }

            if has_gs_package {
                let search_pkg_sql = db::postgres::opengauss_search_package_body_src_sql();
                if let Ok(pkg_rows) = client.query(search_pkg_sql, &[&target_ident]).await {
                    for r in pkg_rows {
                        let ref_schema: String = r.try_get(0).unwrap_or_default();
                        let pkg_name: String = r.try_get(1).unwrap_or_default();
                        let pkg_type: String = r.try_get(2).unwrap_or_default();
                        let src: String = r.try_get(3).unwrap_or_default();

                        let target_is_member_of_package = object_name
                            .split_once('.')
                            .is_some_and(|(package, _)| package.eq_ignore_ascii_case(&pkg_name));
                        if ref_schema == schema
                            && (pkg_name.eq_ignore_ascii_case(object_name) || target_is_member_of_package)
                        {
                            continue;
                        }

                        if crate::plsql_references::plsql_source_references_object(&src, object_type, object_name) {
                            let key = (ref_schema.clone(), pkg_name.clone(), pkg_type.clone());
                            if !seen_keys.contains(&key) {
                                seen_keys.insert(key);
                                results.push(ObjectReferenceInfo {
                                    schema: ref_schema,
                                    name: pkg_name,
                                    object_type: pkg_type,
                                    detail: Some("PL/SQL 包引用".to_string()),
                                });
                            }
                        }
                    }
                }
            }
        }

        results.sort_by(|a, b| {
            a.object_type.cmp(&b.object_type).then_with(|| a.schema.cmp(&b.schema)).then_with(|| a.name.cmp(&b.name))
        });
        return Ok(results);
    }

    // direction == "references"
    if object_type == "synonym" {
        let rows = client
            .query(db::postgres::opengauss_synonym_target_sql(), &[&object_name, &schema])
            .await
            .map_err(|e| e.to_string())?;
        return Ok(rows
            .iter()
            .map(|row| ObjectReferenceInfo {
                schema: row.try_get::<_, String>(0).unwrap_or_default(),
                name: row.try_get::<_, String>(1).unwrap_or_default(),
                object_type: "synonym_target".to_string(),
                detail: None,
            })
            .collect());
    }

    let mut results: Vec<ObjectReferenceInfo> = Vec::new();
    let mut seen_keys = HashSet::new();

    if object_type == "view" || object_type == "materialized_view" {
        if let Ok(dep_rows) =
            query_reference_rows(&client, db::postgres::opengauss_view_references_sql(), object_name, schema).await
        {
            for r in dep_rows {
                let key = (r.schema.clone(), r.name.clone(), r.object_type.clone());
                if !seen_keys.contains(&key) {
                    seen_keys.insert(key);
                    results.push(r);
                }
            }
        }
    }

    if let Some(source) =
        opengauss_fetch_raw_object_source(&client, schema, object_name, object_type, has_gs_package, has_gs_source)
            .await
    {
        let extracted = crate::plsql_references::extract_plsql_referenced_identifiers(&source);
        let idents = plsql_candidate_identifiers(&extracted);
        if !idents.is_empty() {
            let find_sql = db::postgres::opengauss_find_candidate_objects_sql(has_gs_package, has_pg_synonym);

            if let Ok(matched_rows) = client.query(&find_sql, &[&idents]).await {
                for r in matched_rows {
                    let ref_schema: String = r.try_get(0).unwrap_or_default();
                    let ref_name: String = r.try_get(1).unwrap_or_default();
                    let ref_kind: String = r.try_get(2).unwrap_or_default();
                    let mut detail: Option<String> = r.try_get(3).ok().filter(|d: &String| !d.trim().is_empty());

                    if plsql_candidate_is_self(schema, object_type, object_name, &ref_schema, &ref_name)
                        || !plsql_candidate_schema_matches(&extracted, schema, &ref_schema, &ref_name)
                    {
                        continue;
                    }

                    let key = (ref_schema.clone(), ref_name.clone(), ref_kind.clone());
                    if !seen_keys.contains(&key) {
                        seen_keys.insert(key);
                        if detail.is_none() {
                            let name_lower = ref_name.to_lowercase();
                            if extracted.tables.contains(&name_lower) {
                                detail = Some("表/视图操作".to_string());
                            } else if extracted.routines.contains(&name_lower) {
                                detail = Some("例程调用".to_string());
                            } else if extracted.packages.contains(&name_lower) {
                                detail = Some("包引用".to_string());
                            } else if extracted.sequences.contains(&name_lower) {
                                detail = Some("序列生成".to_string());
                            } else if extracted.types.contains(&name_lower) {
                                detail = Some("类型引用".to_string());
                            }
                        }
                        results.push(ObjectReferenceInfo {
                            schema: ref_schema,
                            name: ref_name,
                            object_type: ref_kind,
                            detail,
                        });
                    }
                }
            }
        }
    }

    if object_type == "function"
        || object_type == "procedure"
        || object_type == "package"
        || object_type == "package_body"
    {
        if let Ok(routine_dep_rows) =
            query_reference_rows(&client, db::postgres::opengauss_routine_references_sql(), object_name, schema).await
        {
            for r in routine_dep_rows {
                let key = (r.schema.clone(), r.name.clone(), r.object_type.clone());
                if !seen_keys.contains(&key) {
                    seen_keys.insert(key);
                    results.push(r);
                }
            }
        }
    }

    results.sort_by(|a, b| {
        a.object_type.cmp(&b.object_type).then_with(|| a.schema.cmp(&b.schema)).then_with(|| a.name.cmp(&b.name))
    });
    Ok(results)
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

async fn external_opengauss_query(
    session: std::sync::Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: Option<&str>,
    sql: &str,
    max_rows: usize,
) -> Result<db::QueryResult, String> {
    session
        .invoke_with_timeout(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": sql,
                "maxRows": max_rows
            }),
            agent_metadata_timeout(Some(config)),
        )
        .await
}

async fn external_opengauss_query_text(
    session: std::sync::Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    sql: &str,
) -> Result<String, String> {
    first_string_cell(external_opengauss_query(session, config, database, Some(schema), sql, 1).await?)
}

fn opengauss_trigger_definitions_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT pg_catalog.pg_get_triggerdef(t.oid, true) AS trigger_definition \
         FROM pg_catalog.pg_trigger t \
         JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relname = {} AND NOT t.tgisinternal \
         ORDER BY t.tgname, t.oid",
        sql_string(schema),
        sql_string(table)
    )
}

fn query_result_string_values(result: db::QueryResult) -> Vec<String> {
    result
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().find_map(|value| value.as_str().map(str::to_string)))
        .filter(|value| !value.trim().is_empty())
        .collect()
}

async fn external_opengauss_table_ddl(
    session: std::sync::Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let ddl = external_opengauss_query_text(
        session.clone(),
        config,
        database,
        schema,
        &opengauss_table_ddl_sql(schema, table),
    )
    .await?;
    let trigger_definitions = query_result_string_values(
        external_opengauss_query(
            session,
            config,
            database,
            Some(schema),
            &opengauss_trigger_definitions_sql(schema, table),
            10_000,
        )
        .await?,
    );
    Ok(append_opengauss_trigger_definitions(ddl, &trigger_definitions))
}

fn append_opengauss_trigger_definitions(mut ddl: String, trigger_definitions: &[String]) -> String {
    for definition in
        trigger_definitions.iter().map(|definition| definition.trim()).filter(|definition| !definition.is_empty())
    {
        ddl = ddl.trim_end().to_string();
        if !ddl.ends_with(';') {
            ddl.push(';');
        }
        ddl.push_str("\n\n");
        ddl.push_str(definition);
        if !definition.ends_with(';') {
            ddl.push(';');
        }
    }
    ddl
}

pub fn opengauss_table_ddl_sql(schema: &str, table: &str) -> String {
    let qualified_name = format!("{}.{}", pg_ident(schema), pg_ident(table));
    format!("SELECT pg_get_tabledef({})", sql_string(&qualified_name))
}

pub async fn get_table_ddl_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
) -> Result<String, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            if let Some(native_config) = db_config.as_ref().filter(|config| is_opengauss_family_config(config)) {
                let native_config = native_config.clone();
                let external_config = config.clone();
                let external_session = session.clone();
                drop(connections);
                return match native_postgres_metadata_pool(state, connection_id, database, &native_config).await {
                    Ok(Some(pool)) => match opengauss_table_ddl(&pool, schema, table).await {
                        Ok(ddl) => Ok(ddl),
                        Err(_) => match pg_ddl(&pool, schema, table).await {
                            Ok(ddl) => Ok(ddl),
                            Err(_) => {
                                external_opengauss_table_ddl(
                                    external_session,
                                    external_config.as_ref(),
                                    database,
                                    schema,
                                    table,
                                )
                                .await
                            }
                        },
                    },
                    _ => {
                        external_opengauss_table_ddl(
                            external_session,
                            external_config.as_ref(),
                            database,
                            schema,
                            table,
                        )
                        .await
                    }
                };
            }
        }
    }

    let pool = get_schema_pool(state, connection_id, database).await?;
    match pool {
        PoolKind::Postgres(p) => opengauss_table_ddl(&p, schema, table).await,
        PoolKind::ExternalDriver { config, session, .. } => {
            // Non-openGauss JDBC plugins do not implement getTableDdl; use
            // getObjectSource (supported) as the DDL source instead.
            session
                .invoke_with_timeout::<String>(
                    "getObjectSource",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "name": table,
                        "object_type": "table",
                    }),
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

fn parse_hex_u32(value: &str, offset: usize) -> Option<u32> {
    let slice = value.get(offset..offset.checked_add(8)?)?;
    u32::from_str_radix(slice, 16).ok()
}

fn is_sql_routine_definition(source: &str) -> bool {
    let mut words = source.split_ascii_whitespace();
    if !words.next().is_some_and(|word| word.eq_ignore_ascii_case("CREATE")) {
        return false;
    }

    let Some(next) = words.next() else {
        return false;
    };
    let kind = if next.eq_ignore_ascii_case("OR") {
        if !words.next().is_some_and(|word| word.eq_ignore_ascii_case("REPLACE")) {
            return false;
        }
        words.next()
    } else {
        Some(next)
    };

    kind.is_some_and(|word| word.eq_ignore_ascii_case("FUNCTION") || word.eq_ignore_ascii_case("PROCEDURE"))
}

fn decode_opengauss_functiondef_record(source: &str) -> Option<String> {
    const RECORD_HEADER_HEX_LEN: usize = 48;
    const INT4_OID: u32 = 23;
    const TEXT_OID: u32 = 25;

    let hex = source.strip_prefix("0x").or_else(|| source.strip_prefix("0X"))?;
    if hex.len() < RECORD_HEADER_HEX_LEN || !hex.is_ascii() || !hex.len().is_multiple_of(2) {
        return None;
    }
    if parse_hex_u32(hex, 0)? != 2
        || parse_hex_u32(hex, 8)? != INT4_OID
        || parse_hex_u32(hex, 16)? != 4
        || parse_hex_u32(hex, 24).is_none()
        || parse_hex_u32(hex, 32)? != TEXT_OID
    {
        return None;
    }

    let definition_len = usize::try_from(parse_hex_u32(hex, 40)?).ok()?;
    let expected_len = RECORD_HEADER_HEX_LEN.checked_add(definition_len.checked_mul(2)?)?;
    if hex.len() != expected_len {
        return None;
    }

    let definition_hex = &hex[RECORD_HEADER_HEX_LEN..];
    let mut definition = Vec::with_capacity(definition_len);
    for pair in definition_hex.as_bytes().as_chunks::<2>().0 {
        let pair = std::str::from_utf8(pair).ok()?;
        definition.push(u8::from_str_radix(pair, 16).ok()?);
    }
    let definition = String::from_utf8(definition).ok()?;
    is_sql_routine_definition(&definition).then_some(definition)
}

fn normalize_routine_object_source(source: String) -> String {
    decode_opengauss_functiondef_record(&source).unwrap_or(source)
}

fn first_string_cell(result: db::QueryResult) -> Result<String, String> {
    result
        .rows
        .into_iter()
        .next()
        .and_then(|row| row.into_iter().next())
        .and_then(|value| match value {
            serde_json::Value::String(s) => Some(s),
            serde_json::Value::Null => None,
            other => Some(other.to_string()),
        })
        .ok_or_else(|| "Object source not found".to_string())
}

fn opengauss_object_source_sql(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, true, true)
}

fn opengauss_package_source_fallback_sql(schema: &str, name: &str, kind: &db::ObjectSourceKind) -> String {
    if matches!(kind, db::ObjectSourceKind::PackageBody) {
        format!(
            "SELECT 'CREATE OR REPLACE PACKAGE BODY ' || quote_ident(n.nspname) || '.' || quote_ident(p.pkgname) || ' AS' || E'\\n' || \
               regexp_replace(regexp_replace(p.pkgbodydeclsrc, '^\\s*PACKAGE\\s+DECLARE\\s*', '', 'i'), '\\s*end\\s*;?\\s*$', '', 'i') || \
               CASE WHEN p.pkgbodyinitsrc IS NOT NULL AND length(btrim(p.pkgbodyinitsrc)) > 0 \
                 THEN E'\\n' || regexp_replace(regexp_replace(p.pkgbodyinitsrc, '^\\s*INSTANTIATION\\s*', '', 'i'), '\\s*end\\s*;?\\s*$', '', 'i') \
                 ELSE '' END || \
               E'\\nEND ' || quote_ident(p.pkgname) || ';' \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE n.nspname = {} AND p.pkgname = {} AND p.pkgbodydeclsrc IS NOT NULL \
             ORDER BY p.oid LIMIT 1",
            sql_string(schema),
            sql_string(name)
        )
    } else {
        format!(
            "SELECT 'CREATE OR REPLACE PACKAGE ' || quote_ident(n.nspname) || '.' || quote_ident(p.pkgname) || ' AS' || E'\\n' || \
               regexp_replace(regexp_replace(p.pkgspecsrc, '^\\s*PACKAGE\\s+DECLARE\\s*', '', 'i'), '\\s*end\\s*;?\\s*$', '', 'i') || \
               E'\\nEND ' || quote_ident(p.pkgname) || ';' \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE n.nspname = {} AND p.pkgname = {} \
             ORDER BY p.oid LIMIT 1",
            sql_string(schema),
            sql_string(name)
        )
    }
}

fn opengauss_sequence_object_source_sql(schema: &str, name: &str, include_cache: bool) -> String {
    let cache_clause = if include_cache {
        "'    cache ' || COALESCE((pg_sequence_last_value(c.oid)).cache_value::text, '1') || E'\\n' || "
    } else {
        ""
    };
    format!(
        "SELECT concat_ws(E'\\n\\n', \
           '-- auto-generated definition' || E'\\n' || \
           'create ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
           'sequence ' || quote_ident(c.relname) || E'\\n' || \
           '    increment by ' || COALESCE(s.increment::text, '1') || E'\\n' || \
           '    minvalue ' || COALESCE(s.minimum_value::text, '1') || E'\\n' || \
           '    maxvalue ' || COALESCE(s.maximum_value::text, '9223372036854775807') || E'\\n' || \
           '    start with ' || COALESCE(s.start_value::text, '1') || E'\\n' || \
           {cache_clause} \
           CASE WHEN upper(COALESCE(s.cycle_option::text, 'NO')) = 'YES' \
             THEN '    cycle;' ELSE '    no cycle;' END, \
           'alter ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
           'sequence ' || quote_ident(c.relname) || ' owner to ' || quote_ident(pg_get_userbyid(c.relowner)) || ';', \
           CASE WHEN owned.relname IS NOT NULL AND a.attname IS NOT NULL \
             THEN 'alter ' || CASE WHEN c.relkind IN ('L','Z') THEN 'large ' ELSE '' END || \
             'sequence ' || quote_ident(c.relname) || ' owned by ' || quote_ident(owned.relname) || '.' || quote_ident(a.attname) || ';' \
           END \
         ) \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         JOIN information_schema.sequences s \
           ON s.sequence_schema = n.nspname AND s.sequence_name = c.relname \
         LEFT JOIN pg_catalog.pg_depend d \
           ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' \
         LEFT JOIN pg_catalog.pg_class owned ON owned.oid = d.refobjid \
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
         WHERE n.nspname = {schema} AND c.relname = {name} AND c.relkind IN ('S','L','z','Z') \
         ORDER BY c.oid LIMIT 1",
        schema = sql_string(schema),
        name = sql_string(name)
    )
}

fn postgres_object_source_sql_without_relispopulated(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, false, false)
}

fn postgres_function_object_source_sql_without_prokind(
    schema: &str,
    name: &str,
    unwrap_opengauss_record: bool,
) -> String {
    let source_expression =
        if unwrap_opengauss_record { "(pg_get_functiondef(p.oid)).definition" } else { "pg_get_functiondef(p.oid)" };
    format!(
        "SELECT {source_expression} \
         FROM pg_proc p \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = {} AND p.proname = {} AND NOT p.proisagg AND NOT p.proiswindow \
         ORDER BY p.oid LIMIT 1",
        sql_string(schema),
        sql_string(name)
    )
}

fn opengauss_routine_gs_source_sql(schema: &str, name: &str, object_type: &db::ObjectSourceKind) -> String {
    let source_type = if matches!(object_type, db::ObjectSourceKind::Procedure) { "procedure" } else { "function" };
    format!(
        "SELECT s.src \
         FROM dbe_pldeveloper.gs_source s \
         JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
         WHERE n.nspname = {} AND s.name = {} AND s.type = '{}' \
         ORDER BY s.id DESC LIMIT 1",
        sql_string(schema),
        sql_string(name),
        source_type
    )
}

fn opengauss_routine_source_fallback_sqls(
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    signature: Option<&str>,
    primary_err: &str,
) -> Vec<(&'static str, String)> {
    let mut fallbacks = Vec::with_capacity(4);
    if matches!(object_type, db::ObjectSourceKind::Function) {
        if !postgres_missing_prokind_error(primary_err) {
            fallbacks.push(("text-return", postgres_object_source_sql(schema, name, object_type, signature)));
        }
        fallbacks.push((
            "record-return without prokind",
            postgres_function_object_source_sql_without_prokind(schema, name, true),
        ));
        fallbacks.push((
            "text-return without prokind",
            postgres_function_object_source_sql_without_prokind(schema, name, false),
        ));
    } else {
        fallbacks.push(("text-return", postgres_object_source_sql(schema, name, object_type, signature)));
    }
    fallbacks.push(("gs_source", opengauss_routine_gs_source_sql(schema, name, object_type)));
    fallbacks
}

fn postgres_object_source_sql_inner(
    schema: &str,
    name: &str,
    kind: &db::ObjectSourceKind,
    signature: Option<&str>,
    include_relispopulated: bool,
    unwrap_opengauss_record: bool,
) -> String {
    match kind {
        db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView => {
            let materialized_populated_clause = if include_relispopulated {
                " || CASE WHEN c.relispopulated THEN ' WITH DATA' ELSE ' WITH NO DATA' END"
            } else {
                ""
            };
            let materialized_viewdef = "regexp_replace(pg_get_viewdef(c.oid, 0), ';[[:space:]]*$', '')";
            let materialized_source_expr = format!(
                "CASE WHEN {materialized_viewdef} ~* '^[[:space:]]*CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?MATERIALIZED[[:space:]]+VIEW[[:space:]]+' \
                 THEN {materialized_viewdef} \
                 ELSE format('CREATE MATERIALIZED VIEW %I.%I AS ', n.nspname, c.relname) || {materialized_viewdef}{materialized_populated_clause} \
                 END"
            );
            format!(
                "SELECT CASE WHEN c.relkind = 'm' THEN {} \
                 ELSE format('CREATE OR REPLACE VIEW %I.%I AS ', n.nspname, c.relname) || pg_get_viewdef(c.oid, 0) \
                 END \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relname = {} AND c.relkind IN ('v','m') \
                 ORDER BY c.oid LIMIT 1",
                materialized_source_expr,
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function => {
            let prokind = if matches!(kind, db::ObjectSourceKind::Procedure) { "p" } else { "f" };
            let source_expression = if unwrap_opengauss_record {
                "(pg_get_functiondef(p.oid)).definition"
            } else {
                "pg_get_functiondef(p.oid)"
            };
            let signature_filter = signature
                .map(|value| format!(" AND pg_get_function_identity_arguments(p.oid) = {}", sql_string(value)))
                .unwrap_or_default();
            let (from_clause, routine_filter) = if unwrap_opengauss_record {
                if let Some((package, member)) = name.split_once('.') {
                    (
                        "FROM pg_proc p JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid JOIN pg_catalog.pg_namespace n ON n.oid = pkg.pkgnamespace".to_string(),
                        format!(
                            "n.nspname = {} AND pkg.pkgname = {} AND p.proname = {}",
                            sql_string(schema),
                            sql_string(package),
                            sql_string(member)
                        ),
                    )
                } else {
                    (
                        "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace".to_string(),
                        format!("n.nspname = {} AND p.proname = {}", sql_string(schema), sql_string(name)),
                    )
                }
            } else {
                (
                    "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace".to_string(),
                    format!("n.nspname = {} AND p.proname = {}", sql_string(schema), sql_string(name)),
                )
            };
            format!(
                "SELECT {source_expression} {from_clause} WHERE {routine_filter} AND p.prokind = '{}'{} ORDER BY p.oid LIMIT 1",
                prokind,
                signature_filter
            )
        }
        db::ObjectSourceKind::Sequence => {
            if unwrap_opengauss_record {
                return opengauss_sequence_object_source_sql(schema, name, true);
            }
            format!(
                "SELECT concat_ws(E'\\n\\n', \
                   '-- auto-generated definition' || E'\\n' || \
                   'create sequence ' || quote_ident(c.relname) || E'\\n' || \
                   '    as ' || pg_catalog.format_type(s.seqtypid, NULL) || ';', \
                   'alter sequence ' || quote_ident(c.relname) || ' owner to ' || quote_ident(pg_get_userbyid(c.relowner)) || ';', \
                   CASE WHEN owned.relname IS NOT NULL AND a.attname IS NOT NULL \
                     THEN 'alter sequence ' || quote_ident(c.relname) || ' owned by ' || quote_ident(owned.relname) || '.' || quote_ident(a.attname) || ';' \
                   END \
                 ) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid \
                 LEFT JOIN pg_catalog.pg_depend d \
                   ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a' \
                 LEFT JOIN pg_catalog.pg_class owned ON owned.oid = d.refobjid \
                 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                 WHERE n.nspname = {} AND c.relname = {} AND c.relkind = 'S' \
                 ORDER BY c.oid LIMIT 1",
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody if unwrap_opengauss_record => {
            let source_type = if matches!(kind, db::ObjectSourceKind::Package) { "package" } else { "package body" };
            format!(
                "SELECT s.src \
                 FROM dbe_pldeveloper.gs_source s \
                 JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                 WHERE n.nspname = {} AND s.name = {} AND s.type = '{}' \
                 ORDER BY s.id DESC LIMIT 1",
                sql_string(schema),
                sql_string(name),
                source_type
            )
        }
        db::ObjectSourceKind::Synonym if unwrap_opengauss_record => {
            format!(
                "SELECT format('CREATE OR REPLACE SYNONYM %I.%I FOR %I.%I;', \
                   n.nspname, s.synname, s.synobjschema, s.synobjname) \
                 FROM pg_catalog.pg_synonym s \
                 JOIN pg_catalog.pg_namespace n ON n.oid = s.synnamespace \
                 WHERE n.nspname = {} AND s.synname = {} \
                 ORDER BY s.oid LIMIT 1",
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Job | db::ObjectSourceKind::Scheduler if unwrap_opengauss_record => {
            format!(
                "SELECT '-- openGauss ' || CASE WHEN j.job_name IS NOT NULL AND length(j.job_name) > 0 THEN 'Scheduler: ' || j.job_name ELSE 'Job: #' || j.job_id::text END || CHR(10) || \
                   '-- Status: ' || CASE WHEN j.job_status = 'd' THEN 'disabled' WHEN j.job_status = 'r' THEN 'running' WHEN j.job_status = 'f' THEN 'failed' ELSE 'enabled' END || CHR(10) || \
                   '-- Interval: ' || COALESCE(j.interval, 'null') || CHR(10) || \
                   '-- Next Run: ' || COALESCE(j.next_run_date::text, 'null') || CHR(10) || \
                   '-- Last Run: ' || COALESCE(j.last_start_date::text, 'never') || CHR(10) || \
                   '-- Failures: ' || COALESCE(j.failure_count::text, '0') || CHR(10) || CHR(10) || \
                   COALESCE(p.what, '-- (no action content)') \
                 FROM pg_catalog.pg_job j \
                 LEFT JOIN pg_catalog.pg_job_proc p ON j.job_id = p.job_id \
                 WHERE (j.nspname::text = {} OR (j.nspname IS NULL AND {} = 'public') OR ({} = 'public' AND j.nspname IN ('public', 'dbms_scheduler'))) \
                   AND (j.job_name = {} OR j.job_id::text = {}) \
                   AND j.dbname = current_database()::name \
                 LIMIT 1",
                sql_string(schema),
                sql_string(schema),
                sql_string(schema),
                sql_string(name),
                sql_string(name),
            )
        }
        db::ObjectSourceKind::Type if unwrap_opengauss_record => {
            format!(
                "SELECT 'CREATE TYPE ' || n.nspname || '.' || t.typname || ' AS (' || \
                   string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) || ');' \
                 FROM pg_catalog.pg_type t \
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped \
                 WHERE n.nspname = {} AND t.typname = {} AND t.typtype = 'c' \
                 GROUP BY n.nspname, t.typname \
                 HAVING count(a.attname) > 0 \
                 UNION ALL \
                 SELECT 'CREATE TYPE ' || n.nspname || '.' || t.typname || ' AS ENUM (' || \
                   string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) || ');' \
                 FROM pg_catalog.pg_type t \
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
                 JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid \
                 WHERE n.nspname = {} AND t.typname = {} AND t.typtype = 'e' \
                 GROUP BY n.nspname, t.typname \
                 HAVING count(e.enumlabel) > 0 \
                 LIMIT 1",
                sql_string(schema),
                sql_string(name),
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::TypeBody if unwrap_opengauss_record => {
            format!(
                "SELECT s.src \
                 FROM dbe_pldeveloper.gs_source s \
                 JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                 WHERE n.nspname = {} AND s.name = {} AND s.type = 'type body' \
                 ORDER BY s.id DESC LIMIT 1",
                sql_string(schema),
                sql_string(name)
            )
        }
        db::ObjectSourceKind::Trigger
        | db::ObjectSourceKind::Synonym
        | db::ObjectSourceKind::Package
        | db::ObjectSourceKind::PackageBody
        | db::ObjectSourceKind::Type
        | db::ObjectSourceKind::TypeBody
        | db::ObjectSourceKind::Job
        | db::ObjectSourceKind::Scheduler => "SELECT NULL WHERE FALSE".to_string(),
    }
}

async fn external_opengauss_object_source(
    session: std::sync::Arc<crate::plugins::PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
) -> Result<String, String> {
    let primary_sql = if matches!(object_type, db::ObjectSourceKind::Trigger) {
        postgres_trigger_object_source_sql(schema, name, relation_name)
    } else {
        opengauss_object_source_sql(schema, name, object_type, signature)
    };
    match external_opengauss_query_text(session.clone(), config, database, schema, &primary_sql).await {
        Ok(source) => Ok(source),
        Err(primary_err)
            if postgres_missing_relispopulated_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::View | db::ObjectSourceKind::MaterializedView) =>
        {
            let fallback_sql = postgres_object_source_sql_without_relispopulated(schema, name, object_type, signature);
            external_opengauss_query_text(session, config, database, schema, &fallback_sql)
                .await
                .map_err(|fallback_err| format!("{primary_err}; relispopulated fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if matches!(object_type, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) =>
        {
            let fallback_sql = opengauss_package_source_fallback_sql(schema, name, object_type);
            external_opengauss_query_text(session, config, database, schema, &fallback_sql)
                .await
                .map_err(|fallback_err| format!("{primary_err}; gs_package fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if matches!(object_type, db::ObjectSourceKind::Sequence)
                && opengauss_sequence_cache_metadata_error(&primary_err) =>
        {
            let fallback_sql = opengauss_sequence_object_source_sql(schema, name, false);
            external_opengauss_query_text(session, config, database, schema, &fallback_sql)
                .await
                .map_err(|fallback_err| format!("{primary_err}; sequence cache fallback failed: {fallback_err}"))
        }
        Err(primary_err) if matches!(object_type, db::ObjectSourceKind::Procedure | db::ObjectSourceKind::Function) => {
            let mut errors = vec![primary_err];
            for (label, fallback_sql) in
                opengauss_routine_source_fallback_sqls(schema, name, object_type, signature, &errors[0])
            {
                match external_opengauss_query_text(session.clone(), config, database, schema, &fallback_sql).await {
                    Ok(source) => return Ok(source),
                    Err(fallback_err) => errors.push(format!("{label} fallback failed: {fallback_err}")),
                }
            }
            Err(errors.join("; "))
        }
        Err(primary_err)
            if postgres_missing_prokind_error(&primary_err)
                && matches!(object_type, db::ObjectSourceKind::Function) =>
        {
            let fallback_sql = postgres_function_object_source_sql_without_prokind(schema, name, true);
            external_opengauss_query_text(session, config, database, schema, &fallback_sql)
                .await
                .map_err(|fallback_err| format!("{primary_err}; prokind fallback failed: {fallback_err}"))
        }
        Err(primary_err) if matches!(object_type, db::ObjectSourceKind::View) => {
            let fallback_sql = postgres_view_source_fallback_sql(schema, name);
            external_opengauss_query_text(session, config, database, schema, &fallback_sql)
                .await
                .map_err(|fallback_err| format!("{primary_err}; fallback failed: {fallback_err}"))
        }
        Err(err) => Err(err),
    }
}

pub async fn get_object_source_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    name: &str,
    kind: &ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
) -> Result<crate::types::ObjectSource, String> {
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let db_config = connection_config(state, connection_id).await;
    let raw_source = {
        let connections = state.connections.read().await;
        if let Some(PoolKind::ExternalDriver { config, session, .. }) = connections.get(&pool_key) {
            if db_config.as_ref().is_some_and(is_opengauss_family_config) {
                let native_config = db_config.clone().expect("opengauss family config present");
                let external_config = config.clone();
                let external_session = session.clone();
                drop(connections);
                let source = match native_postgres_metadata_pool(state, connection_id, database, &native_config).await {
                    Ok(Some(pool)) => {
                        match postgres_object_source(&pool, schema, name, kind, signature, relation_name, true).await {
                            Ok(source) => Ok(source),
                            Err(_) => {
                                external_opengauss_object_source(
                                    external_session,
                                    external_config.as_ref(),
                                    database,
                                    schema,
                                    name,
                                    kind,
                                    signature,
                                    relation_name,
                                )
                                .await
                            }
                        }
                    }
                    _ => {
                        external_opengauss_object_source(
                            external_session,
                            external_config.as_ref(),
                            database,
                            schema,
                            name,
                            kind,
                            signature,
                            relation_name,
                        )
                        .await
                    }
                }?;
                source
            } else {
                let config = config.clone();
                let session = session.clone();
                drop(connections);
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
        } else {
            let pool = connections.get(&pool_key).cloned().ok_or_else(|| "Pool not found".to_string())?;
            drop(connections);
            match pool {
                PoolKind::Postgres(p) => {
                    postgres_object_source(&p, schema, name, kind, signature, relation_name, true).await?
                }
                _ => String::new(),
            }
        }
    };

    let final_source = if matches!(kind, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        normalize_routine_object_source(raw_source)
    } else {
        raw_source
    };

    Ok(crate::types::ObjectSource {
        name: name.to_string(),
        object_type: kind.clone(),
        schema: Some(schema.to_string()),
        source: final_source,
        editable: Some(true),
    })
}

pub fn postgres_trigger_object_source_sql(schema: &str, name: &str, relation_name: Option<&str>) -> String {
    let relation_filter = relation_name.map(|r| format!(" AND c.relname = {}", sql_string(r))).unwrap_or_default();
    format!(
        "SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t \
         JOIN pg_class c ON c.oid = t.tgrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND t.tgname = {}{} AND NOT t.tgisinternal LIMIT 1",
        sql_string(schema),
        sql_string(name),
        relation_filter
    )
}

pub fn postgres_view_source_fallback_sql(schema: &str, name: &str) -> String {
    format!(
        "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relname = {} LIMIT 1",
        sql_string(schema),
        sql_string(name)
    )
}

pub fn postgres_object_source_sql(
    schema: &str,
    name: &str,
    kind: &ObjectSourceKind,
    signature: Option<&str>,
) -> String {
    postgres_object_source_sql_inner(schema, name, kind, signature, true, false)
}

fn postgres_missing_prokind_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("does not exist")
        && (lower.contains("column p.prokind")
            || lower.contains("column \"p\".\"prokind\"")
            || lower.contains("column \"prokind\""))
}

fn opengauss_sequence_cache_metadata_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("pg_sequence_last_value") || lower.contains("cache_value")
}

fn postgres_missing_relispopulated_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("does not exist")
        && (lower.contains("column c.relispopulated")
            || lower.contains("column \"c\".\"relispopulated\"")
            || lower.contains("column \"relispopulated\""))
}

pub async fn postgres_object_source(
    pool: &deadpool_postgres::Pool,
    schema: &str,
    name: &str,
    kind: &ObjectSourceKind,
    signature: Option<&str>,
    relation_name: Option<&str>,
    unwrap_opengauss_record: bool,
) -> Result<String, String> {
    let sql = if matches!(kind, ObjectSourceKind::Trigger) {
        postgres_trigger_object_source_sql(schema, name, relation_name)
    } else if unwrap_opengauss_record {
        opengauss_object_source_sql(schema, name, kind, signature)
    } else {
        postgres_object_source_sql(schema, name, kind, signature)
    };
    match db::postgres::execute_query(pool, &sql).await.and_then(first_string_cell) {
        Ok(source) => Ok(source),
        Err(primary_err)
            if postgres_missing_relispopulated_error(&primary_err)
                && matches!(kind, ObjectSourceKind::View | ObjectSourceKind::MaterializedView) =>
        {
            let fallback_sql = postgres_object_source_sql_without_relispopulated(schema, name, kind, signature);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; relispopulated fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if unwrap_opengauss_record && matches!(kind, ObjectSourceKind::Package | ObjectSourceKind::PackageBody) =>
        {
            let fallback_sql = opengauss_package_source_fallback_sql(schema, name, kind);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; gs_package fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if unwrap_opengauss_record
                && matches!(kind, ObjectSourceKind::Sequence)
                && opengauss_sequence_cache_metadata_error(&primary_err) =>
        {
            let fallback_sql = opengauss_sequence_object_source_sql(schema, name, false);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; sequence cache fallback failed: {fallback_err}"))
        }
        Err(primary_err)
            if unwrap_opengauss_record && matches!(kind, ObjectSourceKind::Procedure | ObjectSourceKind::Function) =>
        {
            let mut errors = vec![primary_err];
            for (label, fallback_sql) in
                opengauss_routine_source_fallback_sqls(schema, name, kind, signature, &errors[0])
            {
                match db::postgres::execute_query(pool, &fallback_sql).await.and_then(first_string_cell) {
                    Ok(source) => return Ok(source),
                    Err(fallback_err) => errors.push(format!("{label} fallback failed: {fallback_err}")),
                }
            }
            Err(errors.join("; "))
        }
        Err(primary_err)
            if postgres_missing_prokind_error(&primary_err) && matches!(kind, ObjectSourceKind::Function) =>
        {
            let fallback_sql = postgres_function_object_source_sql_without_prokind(schema, name, true);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; prokind fallback failed: {fallback_err}"))
        }
        Err(primary_err) if matches!(kind, ObjectSourceKind::View) => {
            let fallback_sql = postgres_view_source_fallback_sql(schema, name);
            db::postgres::execute_query(pool, &fallback_sql)
                .await
                .and_then(first_string_cell)
                .map_err(|fallback_err| format!("{primary_err}; fallback failed: {fallback_err}"))
        }
        Err(err) => Err(err),
    }
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
