#[derive(Debug, Clone, serde::Serialize)]
pub struct TransferOwnershipPreview {
    pub statements: Vec<String>,
}
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::{ensure_connection_writable, AppState};

// Re-export types and functions used by other modules
pub use ogdeveloper_core::transfer::{get_db_type, TransferProgress, TransferRequest, TransferStatus};

fn emit_progress(app: &AppHandle, progress: TransferProgress) {
    let _ = app.emit("transfer-progress", progress);
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TransferRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let transfer_id = request.transfer_id.clone();

    // Reject transfer early if the target connection is read-only — writing to it is inherently required
    ensure_connection_writable(&state, &request.target_connection_id, "Transfer").await?;

    // Validate connections exist
    let source_db_type = get_db_type(&state, &request.source_connection_id).await?;
    let target_db_type = get_db_type(&state, &request.target_connection_id).await?;

    // Cross-family object transfers are validated inside transfer_schema_objects:
    // only mechanically rewriteable kinds (views, sequences) are allowed.
    // Structure-only data transfer is unsupported for MongoDB.

    // External Doris/StarRocks catalogs: pool is created with `catalog=` URL
    // setup (SET catalog) and without USE <external-db>. See ensure_transfer_pool.
    let source_pool_key = format!("{}:{}", request.source_connection_id, request.source_database);
    let target_pool_key = format!("{}:{}", request.target_connection_id, request.target_database);

    tokio::spawn(async move {
        // Sort tables by FK dependency so referenced tables are transferred first.
        // Skip for external Doris/StarRocks catalogs — the database name does not
        // exist in the default catalog and sorting is unnecessary (no FK constraints).
        let sorted_tables = ogdeveloper_core::transfer::sort_tables_by_fk_dependency(
            &state,
            &source_pool_key,
            &request.source_database,
            &request.source_schema,
            &request.tables,
        )
        .await
        .unwrap_or_else(|e| {
            log::warn!("[transfer] failed to sort tables by FK dependency, using original order: {e}");
            request.tables.clone()
        });

        let total_tables = sorted_tables.len();
        log::info!("[transfer] starting transfer_id={} tables={}", transfer_id, total_tables);

        let mut failed_tables: Vec<String> = Vec::new();
        let mut last_rows_transferred = 0_u64;
        let mut last_total_rows = None;

        for (i, table) in sorted_tables.iter().enumerate() {
            if ogdeveloper_core::transfer::is_cancelled(&transfer_id).await {
                emit_progress(
                    &app,
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables,
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    },
                );
                ogdeveloper_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }

            log::info!("[transfer] table {}/{}: {}", i + 1, total_tables, table);

            match ogdeveloper_core::transfer::transfer_table(
                &state,
                &request,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    emit_progress(&app, progress);
                },
            )
            .await
            {
                Ok(rows) => {
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: rows,
                            total_rows: last_total_rows.or(Some(rows)),
                            status: TransferStatus::Completed,
                            error: None,
                            terminal: false,
                        },
                    );
                }
                Err(e) => {
                    if e == "Cancelled" {
                        emit_progress(
                            &app,
                            TransferProgress {
                                transfer_id: transfer_id.clone(),
                                table: table.clone(),
                                table_index: i,
                                total_tables,
                                rows_transferred: last_rows_transferred,
                                total_rows: last_total_rows,
                                status: TransferStatus::Cancelled,
                                error: None,
                                terminal: true,
                            },
                        );
                        ogdeveloper_core::transfer::clear_cancelled(&transfer_id).await;
                        return;
                    }
                    failed_tables.push(table.clone());
                    emit_progress(
                        &app,
                        TransferProgress {
                            transfer_id: transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables,
                            rows_transferred: last_rows_transferred,
                            total_rows: last_total_rows,
                            status: TransferStatus::Error,
                            error: Some(e),
                            terminal: false,
                        },
                    );
                }
            }
        }

        // Transfer selected non-table objects (views, procedures, functions,
        // triggers, sequences, events) after the per-table loop. The shared
        // Core decision handles all content modes: DataOnly never
        // transfers schema objects; PG→PG keeps the legacy empty-selection
        // default only when structure participates in the transfer.
        let mut object_outcome = ogdeveloper_core::transfer::TransferObjectOutcome::default();
        match ogdeveloper_core::transfer::transfer_schema_objects(
            &state,
            &request,
            &source_pool_key,
            &target_pool_key,
            |progress| emit_progress(&app, progress),
        )
        .await
        {
            Ok(outcome) => {
                object_outcome = outcome;
            }
            Err(e) if e == "Cancelled" => {
                emit_progress(
                    &app,
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    },
                );
                ogdeveloper_core::transfer::clear_cancelled(&transfer_id).await;
                return;
            }
            Err(e) => {
                failed_tables.push("schema objects".to_string());
                emit_progress(
                    &app,
                    TransferProgress {
                        transfer_id: transfer_id.clone(),
                        table: "schema objects".to_string(),
                        table_index: total_tables,
                        total_tables,
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                    },
                );
            }
        }
        if !object_outcome.failed.is_empty() {
            failed_tables.push(format!("schema objects ({})", object_outcome.failed.len()));
        }
        let skip_suffix = if !object_outcome.skipped.is_empty() && failed_tables.is_empty() {
            format!("，跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else if !object_outcome.skipped.is_empty() {
            format!("；跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else {
            String::new()
        };

        emit_progress(
            &app,
            TransferProgress {
                transfer_id: transfer_id.clone(),
                table: String::new(),
                table_index: total_tables,
                total_tables,
                rows_transferred: last_rows_transferred,
                total_rows: last_total_rows,
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
            },
        );
        ogdeveloper_core::transfer::clear_cancelled(&transfer_id).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn preview_transfer_ownership(
    _state: State<'_, Arc<AppState>>,
    _request: TransferRequest,
) -> Result<TransferOwnershipPreview, String> {
    Ok(TransferOwnershipPreview { statements: Vec::new() })
}

#[tauri::command]
pub async fn cancel_transfer(transfer_id: String) -> Result<(), String> {
    ogdeveloper_core::transfer::set_cancelled(&transfer_id).await;
    Ok(())
}
