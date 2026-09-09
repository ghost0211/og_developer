use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::Stream;
use ogdeveloper_core::transfer::{self, TransferProgress, TransferRequest, TransferStatus};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTransferRequest {
    pub transfer_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTransferOwnershipRequest {
    pub request: TransferRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct SortTablesByFkRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub tables: Vec<String>,
    pub parents_first: bool,
}

fn send_transfer_progress(progress_channel: &Arc<crate::sse::TransferProgressChannel>, progress: &TransferProgress) {
    if let Ok(json) = serde_json::to_string(progress) {
        let kind = if progress.terminal {
            crate::sse::TransferReplayEventKind::Terminal
        } else if progress.status == TransferStatus::Error {
            crate::sse::TransferReplayEventKind::Failure
        } else {
            crate::sse::TransferReplayEventKind::Progress
        };
        progress_channel.send(json, kind);
    }
}

async fn finish_transfer_channel(
    state: &WebState,
    transfer_id: &str,
    _progress_channel: &Arc<crate::sse::TransferProgressChannel>,
) {
    let mut channels = state.transfer_progress_channels.write().await;
    channels.remove(transfer_id);
}

fn terminal_transfer_error(req: &TransferRequest, error: String) -> TransferProgress {
    TransferProgress {
        transfer_id: req.transfer_id.clone(),
        table: String::new(),
        table_index: 0,
        total_tables: req.tables.len(),
        rows_transferred: 0,
        total_rows: None,
        status: TransferStatus::Error,
        error: Some(error),
        terminal: true,
    }
}

pub async fn start_transfer(
    State(state): State<Arc<WebState>>,
    Json(req): Json<TransferRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    transfer::validate_transfer_request(&req).map_err(AppError::from)?;

    let app = state.app.clone();
    let transfer_id = req.transfer_id.clone();
    let channel = Arc::new(crate::sse::TransferProgressChannel::new());
    {
        let mut channels = state.transfer_progress_channels.write().await;
        channels.insert(transfer_id.clone(), channel.clone());
    }

    let progress_channel = channel.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let source_db_type = match transfer::get_db_type(&app, &req.source_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };
        let target_db_type = match transfer::get_db_type(&app, &req.target_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };

        let source_pool_key = format!("{}:{}", req.source_connection_id, req.source_database);
        let target_pool_key = format!("{}:{}", req.target_connection_id, req.target_database);

        let tables = transfer::sort_tables_by_fk_dependency(
            &app,
            &source_pool_key,
            &req.source_database,
            &req.source_schema,
            &req.tables,
        )
        .await
        .unwrap_or_else(|e| {
            log::warn!("[transfer] failed to sort tables by FK dependency, using original order: {e}");
            req.tables.clone()
        });

        let mut failed_tables: Vec<String> = Vec::new();

        for (i, table) in tables.iter().enumerate() {
            if transfer::is_cancelled(&req.transfer_id).await {
                let progress = TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: table.clone(),
                    table_index: i,
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                    terminal: true,
                };
                send_transfer_progress(&progress_channel, &progress);
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }

            let progress_channel_clone = progress_channel.clone();
            let mut last_rows_transferred = 0_u64;
            let mut last_total_rows = None;
            let result = transfer::transfer_table(
                &app,
                &req,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    send_transfer_progress(&progress_channel_clone, &progress);
                },
            )
            .await;

            match result {
                Ok(rows) => {
                    let progress = TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: rows,
                        total_rows: last_total_rows.or(Some(rows)),
                        status: TransferStatus::Completed,
                        error: None,
                        terminal: false,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                }
                Err(e) => {
                    if e == "Cancelled" {
                        let progress = TransferProgress {
                            transfer_id: req.transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables: tables.len(),
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                        };
                        send_transfer_progress(&progress_channel, &progress);
                        finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                        return;
                    }
                    failed_tables.push(table.clone());
                    let progress = TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                }
            }
        }

        let mut object_outcome = transfer::TransferObjectOutcome::default();
        let progress_channel_clone = progress_channel.clone();
        match transfer::transfer_schema_objects(&app, &req, &source_pool_key, &target_pool_key, |progress| {
            send_transfer_progress(&progress_channel_clone, &progress);
        })
        .await
        {
            Ok(outcome) => {
                object_outcome = outcome;
            }
            Err(e) if e == "Cancelled" => {
                let progress = TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: "schema objects".to_string(),
                    table_index: tables.len(),
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                    terminal: true,
                };
                send_transfer_progress(&progress_channel, &progress);
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
            Err(e) => {
                log::warn!("[transfer] schema object transfer failed: {e}");
            }
        }

        let mut skip_reasons: HashMap<String, Vec<String>> = HashMap::new();
        for item in &object_outcome.skipped {
            if let Some((kind, name)) = item.split_once(':') {
                skip_reasons.entry(kind.to_string()).or_default().push(name.to_string());
            } else {
                skip_reasons.entry("object".to_string()).or_default().push(item.clone());
            }
        }

        let skip_suffix = if skip_reasons.is_empty() {
            String::new()
        } else {
            let details = skip_reasons
                .iter()
                .map(|(kind, names)| format!("{}: {}", kind, names.join(", ")))
                .collect::<Vec<_>>()
                .join("; ");
            format!(" (skipped {})", details)
        };

        let done = TransferProgress {
            transfer_id: req.transfer_id.clone(),
            table: String::new(),
            table_index: tables.len(),
            total_tables: tables.len(),
            rows_transferred: 0,
            total_rows: None,
            status: if failed_tables.is_empty() { TransferStatus::Completed } else { TransferStatus::Error },
            error: if failed_tables.is_empty() {
                if skip_suffix.is_empty() {
                    None
                } else {
                    Some(skip_suffix.clone())
                }
            } else {
                Some(format!(
                    "{} table(s) failed: {}{}",
                    failed_tables.len(),
                    failed_tables.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                    skip_suffix
                ))
            },
            terminal: true,
        };
        send_transfer_progress(&progress_channel, &done);
        finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
    });

    Ok(Json(serde_json::json!({ "transferId": transfer_id })))
}

pub async fn preview_transfer_ownership(
    State(state): State<Arc<WebState>>,
    Json(body): Json<PreviewTransferOwnershipRequest>,
) -> Result<Json<transfer::TransferOwnershipPreview>, AppError> {
    let req = body.request;
    transfer::validate_transfer_request(&req).map_err(AppError::from)?;
    let source_db_type = transfer::get_db_type(&state.app, &req.source_connection_id).await.map_err(AppError::from)?;
    let target_db_type = transfer::get_db_type(&state.app, &req.target_connection_id).await.map_err(AppError::from)?;
    let source_pool_key = format!("{}:{}", req.source_connection_id, req.source_database);
    let target_pool_key = format!("{}:{}", req.target_connection_id, req.target_database);
    let preview = transfer::preview_transfer_ownership(
        &state.app,
        &req,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(preview))
}

pub async fn transfer_progress(
    State(state): State<Arc<WebState>>,
    Path(transfer_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.transfer_progress_channels.read().await;
    let channel =
        channels.get(&transfer_id).cloned().ok_or_else(|| AppError::from("Transfer not found".to_string()))?;
    drop(channels);
    Ok(crate::sse::sse_from_transfer_channel(channel))
}

pub async fn cancel_transfer(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelTransferRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.transfer_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

pub async fn sort_tables_by_fk_dependency(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SortTablesByFkRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    transfer::sort_tables_by_fk_dependency(&state.app, &req.connection_id, &req.database, &req.schema, &req.tables)
        .await
        .map(Json)
        .map_err(AppError::from)
}
