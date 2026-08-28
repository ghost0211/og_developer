// SPDX-License-Identifier: Apache-2.0
//
// og developer — openGauss PL/SQL Profiler.
// Provides line-by-line execution count, total time, min/max/avg time,
// and performance heatmap analysis using the openGauss gms_profiler extension.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::db::postgres;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::plugins::PluginDriverSession;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerStatus {
    pub available: bool,
    pub installed: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerLineData {
    pub line_number: i32,
    pub total_occur: i64,
    pub total_time_us: f64,
    pub min_time_us: f64,
    pub max_time_us: f64,
    pub avg_time_us: f64,
    pub percentage: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerUnitSummary {
    pub unit_name: String,
    pub unit_type: String,
    pub unit_owner: String,
    pub total_time_us: f64,
    pub lines: Vec<ProfilerLineData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilerRunResult {
    pub run_id: i64,
    pub run_comment: String,
    pub total_time_ms: f64,
    pub units: Vec<ProfilerUnitSummary>,
    pub execution_output: Option<String>,
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn require_opengauss_config(state: &AppState, connection_id: &str) -> Result<ConnectionConfig, String> {
    let configs = state.configs.read().await;
    let config = configs.get(connection_id).cloned().ok_or("Connection config not found")?;
    if matches!(config.db_type, DatabaseType::OpenGauss) {
        Ok(config)
    } else {
        Err("PL/SQL profiler requires an openGauss/GaussDB connection".to_string())
    }
}

async fn external_session_for_pool(
    state: &AppState,
    pool_key: &str,
) -> Option<(Arc<ConnectionConfig>, Arc<PluginDriverSession>)> {
    let connections = state.connections.read().await;
    match connections.get(pool_key) {
        Some(PoolKind::ExternalDriver { config, session, .. }) => Some((config.clone(), session.clone())),
        _ => None,
    }
}

async fn external_query(
    session: Arc<PluginDriverSession>,
    config: &ConnectionConfig,
    database: &str,
    schema: Option<&str>,
    sql: &str,
    max_rows: usize,
) -> Result<db::QueryResult, String> {
    session
        .invoke_with_timeout(
            "executeQuery",
            serde_json::json!({
                "connection": config,
                "database": database,
                "schema": schema,
                "sql": sql,
                "maxRows": max_rows,
            }),
            Some(db::connection_timeout()),
        )
        .await
}

fn json_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        other => Some(other.to_string()),
    }
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|value| value as i64))
        .or_else(|| value.as_str().and_then(|value| value.trim().parse::<i64>().ok()))
}

fn json_i32(value: Option<&Value>) -> Option<i32> {
    json_i64(value).and_then(|value| i32::try_from(value).ok())
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|value| value as f64))
        .or_else(|| value.as_str().and_then(|value| value.trim().parse::<f64>().ok()))
}

fn json_bool(value: Option<&Value>) -> Option<bool> {
    let value = value?;
    value.as_bool().or_else(|| {
        value.as_str().and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "1" => Some(true),
            "false" | "f" | "0" => Some(false),
            _ => None,
        })
    })
}

fn first_bool(result: &db::QueryResult) -> Option<bool> {
    result.rows.first().and_then(|row| json_bool(row.first()))
}

fn run_sql(comment: &str) -> String {
    format!(
        "SELECT CAST(runid AS bigint), run_comment, CAST(run_total_time AS double precision) \
         FROM gms_profiler.plsql_profiler_runs \
         WHERE run_comment = {} ORDER BY runid DESC LIMIT 1",
        sql_string(comment)
    )
}

fn data_sql(run_id: i64) -> String {
    format!(
        "SELECT CAST(u.unit_number AS bigint), u.unit_name, u.unit_type, u.unit_owner, \
                CAST(d.\"line#\" AS integer), CAST(d.total_occur AS bigint), \
                CAST(d.total_time AS double precision), CAST(d.min_time AS double precision), \
                CAST(d.max_time AS double precision) \
         FROM gms_profiler.plsql_profiler_data d \
         JOIN gms_profiler.plsql_profiler_units u \
           ON u.runid = d.runid AND u.unit_number = d.unit_number \
         WHERE d.runid = {} ORDER BY u.unit_number, d.\"line#\"",
        run_id
    )
}

