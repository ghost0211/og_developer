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
#[serde(rename_all = "camelCase")]
pub struct TextSearchRequest {
    pub query: String,
    pub limit: Option<usize>,
    pub targets: Option<Vec<ogdeveloper_core::search::DatabaseSearchScopeTarget>>,
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
    State(_state): State<Arc<WebState>>,
    Query(q): Query<FileSearchQuery>,
) -> Result<Json<Vec<ogdeveloper_core::search::FileSearchHit>>, AppError> {
    let hits = tokio::task::spawn_blocking(move || {
        ogdeveloper_core::search::search_files(&q.root, &q.query, q.limit.unwrap_or(200))
    })
    .await
    .map_err(|e| AppError::from(format!("file search task failed: {e}")))?;
    Ok(Json(hits.map_err(AppError::from)?))
}

pub async fn list_database_targets(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<ogdeveloper_core::search::DatabaseSearchScopeTarget>>, AppError> {
    Ok(Json(ogdeveloper_core::search::list_database_search_scope_targets(&state.app).await))
}

pub async fn search_metadata(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TextSearchRequest>,
) -> Result<Json<Vec<ogdeveloper_core::search::MetadataSearchHit>>, AppError> {
    Ok(Json(
        ogdeveloper_core::search::search_metadata_for_targets(
            &state.app,
            &req.query,
            req.limit.unwrap_or(200),
            req.targets.as_deref(),
        )
        .await,
    ))
}

pub async fn search_object_definitions(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TextSearchRequest>,
) -> Result<Json<Vec<ogdeveloper_core::search::DefinitionSearchHit>>, AppError> {
    Ok(Json(
        ogdeveloper_core::search::search_object_definitions_for_targets(
            &state.app,
            &req.query,
            req.limit.unwrap_or(100),
            req.targets.as_deref(),
        )
        .await,
    ))
}

pub async fn list_dir(
    State(_state): State<Arc<WebState>>,
    Query(q): Query<DirListQuery>,
) -> Result<Json<Vec<String>>, AppError> {
    let dirs = tokio::task::spawn_blocking(move || ogdeveloper_core::search::list_directories(&q.path))
        .await
        .map_err(|e| AppError::from(format!("dir list task failed: {e}")))?;
    Ok(Json(dirs.map_err(AppError::from)?))
}

#[derive(Deserialize)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,
}

pub async fn write_text_file(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<()>, AppError> {
    let result =
        tokio::task::spawn_blocking(move || ogdeveloper_core::search::write_text_file(&req.path, &req.content))
            .await
            .map_err(|e| AppError::from(format!("file write task failed: {e}")))?;
    Ok(Json(result.map_err(AppError::from)?))
}

pub async fn ensure_directory(
    State(_state): State<Arc<WebState>>,
    Query(q): Query<DirListQuery>,
) -> Result<Json<()>, AppError> {
    let result = tokio::task::spawn_blocking(move || ogdeveloper_core::search::ensure_directory(&q.path))
        .await
        .map_err(|e| AppError::from(format!("mkdir task failed: {e}")))?;
    Ok(Json(result.map_err(AppError::from)?))
}

pub async fn default_projects_root(State(_state): State<Arc<WebState>>) -> Result<Json<String>, AppError> {
    Ok(Json(ogdeveloper_core::search::default_projects_root()))
}

pub async fn read_text_file(
    State(_state): State<Arc<WebState>>,
    Query(q): Query<ReadFileQuery>,
) -> Result<Json<String>, AppError> {
    let text = tokio::task::spawn_blocking(move || ogdeveloper_core::search::read_text_file(&q.path))
        .await
        .map_err(|e| AppError::from(format!("file read task failed: {e}")))?;
    Ok(Json(text.map_err(AppError::from)?))
}
