use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::connection::{AppState, PoolKind, TransactionSession, TxnConnection};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::sql::{split_sql_statements, starts_with_executable_sql_keyword};

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_ROWS: usize = 10000;
pub const QUERY_CANCELED: &str = "Query canceled";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolErrorAction {
    Keep,
    Discard,
    ReconnectAndRetry,
}

#[derive(Debug, Clone)]
pub enum QueryExecutionError {
    DuckDb { code: String, message: String },
    Canceled { stage: String, operation_outcome: String },
    Timeout(String),
    Sql(String),
    Legacy(String),
}

impl std::fmt::Display for QueryExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuckDb { message, .. } => write!(f, "{message}"),
            Self::Canceled { .. } => write!(f, "{}", canceled_error()),
            Self::Timeout(error) => write!(f, "{error}"),
            Self::Sql(error) => write!(f, "{error}"),
            Self::Legacy(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for QueryExecutionError {}

impl From<String> for QueryExecutionError {
    fn from(s: String) -> Self {
        Self::Legacy(s)
    }
}

impl From<&str> for QueryExecutionError {
    fn from(s: &str) -> Self {
        Self::Legacy(s.to_string())
    }
}

impl QueryExecutionError {
    pub fn into_legacy_string(self) -> String {
        self.to_string()
    }

    pub fn into_backend_error(self) -> crate::backend_error::BackendError {
        crate::backend_error::BackendError::from_legacy_backend(&self.to_string())
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecuteMultiResult {
    #[serde(flatten)]
    pub result: db::QueryResult,
    #[serde(skip_serializing_if = "is_false")]
    pub execution_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::backend_error::BackendError>,
    #[serde(skip_serializing_if = "is_false")]
    pub server_message: bool,
}

impl ExecuteMultiResult {
    pub fn success(result: db::QueryResult) -> Self {
        Self { result, execution_error: false, statement_index: None, error: None, server_message: false }
    }

    pub fn success_with_index(result: db::QueryResult, statement_index: usize) -> Self {
        Self {
            result,
            execution_error: false,
            statement_index: Some(statement_index),
            error: None,
            server_message: false,
        }
    }

    pub fn execution_error(result: db::QueryResult) -> Self {
        let err_msg = result.columns.first().cloned().unwrap_or_default();
        let backend_error = crate::backend_error::BackendError::from_legacy_backend(&err_msg);
        Self { result, execution_error: true, statement_index: None, error: Some(backend_error), server_message: false }
    }

    pub fn execution_error_with_index(result: db::QueryResult, statement_index: usize) -> Self {
        let err_msg = result.columns.first().cloned().unwrap_or_default();
        let backend_error = crate::backend_error::BackendError::from_legacy_backend(&err_msg);
        Self {
            result,
            execution_error: true,
            statement_index: Some(statement_index),
            error: Some(backend_error),
            server_message: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExecuteMultiProgress {
    pub statement_index: usize,
    pub completed: usize,
    pub total: usize,
    pub success: bool,
    pub execution_time_ms: u128,
    pub affected_rows: u64,
    pub error: Option<crate::backend_error::BackendError>,
}

pub type ExecuteMultiProgressCallback = Arc<dyn Fn(ExecuteMultiProgress) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct DbOperationBudget {
    pub checkout_timeout: Duration,
    pub connect_timeout: Duration,
    pub recycle_timeout: Duration,
    pub query_timeout: Option<Duration>,
    pub cancel_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl Default for DbOperationBudget {
    fn default() -> Self {
        Self {
            checkout_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(10),
            recycle_timeout: Duration::from_secs(5),
            query_timeout: Some(QUERY_TIMEOUT),
            cancel_timeout: Duration::from_secs(5),
            cleanup_timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueryExecutionMode {
    #[default]
    Normal,
    PostgresReadOnlyTransaction,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryExecutionOptions {
    #[serde(default)]
    pub max_rows: Option<usize>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub execution_id: Option<String>,
    #[serde(default)]
    pub execution_mode: QueryExecutionMode,
    #[serde(default)]
    pub stream_results: bool,
    #[serde(default)]
    pub result_session_id: Option<String>,
    #[serde(default)]
    pub page_size: Option<usize>,
    #[serde(default)]
    pub fetch_size: Option<usize>,
    #[serde(default)]
    pub client_session_id: Option<String>,
    #[serde(default)]
    pub use_transaction: Option<bool>,
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub continue_on_error: bool,
}

fn empty_query_result(execution_time_ms: u128) -> db::QueryResult {
    db::QueryResult { execution_time_ms, ..Default::default() }
}

fn error_query_result(message: String) -> db::QueryResult {
    let mut res = empty_query_result(0);
    res.columns = vec![message];
    res
}

pub async fn check_read_only_for_connection(state: &AppState, pool_key: &str, sql: &str) -> Result<(), String> {
    let configs = state.configs.read().await;
    if let Some(config) = crate::connection::config_for_pool_key(pool_key, &configs) {
        if config.read_only {
            crate::query_execution_sql::check_read_only(sql, &config.name, config.db_type)?;
        }
    }
    Ok(())
}

pub async fn check_read_only_for_connection_multi(
    state: &AppState,
    pool_key: &str,
    statements: &[String],
) -> Result<(), String> {
    for stmt in statements {
        check_read_only_for_connection(state, pool_key, stmt).await?;
    }
    Ok(())
}

pub async fn connection_readonly_name(state: &AppState, connection_id: &str) -> Option<String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).filter(|c| c.read_only).map(|c| c.name.clone())
}

async fn connection_database_type(state: &AppState, connection_id: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    configs.get(connection_id).map(|c| c.db_type)
}

async fn connection_database_type_for_pool_key(state: &AppState, pool_key: &str) -> Option<DatabaseType> {
    let configs = state.configs.read().await;
    crate::connection::config_for_pool_key(pool_key, &configs).map(|c| c.db_type)
}

pub fn truncate_result(result: db::QueryResult) -> db::QueryResult {
    truncate_result_with_max_rows(result, Some(MAX_ROWS))
}

pub fn truncate_result_with_max_rows(mut result: db::QueryResult, max_rows: Option<usize>) -> db::QueryResult {
    if let Some(limit) = max_rows {
        if result.rows.len() > limit {
            result.rows.truncate(limit);
        }
    }
    result
}

pub fn is_connection_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("connection reset")
        || lower.contains("server closed the connection")
        || lower.contains("terminating connection")
        || lower.contains("connection refused")
        || lower.contains("timeout")
}

pub fn pool_error_action(db_type: Option<DatabaseType>, err: &str) -> PoolErrorAction {
    match db_type {
        Some(DatabaseType::Postgres | DatabaseType::OpenGauss) => {
            if is_connection_error(err) {
                PoolErrorAction::Discard
            } else {
                PoolErrorAction::Keep
            }
        }
        _ => PoolErrorAction::Keep,
    }
}

pub fn should_discard_pool_after_error(db_type: Option<DatabaseType>, err: &str) -> bool {
    pool_error_action(db_type, err) == PoolErrorAction::Discard
}

async fn discard_pool_after_error(state: &AppState, pool_key: &str, db_type: Option<DatabaseType>, err: &str) {
    if should_discard_pool_after_error(db_type, err) {
        let mut connections = state.connections.write().await;
        connections.remove(pool_key);
    }
}

pub fn timeout_error() -> String {
    "Query timed out".to_string()
}

pub fn canceled_error() -> String {
    "Query canceled".to_string()
}

pub fn is_canceled(cancel_token: &Option<CancellationToken>) -> bool {
    cancel_token.as_ref().is_some_and(|token| token.is_cancelled())
}

pub(crate) struct StreamProgressClock {
    started_at: tokio::time::Instant,
    last_progress_ms: AtomicU64,
}

impl StreamProgressClock {
    pub(crate) fn new() -> Self {
        Self { started_at: tokio::time::Instant::now(), last_progress_ms: AtomicU64::new(0) }
    }

    pub(crate) fn mark(&self) {
        self.last_progress_ms.store(self.started_at.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn elapsed_since_progress(&self) -> Duration {
        let last_progress_ms = self.last_progress_ms.load(Ordering::Relaxed);
        let elapsed_ms = self.started_at.elapsed().as_millis() as u64;
        Duration::from_millis(elapsed_ms.saturating_sub(last_progress_ms))
    }
}

pub(crate) async fn await_stream_with_progress_timeout<F, T>(
    stream_future: F,
    timeout: Option<Duration>,
    progress_clock: Arc<StreamProgressClock>,
    cancel_token: Option<&CancellationToken>,
    timeout_message: String,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let Some(timeout) = timeout else {
        return match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => Err(canceled_error()),
                    result = stream_future => result,
                }
            }
            None => stream_future.await,
        };
    };

    tokio::pin!(stream_future);
    loop {
        let remaining = timeout.saturating_sub(progress_clock.elapsed_since_progress());
        if remaining.is_zero() {
            return Err(timeout_message.clone());
        }
        let sleep = tokio::time::sleep(remaining);
        tokio::pin!(sleep);

        match cancel_token {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(canceled_error()),
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
            None => {
                tokio::select! {
                    biased;
                    result = &mut stream_future => return result,
                    _ = &mut sleep => {},
                }
            }
        }

        if progress_clock.elapsed_since_progress() >= timeout {
            return Err(timeout_message);
        }
    }
}

pub async fn wait_for_query<F>(cancel_token: Option<CancellationToken>, future: F) -> Result<db::QueryResult, String>
where
    F: std::future::Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_query_opt(cancel_token, Some(QUERY_TIMEOUT), future).await
}

pub async fn wait_for_query_with_timeout<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Duration,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: std::future::Future<Output = Result<db::QueryResult, String>>,
{
    wait_for_query_opt(cancel_token, Some(timeout_duration), future).await
}

pub async fn wait_for_query_opt<F>(
    cancel_token: Option<CancellationToken>,
    timeout_duration: Option<Duration>,
    future: F,
) -> Result<db::QueryResult, String>
where
    F: std::future::Future<Output = Result<db::QueryResult, String>>,
{
    if let Some(token) = cancel_token {
        tokio::select! {
            _ = token.cancelled() => Err(canceled_error()),
            result = async {
                if let Some(timeout_dur) = timeout_duration {
                    match tokio::time::timeout(timeout_dur, future).await {
                        Ok(res) => res,
                        Err(_) => Err(timeout_error()),
                    }
                } else {
                    future.await
                }
            } => result,
        }
    } else if let Some(timeout_dur) = timeout_duration {
        match tokio::time::timeout(timeout_dur, future).await {
            Ok(res) => res,
            Err(_) => Err(timeout_error()),
        }
    } else {
        future.await
    }
}

pub async fn operation_budget_for_pool_key(
    state: &AppState,
    pool_key: &str,
    query_timeout: Option<Duration>,
) -> DbOperationBudget {
    let configs = state.configs.read().await;
    let config = crate::connection::config_for_pool_key(pool_key, &configs);
    let connect_timeout =
        config.map(|c| Duration::from_secs(c.connect_timeout_secs)).unwrap_or(Duration::from_secs(10));
    DbOperationBudget { connect_timeout, query_timeout, ..Default::default() }
}

fn resolve_query_timeout(timeout_secs: Option<u64>) -> Option<Duration> {
    match timeout_secs {
        Some(0) => None,
        Some(s) => Some(Duration::from_secs(s)),
        None => Some(QUERY_TIMEOUT),
    }
}

fn postgres_prefers_text_protocol(_db_type: Option<DatabaseType>) -> bool {
    false
}

async fn guard_gms_output_capture_outcome(
    state: &AppState,
    pool_key: &str,
    capture_gms_output: bool,
    outcome: Result<db::QueryResult, String>,
) -> Result<db::QueryResult, String> {
    if capture_gms_output && outcome.is_err() {
        state.mark_gms_output_capture_unsupported(pool_key).await;
    }
    outcome
}

fn external_driver_query_params(
    config: &ConnectionConfig,
    database: &str,
    schema: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
) -> serde_json::Value {
    serde_json::json!({
        "connection": config,
        "sql": sql,
        "database": database,
        "schema": schema,
        "maxRows": max_rows,
    })
}

fn external_driver_fetch_query_page_params(
    config: &ConnectionConfig,
    session_id: &str,
    page_size: usize,
) -> serde_json::Value {
    serde_json::json!({
        "connection": config,
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub fn agent_execute_query_params(
    database: &str,
    schema: Option<&str>,
    sql: &str,
    max_rows: Option<usize>,
) -> serde_json::Value {
    serde_json::json!({
        "database": database,
        "schema": schema,
        "sql": sql,
        "maxRows": max_rows,
    })
}

pub fn agent_execute_query_page_params(
    database: &str,
    schema: Option<&str>,
    sql: &str,
    page_size: usize,
) -> serde_json::Value {
    serde_json::json!({
        "database": database,
        "schema": schema,
        "sql": sql,
        "pageSize": page_size,
    })
}

pub fn agent_fetch_query_page_params(session_id: &str, page_size: usize) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "pageSize": page_size,
    })
}

pub fn agent_close_query_session_params(session_id: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
    })
}

pub async fn do_execute(
    state: &AppState,
    pool_key: &str,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    do_execute_typed(state, pool_key, database, sql, schema, cancel_token, options)
        .await
        .map_err(|e| e.into_legacy_string())
}

async fn do_execute_typed(
    state: &AppState,
    pool_key: &str,
    database: Option<&str>,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, QueryExecutionError> {
    if let Some(execution_id) = options.execution_id.as_deref() {
        state.running_queries.set_pool_key(execution_id, pool_key.to_string());
    }
    state.touch_pool_activity(pool_key).await;
    let _activity_touch = state.pool_activity_touch(pool_key);

    let query_timeout = resolve_query_timeout(options.timeout_secs);
    let read_only_connection = {
        let configs = state.configs.read().await;
        let config = crate::connection::config_for_pool_key(pool_key, &configs);
        config.filter(|config| config.read_only).map(|config| (config.name.clone(), config.db_type))
    };
    let operation_budget = operation_budget_for_pool_key(state, pool_key, query_timeout).await;
    if let Some((name, database_type)) = read_only_connection {
        crate::query_execution_sql::check_read_only(sql, &name, database_type).map_err(QueryExecutionError::Sql)?;
    }
    let pool_db_type = connection_database_type_for_pool_key(state, pool_key).await;
    let connections = state.connections.read().await;
    let pool = connections
        .get(pool_key)
        .or_else(|| connections.get(pool_key.split(':').next().unwrap_or(pool_key)))
        .ok_or_else(|| QueryExecutionError::Legacy("Connection not found".to_string()))?;

    let result: Result<db::QueryResult, String> = match pool {
        PoolKind::Postgres(p) => {
            let p = p.clone();
            let schema = schema.map(|s| s.to_string());
            let max_rows = options.max_rows;
            let prefer_text_protocol = postgres_prefers_text_protocol(pool_db_type);
            let capture_gms_output = matches!(pool_db_type, Some(DatabaseType::OpenGauss))
                && !state.is_gms_output_capture_unsupported(pool_key).await;
            let notice_receiver = if matches!(pool_db_type, Some(DatabaseType::OpenGauss)) {
                state.get_postgres_notice_receiver(pool_key).await
            } else {
                None
            };
            let execution_mode = options.execution_mode;
            let cancel_context = state.get_postgres_cancel_context(pool_key).await;
            drop(connections);
            if execution_mode == QueryExecutionMode::PostgresReadOnlyTransaction {
                db::postgres::execute_query_in_read_only_transaction_with_rollback(
                    &p,
                    schema.as_deref(),
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                )
                .await
            } else if let Some(schema) = schema {
                let outcome = db::postgres::execute_query_with_schema_and_max_rows_and_cancel(
                    &p,
                    &schema,
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                    prefer_text_protocol,
                    capture_gms_output,
                    notice_receiver,
                )
                .await;
                guard_gms_output_capture_outcome(state, pool_key, capture_gms_output, outcome).await
            } else {
                let outcome = db::postgres::execute_query_with_max_rows_and_cancel(
                    &p,
                    sql,
                    max_rows,
                    cancel_token,
                    operation_budget.clone(),
                    cancel_context,
                    prefer_text_protocol,
                    capture_gms_output,
                    notice_receiver,
                )
                .await;
                guard_gms_output_capture_outcome(state, pool_key, capture_gms_output, outcome).await
            }
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            let sql = sql.to_string();
            let schema = schema.map(str::to_string);
            let database = database.unwrap_or_else(|| config.effective_database().unwrap_or("")).to_string();
            let max_rows = options.max_rows;
            let plugin_timeout = query_timeout;
            drop(connections);
            wait_for_query_opt(cancel_token, query_timeout, async move {
                if let Some(session_id) = options.result_session_id.as_deref() {
                    let params = external_driver_fetch_query_page_params(
                        config.as_ref(),
                        session_id,
                        options.page_size.unwrap_or(MAX_ROWS),
                    );
                    session.invoke_with_timeout::<db::QueryResult>("fetchQueryPage", params, plugin_timeout).await
                } else if options.stream_results || options.page_size.is_some() || options.fetch_size.is_some() {
                    let params = external_driver_query_params(
                        config.as_ref(),
                        &database,
                        schema.as_deref(),
                        &sql,
                        options.page_size.or(options.fetch_size).or(Some(MAX_ROWS)),
                    );
                    session.invoke_with_timeout::<db::QueryResult>("executeQueryPage", params, plugin_timeout).await
                } else {
                    let params =
                        external_driver_query_params(config.as_ref(), &database, schema.as_deref(), &sql, max_rows);
                    session.invoke_with_timeout::<db::QueryResult>("executeQuery", params, plugin_timeout).await
                }
            })
            .await
        }
    };

    match result {
        Ok(res) => Ok(res),
        Err(err) => {
            discard_pool_after_error(state, pool_key, pool_db_type, &err).await;
            Err(QueryExecutionError::Sql(err))
        }
    }
}

pub async fn execute_sql_statement(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    execute_sql_statement_with_options(state, connection_id, database, sql, schema, cancel_token, options).await
}

pub async fn execute_sql_statement_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, String> {
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, Some(database), options.client_session_id.as_deref())
        .await?;
    do_execute(state, &pool_key, Some(database), sql, schema, cancel_token, options).await
}

pub async fn execute_sql_statement_with_options_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<db::QueryResult, QueryExecutionError> {
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, Some(database), options.client_session_id.as_deref())
        .await
        .map_err(QueryExecutionError::Legacy)?;
    do_execute_typed(state, &pool_key, Some(database), sql, schema, cancel_token, options).await
}

pub async fn close_query_session(
    state: &AppState,
    connection_id: &str,
    database: &str,
    session_id: &str,
    client_session_id: Option<&str>,
    _catalog: Option<&str>,
) -> Result<(), String> {
    let pool_key = state
        .get_or_create_pool_for_session(connection_id, Some(database), client_session_id)
        .await
        .unwrap_or_else(|_| connection_id.to_string());
    let connections = state.connections.read().await;
    let pool = connections.get(&pool_key).or_else(|| connections.get(connection_id));
    let Some(pool) = pool else {
        return Ok(());
    };
    if let PoolKind::ExternalDriver { config, session, .. } = pool {
        let config = config.clone();
        let session = session.clone();
        drop(connections);
        let params = external_driver_fetch_query_page_params(config.as_ref(), session_id, 1);
        let _ = session.invoke::<serde_json::Value>("closeQuerySession", params).await;
    }
    Ok(())
}

pub async fn execute_multi_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        QueryExecutionOptions::default(),
    )
    .await
}

pub async fn execute_multi_core_with_options(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options_for_client_and_progress_typed(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        options,
        None,
    )
    .await
    .map_err(|e| e.into_legacy_string())
}

pub async fn execute_multi_core_with_options_for_client(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options(state, connection_id, database, sql, schema, cancel_token, options).await
}

pub async fn execute_multi_core_with_options_for_client_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
) -> Result<Vec<ExecuteMultiResult>, QueryExecutionError> {
    execute_multi_core_with_options_for_client_and_progress_typed(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        options,
        None,
    )
    .await
}

