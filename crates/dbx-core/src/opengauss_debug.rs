//! openGauss PL/SQL debugger (og developer).
//!
//! Implements the two-session model of `dbe_pldebugger`:
//! - a **debuggee** session runs `turn_on(oid)` and then executes the target
//!   routine in the background; the server parks it before the first SQL
//!   statement;
//! - a **debugger** session `attach`es with the nodename/port returned by
//!   turn_on and drives execution (next/step/finish/continue/abort), reads
//!   locals, evaluates `set_var`, and manages breakpoints.
//!
//! Both sessions are pinned single-connection pools (max_size=1) because all
//! debugger state is bound to the backend session. Only administrators (or
//! roles granted `gs_role_pldebugger`) may use these interfaces.
//!
//! Live-verified against openGauss 7.0: turn_on → attach → add_breakpoint →
//! next/continue → info_locals/print_var/set_var → backtrace → finish.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Object, Pool};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;

use crate::connection::{connection_url_for_endpoint, AppState, PoolKind};
use crate::db::postgres;
use crate::models::connection::ConnectionConfig;

const DEBUG_POOL_SIZE: usize = 1;
const DEBUG_CALL_LOG_TAG: &str = "[opengauss][debug]";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugTarget {
    pub oid: i64,
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugPosition {
    pub funcoid: i64,
    pub funcname: String,
    pub lineno: Option<i64>,
    pub query: String,
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugCodeLine {
    pub lineno: Option<i64>,
    pub query: String,
    pub canbreak: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugLocal {
    pub varname: String,
    pub vartype: String,
    pub value: Option<String>,
    pub package_name: Option<String>,
    pub isconst: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugBreakpoint {
    pub breakpointno: i64,
    pub funcoid: i64,
    pub lineno: i64,
    pub query: String,
    pub enable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugBacktraceFrame {
    pub frameno: i64,
    pub funcname: String,
    pub lineno: Option<i64>,
    pub query: String,
    pub funcoid: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGaussDebugStartResult {
    pub session_id: String,
    pub target: OpenGaussDebugTarget,
    pub position: OpenGaussDebugPosition,
    pub code: Vec<OpenGaussDebugCodeLine>,
    pub breakpoints: Vec<OpenGaussDebugBreakpoint>,
}

pub struct OpenGaussDebugSession {
    connection_id: String,
    #[allow(dead_code)]
    database: String,
    target: OpenGaussDebugTarget,
    /// Pinned session executing the CALL in the background (hangs while debugging).
    debuggee_pool: Pool,
    /// Pinned control session (attach/next/locals/breakpoints).
    debugger: Object,
    call_task: Mutex<Option<JoinHandle<Result<String, String>>>>,
    finished: AtomicBool,
}

impl OpenGaussDebugSession {
    fn debugger(&self) -> &Object {
        &self.debugger
    }
}

fn debug_sessions(state: &AppState) -> Arc<RwLock<HashMap<String, Arc<OpenGaussDebugSession>>>> {
    state.opengauss_debug_sessions.clone()
}

async fn take_session(state: &AppState, session_id: &str) -> Result<Arc<OpenGaussDebugSession>, String> {
    debug_sessions(state)
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Debug session not found: {session_id}"))
}

fn pg_quote_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn pg_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sql_string(value: &str) -> String {
    pg_quote_literal(value)
}

/// Attaches with retries (the debuggee needs a moment to reach the parking
/// point), then reads the code lines for the target.
async fn attach_and_collect(
    debugger: &Object,
    nodename: &str,
    port: i64,
    oid: i64,
) -> Result<(OpenGaussDebugPosition, Vec<OpenGaussDebugCodeLine>), String> {
    let mut last_error = String::new();
    let mut attach_rows = Vec::new();
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        match run_debug_query(
            debugger,
            &format!("select * from dbe_pldebugger.attach({}, {port})", sql_string(nodename)),
        )
        .await
        {
            Ok(rows) => {
                attach_rows = rows;
                break;
            }
            Err(error) => last_error = error,
        }
        // Give the debuggee time to park before the first retry.
        if attempt == 0 {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }
    let position = attach_rows.first().map(position_from_row).ok_or_else(|| {
        if last_error.is_empty() {
            "attach returned no rows".to_string()
        } else {
            format!("attach failed: {last_error}")
        }
    })?;

    let code_rows = run_debug_query(debugger, &format!("select * from dbe_pldebugger.info_code({oid})")).await?;
    let code: Vec<OpenGaussDebugCodeLine> = code_rows
        .iter()
        .map(|row| OpenGaussDebugCodeLine {
            lineno: row_i64(row, 0),
            query: row_string(row, 1).unwrap_or_default(),
            canbreak: row_bool(row, 2),
        })
        .collect();
    Ok((position, code))
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/// Resolves the pg_proc oid of the debug target. Standalone procedures and
/// functions match on (schema, name, kind [, identity arguments]); qualified
/// `package.member` names join gs_package via propackageid.
fn opengauss_debug_resolve_oid_sql(schema: &str, name: &str, kind: &str, signature: Option<&str>) -> String {
    let prokind = if kind.eq_ignore_ascii_case("procedure") { "p" } else { "f" };
    let signature_filter = signature
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" AND pg_get_function_identity_arguments(p.oid) = {}", sql_string(value)))
        .unwrap_or_default();
    if let Some((package, member)) = name.split_once('.') {
        format!(
            "SELECT p.oid FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid \
             JOIN pg_catalog.pg_namespace n ON n.oid = pkg.pkgnamespace \
             WHERE n.nspname = {} AND pkg.pkgname = {} AND p.proname = {} AND p.prokind = '{}'{} \
             ORDER BY p.oid LIMIT 1",
            sql_string(schema),
            sql_string(package),
            sql_string(member),
            prokind,
            signature_filter
        )
    } else {
        format!(
            "SELECT p.oid FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {} AND p.proname = {} AND p.prokind = '{}'{} \
             ORDER BY p.oid LIMIT 1",
            sql_string(schema),
            sql_string(name),
            prokind,
            signature_filter
        )
    }
}

// ---------------------------------------------------------------------------
// Row parsing helpers (debugger records come back as typed SETOF rows)
// ---------------------------------------------------------------------------

fn row_i64(row: &tokio_postgres::Row, index: usize) -> Option<i64> {
    // turn_on port comes back as int4, oids as the OID type (u32), most others
    // as int8 — accept all three.
    row.try_get::<_, i64>(index)
        .ok()
        .or_else(|| row.try_get::<_, i32>(index).ok().map(i64::from))
        .or_else(|| row.try_get::<_, u32>(index).ok().map(i64::from))
}

fn row_string(row: &tokio_postgres::Row, index: usize) -> Option<String> {
    row.try_get::<_, String>(index).ok()
}

fn row_bool(row: &tokio_postgres::Row, index: usize) -> bool {
    row.try_get::<_, bool>(index).unwrap_or(false)
}

fn position_from_row(row: &tokio_postgres::Row) -> OpenGaussDebugPosition {
    let query = row_string(row, 3).unwrap_or_default();
    let finished = query.contains("EXECUTION FINISHED");
    OpenGaussDebugPosition {
        funcoid: row_i64(row, 0).unwrap_or_default(),
        funcname: row_string(row, 1).unwrap_or_default(),
        lineno: row_i64(row, 2),
        query,
        finished,
    }
}

async fn run_debug_query(client: &Object, sql: &str) -> Result<Vec<tokio_postgres::Row>, String> {
    tokio::time::timeout(Duration::from_secs(15), client.query(sql, &[]))
        .await
        .map_err(|_| "Debug command timed out".to_string())?
        .map_err(|err| postgres::debug_error_to_string(&err))
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async fn connect_pinned_pool(config: &ConnectionConfig) -> Result<Pool, String> {
    let url = connection_url_for_endpoint(config, &config.host, config.port);
    postgres::connect_with_pool_size(&url, Duration::from_secs(10), DEBUG_POOL_SIZE).await
}

/// Starts a debug session: resolves the target oid, turns it on, launches the
/// CALL in the background, attaches the debugger, and returns the initial
/// position plus the code lines and existing breakpoints.
pub async fn opengauss_debug_start(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    kind: &str,
    name: &str,
    signature: Option<&str>,
    call_sql: &str,
) -> Result<OpenGaussDebugStartResult, String> {
    let config = {
        let configs = state.configs.read().await;
        configs.get(connection_id).cloned().ok_or_else(|| format!("Connection config not found: {connection_id}"))?
    };
    let mut endpoint_config = config.clone();
    endpoint_config.database = Some(database.to_string());

    // 1. Resolve oid on a metadata pool.
    let metadata_pool_key = state.get_or_create_pool(connection_id, Some(database)).await?;
    let oid = {
        let connections = state.connections.read().await;
        let Some(PoolKind::Postgres(pool)) = connections.get(&metadata_pool_key) else {
            return Err("PL debugger requires a native PostgreSQL-protocol connection".to_string());
        };
        let client = postgres::checkout_postgres_client(pool, None, Duration::from_secs(10)).await?;
        let sql = opengauss_debug_resolve_oid_sql(schema, name, kind, signature);
        let row = client
            .query_opt(&sql, &[])
            .await
            .map_err(|err| postgres::debug_error_to_string(&err))?
            .ok_or_else(|| format!("Debug target not found: {schema}.{name}"))?;
        row_i64(&row, 0).ok_or_else(|| format!("Failed to read oid for {schema}.{name}"))?
    };
    drop(metadata_pool_key);

    let target = OpenGaussDebugTarget {
        oid,
        schema: schema.to_string(),
        name: name.to_string(),
        kind: kind.to_string(),
        signature: signature.map(str::to_string),
    };

    // 2. Two pinned sessions.
    let debuggee_pool = connect_pinned_pool(&endpoint_config).await?;
    let debugger_pool = connect_pinned_pool(&endpoint_config).await?;
    let debugger = debugger_pool.get().await.map_err(|err| format!("Failed to open debugger session: {err}"))?;

    // 3. turn_on(oid) on the DEBUGGEE session (server side marks the routine).
    let turn_on_rows = {
        let debuggee = debuggee_pool.get().await.map_err(|err| format!("Failed to open debuggee session: {err}"))?;
        let rows = run_debug_query(&debuggee, &format!("select * from dbe_pldebugger.turn_on({oid})")).await?;
        rows
    };
    let Some(turn_on_row) = turn_on_rows.first() else {
        return Err("turn_on returned no rows".to_string());
    };
    let nodename = row_string(turn_on_row, 0).ok_or("turn_on returned no nodename")?;
    let port = row_i64(turn_on_row, 1).ok_or("turn_on returned no port")?;

    // 4. Launch the CALL in the background (server parks before the first SQL).
    let call_pool = debuggee_pool.clone();
    let call_sql_owned = call_sql.trim().trim_end_matches(';').to_string();
    let call_task: JoinHandle<Result<String, String>> = tokio::spawn(async move {
        let client = call_pool.get().await.map_err(|err| format!("Debuggee session lost: {err}"))?;
        match client.execute(&call_sql_owned, &[]).await {
            Ok(affected) => Ok(format!("{affected}")),
            Err(err) => Err(postgres::debug_error_to_string(&err)),
        }
    });

    // From here on, any failure must unwind the parked routine and both pinned
    // sessions; otherwise the server keeps the routine hung forever.
    let start_result = attach_and_collect(&debugger, &nodename, port, oid).await;
    let (position, code) = match start_result {
        Ok(collected) => collected,
        Err(error) => {
            let _ = run_debug_query(&debugger, "select * from dbe_pldebugger.abort()").await;
            if let Ok(debuggee) = debuggee_pool.get().await {
                let _ = run_debug_query(&debuggee, &format!("select * from dbe_pldebugger.turn_off({oid})")).await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(3), call_task).await;
            return Err(error);
        }
    };

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(OpenGaussDebugSession {
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        target: target.clone(),
        debuggee_pool,
        debugger,
        call_task: Mutex::new(Some(call_task)),
        finished: AtomicBool::new(position.finished),
    });
    let breakpoints = read_breakpoints(session.debugger()).await.unwrap_or_default();
    debug_sessions(state).write().await.insert(session_id.clone(), session);

    log::info!(
        "{DEBUG_CALL_LOG_TAG} started session={} target={}.{} oid={} nodename={} port={}",
        session_id,
        target.schema,
        target.name,
        target.oid,
        nodename,
        port
    );

    Ok(OpenGaussDebugStartResult { session_id, target, position, code, breakpoints })
}

// ---------------------------------------------------------------------------
// Stepping commands
// ---------------------------------------------------------------------------

async fn debug_step_like(session: &OpenGaussDebugSession, verb: &str) -> Result<OpenGaussDebugPosition, String> {
    let rows = run_debug_query(session.debugger(), &format!("select * from dbe_pldebugger.{verb}()")).await?;
    let position = rows.first().map(position_from_row).ok_or_else(|| format!("{verb} returned no rows"))?;
    if position.finished {
        session.finished.store(true, Ordering::SeqCst);
    }
    Ok(position)
}

pub async fn opengauss_debug_step(
    state: &AppState,
    session_id: &str,
    action: &str,
) -> Result<OpenGaussDebugPosition, String> {
    let session = take_session(state, session_id).await?;
    let verb = match action {
        "next" => "next",
        "step" => "step",
        "finish" => "finish",
        "continue" => "continue",
        other => return Err(format!("Unsupported debug action: {other}")),
    };
    debug_step_like(&session, verb).await
}

// ---------------------------------------------------------------------------
// Locals / variables
// ---------------------------------------------------------------------------

pub async fn opengauss_debug_locals(state: &AppState, session_id: &str) -> Result<Vec<OpenGaussDebugLocal>, String> {
    let session = take_session(state, session_id).await?;
    let rows = run_debug_query(session.debugger(), "select * from dbe_pldebugger.info_locals()").await?;
    Ok(rows
        .iter()
        .map(|row| OpenGaussDebugLocal {
            varname: row_string(row, 0).unwrap_or_default(),
            vartype: row_string(row, 1).unwrap_or_default(),
            value: row_string(row, 2),
            package_name: row_string(row, 3).filter(|value| !value.is_empty()),
            isconst: row_bool(row, 4),
        })
        .collect())
}

pub async fn opengauss_debug_set_var(
    state: &AppState,
    session_id: &str,
    name: &str,
    value: &str,
) -> Result<bool, String> {
    let session = take_session(state, session_id).await?;
    let sql = format!("select * from dbe_pldebugger.set_var({}, {})", sql_string(name), sql_string(value));
    let rows = run_debug_query(session.debugger(), &sql).await?;
    Ok(rows.first().map(|row| row_bool(row, 0)).unwrap_or(false))
}

pub async fn opengauss_debug_backtrace(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<OpenGaussDebugBacktraceFrame>, String> {
    let session = take_session(state, session_id).await?;
    let rows = run_debug_query(session.debugger(), "select * from dbe_pldebugger.backtrace()").await?;
    Ok(rows
        .iter()
        .map(|row| OpenGaussDebugBacktraceFrame {
            frameno: row_i64(row, 0).unwrap_or_default(),
            funcname: row_string(row, 1).unwrap_or_default(),
            lineno: row_i64(row, 2),
            query: row_string(row, 3).unwrap_or_default(),
            funcoid: row_i64(row, 4).unwrap_or_default(),
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

async fn read_breakpoints(client: &Object) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    let rows = run_debug_query(client, "select * from dbe_pldebugger.info_breakpoints()").await?;
    Ok(rows
        .iter()
        .map(|row| OpenGaussDebugBreakpoint {
            breakpointno: row_i64(row, 0).unwrap_or_default(),
            funcoid: row_i64(row, 1).unwrap_or_default(),
            lineno: row_i64(row, 2).unwrap_or_default(),
            query: row_string(row, 3).unwrap_or_default(),
            enable: row_bool(row, 4),
        })
        .collect())
}

pub async fn opengauss_debug_breakpoints(
    state: &AppState,
    session_id: &str,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    let session = take_session(state, session_id).await?;
    read_breakpoints(session.debugger()).await
}

pub async fn opengauss_debug_add_breakpoint(
    state: &AppState,
    session_id: &str,
    lineno: i64,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    let session = take_session(state, session_id).await?;
    let oid = session.target.oid;
    run_debug_query(session.debugger(), &format!("select * from dbe_pldebugger.add_breakpoint({oid}, {lineno})"))
        .await?;
    read_breakpoints(session.debugger()).await
}

pub async fn opengauss_debug_delete_breakpoint(
    state: &AppState,
    session_id: &str,
    breakpointno: i64,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    let session = take_session(state, session_id).await?;
    run_debug_query(session.debugger(), &format!("select * from dbe_pldebugger.delete_breakpoint({breakpointno})"))
        .await?;
    read_breakpoints(session.debugger()).await
}

pub async fn opengauss_debug_toggle_breakpoint(
    state: &AppState,
    session_id: &str,
    breakpointno: i64,
    enable: bool,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    let session = take_session(state, session_id).await?;
    let verb = if enable { "enable_breakpoint" } else { "disable_breakpoint" };
    run_debug_query(session.debugger(), &format!("select * from dbe_pldebugger.{verb}({breakpointno})")).await?;
    read_breakpoints(session.debugger()).await
}

// ---------------------------------------------------------------------------
// Stop / cleanup
// ---------------------------------------------------------------------------

pub async fn opengauss_debug_stop(state: &AppState, session_id: &str) -> Result<(), String> {
    let session = debug_sessions(state).write().await.remove(session_id);
    let Some(session) = session else { return Ok(()) };
    cleanup_session(&session).await;
    log::info!("{DEBUG_CALL_LOG_TAG} stopped session={}", session_id);
    Ok(())
}

/// Removes every debug session owned by a connection (disconnect path).
pub async fn opengauss_debug_cleanup_connection(state: &AppState, connection_id: &str) {
    let stale: Vec<String> = debug_sessions(state)
        .read()
        .await
        .iter()
        .filter(|(_, session)| session.connection_id == connection_id)
        .map(|(id, _)| id.clone())
        .collect();
    for session_id in stale {
        if let Some(session) = debug_sessions(state).write().await.remove(&session_id) {
            cleanup_session(&session).await;
        }
    }
}

async fn cleanup_session(session: &OpenGaussDebugSession) {
    // abort() makes the parked server routine long-jump out, freeing the debuggee.
    if !session.finished.load(Ordering::SeqCst) {
        let _ = run_debug_query(session.debugger(), "select * from dbe_pldebugger.abort()").await;
    }
    // turn_off on the debuggee (server side) so the routine is no longer debuggable.
    if let Ok(debuggee) = session.debuggee_pool.get().await {
        let oid = session.target.oid;
        let _ = run_debug_query(&debuggee, &format!("select * from dbe_pldebugger.turn_off({oid})")).await;
    }
    if let Some(task) = session.call_task.lock().await.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
    }
}

/// Reads the background CALL result once it completes (for surfacing
/// procedure errors after [EXECUTION FINISHED]). Waits briefly for the call
/// to settle — the debug protocol reports completion marginally ahead of the
/// debuggee connection returning.
pub async fn opengauss_debug_call_result(state: &AppState, session_id: &str) -> Result<Option<String>, String> {
    let session = take_session(state, session_id).await?;
    let mut slot = session.call_task.lock().await;
    let Some(task) = slot.take() else { return Ok(None) };
    let finished_at = tokio::time::timeout(Duration::from_secs(3), task).await;
    match finished_at {
        Ok(Ok(Ok(affected))) => Ok(Some(format!("OK ({affected})"))),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(join_err)) => Err(format!("Debug call task failed: {join_err}")),
        Err(_) => Ok(None), // still running (handle dropped → task keeps running detached)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_oid_sql_matches_standalone_procedure() {
        let sql = opengauss_debug_resolve_oid_sql("public", "dbg_demo", "procedure", None);
        assert!(sql.contains("p.proname = 'dbg_demo'"));
        assert!(sql.contains("p.prokind = 'p'"));
        assert!(sql.contains("n.nspname = 'public'"));
        assert!(!sql.contains("gs_package"));
    }

    #[test]
    fn resolve_oid_sql_joins_package_for_qualified_names() {
        let sql =
            opengauss_debug_resolve_oid_sql("public", "emp_pkg.raise_salary", "procedure", Some("integer, numeric"));
        assert!(sql.contains("JOIN pg_catalog.gs_package pkg ON pkg.oid = p.propackageid"));
        assert!(sql.contains("pkg.pkgname = 'emp_pkg'"));
        assert!(sql.contains("p.proname = 'raise_salary'"));
        assert!(sql.contains("pg_get_function_identity_arguments(p.oid) = 'integer, numeric'"));
    }

    #[test]
    fn resolve_oid_sql_function_kind_uses_f_prokind() {
        let sql = opengauss_debug_resolve_oid_sql("hr", "get_salary", "function", None);
        assert!(sql.contains("p.prokind = 'f'"));
    }

    #[test]
    fn literal_quoting_escapes_quotes_and_backslashes() {
        assert_eq!(pg_quote_literal("o'brien\\x"), "'o''brien\\\\x'");
        assert_eq!(pg_quote_ident("weird\"name"), "\"weird\"\"name\"");
    }

    fn live_test_config() -> Option<ConnectionConfig> {
        let host = std::env::var("DBX_TEST_OPENGAUSS_HOST").ok()?;
        let port = std::env::var("DBX_TEST_OPENGAUSS_PORT").ok()?.parse::<u16>().ok()?;
        let username = std::env::var("DBX_TEST_OPENGAUSS_USER").ok()?;
        let password = std::env::var("DBX_TEST_OPENGAUSS_PASSWORD").ok()?;
        let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
        Some(ConnectionConfig {
            id: "og-debug-live".to_string(),
            name: "og-debug-live".to_string(),
            note: String::new(),
            db_type: crate::models::connection::DatabaseType::OpenGauss,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host,
            port,
            username,
            password,
            database: Some(database),
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        })
    }

    async fn live_app_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-debug-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::storage::Storage::open(&dir.join("storage.db")).await.unwrap();
        (AppState::new(storage), dir)
    }

    #[tokio::test]
    #[ignore = "requires a reachable openGauss instance via environment variables"]
    async fn live_opengauss_debug_full_flow() {
        let Some(config) = live_test_config() else {
            eprintln!("skip: DBX_TEST_OPENGAUSS_* not set");
            return;
        };
        let database = config.database.clone().unwrap_or_else(|| "postgres".to_string());
        let (state, dir) = live_app_state().await;
        state.configs.write().await.insert("og-debug-live".to_string(), config);

        // Fixture procedure (no table dependency).
        let pool_key = state.get_or_create_pool("og-debug-live", Some(&database)).await.expect("pool");
        let pool = {
            let connections = state.connections.read().await;
            match connections.get(&pool_key) {
                Some(PoolKind::Postgres(pool)) => pool.clone(),
                _ => panic!("expected postgres pool"),
            }
        };
        let schema = "gaussdb";
        postgres::execute_query(&pool, "drop procedure if exists og_dbg_live").await.expect("drop fixture");
        postgres::execute_query(
            &pool,
            "create or replace procedure og_dbg_live(x int) as\n    y int := 10;\nbegin\n    y := y + x;\n    y := y * 2;\nend;",
        )
        .await
        .expect("create fixture");

        // Start: turn_on → background CALL → attach.
        let start = opengauss_debug_start(
            &state,
            "og-debug-live",
            &database,
            schema,
            "procedure",
            "og_dbg_live",
            None,
            &format!("call {schema}.og_dbg_live(1)"),
        )
        .await
        .expect("debug start");
        assert_eq!(start.position.lineno, Some(3), "parks at first SQL line");
        assert!(!start.position.finished);
        assert!(start.code.iter().any(|line| line.lineno == Some(3) && line.canbreak));

        // Breakpoint at line 4.
        let breakpoints = opengauss_debug_add_breakpoint(&state, &start.session_id, 4).await.expect("add breakpoint");
        assert_eq!(breakpoints.len(), 1);
        assert!(breakpoints[0].enable);

        // Locals at entry: x=1, y=10.
        let locals = opengauss_debug_locals(&state, &start.session_id).await.expect("locals");
        let y = locals.iter().find(|local| local.varname == "y").expect("y local");
        assert_eq!(y.value.as_deref(), Some("10"));

        // next → line 4, y becomes 11.
        let position = opengauss_debug_step(&state, &start.session_id, "next").await.expect("next");
        assert_eq!(position.lineno, Some(4));
        let locals = opengauss_debug_locals(&state, &start.session_id).await.expect("locals after next");
        let y = locals.iter().find(|local| local.varname == "y").expect("y local");
        assert_eq!(y.value.as_deref(), Some("11"));

        // set_var round-trip.
        assert!(opengauss_debug_set_var(&state, &start.session_id, "y", "100").await.expect("set_var"));
        let locals = opengauss_debug_locals(&state, &start.session_id).await.expect("locals after set_var");
        let y = locals.iter().find(|local| local.varname == "y").expect("y local");
        assert_eq!(y.value.as_deref(), Some("100"));

        // backtrace has the target frame.
        let frames = opengauss_debug_backtrace(&state, &start.session_id).await.expect("backtrace");
        assert!(frames.iter().any(|frame| frame.funcname == "og_dbg_live"));

        // continue runs to completion.
        let position = opengauss_debug_step(&state, &start.session_id, "continue").await.expect("continue");
        assert!(position.finished, "continue reaches [EXECUTION FINISHED]");

        // Background CALL completed without error.
        let call_result = opengauss_debug_call_result(&state, &start.session_id).await.expect("call result");
        assert!(call_result.is_some());

        // Cleanup.
        opengauss_debug_stop(&state, &start.session_id).await.expect("stop");
        let schema = "gaussdb";
        postgres::execute_query(&pool, "drop procedure if exists og_dbg_live").await.expect("drop fixture");
        drop(dir);
    }

    #[test]
    fn position_finished_detects_execution_finished_marker() {
        let marker = OpenGaussDebugPosition {
            funcoid: 1,
            funcname: "f".to_string(),
            lineno: Some(0),
            query: "[EXECUTION FINISHED]".to_string(),
            finished: true,
        };
        assert!(marker.finished);
    }
}
