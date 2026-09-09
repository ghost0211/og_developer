use std::sync::Arc;

use axum::http::HeaderMap;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::storage::McpGlobalPolicy;

use crate::error::AppError;
use crate::state::WebState;

const MCP_REQUEST_HEADER: &str = "x-dbx-mcp-request";

pub fn is_mcp_request(headers: &HeaderMap) -> bool {
    headers.get(MCP_REQUEST_HEADER).and_then(|value| value.to_str().ok()) == Some("1")
}

async fn load_policy(state: &Arc<WebState>) -> Result<McpGlobalPolicy, AppError> {
    state.app.storage.load_mcp_global_policy().await.map(|state| state.policy()).map_err(AppError::from)
}

fn ensure_allowed(policy: &McpGlobalPolicy, connection_id: &str) -> Result<(), AppError> {
    if policy.allowed_connection_ids.as_ref().is_some_and(|allowed| !allowed.iter().any(|id| id == connection_id)) {
        return Err(AppError::from(format!(
            "CONNECTION_OUT_OF_SCOPE: connection '{connection_id}' is not allowed by DBX MCP settings"
        )));
    }
    Ok(())
}

fn connection_read_only_error(message: impl Into<String>) -> AppError {
    AppError::from(format!("CONNECTION_READ_ONLY: {}", message.into()))
}

async fn load_connection(state: &Arc<WebState>, connection_id: &str) -> Result<ConnectionConfig, AppError> {
    state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .find(|config| config.id == connection_id)
        .ok_or_else(|| AppError::from(format!("Connection with id '{connection_id}' not found")))
}

pub async fn ensure_sql(
    state: &Arc<WebState>,
    headers: &HeaderMap,
    connection_id: &str,
    database: &str,
    sql: &str,
    allow_database_switch: bool,
) -> Result<(), AppError> {
    if !is_mcp_request(headers) {
        return Ok(());
    }
    let policy = load_policy(state).await?;
    ensure_allowed(&policy, connection_id)?;
    let config = load_connection(state, connection_id).await?;
    if !allow_database_switch && ogdeveloper_core::sql_risk::mcp_sql_has_forbidden_database_switch(sql, config.db_type)
    {
        return Err(AppError::from(
            "SQL_BLOCKED: MCP does not allow USE or persistent database switching.".to_string(),
        ));
    }
    let is_write = ogdeveloper_core::query_execution_sql::is_write_sql_for_database(sql, config.db_type);
    if policy.read_only && is_write {
        return Err(AppError::from("MCP_READ_ONLY: DBX MCP read-only mode is enabled. SQL write blocked.".to_string()));
    }
    if !policy.allow_dangerous_sql && ogdeveloper_core::sql_risk::is_dangerous_sql_for_database(sql, config.db_type) {
        return Err(AppError::from("SQL_BLOCKED: High-risk SQL is disabled in DBX MCP settings.".to_string()));
    }
    if config.read_only {
        ogdeveloper_core::query_execution_sql::check_read_only(sql, &config.name, config.db_type)
            .map_err(connection_read_only_error)?;
    }
    if is_write && ogdeveloper_core::production_safety::targets_production_database(&config, database, sql) {
        return Err(AppError::from(
            "PRODUCTION_DATABASE_READ_ONLY: SQL write targeting production scope is blocked.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::connection_read_only_error;

    #[test]
    fn connection_read_only_errors_use_the_stable_mcp_code() {
        assert_eq!(connection_read_only_error("write blocked").message, "CONNECTION_READ_ONLY: write blocked");
    }
}