/// gms_profiler requires its entry points to be called from PL/SQL. Keep the
/// start/stop calls in anonymous blocks, then execute the user target on the
/// same checked-out/session connection so the profiler context is preserved.
fn start_profiler_sql(comment: &str) -> String {
    format!(
        "DO $dbx_profiler_start$\nDECLARE\n  result binary_integer;\nBEGIN\n  result := gms_profiler.start_profiler({}, 'ogdeveloper');\n  IF result <> 0 THEN\n    RAISE EXCEPTION 'gms_profiler.start_profiler returned %', result;\n  END IF;\nEND;\n$dbx_profiler_start$;",
        sql_string(comment)
    )
}

fn stop_profiler_sql() -> &'static str {
    "DO $dbx_profiler_stop$\nDECLARE\n  result binary_integer;\nBEGIN\n  result := gms_profiler.stop_profiler();\n  IF result <> 0 THEN\n    RAISE EXCEPTION 'gms_profiler.stop_profiler returned %', result;\n  END IF;\nEND;\n$dbx_profiler_stop$;"
}

fn finite_non_negative(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}

fn units_from_external_result(result: db::QueryResult) -> Result<Vec<ProfilerUnitSummary>, String> {
    let mut units_map: BTreeMap<i64, (String, String, String, Vec<ProfilerLineData>)> = BTreeMap::new();
    let mut grand_total_time_us = 0.0;

    for row in result.rows {
        let unit_no = json_i64(row.first()).ok_or("Invalid profiler unit number")?;
        let unit_name = json_string(row.get(1)).unwrap_or_default();
        let unit_type = json_string(row.get(2)).unwrap_or_default();
        let unit_owner = json_string(row.get(3)).unwrap_or_default();
        let line_number = json_i32(row.get(4)).ok_or("Invalid profiler line number")?;
        let total_occur = json_i64(row.get(5)).ok_or("Invalid profiler execution count")?;
        let total_time_us = finite_non_negative(json_f64(row.get(6)).unwrap_or(0.0));
        let min_time_us = finite_non_negative(json_f64(row.get(7)).unwrap_or(0.0));
        let max_time_us = finite_non_negative(json_f64(row.get(8)).unwrap_or(0.0));
        let avg_time_us = if total_occur > 0 { total_time_us / total_occur as f64 } else { 0.0 };
        grand_total_time_us += total_time_us;

        units_map.entry(unit_no).or_insert_with(|| (unit_name, unit_type, unit_owner, Vec::new())).3.push(
            ProfilerLineData {
                line_number,
                total_occur,
                total_time_us,
                min_time_us,
                max_time_us,
                avg_time_us,
                percentage: 0.0,
            },
        );
    }

    Ok(finalize_units(units_map, grand_total_time_us))
}

fn units_from_native_rows(rows: Vec<tokio_postgres::Row>) -> Result<Vec<ProfilerUnitSummary>, String> {
    let mut units_map: BTreeMap<i64, (String, String, String, Vec<ProfilerLineData>)> = BTreeMap::new();
    let mut grand_total_time_us = 0.0;

    for row in rows {
        let unit_no: i64 = row.try_get(0).map_err(|e| e.to_string())?;
        let unit_name = row.try_get::<_, Option<String>>(1).ok().flatten().unwrap_or_default();
        let unit_type = row.try_get::<_, Option<String>>(2).ok().flatten().unwrap_or_default();
        let unit_owner = row.try_get::<_, Option<String>>(3).ok().flatten().unwrap_or_default();
        let line_number: i32 = row.try_get(4).map_err(|e| e.to_string())?;
        let total_occur: i64 = row.try_get(5).map_err(|e| e.to_string())?;
        let total_time_us =
            finite_non_negative(row.try_get::<_, Option<f64>>(6).map_err(|e| e.to_string())?.unwrap_or(0.0));
        let min_time_us =
            finite_non_negative(row.try_get::<_, Option<f64>>(7).map_err(|e| e.to_string())?.unwrap_or(0.0));
        let max_time_us =
            finite_non_negative(row.try_get::<_, Option<f64>>(8).map_err(|e| e.to_string())?.unwrap_or(0.0));
        let avg_time_us = if total_occur > 0 { total_time_us / total_occur as f64 } else { 0.0 };
        grand_total_time_us += total_time_us;

        units_map.entry(unit_no).or_insert_with(|| (unit_name, unit_type, unit_owner, Vec::new())).3.push(
            ProfilerLineData {
                line_number,
                total_occur,
                total_time_us,
                min_time_us,
                max_time_us,
                avg_time_us,
                percentage: 0.0,
            },
        );
    }

    Ok(finalize_units(units_map, grand_total_time_us))
}

