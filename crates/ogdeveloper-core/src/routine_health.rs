// SPDX-License-Identifier: Apache-2.0
//! Read-only catalog input for routine health analysis. Never invokes a user routine.
use std::sync::Arc;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::opengauss_maintenance::InvalidObjectInfo;
use crate::plugins::PluginDriverSession;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHealthRoutine {
    pub id: String,
    pub schema: String,
    pub name: String,
    pub object_type: String,
    pub signature: String,
    pub source: Option<String>,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_path: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHealthRelation {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHealthIndex {
    pub schema: String,
    pub name: String,
    pub table_schema: String,
    pub table_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHealthSnapshot {
    pub routines: Vec<RoutineHealthRoutine>,
    pub relations: Vec<RoutineHealthRelation>,
    pub indexes: Vec<RoutineHealthIndex>,
    pub search_path: Vec<String>,
    pub invalid_objects: Vec<InvalidObjectInfo>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    has_prokind: bool,
    has_prosp: bool,
    has_source: bool,
    has_errors: bool,
    search_path: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRoutine {
    #[serde(flatten)]
    routine: RoutineHealthRoutine,
    config: Vec<String>,
    effective_user: String,
}

enum CatalogSession {
    Native(deadpool_postgres::Object),
    External(Arc<ConnectionConfig>, Arc<PluginDriverSession>, String),
}

impl CatalogSession {
    async fn json<T: DeserializeOwned>(&self, sql: &str) -> Result<T, String> {
        // Aggregate each complete catalog into ONE JSON text cell. A JDBC driver's
        // result-row limit therefore cannot silently truncate the dependency universe.
        let value = match self {
            Self::Native(client) => {
                let rows = client.query(sql, &[]).await.map_err(|e| e.to_string())?;
                let row = rows.first().ok_or("Catalog query returned no JSON row")?;
                Value::String(row.try_get::<_, String>(0).map_err(|e| e.to_string())?)
            }
            Self::External(config, session, database) => {
                let result: db::QueryResult = session
                    .invoke_with_timeout(
                        "executeQuery",
                        serde_json::json!({"connection": config.as_ref(), "database": database,
                        "schema": null, "sql": sql, "maxRows": 2}),
                        Some(db::connection_timeout()),
                    )
                    .await?;
                result.rows.first().and_then(|row| row.first()).cloned().ok_or("Catalog query returned no JSON cell")?
            }
        };
        decode_json_cell(value)
    }
}

fn decode_json_cell<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    match value {
        Value::String(text) => serde_json::from_str(&text),
        value => serde_json::from_value(value),
    }
    .map_err(|e| format!("Incomplete or invalid routine-health catalog JSON: {e}"))
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn business_schema_predicate(column: &str) -> String {
    format!(
        "{column} !~ '^pg_' AND {column} !~ '^dbe_' AND {column} NOT IN \
        ('information_schema', 'db4ai', 'cstore', 'pkg_service', 'snapshot', 'blockchain', 'sqladvisor')"
    )
}

fn source_predicate(schema: Option<&str>, column: &str) -> String {
    match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(schema) => format!("{column} = {}", sql_string(schema)),
        None => business_schema_predicate(column),
    }
}

const CAPABILITIES_SQL: &str = r#"SELECT pg_catalog.row_to_json(x)::text FROM (
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND a.attname = 'prokind' AND NOT a.attisdropped) AS "hasProkind",
      EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND a.attname = 'prosp' AND NOT a.attisdropped) AS "hasProsp",
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'dbe_pldeveloper' AND c.relname = 'gs_source') AS "hasSource",
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'dbe_pldeveloper' AND c.relname = 'gs_errors') AS "hasErrors",
      pg_catalog.current_schemas(true) AS "searchPath"
) x"#;

fn aggregate_sql(inner: &str) -> String {
    format!("SELECT COALESCE(pg_catalog.json_agg(pg_catalog.row_to_json(x)), '[]'::json)::text FROM ({inner}) x")
}

