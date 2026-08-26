// SPDX-License-Identifier: Apache-2.0
//
// og developer — openGauss Maintenance: Invalid Objects Scanning and Batch Recompilation.
// Queries dbe_pldeveloper.gs_source and dbe_pldeveloper.gs_errors to identify
// invalid (compilation failed) procedures, functions, packages, and package bodies,
// and provides safe recompilation for the selected objects.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::db::postgres;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::plugins::PluginDriverSession;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidObjectInfo {
    pub schema: String,
    pub name: String,
    pub object_type: String,
    pub error_line: Option<i32>,
    pub error_position: Option<i32>,
    pub error_message: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecompileObjectResult {
    pub schema: String,
    pub name: String,
    pub object_type: String,
    pub success: bool,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn normalized_object_type(object_type: &str) -> String {
    object_type.trim().replace('_', " ")
}

async fn require_opengauss_config(state: &AppState, connection_id: &str) -> Result<ConnectionConfig, String> {
    let configs = state.configs.read().await;
    let config = configs.get(connection_id).cloned().ok_or("Connection config not found")?;
    if matches!(config.db_type, DatabaseType::OpenGauss | DatabaseType::Gaussdb) {
        Ok(config)
    } else {
        Err("Invalid-object maintenance requires an openGauss/GaussDB connection".to_string())
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

fn json_i32(value: Option<&Value>) -> Option<i32> {
    let value = value?;
    value
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .or_else(|| value.as_f64().map(|value| value as i32))
        .or_else(|| value.as_str().and_then(|value| value.trim().parse::<i32>().ok()))
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

fn invalid_objects_from_query_result(result: db::QueryResult) -> Vec<InvalidObjectInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let schema = json_string(row.first()).filter(|value| !value.is_empty())?;
            let name = json_string(row.get(1)).unwrap_or_default();
            let object_type = json_string(row.get(2)).unwrap_or_default();
            Some(InvalidObjectInfo {
                schema,
                name,
                object_type,
                error_line: json_i32(row.get(3)),
                error_position: json_i32(row.get(4)),
                error_message: json_string(row.get(5)).filter(|value| !value.trim().is_empty()),
                source: json_string(row.get(6)).filter(|value| !value.trim().is_empty()),
            })
        })
        .collect()
}

fn bool_from_query_result(result: &db::QueryResult) -> Option<bool> {
    result.rows.first().and_then(|row| json_bool(row.first()))
}

fn string_from_query_result(result: &db::QueryResult) -> Option<String> {
    result.rows.first().and_then(|row| json_string(row.first()))
}

/// Query the latest gs_source row for every object before filtering by status.
/// gs_source keeps one row per object in current openGauss releases, but doing
/// the latest-row selection first also protects older installations containing
/// duplicate historical rows.
pub(crate) fn opengauss_invalid_objects_sql(schema: Option<&str>) -> String {
    let schema_filter = schema
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(" AND latest.schema_name = {}", sql_string(value)))
        .unwrap_or_default();

    format!(
        "WITH latest_source AS ( \
             SELECT DISTINCT ON (s.nspid, s.name, s.type) \
                    n.nspname AS schema_name, s.nspid, s.name AS object_name, \
                    upper(s.type) AS object_type, s.status, s.src, s.id \
             FROM dbe_pldeveloper.gs_source s \
             JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
             ORDER BY s.nspid, s.name, s.type, s.id DESC \
         ), first_error AS ( \
             SELECT DISTINCT ON (e.id) \
                    e.id, e.line, e.src \
             FROM dbe_pldeveloper.gs_errors e \
             ORDER BY e.id, e.line NULLS LAST \
         ) \
         SELECT latest.schema_name, latest.object_name, latest.object_type, \
                first_error.line AS error_line, CAST(NULL AS integer) AS error_position, \
                first_error.src AS error_message, latest.src AS source \
         FROM latest_source latest \
         LEFT JOIN first_error ON first_error.id = latest.id \
         WHERE latest.status = false \
           AND latest.schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'cstore', 'dbe_perf', 'dbe_pldebugger', 'pkg_service'){} \
         ORDER BY latest.schema_name, latest.object_name, latest.object_type",
        schema_filter
    )
}

