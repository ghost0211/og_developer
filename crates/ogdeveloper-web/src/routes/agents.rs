//! Agent-driver endpoints.
//!
//! The desktop agent-driver store was removed; the Tauri commands
//! (`src-tauri/src/commands/agents.rs`) are legacy compatibility stubs that
//! return empty data. The web server must mirror those stubs: the frontend's
//! connection dialog always queries the agent-driver list before testing or
//! saving a connection, so a missing route surfaced as "Backend request
//! failed" (empty 405 body) in web mode while desktop kept working.
//!
//! Driver-runtime summary/stop/restart delegate to the real core functions,
//! exactly like the desktop commands.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};

use ogdeveloper_core::driver_runtime::{self, DriverRuntimeSummary};

use crate::error::AppError;
use crate::state::WebState;

// ---- Legacy empty stubs (parity with the desktop commands) ----

pub async fn list_installed_agents_local() -> Json<Value> {
    Json(json!([]))
}

pub async fn list_installed_agents() -> Json<Value> {
    Json(json!([]))
}

pub async fn is_agent_installed(Path(_db_type): Path<String>) -> Json<bool> {
    Json(false)
}

pub async fn driver_store_usage() -> Json<Value> {
    Json(json!({}))
}

pub async fn clear_driver_download_cache() -> Json<Value> {
    Json(json!({}))
}

// ---- Driver runtime (real core delegation, same as desktop) ----

pub async fn driver_runtime_summary(State(state): State<Arc<WebState>>) -> Json<DriverRuntimeSummary> {
    Json(driver_runtime::collect_driver_runtime_summary(state.app.as_ref()).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdRequest {
    runtime_id: String,
}

pub async fn stop_driver_runtime(
    State(state): State<Arc<WebState>>,
    Json(body): Json<RuntimeIdRequest>,
) -> Result<Json<Value>, AppError> {
    driver_runtime::stop_driver_runtime(state.app.as_ref(), &body.runtime_id).await.map_err(AppError::internal)?;
    Ok(Json(json!({})))
}

pub async fn restart_driver_runtime(
    State(state): State<Arc<WebState>>,
    Json(body): Json<RuntimeIdRequest>,
) -> Result<Json<Value>, AppError> {
    driver_runtime::restart_driver_runtime(state.app.as_ref(), &body.runtime_id).await.map_err(AppError::internal)?;
    Ok(Json(json!({})))
}

// ---- Remaining legacy stubs ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAgentRequest {
    #[allow(dead_code)]
    db_type: Option<String>,
    #[allow(dead_code)]
    operation_id: Option<String>,
}

pub async fn install_agent(Json(_body): Json<InstallAgentRequest>) -> Json<Value> {
    Json(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRequest {
    #[allow(dead_code)]
    operation_id: Option<String>,
}

pub async fn upgrade_all_agents(Json(_body): Json<OperationRequest>) -> Json<Value> {
    Json(json!({ "upgraded": 0, "failed": [] }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBlockersRequest {
    #[allow(dead_code)]
    db_types: Vec<String>,
}

pub async fn agent_update_blockers(Json(_body): Json<UpdateBlockersRequest>) -> Json<Value> {
    Json(json!([]))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTypeRequest {
    #[allow(dead_code)]
    db_type: Option<String>,
}

pub async fn uninstall_agent(Json(_body): Json<DbTypeRequest>) -> Json<Value> {
    Json(json!({}))
}

pub async fn get_java_runtime() -> Json<Value> {
    Json(json!({}))
}

/// The frontend expects the saved config back; echo it like a successful save.
pub async fn set_java_runtime(Json(body): Json<Value>) -> Json<Value> {
    Json(body.get("config").cloned().unwrap_or_else(|| json!({})))
}

pub async fn invalidate_registry_cache() -> Json<Value> {
    Json(json!({}))
}

/// Offline driver-package import is a desktop no-op stub as well; keep the
/// response shape (`{count}`) the web frontend parses.
pub async fn import_offline() -> Json<Value> {
    Json(json!({ "count": 0 }))
}

pub async fn import_driver() -> Json<Value> {
    Json(json!({}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JreRequest {
    #[allow(dead_code)]
    jre_key: Option<String>,
    #[allow(dead_code)]
    operation_id: Option<String>,
}

pub async fn reinstall_jre(Json(_body): Json<JreRequest>) -> Json<Value> {
    Json(json!({}))
}

pub async fn uninstall_jre(Json(_body): Json<JreRequest>) -> Json<Value> {
    Json(json!({}))
}

// ---- Install progress (SSE) ----

/// Agent installs are no-op stubs on web, so no progress events ever exist.
/// The frontend still opens this EventSource around install flows; without the
/// route the browser would reconnect-loop against a 405 forever. Keep the
/// stream open and silent (keep-alive comments only) until the client closes.
pub async fn agent_progress_global() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    Sse::new(futures::stream::pending())
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(30)).text("keep-alive"))
}