fn routines_sql(schema: Option<&str>, has_prokind: bool, has_prosp: bool, source_expression: &str) -> String {
    let kind = match (has_prokind, has_prosp) {
        (true, true) => "CASE WHEN p.prokind = 'p' OR p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END",
        (true, false) => "CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END",
        (false, true) => "CASE WHEN p.prosp THEN 'PROCEDURE' ELSE 'FUNCTION' END",
        _ => "'FUNCTION'::text",
    };
    let executable = if has_prokind { "p.prokind IN ('f', 'p')" } else { "NOT p.proisagg AND NOT p.proiswindow" };
    // Include aggregate/window identities too, so count()/sum() are never reported missing.
    aggregate_sql(&format!(
        r#"SELECT p.oid::text AS id, n.nspname AS schema, p.proname AS name,
        {kind} AS "objectType", COALESCE(pg_catalog.pg_get_function_arguments(p.oid), '') AS signature,
        CASE WHEN ({scope}) AND {executable} THEN {source_expression} ELSE NULL::text END AS source,
        l.lanname AS language, COALESCE(p.proconfig, ARRAY[]::text[]) AS config,
        CASE WHEN p.prosecdef THEN pg_catalog.pg_get_userbyid(p.proowner)::text ELSE CURRENT_USER::text END AS "effectiveUser"
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_catalog.pg_language l ON l.oid = p.prolang ORDER BY n.nspname, p.proname, p.oid"#,
        scope = source_predicate(schema, "n.nspname")
    ))
}

fn relations_sql() -> String {
    aggregate_sql(
        r#"SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
      ARRAY(SELECT a.attname::text FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'v', 'm', 'f', 'p', 'S') ORDER BY n.nspname, c.relname"#,
    )
}

fn indexes_sql() -> String {
    aggregate_sql(
        r#"SELECT ni.nspname AS schema, i.relname AS name, nt.nspname AS "tableSchema", t.relname AS "tableName"
      FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
      JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
      JOIN pg_catalog.pg_namespace ni ON ni.oid = i.relnamespace
      JOIN pg_catalog.pg_namespace nt ON nt.oid = t.relnamespace ORDER BY ni.nspname, i.relname"#,
    )
}

fn invalid_objects_sql(schema: Option<&str>, has_errors: bool) -> String {
    // Reuse the existing newest-source-record selection, but keep all schemas when
    // explicitly requested and describe missing diagnostics honestly.
    let mut inner = crate::opengauss_maintenance::opengauss_invalid_objects_sql(schema);
    let old_filter = "AND latest.schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'cstore', 'dbe_perf', 'dbe_pldebugger', 'pkg_service')";
    let filter = if schema.map(str::trim).is_some_and(|s| !s.is_empty()) {
        String::new()
    } else {
        format!("AND {}", business_schema_predicate("latest.schema_name"))
    };
    inner = inner.replace(old_filter, &filter);
    if !has_errors {
        inner = inner.replace(
            "FROM dbe_pldeveloper.gs_errors e",
            "FROM (SELECT NULL::bigint AS id, NULL::integer AS line, NULL::text AS src WHERE false) e",
        );
    }
    aggregate_sql(&format!(
        r#"SELECT s.schema_name AS schema, s.object_name AS name, s.object_type AS "objectType",
        s.error_line AS "errorLine", s.error_position AS "errorPosition", s.error_message AS "errorMessage", s.source
        FROM ({inner}) s"#
    ))
}

/// Parse the GUC identifier list without splitting commas inside quoted identifiers.
/// Preserve explicit pg_catalog position; otherwise it is searched implicitly first.
fn routine_search_path(config: &[String], effective_user: &str) -> Result<Option<Vec<String>>, String> {
    let Some(setting) = config.iter().find_map(|s| s.strip_prefix("search_path=")) else { return Ok(None) };
    let mut chars = setting.chars().peekable();
    let mut paths = Vec::new();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut name = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        name.push('"');
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    name.push(c);
                }
            }
            if !closed {
                return Err("Unterminated quoted search_path identifier".into());
            }
            while chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
            if chars.peek().is_some_and(|c| *c != ',') {
                return Err("Unsupported search_path expression".into());
            }
        } else {
            while chars.peek().is_some_and(|c| *c != ',') {
                name.push(chars.next().unwrap());
            }
            name = name.trim().to_ascii_lowercase();
            if name.chars().any(|c| c.is_whitespace()) {
                return Err("Unsupported search_path expression".into());
            }
        }
        if name == "$user" {
            name = effective_user.to_string();
        }
        if name == "pg_temp" {
            return Err("Routine search_path includes session-dependent pg_temp".into());
        }
        if !name.is_empty() {
            paths.push(name);
        }
        if chars.peek() == Some(&',') {
            chars.next();
        }
    }
    if !paths.iter().any(|s| s == "pg_catalog") {
        paths.insert(0, "pg_catalog".into());
    }
    Ok(Some(paths))
}