/// List all invalid / failed compilation objects in the openGauss database.
pub async fn list_invalid_objects_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<Vec<InvalidObjectInfo>, String> {
    let config = require_opengauss_config(state, connection_id).await?;
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let sql = opengauss_invalid_objects_sql(schema);

    if let Some((external_config, external_session)) = external_session_for_pool(state, &pool_key).await {
        let relation_sql = "SELECT EXISTS ( \
            SELECT 1 FROM pg_catalog.pg_class c \
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
            WHERE n.nspname = 'dbe_pldeveloper' AND c.relname = 'gs_source' \
        )";
        let relation =
            external_query(external_session.clone(), external_config.as_ref(), database, None, relation_sql, 1).await?;
        if !bool_from_query_result(&relation).unwrap_or(false) {
            return Ok(vec![]);
        }
        let result = external_query(external_session, external_config.as_ref(), database, None, &sql, 10_000).await?;
        return Ok(invalid_objects_from_query_result(result));
    }

    let Some(pool) = crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?
    else {
        return Err(format!("No PostgreSQL-compatible metadata session for {}", config.name));
    };
    let client = postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?;
    if !postgres::postgres_has_namespaced_relation(&client, "dbe_pldeveloper", "gs_source").await.unwrap_or(false) {
        return Ok(vec![]);
    }

    let rows = client.query(&sql, &[]).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| InvalidObjectInfo {
            schema: row.try_get(0).unwrap_or_default(),
            name: row.try_get(1).unwrap_or_default(),
            object_type: row.try_get(2).unwrap_or_default(),
            error_line: row.try_get::<_, Option<i32>>(3).ok().flatten(),
            error_position: row.try_get::<_, Option<i32>>(4).ok().flatten(),
            error_message: row.try_get::<_, Option<String>>(5).ok().flatten().filter(|value| !value.trim().is_empty()),
            source: row.try_get::<_, Option<String>>(6).ok().flatten().filter(|value| !value.trim().is_empty()),
        })
        .collect())
}

fn source_lookup_sql(schema: &str, object_name: &str, object_type: &str) -> String {
    format!(
        "SELECT s.src FROM dbe_pldeveloper.gs_source s \
         JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
         WHERE n.nspname = {} AND s.name = {} AND upper(replace(s.type, '_', ' ')) = upper({}) \
         ORDER BY s.id DESC LIMIT 1",
        sql_string(schema),
        sql_string(object_name),
        sql_string(&normalized_object_type(object_type)),
    )
}

fn status_lookup_sql(schema: &str, object_name: &str, object_type: &str) -> String {
    format!(
        "SELECT s.status FROM dbe_pldeveloper.gs_source s \
         JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
         WHERE n.nspname = {} AND s.name = {} AND upper(replace(s.type, '_', ' ')) = upper({}) \
         ORDER BY s.id DESC LIMIT 1",
        sql_string(schema),
        sql_string(object_name),
        sql_string(&normalized_object_type(object_type)),
    )
}

fn error_lookup_sql(schema: &str, object_name: &str, object_type: &str) -> String {
    format!(
        "SELECT e.src FROM dbe_pldeveloper.gs_errors e \
         WHERE e.id = ( \
             SELECT s.id FROM dbe_pldeveloper.gs_source s \
             JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
             WHERE n.nspname = {} AND s.name = {} \
               AND upper(replace(s.type, '_', ' ')) = upper({}) \
             ORDER BY s.id DESC LIMIT 1 \
         ) ORDER BY e.line NULLS LAST LIMIT 1",
        sql_string(schema),
        sql_string(object_name),
        sql_string(&normalized_object_type(object_type)),
    )
}

fn clean_source(source: &str) -> &str {
    let trimmed = source.trim();
    trimmed.strip_suffix('/').map(str::trim_end).unwrap_or(trimmed)
}

fn recompile_result(
    schema: &str,
    object_name: &str,
    object_type: &str,
    success: bool,
    error: Option<String>,
    elapsed_ms: u64,
) -> RecompileObjectResult {
    RecompileObjectResult {
        schema: schema.to_string(),
        name: object_name.to_string(),
        object_type: object_type.to_string(),
        success,
        error,
        elapsed_ms,
    }
}

async fn recompile_external(
    session: Arc<PluginDriverSession>,
    config: Arc<ConnectionConfig>,
    database: &str,
    schema: &str,
    object_name: &str,
    object_type: &str,
) -> Result<RecompileObjectResult, String> {
    let source_result = external_query(
        session.clone(),
        config.as_ref(),
        database,
        Some(schema),
        &source_lookup_sql(schema, object_name, object_type),
        1,
    )
    .await?;
    let Some(source) = string_from_query_result(&source_result) else {
        return Err(format!("Source code not found for {object_type} {schema}.{object_name}"));
    };
    let source = clean_source(&source);
    if source.is_empty() {
        return Err(format!("Empty source for {object_type} {schema}.{object_name}"));
    }

    let start_time = Instant::now();
    let compile_error = external_query(session.clone(), config.as_ref(), database, Some(schema), source, 1).await.err();
    let elapsed_ms = start_time.elapsed().as_millis() as u64;

    // A failed CREATE can still update gs_source/gs_errors through the
    // server's PL/SQL compiler bookkeeping. Always re-read status after the
    // attempt instead of treating the JDBC exception as the final state.
    let status_result = match external_query(
        session.clone(),
        config.as_ref(),
        database,
        Some(schema),
        &status_lookup_sql(schema, object_name, object_type),
        1,
    )
    .await
    {
        Ok(result) => result,
        Err(status_error) => {
            if let Some(compile_error) = compile_error {
                return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
            }
            return Err(status_error);
        }
    };
    let Some(success) = bool_from_query_result(&status_result) else {
        if let Some(compile_error) = compile_error {
            return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
        }
        return Err(format!("Could not verify compilation status for {object_type} {schema}.{object_name}"));
    };
    if let Some(compile_error) = compile_error {
        return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
    }
    if success {
        return Ok(recompile_result(schema, object_name, object_type, true, None, elapsed_ms));
    }

    let error_result = external_query(
        session,
        config.as_ref(),
        database,
        Some(schema),
        &error_lookup_sql(schema, object_name, object_type),
        1,
    )
    .await?;
    let error =
        string_from_query_result(&error_result).or_else(|| Some("Compilation failed with unknown error".to_string()));
    Ok(recompile_result(schema, object_name, object_type, false, error, elapsed_ms))
}

