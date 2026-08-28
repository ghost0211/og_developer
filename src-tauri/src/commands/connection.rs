use std::collections::HashSet;
use std::sync::Arc;
use tauri::State;

pub use dbx_core::connection::{
    connection_url_for_endpoint, metadata_connection_config, probe_connection_endpoint,
    redacted_connection_url_for_endpoint, AppState, PoolKind,
};
use dbx_core::db;
use dbx_core::models::connection::{ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, DatabaseType};

fn is_transient_runtime_config_id(id: &str) -> bool {
    id.starts_with("__test_") || id.starts_with("__visible_draft_") || id.starts_with("__visible_schema_draft_")
}

#[tauri::command]
pub async fn save_connections(state: State<'_, Arc<AppState>>, configs: Vec<ConnectionConfig>) -> Result<(), String> {
    let configs: Vec<ConnectionConfig> = configs.into_iter().map(|config| config.canonicalized()).collect();
    save_connection_configs(state.inner(), &configs).await
}

async fn save_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> Result<(), String> {
    state.storage.save_connections(configs).await?;
    let sync = sync_connection_configs(state, configs).await;
    remove_connection_pools_for_connection_ids(state, &sync.connection_pool_ids_to_drop).await;
    Ok(())
}

struct ConnectionConfigSync {
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &AppState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.configs.write().await;
    runtime_configs.retain(|id, _existing| {
        if saved_ids.contains(id.as_str()) || is_transient_runtime_config_id(id) {
            true
        } else {
            connection_pool_ids_to_drop.insert(id.clone());
            false
        }
    });
    for config in configs {
        if let Some(previous) = runtime_configs.insert(config.id.clone(), config.clone()) {
            if &previous != config {
                connection_pool_ids_to_drop.insert(config.id.clone());
            }
        }
    }
    ConnectionConfigSync { connection_pool_ids_to_drop: connection_pool_ids_to_drop.into_iter().collect() }
}

async fn remove_connection_pools_for_connection_ids(state: &AppState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.remove_connection_pools_detached(connection_id).await;
    }
}

#[tauri::command]
pub async fn load_connections(state: State<'_, Arc<AppState>>) -> Result<Vec<ConnectionConfig>, String> {
    load_connection_configs(state.inner()).await
}

async fn load_connection_configs(state: &AppState) -> Result<Vec<ConnectionConfig>, String> {
    let configs: Vec<ConnectionConfig> =
        state.storage.load_connections().await?.into_iter().map(|config| config.canonicalized()).collect();
    let sync = sync_connection_configs(state, &configs).await;
    remove_connection_pools_for_connection_ids(state, &sync.connection_pool_ids_to_drop).await;
    Ok(configs)
}

#[tauri::command]
pub async fn save_sidebar_layout(state: State<'_, Arc<AppState>>, layout: serde_json::Value) -> Result<(), String> {
    state.storage.save_sidebar_layout(&layout).await
}

#[tauri::command]
pub async fn load_sidebar_layout(state: State<'_, Arc<AppState>>) -> Result<Option<serde_json::Value>, String> {
    state.storage.load_sidebar_layout().await
}

#[tauri::command]
pub async fn test_connection(state: State<'_, Arc<AppState>>, config: ConnectionConfig) -> Result<String, String> {
    test_connection_with_info_inner(state.inner(), config).await.map(|result| result.message)
}

#[tauri::command]
pub async fn test_connection_with_info(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
) -> Result<ConnectionTestResult, String> {
    test_connection_with_info_inner(state.inner(), config).await
}

async fn test_connection_with_info_inner(
    state: &Arc<AppState>,
    config: ConnectionConfig,
) -> Result<ConnectionTestResult, String> {
    let tunnel_id = format!("{}:test", config.id);
    let has_transport_layers = config.has_effective_transport_layers();
    let connection_id = if has_transport_layers { tunnel_id.as_str() } else { config.id.as_str() };
    let (host, port) = state.connection_host_port(connection_id, &config).await?;
    let probe_result = probe_connection_endpoint(&config, &host, port).await;
    let url = connection_url_for_endpoint(&config, &host, port);
    let target = redacted_connection_url_for_endpoint(&config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());
    log::info!("[test_connection] db_type={:?} target={}", config.db_type, target);
    let mut database_info = None;
    let result = match probe_result {
        Err(e) => Err(e),
        Ok(()) => match config.db_type {
            DatabaseType::Postgres | DatabaseType::OpenGauss => {
                match db::postgres::connect(&url, connect_timeout).await {
                    Ok(pool) => {
                        pool.close();
                        Ok("Connection successful".to_string())
                    }
                    Err(e) => Err(e),
                }
            }
            DatabaseType::Jdbc => match state.test_external_driver_with_info("jdbc", &config).await {
                Ok(details) => {
                    database_info = details.database_info;
                    Ok(details.message)
                }
                Err(err) => Err(err),
            },
        },
    };

    if has_transport_layers {
        state.reset_connection_transport_for_config(&tunnel_id, &config).await;
    }

    result.map(|message| ConnectionTestResult::success(message).with_database_info(database_info))
}