fn finalize_units(
    units_map: BTreeMap<i64, (String, String, String, Vec<ProfilerLineData>)>,
    grand_total_time_us: f64,
) -> Vec<ProfilerUnitSummary> {
    units_map
        .into_values()
        .map(|(unit_name, unit_type, unit_owner, mut lines)| {
            let unit_time = lines.iter().map(|line| line.total_time_us).sum::<f64>();
            for line in &mut lines {
                if grand_total_time_us > 0.0 {
                    line.percentage = ((line.total_time_us / grand_total_time_us) * 10000.0).round() / 100.0;
                }
            }
            ProfilerUnitSummary { unit_name, unit_type, unit_owner, total_time_us: unit_time, lines }
        })
        .collect()
}

/// Check if gms_profiler extension is installed and available.
pub async fn check_profiler_status_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<ProfilerStatus, String> {
    let _config = require_opengauss_config(state, connection_id).await?;
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let installed_sql = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'gms_profiler')";

    let installed = if let Some((external_config, external_session)) = external_session_for_pool(state, &pool_key).await
    {
        let result =
            external_query(external_session, external_config.as_ref(), database, None, installed_sql, 1).await?;
        first_bool(&result).unwrap_or(false)
    } else {
        let Some(pool) =
            crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?
        else {
            return Err("No PostgreSQL-compatible metadata session for profiler".to_string());
        };
        let client = postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?;
        let row = client.query_one(installed_sql, &[]).await.map_err(|e| e.to_string())?;
        row.try_get(0).map_err(|e| e.to_string())?
    };

    if installed {
        return Ok(ProfilerStatus {
            available: true,
            installed: true,
            message: Some("gms_profiler 性能剖析扩展已就绪".to_string()),
        });
    }

    let available_sql = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'gms_profiler')";
    let available = if let Some((external_config, external_session)) = external_session_for_pool(state, &pool_key).await
    {
        let result =
            external_query(external_session, external_config.as_ref(), database, None, available_sql, 1).await?;
        first_bool(&result).unwrap_or(false)
    } else {
        let Some(pool) =
            crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?
        else {
            return Err("No PostgreSQL-compatible metadata session for profiler".to_string());
        };
        let client = postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?;
        let row = client.query_one(available_sql, &[]).await.map_err(|e| e.to_string())?;
        row.try_get(0).map_err(|e| e.to_string())?
    };

    Ok(ProfilerStatus {
        available,
        installed: false,
        message: Some(if available {
            "gms_profiler 扩展可用，可通过 CREATE EXTENSION gms_profiler; 启用".to_string()
        } else {
            "数据库当前未包含 gms_profiler 扩展包".to_string()
        }),
    })
}

