use std::sync::Arc;

use dbx_core::connection::AppState;
use dbx_core::opengauss_debug::{
    OpenGaussDebugBacktraceFrame, OpenGaussDebugBreakpoint, OpenGaussDebugCodeLine, OpenGaussDebugLocal,
    OpenGaussDebugPosition, OpenGaussDebugStartResult,
};
use tauri::State;

#[tauri::command]
pub async fn opengauss_debug_start(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    schema: String,
    kind: String,
    name: String,
    signature: Option<String>,
    call_sql: String,
) -> Result<OpenGaussDebugStartResult, String> {
    dbx_core::opengauss_debug::opengauss_debug_start(
        &state,
        &connection_id,
        &database,
        &schema,
        &kind,
        &name,
        signature.as_deref(),
        &call_sql,
    )
    .await
}

#[tauri::command]
pub async fn opengauss_debug_step(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    action: String,
) -> Result<OpenGaussDebugPosition, String> {
    dbx_core::opengauss_debug::opengauss_debug_step(&state, &session_id, &action).await
}

#[tauri::command]
pub async fn opengauss_debug_locals(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Vec<OpenGaussDebugLocal>, String> {
    dbx_core::opengauss_debug::opengauss_debug_locals(&state, &session_id).await
}

#[tauri::command]
pub async fn opengauss_debug_set_var(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    name: String,
    value: String,
) -> Result<bool, String> {
    dbx_core::opengauss_debug::opengauss_debug_set_var(&state, &session_id, &name, &value).await
}

#[tauri::command]
pub async fn opengauss_debug_backtrace(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Vec<OpenGaussDebugBacktraceFrame>, String> {
    dbx_core::opengauss_debug::opengauss_debug_backtrace(&state, &session_id).await
}

#[tauri::command]
pub async fn opengauss_debug_breakpoints(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    dbx_core::opengauss_debug::opengauss_debug_breakpoints(&state, &session_id).await
}

#[tauri::command]
pub async fn opengauss_debug_add_breakpoint(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    lineno: i64,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    dbx_core::opengauss_debug::opengauss_debug_add_breakpoint(&state, &session_id, lineno).await
}

#[tauri::command]
pub async fn opengauss_debug_delete_breakpoint(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    breakpointno: i64,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    dbx_core::opengauss_debug::opengauss_debug_delete_breakpoint(&state, &session_id, breakpointno).await
}

#[tauri::command]
pub async fn opengauss_debug_toggle_breakpoint(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    breakpointno: i64,
    enable: bool,
) -> Result<Vec<OpenGaussDebugBreakpoint>, String> {
    dbx_core::opengauss_debug::opengauss_debug_toggle_breakpoint(&state, &session_id, breakpointno, enable).await
}

#[tauri::command]
pub async fn opengauss_debug_stop(state: State<'_, Arc<AppState>>, session_id: String) -> Result<(), String> {
    dbx_core::opengauss_debug::opengauss_debug_stop(&state, &session_id).await
}

#[tauri::command]
pub async fn opengauss_debug_call_result(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Option<String>, String> {
    dbx_core::opengauss_debug::opengauss_debug_call_result(&state, &session_id).await
}