pub async fn execute_multi_core_with_options_for_client_and_progress(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
    progress: Option<ExecuteMultiProgressCallback>,
) -> Result<Vec<ExecuteMultiResult>, String> {
    execute_multi_core_with_options_for_client_and_progress_typed(
        state,
        connection_id,
        database,
        sql,
        schema,
        cancel_token,
        options,
        progress,
    )
    .await
    .map_err(|e| e.into_legacy_string())
}

pub async fn execute_multi_core_with_options_for_client_and_progress_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
    options: QueryExecutionOptions,
    _progress: Option<ExecuteMultiProgressCallback>,
) -> Result<Vec<ExecuteMultiResult>, QueryExecutionError> {
    let statements = split_sql_statements(sql);
    if statements.is_empty() {
        return Ok(Vec::new());
    }

    let pool_key = format!("{connection_id}:{database}");
    let pool_db_type = connection_database_type_for_pool_key(state, &pool_key).await;
    let connections = state.connections.read().await;
    let pool =
        connections.get(&pool_key).ok_or_else(|| QueryExecutionError::Legacy("Connection not found".to_string()))?;

    let (results, pool_action) = match pool {
        PoolKind::Postgres(p) => {
            let p = p.clone();
            let stmts = statements.to_vec();
            let schema = schema.map(|s| s.to_string());
            let cancel_context = state.get_postgres_cancel_context(&pool_key).await;
            let budget =
                operation_budget_for_pool_key(state, &pool_key, resolve_query_timeout(options.timeout_secs)).await;
            drop(connections);
            let mut results = Vec::new();
            for (i, stmt) in stmts.iter().enumerate() {
                let res = db::postgres::execute_query_with_schema_and_max_rows_and_cancel(
                    &p,
                    schema.as_deref().unwrap_or("public"),
                    stmt,
                    options.max_rows,
                    cancel_token.clone(),
                    budget.clone(),
                    cancel_context.clone(),
                    false,
                    false,
                    None,
                )
                .await;
                match res {
                    Ok(r) => results.push(ExecuteMultiResult::success_with_index(r, i)),
                    Err(err) => {
                        let _action = pool_error_action(pool_db_type, &err);
                        results.push(ExecuteMultiResult::execution_error_with_index(error_query_result(err), i));
                        return Ok(results);
                    }
                }
            }
            (results, None::<PoolErrorAction>)
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            let stmts = statements.to_vec();
            drop(connections);
            let mut results = Vec::new();
            for (i, stmt) in stmts.into_iter().enumerate() {
                let params = external_driver_query_params(config.as_ref(), database, schema, &stmt, options.max_rows);
                let res = session.invoke::<db::QueryResult>("executeQuery", params).await;
                match res {
                    Ok(r) => results.push(ExecuteMultiResult::success_with_index(r, i)),
                    Err(e) => {
                        results.push(ExecuteMultiResult::execution_error_with_index(error_query_result(e), i));
                        break;
                    }
                }
            }
            (results, None::<PoolErrorAction>)
        }
    };

    if let Some(action) = pool_action {
        if action == PoolErrorAction::Discard {
            let mut connections = state.connections.write().await;
            connections.remove(&pool_key);
        }
    }

    Ok(results)
}

