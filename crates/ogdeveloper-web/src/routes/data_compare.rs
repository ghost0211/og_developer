use axum::extract::State;
use axum::Json;
use std::sync::Arc;

use crate::error::AppError;
use crate::state::WebState;

pub async fn prepare_data_compare(
    Json(options): Json<ogdeveloper_core::data_compare::DataComparePreparationOptions>,
) -> Result<Json<ogdeveloper_core::data_compare::DataComparePreparation>, AppError> {
    ogdeveloper_core::data_compare::prepare_data_compare(options).map(Json).map_err(AppError::from)
}

pub async fn prepare_data_compare_from_tables(
    State(state): State<Arc<WebState>>,
    Json(options): Json<ogdeveloper_core::data_compare::DataCompareFromTablesOptions>,
) -> Result<Json<ogdeveloper_core::data_compare::DataCompareFromTablesPreparation>, AppError> {
    ogdeveloper_core::data_compare::prepare_data_compare_from_tables(&state.app, options)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn prepare_data_compare_missing_target(
    State(state): State<Arc<WebState>>,
    Json(options): Json<ogdeveloper_core::data_compare::DataCompareMissingTargetOptions>,
) -> Result<Json<ogdeveloper_core::data_compare::DataCompareFromTablesPreparation>, AppError> {
    ogdeveloper_core::data_compare::prepare_data_compare_missing_target(&state.app, options)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn build_data_compare_sync_plan(
    Json(options): Json<ogdeveloper_core::data_compare::DataCompareSyncPlanOptions>,
) -> Json<ogdeveloper_core::data_compare::DataCompareSyncPlan> {
    Json(ogdeveloper_core::data_compare::build_data_compare_sync_plan(options))
}
