use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
pub struct FileSearchQuery {
    pub root: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct TextSearchRequest {
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct DirListQuery {
    pub path: String,
}

#[derive(Deserialize)]
pub struct ReadFileQuery {
    pub path: String,
}

pub async fn search_files(
    State(state): State<Arc<WebState>>,
    Query(q): Query<FileSearchQuery>,
) -> Result<Json<Vec<dbx_core::search::FileSearchHit>>, AppError> {
    let hits =
        tokio::task::spawn_blocking(move || dbx_core::search::search_files(&q.root, &q.query, q.limit.unwrap_or(200)))
            .await
            .map_err(|e| AppError::from(format!("file search task failed: {e}")))?;
    Ok(Json(hits.map_err(AppError::from)?))
}

pub async fn search_metadata(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TextSearchRequest>,
) -> Result<Json<Vec<dbx_core::search::MetadataSearchHit>>, AppError> {
    Ok(Json(dbx_core::search::search_metadata(&state.app, &req.query, req.limit.unwrap_or(200)).await))
}

pub async fn search_object_definitions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TextSearchRequest>,
) -> Result<Json<Vec<dbx_core::search::DefinitionSearchHit>>, AppError> {
    Ok(Json(dbx_core::search::search_object_definitions(&state.app, &req.query, req.limit.unwrap_or(100)).await))
}

pub async fn list_dir(
    State(_state): State<Arc<WebState>>,
    Query(q): Query<DirListQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let dirs = tokio::task::spawn_blocking(move || dbx_core::search::list_directories(&q.path))
        .await
        .map_err(|e| AppError::from(format!("dir list task failed: {e}")))?;
    Ok(Json(dirs.map_err(AppError::from)?))
}

pub async fn read_text_file(
    State(_state): State<Arc<WebState>>,
    Query(q): Query<ReadFileQuery>,
) -> Result<Json<String>, AppError> {
    let text = tokio::task::spawn_blocking(move || dbx_core::search::read_text_file(&q.path))
        .await
        .map_err(|e| AppError::from(format!("file read task failed: {e}")))?;
    Ok(Json(text.map_err(AppError::from)?))
}
