use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
pub struct KillSessionRequest {
    pub connection_id: String,
    pub pid: i64,
}

pub async fn list_sessions(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<ogdeveloper_core::sessions::SessionInfo>>, AppError> {
    Ok(Json(ogdeveloper_core::sessions::list_sessions(&state.app).await))
}

pub async fn kill_session(
    State(state): State<Arc<WebState>>,
    Json(req): Json<KillSessionRequest>,
) -> Result<Json<()>, AppError> {
    ogdeveloper_core::sessions::kill_session(&state.app, &req.connection_id, req.pid)
        .await
        .map(Json)
        .map_err(AppError::from)
}