pub async fn execute_statements(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    cancel_token: Option<CancellationToken>,
) -> Result<Vec<db::QueryResult>, String> {
    let sql = statements.join(";\n");
    let multi_results = execute_multi_core(state, connection_id, database, &sql, schema, cancel_token).await?;
    Ok(multi_results.into_iter().map(|mr| mr.result).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffDeployResult {
    pub success: bool,
    pub executed_statements: usize,
    pub total_statements: usize,
    pub error: Option<String>,
    pub transactional: bool,
}

pub async fn execute_schema_diff_deploy(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<SchemaDiffDeployResult, String> {
    let non_comment_statements: Vec<&String> = statements
        .iter()
        .filter(|s| {
            let trimmed = s.trim();
            !trimmed.is_empty() && !trimmed.starts_with("--")
        })
        .collect();
    if non_comment_statements.is_empty() {
        return Ok(SchemaDiffDeployResult {
            success: true,
            executed_statements: 0,
            total_statements: 0,
            error: None,
            transactional: true,
        });
    }

    let total_statements = statements.len();
    match execute_statements_in_transaction(state, connection_id, database, statements, schema, catalog).await {
        Ok(_) => Ok(SchemaDiffDeployResult {
            success: true,
            executed_statements: total_statements,
            total_statements,
            error: None,
            transactional: true,
        }),
        Err(e) => Ok(SchemaDiffDeployResult {
            success: false,
            executed_statements: 0,
            total_statements,
            error: Some(e),
            transactional: true,
        }),
    }
}

pub async fn execute_statements_in_transaction(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    _catalog: Option<&str>,
) -> Result<db::QueryResult, String> {
    let pool_key = format!("{connection_id}:{database}");
    execute_statements_in_transaction_on_pool(state, &pool_key, connection_id, database, statements, schema, None).await
}

pub async fn execute_statements_in_transaction_typed(
    state: &AppState,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, QueryExecutionError> {
    let pool_key = format!("{connection_id}:{database}");
    execute_statements_in_transaction_on_pool_typed(
        state,
        &pool_key,
        connection_id,
        database,
        statements,
        schema,
        catalog,
    )
    .await
}

pub async fn execute_statements_in_transaction_on_pool(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    catalog: Option<&str>,
) -> Result<db::QueryResult, String> {
    execute_statements_in_transaction_on_pool_typed(
        state,
        pool_key,
        connection_id,
        database,
        statements,
        schema,
        catalog,
    )
    .await
    .map_err(|e| e.into_legacy_string())
}

pub async fn execute_statements_in_transaction_on_pool_typed(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    statements: &[String],
    schema: Option<&str>,
    _catalog: Option<&str>,
) -> Result<db::QueryResult, QueryExecutionError> {
    check_read_only_for_connection_multi(state, pool_key, statements).await.map_err(QueryExecutionError::Sql)?;

    let db_type = connection_database_type(state, connection_id).await;
    let connections = state.connections.read().await;
    let pool =
        connections.get(pool_key).ok_or_else(|| QueryExecutionError::Legacy("Connection not found".to_string()))?;

    let result = match pool {
        PoolKind::Postgres(pg) => {
            let conn = pg.get().await.map_err(|e| QueryExecutionError::Legacy(e.to_string()))?;
            conn.execute("BEGIN", &[]).await.map_err(|e| QueryExecutionError::Legacy(e.to_string()))?;
            if let Some(s) = schema {
                conn.execute(&format!("SET LOCAL search_path TO \"{s}\""), &[])
                    .await
                    .map_err(|e| QueryExecutionError::Legacy(e.to_string()))?;
            }
            for stmt in statements {
                conn.execute(stmt.as_str(), &[]).await.map_err(|e| QueryExecutionError::Legacy(e.to_string()))?;
            }
            conn.execute("COMMIT", &[]).await.map_err(|e| QueryExecutionError::Legacy(e.to_string()))?;
            Ok(empty_query_result(0))
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            let res = session
                .invoke::<db::QueryResult>(
                    "executeTransaction",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "statements": statements,
                        "database": database,
                        "schema": schema,
                    }),
                )
                .await;
            res.map_err(QueryExecutionError::Legacy)
        }
    };

    if let Err(ref err) = result {
        discard_pool_after_error(state, pool_key, db_type, &err.to_string()).await;
    }

    result
}

pub async fn begin_manual_transaction(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<String, String> {
    let pool_key = format!("{connection_id}:{database}");
    let pool_kind = {
        let connections = state.connections.read().await;
        connections.get(&pool_key).cloned().or_else(|| connections.get(connection_id).cloned())
    };
    let Some(pool_kind) = pool_kind else {
        return Err("Connection not found".to_string());
    };

    let txn_conn = match pool_kind {
        PoolKind::Postgres(p) => {
            let conn = p.get().await.map_err(|e| format!("Failed to check out connection from pool: {e}"))?;
            conn.execute("BEGIN", &[]).await.map_err(|e| format!("Failed to BEGIN transaction: {e}"))?;
            if let Some(s) = schema {
                conn.execute(&format!("SET LOCAL search_path TO \"{s}\""), &[])
                    .await
                    .map_err(|e| format!("SET search_path failed: {e}"))?;
            }
            TxnConnection::Postgres(Box::new(conn))
        }
        PoolKind::ExternalDriver { .. } => {
            // openGauss JDBC (ExternalDriver) sessions cannot open a manual
            // transaction; use the native wire pool instead, which speaks
            // the postgres protocol and supports BEGIN snapshots.
            let config = state
                .configs
                .read()
                .await
                .get(connection_id)
                .cloned()
                .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
            if !crate::schema::is_opengauss_family_config(&config) {
                return Err("Manual transactions not supported for this database type".to_string());
            }
            let internal_pool =
                crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?;
            let Some(p) = internal_pool else {
                return Err("Cannot open a backup snapshot: native wire pool unavailable".to_string());
            };
            let conn = p.get().await.map_err(|e| format!("Failed to check out connection from pool: {e}"))?;
            conn.execute("BEGIN", &[]).await.map_err(|e| format!("Failed to BEGIN transaction: {e}"))?;
            if let Some(s) = schema {
                conn.execute(&format!("SET LOCAL search_path TO \"{s}\""), &[])
                    .await
                    .map_err(|e| format!("SET search_path failed: {e}"))?;
            }
            TxnConnection::Postgres(Box::new(conn))
        }
    };

    let txn_session_id = uuid::Uuid::new_v4().to_string();
    let session = TransactionSession {
        connection: Arc::new(tokio::sync::Mutex::new(txn_conn)),
        pool_key: pool_key.clone(),
        last_activity: std::time::Instant::now(),
        busy: false,
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: schema.map(|s| s.to_string()),
    };

    {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.insert(txn_session_id.clone(), session);
    }

    spawn_txn_idle_watcher(state, txn_session_id.clone());
    Ok(txn_session_id)
}

pub async fn begin_database_backup_snapshot(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<String, String> {
    begin_manual_transaction(state, connection_id, database, None).await
}

pub async fn stream_rows_in_manual_transaction<F>(
    state: &AppState,
    txn_session_id: &str,
    sql: &str,
    batch_size: usize,
    mut on_batch: F,
) -> Result<u64, String>
where
    F: FnMut(Vec<Vec<serde_json::Value>>) -> Result<(), String> + Send,
{
    let results = execute_in_manual_transaction(state, txn_session_id, sql, "", None, Some(batch_size)).await?;
    let mut total = 0u64;
    for result in results {
        let count = result.rows.len() as u64;
        total += count;
        on_batch(result.rows)?;
    }
    Ok(total)
}

pub async fn execute_in_manual_transaction(
    state: &AppState,
    txn_session_id: &str,
    sql: &str,
    _database: &str,
    _schema: Option<&str>,
    max_rows: Option<usize>,
) -> Result<Vec<db::QueryResult>, String> {
    let connection = {
        let sessions = state.transaction_sessions.read().await;
        sessions
            .get(txn_session_id)
            .map(|s| Arc::clone(&s.connection))
            .ok_or_else(|| "Transaction session not found".to_string())?
    };

    let row_limit = max_rows.unwrap_or(MAX_ROWS).max(1);
    let mut conn = connection.lock().await;
    let statements = split_sql_statements(sql);
    let mut results = Vec::with_capacity(statements.len());

    for statement in &statements {
        match &mut *conn {
            TxnConnection::Postgres(conn) => {
                let res = execute_manual_txn_postgres_statement(conn.as_ref(), statement, row_limit).await?;
                results.push(res);
            }
        }
    }

    Ok(results)
}

async fn execute_manual_txn_postgres_statement(
    conn: &deadpool_postgres::Object,
    sql: &str,
    row_limit: usize,
) -> Result<db::QueryResult, String> {
    if starts_with_executable_sql_keyword(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH", "TABLE"]) {
        let start = std::time::Instant::now();
        let stmt = conn.prepare_cached(sql).await.map_err(|e| format!("Prepare failed: {e}"))?;
        let columns: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
        let column_types: Vec<String> = stmt.columns().iter().map(|c| c.type_().name().to_string()).collect();
        let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = Vec::new();
        let stream = conn.query_raw(&stmt, params).await.map_err(|e| format!("Query failed: {e}"))?;
        tokio::pin!(stream);
        let mut data: Vec<Vec<serde_json::Value>> = Vec::with_capacity(row_limit.min(1024));
        while let Some(row_result) = stream.next().await {
            if data.len() >= row_limit {
                break;
            }
            let row = row_result.map_err(|e| format!("Query failed: {e}"))?;
            let values: Vec<serde_json::Value> = (0..row.columns().len())
                .map(|i| db::postgres::pg_value_to_json(&row, i, column_types.get(i).map(String::as_str).unwrap_or("")))
                .collect();
            data.push(values);
        }
        Ok(db::QueryResult {
            columns,
            column_types,
            rows: data,
            execution_time_ms: start.elapsed().as_millis(),
            ..Default::default()
        })
    } else {
        let affected = conn.execute(sql, &[]).await.map_err(|e| format!("Query failed: {e}"))?;
        Ok(db::QueryResult { affected_rows: affected, ..Default::default() })
    }
}

async fn rollback_manual_txn_connection(conn: &mut TxnConnection) -> Result<(), String> {
    match conn {
        TxnConnection::Postgres(conn) => {
            conn.execute("ROLLBACK", &[]).await.map_err(|e| format!("ROLLBACK failed: {e}"))?;
        }
    }
    Ok(())
}

fn spawn_txn_idle_watcher(state: &AppState, txn_session_id: String) {
    let sessions = Arc::clone(&state.transaction_sessions);
    tokio::spawn(async move {
        const TXN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
        tokio::time::sleep(TXN_IDLE_TIMEOUT).await;

        let removed: Option<TransactionSession> = {
            let mut guard = sessions.write().await;
            match guard.get(&txn_session_id) {
                Some(session) if !session.busy && session.last_activity.elapsed() >= TXN_IDLE_TIMEOUT => {
                    guard.remove(&txn_session_id)
                }
                _ => None,
            }
        };

        if let Some(session) = removed {
            let mut conn = session.connection.lock().await;
            let _ = rollback_manual_txn_connection(&mut conn).await;
        }
    });
}

pub async fn commit_manual_transaction(state: &AppState, txn_session_id: &str) -> Result<db::QueryResult, String> {
    let session = {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.remove(txn_session_id).ok_or("Transaction session not found")?
    };

    let mut conn = session.connection.lock().await;
    match &mut *conn {
        TxnConnection::Postgres(conn) => {
            conn.execute("COMMIT", &[]).await.map_err(|e| format!("COMMIT failed: {e}"))?;
        }
    }

    Ok(empty_query_result(0))
}

pub async fn rollback_manual_transaction(state: &AppState, txn_session_id: &str) -> Result<db::QueryResult, String> {
    let session = {
        let mut sessions = state.transaction_sessions.write().await;
        sessions.remove(txn_session_id).ok_or("Transaction session not found")?
    };

    let mut conn = session.connection.lock().await;
    rollback_manual_txn_connection(&mut conn).await?;

    Ok(empty_query_result(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_write_sql_basic() {
        assert!(crate::query_execution_sql::is_write_sql("INSERT INTO t VALUES (1)"));
        assert!(!crate::query_execution_sql::is_write_sql("SELECT 1"));
    }

    #[test]
    fn test_external_driver_query_params_includes_connection() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "conn-1",
            "name": "JDBC Conn",
            "db_type": "opengauss",
            "host": "localhost",
            "port": 5432,
            "username": "user",
            "password": "pwd",
            "database": "postgres"
        }))
        .unwrap();

        let params = external_driver_query_params(&config, "postgres", Some("public"), "SELECT 1", Some(100));
        assert!(params.get("connection").is_some(), "params must contain 'connection'");
        assert_eq!(params["connection"]["id"], "conn-1");
        assert_eq!(params["sql"], "SELECT 1");
        assert_eq!(params["database"], "postgres");
        assert_eq!(params["schema"], "public");
        assert_eq!(params["maxRows"], 100);
    }

    #[test]
    fn test_external_driver_fetch_query_page_params_includes_connection() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "conn-1",
            "name": "JDBC Conn",
            "db_type": "opengauss",
            "host": "localhost",
            "port": 5432,
            "username": "user",
            "password": "pwd",
            "database": "postgres"
        }))
        .unwrap();

        let params = external_driver_fetch_query_page_params(&config, "session-123", 500);
        assert!(params.get("connection").is_some(), "params must contain 'connection'");
        assert_eq!(params["connection"]["id"], "conn-1");
        assert_eq!(params["sessionId"], "session-123");
        assert_eq!(params["pageSize"], 500);
    }
}