#[tauri::command]
pub async fn connect_db(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
    client_attempt: Option<u64>,
) -> Result<String, String> {
    let config = config.canonicalized();
    let id = config.id.clone();
    let db_config = metadata_connection_config(&config);
    let attempt = state.begin_connection_attempt_with_client_attempt(&id, client_attempt).await;
    let connected_config = config.clone();
    let connected_db_config = db_config.clone();

    state.remove_connection_pools_detached(&id).await;
    state.reset_connection_transport_for_config(&id, &db_config).await;

    let (host, port) = state.connection_host_port(&id, &db_config).await?;
    if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
        state.reset_connection_transport_for_config(&id, &db_config).await;
        return Err(err);
    }
    probe_connection_endpoint(&db_config, &host, port).await?;
    if let Err(err) = state.ensure_current_connection_attempt(&id, Some(attempt)).await {
        state.reset_connection_transport_for_config(&id, &db_config).await;
        return Err(err);
    }
    let url = connection_url_for_endpoint(&db_config, &host, port);
    let connect_timeout = std::time::Duration::from_secs(db_config.effective_connect_timeout_secs());
    let _idle_timeout = std::time::Duration::from_secs(db_config.idle_timeout_secs);

    let pool = match db_config.db_type {
        DatabaseType::Postgres | DatabaseType::OpenGauss => {
            PoolKind::Postgres(db::postgres::connect(&url, connect_timeout).await?)
        }
        DatabaseType::Jdbc => state.external_driver_pool("jdbc", &db_config).await?,
    };

    let pool_key = id.clone();
    state.connections.write().await.insert(pool_key, pool);
    state.configs.write().await.insert(id.clone(), connected_config);
    state.storage.save_connections(&[connected_db_config]).await.map_err(|e| e.to_string())?;

    Ok("Connected".to_string())
}

#[tauri::command]
pub async fn disconnect_db(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.remove_connection_pools_detached(&id).await;
    state.reset_connection_transport(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn close_database_connection(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
) -> Result<(), String> {
    let pool_key = format!("{connection_id}:{database}");
    let mut connections = state.connections.write().await;
    connections.remove(&pool_key);
    Ok(())
}

#[tauri::command]
pub async fn refresh_connections(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let configs = state.storage.load_connections().await?;
    let mut current_configs = state.configs.write().await;
    current_configs.clear();
    for config in configs {
        current_configs.insert(config.id.clone(), config);
    }
    Ok(())
}

#[tauri::command]
pub async fn check_connection_health(state: State<'_, Arc<AppState>>, connection_id: String) -> Result<(), String> {
    let connections = state.connections.read().await;
    if connections.contains_key(&connection_id) {
        Ok(())
    } else {
        Err("Connection not found".to_string())
    }
}

#[tauri::command]
pub async fn connection_identifier_quote(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Option<String>, String> {
    Ok(Some("\"".to_string()))
}

#[tauri::command]
pub async fn connection_database_info(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Option<DatabaseConnectionInfo>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn save_connection_database_info(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    info: DatabaseConnectionInfo,
) -> Result<(), String> {
    state.storage.save_connection_database_info(&connection_id, Some(info)).await
}

pub async fn ensure_connection_writable(state: &AppState, connection_id: &str, _action: &str) -> Result<(), String> {
    dbx_core::query::check_read_only_for_connection(state, connection_id, "").await
}

#[tauri::command]
pub async fn connection_final_proxy_port(
    _state: State<'_, Arc<AppState>>,
    _connection_id: String,
) -> Result<Option<u16>, String> {
    Ok(None)
}
