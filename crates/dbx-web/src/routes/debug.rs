use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::opengauss_debug as debug;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
pub struct DebugStartRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub kind: String,
    pub name: String,
    pub signature: Option<String>,
    pub call_sql: String,
}

pub async fn start(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugStartRequest>,
) -> Result<Json<debug::OpenGaussDebugStartResult>, AppError> {
    debug::opengauss_debug_start(
        &state.app,
        &req.connection_id,
        &req.database,
        req.schema.as_deref().unwrap_or(""),
        &req.kind,
        &req.name,
        req.signature.as_deref(),
        &req.call_sql,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct DebugSessionRequest {
    pub session_id: String,
}

#[derive(Deserialize)]
pub struct DebugStepRequest {
    pub session_id: String,
    pub action: String,
}

pub async fn step(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugStepRequest>,
) -> Result<Json<debug::OpenGaussDebugPosition>, AppError> {
    debug::opengauss_debug_step(&state.app, &req.session_id, &req.action).await.map(Json).map_err(AppError::from)
}

pub async fn locals(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSessionRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugLocal>>, AppError> {
    debug::opengauss_debug_locals(&state.app, &req.session_id).await.map(Json).map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct DebugSetVarRequest {
    pub session_id: String,
    pub name: String,
    pub value: String,
}

pub async fn set_var(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSetVarRequest>,
) -> Result<Json<bool>, AppError> {
    debug::opengauss_debug_set_var(&state.app, &req.session_id, &req.name, &req.value)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn backtrace(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSessionRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugBacktraceFrame>>, AppError> {
    debug::opengauss_debug_backtrace(&state.app, &req.session_id).await.map(Json).map_err(AppError::from)
}

pub async fn breakpoints(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSessionRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugBreakpoint>>, AppError> {
    debug::opengauss_debug_breakpoints(&state.app, &req.session_id).await.map(Json).map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct DebugBreakpointAddRequest {
    pub session_id: String,
    pub lineno: i64,
}

pub async fn add_breakpoint(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugBreakpointAddRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugBreakpoint>>, AppError> {
    debug::opengauss_debug_add_breakpoint(&state.app, &req.session_id, req.lineno)
        .await
        .map(Json)
        .map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct DebugBreakpointDeleteRequest {
    pub session_id: String,
    pub breakpointno: i64,
}

pub async fn delete_breakpoint(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugBreakpointDeleteRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugBreakpoint>>, AppError> {
    debug::opengauss_debug_delete_breakpoint(&state.app, &req.session_id, req.breakpointno)
        .await
        .map(Json)
        .map_err(AppError::from)
}

#[derive(Deserialize)]
pub struct DebugBreakpointToggleRequest {
    pub session_id: String,
    pub breakpointno: i64,
    pub enable: bool,
}

pub async fn toggle_breakpoint(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugBreakpointToggleRequest>,
) -> Result<Json<Vec<debug::OpenGaussDebugBreakpoint>>, AppError> {
    debug::opengauss_debug_toggle_breakpoint(&state.app, &req.session_id, req.breakpointno, req.enable)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn stop(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSessionRequest>,
) -> Result<Json<()>, AppError> {
    debug::opengauss_debug_stop(&state.app, &req.session_id).await.map(Json).map_err(AppError::from)
}

pub async fn call_result(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DebugSessionRequest>,
) -> Result<Json<Option<String>>, AppError> {
    debug::opengauss_debug_call_result(&state.app, &req.session_id).await.map(Json).map_err(AppError::from)
}