/// Recompile a single invalid object by executing its stored CREATE source.
pub async fn recompile_object_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    object_name: &str,
    object_type: &str,
) -> Result<RecompileObjectResult, String> {
    let config = require_opengauss_config(state, connection_id).await?;
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;

    if let Some((external_config, external_session)) = external_session_for_pool(state, &pool_key).await {
        return recompile_external(external_session, external_config, database, schema, object_name, object_type).await;
    }

    let Some(pool) = crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key).await?
    else {
        return Err(format!("No PostgreSQL-compatible metadata session for {}", config.name));
    };
    let client = postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?;
    let source_rows =
        client.query(&source_lookup_sql(schema, object_name, object_type), &[]).await.map_err(|e| e.to_string())?;
    let Some(row) = source_rows.first() else {
        return Err(format!("Source code not found for {object_type} {schema}.{object_name}"));
    };
    let raw_source: String = row.try_get(0).map_err(|e| e.to_string())?;
    let source = clean_source(&raw_source);
    if source.is_empty() {
        return Err(format!("Empty source for {object_type} {schema}.{object_name}"));
    }

    let start_time = Instant::now();
    client.batch_execute("BEGIN").await.map_err(|e| e.to_string())?;
    let search_path_sql = format!("SET LOCAL search_path TO {}, pg_catalog, public", postgres::pg_quote_ident(schema));
    if let Err(error) = client.batch_execute(&search_path_sql).await {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(error.to_string());
    }

    let compile_error = client.simple_query(source).await.err().map(|error| error.to_string());
    let elapsed_ms = start_time.elapsed().as_millis() as u64;
    let commit_error = if compile_error.is_none() {
        client.batch_execute("COMMIT").await.err().map(|error| error.to_string())
    } else {
        None
    };
    if compile_error.is_some() || commit_error.is_some() {
        let _ = client.batch_execute("ROLLBACK").await;
    }
    let compile_error = compile_error.or(commit_error);

    // Re-query status even when CREATE returned an error. openGauss records
    // PL/SQL compiler diagnostics separately from the client error response.
    let status_rows = match client.query(&status_lookup_sql(schema, object_name, object_type), &[]).await {
        Ok(rows) => rows,
        Err(status_error) => {
            if let Some(compile_error) = compile_error {
                return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
            }
            return Err(status_error.to_string());
        }
    };
    let Some(success) = status_rows.first().and_then(|row| row.try_get::<_, bool>(0).ok()) else {
        if let Some(compile_error) = compile_error {
            return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
        }
        return Err(format!("Could not verify compilation status for {object_type} {schema}.{object_name}"));
    };
    if let Some(compile_error) = compile_error {
        return Ok(recompile_result(schema, object_name, object_type, false, Some(compile_error), elapsed_ms));
    }
    if success {
        return Ok(recompile_result(schema, object_name, object_type, true, None, elapsed_ms));
    }

    let error_rows =
        client.query(&error_lookup_sql(schema, object_name, object_type), &[]).await.map_err(|e| e.to_string())?;
    let error = error_rows
        .first()
        .and_then(|row| row.try_get::<_, String>(0).ok())
        .or_else(|| Some("Compilation failed with unknown error".to_string()));
    Ok(recompile_result(schema, object_name, object_type, false, error, elapsed_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_objects_sql_targets_actual_open_gauss_catalog_columns() {
        let sql = opengauss_invalid_objects_sql(Some("app"));
        assert!(sql.contains("dbe_pldeveloper.gs_source"));
        assert!(sql.contains("dbe_pldeveloper.gs_errors"));
        assert!(sql.contains("latest.status = false"));
        assert!(sql.contains("first_error.src AS error_message"));
        assert!(sql.contains("first_error.id = latest.id"));
        assert!(!sql.contains("e.position"));
        assert!(!sql.contains("e.errormsg"));
        assert!(sql.contains("latest.schema_name = 'app'"));
    }

    #[test]
    fn object_type_normalization_accepts_package_body_wire_names() {
        assert_eq!(normalized_object_type("PACKAGE_BODY"), "PACKAGE BODY");
        assert_eq!(normalized_object_type(" package body "), "package body");
    }
}