/// Execute a PL/SQL statement or block under gms_profiler, collecting line-by-line statistics.
pub async fn run_profiler_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    call_sql: &str,
    comment: &str,
) -> Result<ProfilerRunResult, String> {
    let _config = require_opengauss_config(state, connection_id).await?;
    let call_sql = call_sql.trim();
    let call_sql = call_sql.strip_suffix('/').map(str::trim_end).unwrap_or(call_sql);
    if call_sql.is_empty() {
        return Err("性能剖析目标调用 SQL 不能为空".to_string());
    }
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let run_comment = if comment.trim().is_empty() {
        format!("og_profile_{}", chrono::Local::now().format("%Y%m%d_%H%M%S"))
    } else {
        comment.to_string()
    };
    let start_instant = Instant::now();

    let (run_id, server_total_time_us, units) = if let Some((external_config, external_session)) =
        external_session_for_pool(state, &pool_key).await
    {
        external_query(
            external_session.clone(),
            external_config.as_ref(),
            database,
            schema,
            &start_profiler_sql(&run_comment),
            1,
        )
        .await
        .map_err(|e| format!("启动性能剖析器失败: {e}"))?;

        let target_result =
            external_query(external_session.clone(), external_config.as_ref(), database, schema, call_sql, 10_000)
                .await;
        let stop_result = external_query(
            external_session.clone(),
            external_config.as_ref(),
            database,
            schema,
            stop_profiler_sql(),
            1,
        )
        .await;
        if let Err(target_error) = target_result {
            let stop_error = stop_result.err().map(|error| format!("；停止剖析器失败: {error}"));
            return Err(format!("目标语句执行报错: {target_error}{}", stop_error.unwrap_or_default()));
        }
        stop_result.map_err(|e| format!("停止性能剖析器失败: {e}"))?;

        let run_result = external_query(
            external_session.clone(),
            external_config.as_ref(),
            database,
            None,
            &run_sql(&run_comment),
            1,
        )
        .await?;
        let run_row = run_result.rows.first().ok_or("读取剖析运行记录失败")?;
        let run_id = json_i64(run_row.first()).ok_or("剖析运行编号无效")?;
        let server_total_time_us = json_f64(run_row.get(2)).unwrap_or(0.0);
        let data_result =
            external_query(external_session, external_config.as_ref(), database, None, &data_sql(run_id), 100_000)
                .await?;
        (run_id, server_total_time_us, units_from_external_result(data_result)?)
    } else {
        let Some(pool) =
            crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?
        else {
            return Err("No PostgreSQL-compatible metadata session for profiler".to_string());
        };
        let client = postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?;
        let schema_name = schema.map(str::trim).filter(|schema| !schema.is_empty());
        if let Some(schema_name) = schema_name {
            postgres::set_postgres_search_path(
                &client,
                schema_name,
                postgres::PostgresSearchPathContext::Query,
                db::connection_timeout(),
            )
            .await
            .map_err(|error| format!("设置性能剖析模式失败: {error}"))?;
        }
        let start_result = client.batch_execute(&start_profiler_sql(&run_comment)).await;
        if let Err(start_error) = start_result {
            if schema_name.is_some() {
                let _ = client.batch_execute("RESET search_path").await;
            }
            return Err(format!("启动性能剖析器失败: {start_error}"));
        }

        let target_result = client.simple_query(call_sql).await;
        let stop_result = client.batch_execute(stop_profiler_sql()).await;
        let reset_result =
            if schema_name.is_some() { Some(client.batch_execute("RESET search_path").await) } else { None };
        let stop_error = stop_result.err().map(|error| error.to_string());
        let reset_error = reset_result.and_then(|result| result.err().map(|error| error.to_string()));
        if let Err(target_error) = target_result {
            let stop_detail = stop_error.as_deref().map(|error| format!("；停止剖析器失败: {error}"));
            let reset_detail = reset_error.as_deref().map(|error| format!("；恢复搜索路径失败: {error}"));
            return Err(format!(
                "目标语句执行报错: {target_error}{}{}",
                stop_detail.unwrap_or_default(),
                reset_detail.unwrap_or_default()
            ));
        }
        if let Some(stop_error) = stop_error {
            return Err(format!("停止性能剖析器失败: {stop_error}"));
        }
        if let Some(reset_error) = reset_error {
            return Err(format!("恢复搜索路径失败: {reset_error}"));
        }

        let run_row =
            client.query_one(&run_sql(&run_comment), &[]).await.map_err(|e| format!("读取剖析运行记录失败: {e}"))?;
        let run_id: i64 = run_row.try_get(0).map_err(|e| e.to_string())?;
        let server_total_time_us: f64 = run_row.try_get::<_, Option<f64>>(2).map_err(|e| e.to_string())?.unwrap_or(0.0);
        let data_rows = client.query(&data_sql(run_id), &[]).await.map_err(|e| format!("读取逐行统计失败: {e}"))?;
        (run_id, server_total_time_us, units_from_native_rows(data_rows)?)
    };

    let wall_time_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
    // gms_profiler stores GetCurrentTimestamp deltas in openGauss' integer
    // timestamp unit: microseconds. Convert µs to milliseconds here.
    let total_time_ms = if server_total_time_us > 0.0 { server_total_time_us / 1000.0 } else { wall_time_ms };
    Ok(ProfilerRunResult {
        run_id,
        run_comment,
        total_time_ms,
        units,
        execution_output: Some("剖析运行完成".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiler_data_sql_quotes_line_hash_and_uses_profiler_schema() {
        let sql = data_sql(42);
        assert!(sql.contains("gms_profiler.plsql_profiler_data"));
        assert!(sql.contains("d.\"line#\""));
        assert!(!sql.contains("d.line#"));
    }

    #[test]
    fn profiler_start_is_wrapped_in_plsql() {
        let sql = start_profiler_sql("it's a run");
        assert!(sql.starts_with("DO $dbx_profiler_start$"));
        assert!(sql.contains("gms_profiler.start_profiler('it''s a run', 'ogdeveloper')"));
    }
}
