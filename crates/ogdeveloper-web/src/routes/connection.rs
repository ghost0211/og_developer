use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::{ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config: ConnectionConfig,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDatabaseConnectionRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdentifierQuoteRequest {
    pub connection_id: String,
    pub database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionDatabaseInfoRequest {
    pub connection_id: String,
    pub database_info: Option<DatabaseConnectionInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionsRequest {
    pub configs: Vec<ConnectionConfig>,
}

fn is_connection_info_capability_unsupported(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("connectioninfo")
        && (error.contains("unsupported") || error.contains("unknown method") || error.contains("method not found"))
}

async fn run_temporary_connection_test(
    app: &Arc<AppState>,
    config: ConnectionConfig,
    include_database_info: bool,
) -> Result<ConnectionTestResult, String> {
    let temp_id = format!("__test_{}", uuid::Uuid::new_v4());
    app.configs.write().await.insert(temp_id.clone(), config.clone());

    let pool_result = app.get_or_create_pool(&temp_id, config.database.as_deref()).await;
    let database_info = if include_database_info {
        match &pool_result {
            Ok(_) => match app.connection_database_info(&temp_id, config.database.as_deref()).await {
                Ok(info) => info,
                Err(error) if is_connection_info_capability_unsupported(&error) => {
                    log::debug!("Connection information capability is unavailable: {error}");
                    None
                }
                Err(error) => {
                    log::warn!("Failed to read optional connection information: {error}");
                    None
                }
            },
            Err(_) => None,
        }
    } else {
        None
    };

    app.remove_connection_pools(&temp_id).await;
    app.reset_connection_transport_for_config(&temp_id, &config).await;
    app.configs.write().await.remove(&temp_id);

    pool_result.map(|_| ConnectionTestResult::success("Connection successful").with_database_info(database_info))
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    run_temporary_connection_test(&state.app, body.config, false)
        .await
        .map(|result| Json(result.message))
        .map_err(AppError::from)
}

pub async fn test_connection_with_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<ConnectionTestResult>, AppError> {
    run_temporary_connection_test(&state.app, body.config, true).await.map(Json).map_err(AppError::from)
}

pub async fn connect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    let app = &state.app;
    let connection_id = config.id.clone();
    let attempt = app.begin_connection_attempt_with_client_attempt(&connection_id, body.client_attempt).await;

    app.remove_connection_pools_detached(&connection_id).await;
    app.reset_connection_transport_for_config(&connection_id, &config).await;
    app.configs.write().await.insert(connection_id.clone(), config.clone());

    app.get_or_create_pool_for_connection_attempt(&connection_id, None, attempt).await.map_err(AppError::from)?;

    Ok(Json(connection_id))
}

pub async fn connected_database_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<Option<DatabaseConnectionInfo>>, AppError> {
    state
        .app
        .connection_database_info(&body.connection_id, body.database.as_deref())
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn save_connection_database_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveConnectionDatabaseInfoRequest>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .save_connection_database_info(&body.connection_id, body.database_info)
        .await
        .map(|_| Json(()))
        .map_err(AppError::from)
}

pub async fn connection_final_proxy_port(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<u16>, AppError> {
    let runtime_config = body.config.canonicalized();
    if !runtime_config.has_effective_transport_layers() {
        return Err(AppError::from("Connection has no configured transport layers".to_string()));
    }

    let app = &state.app;
    let connection_id = runtime_config.id.clone();
    let db_config = ogdeveloper_core::connection::metadata_connection_config(&runtime_config);
    app.configs.write().await.insert(connection_id.clone(), runtime_config);

    let (_, port) = app.connection_host_port(&connection_id, &db_config).await.map_err(AppError::from)?;
    Ok(Json(port))
}

pub async fn disconnect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    let app = &state.app;

    let should_disconnect = if let Some(client_attempt) = body.client_attempt {
        app.supersede_connection_attempt_if_client_attempt(&body.connection_id, client_attempt).await
    } else {
        app.supersede_connection_attempt(&body.connection_id).await;
        true
    };
    if !should_disconnect {
        return Ok(Json(()));
    }
    app.running_queries.cancel_connection(&body.connection_id);
    app.remove_connection_pools_detached(&body.connection_id).await;
    app.reset_connection_transport(&body.connection_id).await;
    if body.connection_id.starts_with("__visible_draft_") || body.connection_id.starts_with("__visible_schema_draft_") {
        app.configs.write().await.remove(&body.connection_id);
    }

    Ok(Json(()))
}

pub async fn check_connection_health(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    state.app.check_connection_health(&body.connection_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn connection_identifier_quote(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<Option<String>>, AppError> {
    state
        .app
        .connection_identifier_quote(&body.connection_id, body.database.as_deref())
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn close_database_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<CloseDatabaseConnectionRequest>,
) -> Result<Json<bool>, AppError> {
    let database = body.database.trim();
    let database = if database.is_empty() { None } else { Some(database) };
    state.app.close_database_pool(&body.connection_id, database).await.map(Json).map_err(AppError::from)
}

pub async fn save_connections(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveConnectionsRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_connections(&body.configs).await.map_err(AppError::from)?;
    let sync = sync_connection_configs(&state, &body.configs).await;
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    Ok(Json(()))
}

pub async fn load_connections(State(state): State<Arc<WebState>>) -> Result<Json<Vec<ConnectionConfig>>, AppError> {
    let configs = state.app.storage.load_connections().await.map_err(AppError::from)?;
    let sync = sync_connection_configs(&state, &configs).await;
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    Ok(Json(configs))
}

struct ConnectionConfigSync {
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &WebState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.app.configs.write().await;
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

fn is_transient_runtime_config_id(id: &str) -> bool {
    id.starts_with("__test_") || id.starts_with("__visible_draft_") || id.starts_with("__visible_schema_draft_")
}

async fn remove_connection_pools_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.remove_connection_pools_detached(connection_id).await;
    }
}