pub async fn list_routine_health_snapshot_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
) -> Result<RoutineHealthSnapshot, String> {
    let config = state.configs.read().await.get(connection_id).cloned().ok_or("Connection config not found")?;
    let is_opengauss = crate::schema::is_opengauss_family_config(&config);
    let is_postgres = matches!(config.db_type, DatabaseType::Postgres)
        || config.driver_profile.as_deref().is_some_and(|p| {
            matches!(p.to_ascii_lowercase().as_str(), "postgres" | "postgresql" | "postgres-jdbc" | "postgresql-jdbc")
        });
    if !is_opengauss && !is_postgres {
        return Err("Routine health analysis requires PostgreSQL or openGauss".into());
    }
    let pool_key = state.get_or_create_metadata_pool_for_session(connection_id, Some(database), None).await?;
    let external = {
        let connections = state.connections.read().await;
        match connections.get(&pool_key) {
            Some(PoolKind::ExternalDriver { config, session, .. }) => Some((config.clone(), session.clone())),
            _ => None,
        }
    };
    let session = if let Some((config, driver)) = external {
        CatalogSession::External(config, driver, database.to_string())
    } else {
        let pool = crate::schema::opengauss_metadata_postgres_pool(state, connection_id, database, &pool_key)
            .await?
            .ok_or("No PostgreSQL-compatible metadata connection")?;
        CatalogSession::Native(db::postgres::checkout_postgres_client(&pool, None, db::connection_timeout()).await?)
    };
    let caps: Capabilities = session
        .json(CAPABILITIES_SQL)
        .await
        .map_err(|e| format!("Cannot read routine-health catalog capabilities: {e}"))?;
    let mut warnings = vec!["Routine calls are checked by name, not overload argument types. Unqualified names use the routine search_path when configured, otherwise the current metadata session search_path; results can differ in another execution session.".to_string()];
    let sources = if is_opengauss {
        ["(pg_catalog.pg_get_functiondef(p.oid)).definition", "pg_catalog.pg_get_functiondef(p.oid)", "p.prosrc::text"]
    } else {
        ["pg_catalog.pg_get_functiondef(p.oid)", "(pg_catalog.pg_get_functiondef(p.oid)).definition", "p.prosrc::text"]
    };
    let mut raw_routines = None;
    let mut failures = Vec::new();
    for (index, expression) in sources.into_iter().enumerate() {
        match session.json::<Vec<RawRoutine>>(&routines_sql(schema, caps.has_prokind, caps.has_prosp, expression)).await
        {
            Ok(rows) => {
                if index == 2 {
                    warnings.push(format!("Full routine definitions unavailable; analyzing stored bodies only (parameter/declaration context may be incomplete): {}", failures.join("; ")));
                }
                raw_routines = Some(rows);
                break;
            }
            Err(error) => failures.push(error),
        }
    }
    let raw_routines =
        raw_routines.ok_or_else(|| format!("Cannot read complete routine catalog: {}", failures.join("; ")))?;
    let mut routines = Vec::with_capacity(raw_routines.len());
    for raw in raw_routines {
        let mut routine = raw.routine;
        match routine_search_path(&raw.config, &raw.effective_user) {
            Ok(path) => routine.search_path = path,
            Err(error) => {
                routine.search_path = Some(Vec::new());
                if routine.source.is_some() {
                    warnings.push(format!(
                        "{}.{}: {error}; unqualified dependencies were not checked",
                        routine.schema, routine.name
                    ));
                }
            }
        }
        routines.push(routine);
    }
    let relations = session
        .json(&relations_sql())
        .await
        .map_err(|e| format!("Cannot read complete relation/column catalog: {e}"))?;
    let indexes = session.json(&indexes_sql()).await.map_err(|e| format!("Cannot read complete index catalog: {e}"))?;
    let invalid_objects = if caps.has_source {
        if !caps.has_errors {
            warnings.push("gs_errors is unavailable; compilation-failure records have no detailed diagnostics".into());
        }
        match session.json(&invalid_objects_sql(schema, caps.has_errors)).await {
            Ok(records) => records,
            Err(error) => {
                warnings.push(format!(
                    "Compilation-failure records could not be read (catalog support or permissions): {error}"
                ));
                Vec::new()
            }
        }
    } else {
        warnings.push(if is_opengauss { "gs_source is unavailable; compilation-failure status was not checked" }
            else { "PostgreSQL does not provide openGauss gs_source compilation-failure records; only static dependency analysis is available" }.into());
        Vec::new()
    };
    Ok(RoutineHealthSnapshot { routines, relations, indexes, search_path: caps.search_path, invalid_objects, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routine_scope_never_removes_cross_schema_or_builtin_identities() {
        let sql = routines_sql(Some("app'o"), true, false, "p.prosrc::text");
        assert!(sql.contains("CASE WHEN (n.nspname = 'app''o') AND p.prokind IN ('f', 'p')"));
        assert!(!sql.contains("WHERE n.nspname"));
        assert!(!sql.contains("LIMIT"));
        assert!(sql.contains("p.oid::text AS id"));
        assert!(routines_sql(None, false, false, "p.prosrc::text").contains("NOT p.proisagg AND NOT p.proiswindow"));
        assert!(routines_sql(None, true, false, "p.prosrc::text").contains("'db4ai'"));
    }

    #[test]
    fn configured_search_path_handles_quoted_commas_user_and_catalog_order() {
        let config = vec![r#"search_path="$user", "Mixed,Case", pg_catalog, "a""b""#.into()];
        assert_eq!(
            routine_search_path(&config, "owner").unwrap().unwrap(),
            vec!["owner", "Mixed,Case", "pg_catalog", "a\"b"]
        );
        assert_eq!(
            routine_search_path(&["search_path=app, public".into()], "owner").unwrap().unwrap(),
            vec!["pg_catalog", "app", "public"]
        );
        assert!(routine_search_path(&["search_path=pg_temp, app".into()], "u").is_err());
        assert!(routine_search_path(&[], "u").unwrap().is_none());
    }

    #[test]
    fn jdbc_json_cell_preserves_overloads_null_source_and_complete_columns() {
        let raw = r#"[{"id":"12","schema":"app","name":"f","objectType":"FUNCTION","signature":"id integer","source":null,"language":"plpgsql","config":[],"effectiveUser":"u"},{"id":"13","schema":"app","name":"f","objectType":"FUNCTION","signature":"id text","source":"BEGIN END","language":"plpgsql","config":[],"effectiveUser":"u"}]"#;
        let rows: Vec<RawRoutine> = decode_json_cell(Value::String(raw.into())).unwrap();
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0].routine.id, rows[1].routine.id);
        assert!(rows[0].routine.source.is_none());
        assert!(decode_json_cell::<Vec<RawRoutine>>(Value::String(raw[..raw.len() - 1].into())).is_err());
        let relations: Vec<RoutineHealthRelation> =
            decode_json_cell(serde_json::json!([{"schema":"app","name":"t","kind":"r","columns":["a","b"]}])).unwrap();
        assert_eq!(relations[0].columns, vec!["a", "b"]);
    }

    #[test]
    fn compilation_records_without_error_catalog_keep_unknown_diagnostics() {
        let sql = invalid_objects_sql(None, false);
        assert!(!sql.contains("FROM dbe_pldeveloper.gs_errors"));
        assert!(sql.contains("NULL::text AS src WHERE false"));
        assert!(sql.contains("latest.status = false"));
        assert!(sql.contains("'db4ai'"));
        assert!(invalid_objects_sql(Some("db4ai"), true).contains("latest.schema_name = 'db4ai'"));
        assert!(!relations_sql().contains("LIMIT"));
        assert!(relations_sql().contains("NOT a.attisdropped"));
    }
}
