//! Cross-connection search: object names (metadata) and object definition
//! text, plus host filesystem search for the 项目 (workspace) feature.

use std::time::Duration;

use crate::connection::{config_for_pool_key, AppState, PoolKind};
use crate::models::connection::{ConnectionConfig, DatabaseType};

#[derive(Debug, Clone, serde::Serialize)]
pub struct MetadataSearchHit {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: String,
    pub object_type: String,
    pub name: String,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DefinitionSearchHit {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: String,
    pub object_type: String,
    pub name: String,
    pub signature: Option<String>,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileSearchHit {
    pub path: String,
    pub relative: String,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchScopeTarget {
    pub connection_id: String,
    #[serde(default)]
    pub database: String,
}

const SEARCH_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);

fn supports_postgres_search(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::Postgres | DatabaseType::OpenGauss)
}

fn supports_package_search(config: &ConnectionConfig) -> bool {
    matches!(config.db_type, DatabaseType::OpenGauss)
}

fn escape_like_pattern(query: &str) -> String {
    query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn sql_string(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn user_schema_predicate(include_opengauss_schemas: bool) -> &'static str {
    if include_opengauss_schemas {
        "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'blockchain', 'coverage', 'cstore', 'db4ai', 'dbe_perf', 'dbe_pldebugger', 'dbe_pldeveloper', 'dbe_sql_util', 'pkg_service', 'snapshot', 'sqladvisor', 'xmltype') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'"
    } else {
        "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'"
    }
}

fn pg_metadata_search_sql(pattern: &str, include_packages: bool, limit: usize) -> String {
    let schema_predicate = user_schema_predicate(include_packages);
    let packages = if include_packages {
        format!(
            " UNION ALL \
             SELECT n.nspname, p.pkgname, 'PACKAGE', NULL::text \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE p.pkgname ILIKE {pattern} ESCAPE '\\' AND {schema_predicate} \
             UNION ALL \
             SELECT n.nspname, p.pkgname, 'PACKAGE_BODY', NULL::text \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE p.pkgbodydeclsrc IS NOT NULL AND p.pkgname ILIKE {pattern} ESCAPE '\\' AND {schema_predicate}"
        )
    } else {
        String::new()
    };
    format!(
        "SELECT n.nspname, c.relname, \
                CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'p' THEN 'TABLE' WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END, \
                NULL::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relname ILIKE {pattern} ESCAPE '\\' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c') AND {schema_predicate} \
         UNION ALL \
         SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                pg_get_function_identity_arguments(p.oid) \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.proname ILIKE {pattern} ESCAPE '\\' AND {schema_predicate} \
         UNION ALL \
         SELECT n.nspname, t.typname, 'TYPE', NULL::text \
         FROM pg_catalog.pg_type t \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE t.typname ILIKE {pattern} ESCAPE '\\' AND t.typtype = 'e' \
           AND t.typname NOT LIKE '\\_%' ESCAPE '\\' \
           AND {schema_predicate} \
         UNION ALL \
         SELECT n.nspname, c.relname || '.' || a.attname, 'COLUMN', NULL::text \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm') \
           AND a.attname ILIKE {pattern} ESCAPE '\\' \
           AND {schema_predicate} \
         {packages} \
         LIMIT {}",
        limit.clamp(1, 500)
    )
}

fn pg_definition_search_sql(pattern: &str, include_packages: bool, limit: usize) -> String {
    let schema_predicate = user_schema_predicate(include_packages);
    // openGauss-lite 的 pg_get_functiondef 在 WHERE 中不可用（planner bug），
    // 所以函数/过程使用 pg_proc.prosrc，视图使用 pg_get_viewdef。
    let packages = if include_packages {
        format!(
            " UNION ALL \
             SELECT n.nspname, p.pkgname, 'PACKAGE', NULL::text, p.pkgspecsrc \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE p.pkgspecsrc ILIKE {pattern} ESCAPE '\\' AND {schema_predicate} \
             UNION ALL \
             SELECT n.nspname, p.pkgname, 'PACKAGE_BODY', NULL::text, \
                    COALESCE(p.pkgbodydeclsrc, '') || E'\\n' || COALESCE(p.pkgbodyinitsrc, '') \
             FROM pg_catalog.gs_package p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pkgnamespace \
             WHERE (COALESCE(p.pkgbodydeclsrc, '') || E'\\n' || COALESCE(p.pkgbodyinitsrc, '')) ILIKE {pattern} ESCAPE '\\' AND {schema_predicate}"
        )
    } else {
        String::new()
    };
    format!(
        "SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                pg_get_function_identity_arguments(p.oid), p.prosrc \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.prosrc ILIKE {pattern} ESCAPE '\\' AND {schema_predicate} \
         UNION ALL \
         SELECT n.nspname, c.relname, CASE c.relkind WHEN 'm' THEN 'MATERIALIZED_VIEW' ELSE 'VIEW' END, \
                NULL::text, pg_get_viewdef(c.oid)::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid)::text ILIKE {pattern} ESCAPE '\\' \
           AND {schema_predicate} \
         {packages} \
         LIMIT {}",
        limit.clamp(1, 500)
    )
}

fn clean_definition_source(raw: &str) -> &str {
    raw.strip_prefix("(1,\"").and_then(|rest| rest.strip_suffix("\")")).unwrap_or(raw)
}

fn definition_snippet(raw: &str, query: &str) -> String {
    let raw = clean_definition_source(raw);
    let query_lower = query.to_lowercase();
    let raw_lower = raw.to_lowercase();
    let match_byte = raw_lower.find(&query_lower).unwrap_or(0);
    let match_char = raw_lower[..match_byte].chars().count();
    let chars: Vec<char> = raw.chars().collect();
    let start = match_char.saturating_sub(140);
    let end = (start + 600).min(chars.len());
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..end].iter().collect::<String>(),
        if end < chars.len() { "…" } else { "" }
    )
}

fn json_text(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(value)) => value.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn append_metadata_row(
    values: &[serde_json::Value],
    hits: &mut Vec<MetadataSearchHit>,
    connection_id: &str,
    connection_name: &str,
    database: &str,
    limit: usize,
) {
    if hits.len() >= limit {
        return;
    }
    hits.push(MetadataSearchHit {
        connection_id: connection_id.to_string(),
        connection_name: connection_name.to_string(),
        database: database.to_string(),
        schema: json_text(values.first()),
        name: json_text(values.get(1)),
        object_type: json_text(values.get(2)),
        signature: values.get(3).filter(|value| !value.is_null()).map(|value| json_text(Some(value))),
    });
}

fn append_definition_row(
    values: &[serde_json::Value],
    query: &str,
    hits: &mut Vec<DefinitionSearchHit>,
    connection_id: &str,
    connection_name: &str,
    database: &str,
    limit: usize,
) {
    if hits.len() >= limit {
        return;
    }
    let raw = json_text(values.get(4));
    hits.push(DefinitionSearchHit {
        connection_id: connection_id.to_string(),
        connection_name: connection_name.to_string(),
        database: database.to_string(),
        schema: json_text(values.first()),
        name: json_text(values.get(1)),
        object_type: json_text(values.get(2)),
        signature: values.get(3).filter(|value| !value.is_null()).map(|value| json_text(Some(value))),
        snippet: definition_snippet(&raw, query),
    });
}

async fn search_native_postgres(
    pool: &deadpool_postgres::Pool,
    config: &ConnectionConfig,
    query: &str,
    definitions: bool,
    metadata_hits: &mut Vec<MetadataSearchHit>,
    definition_hits: &mut Vec<DefinitionSearchHit>,
    connection_id: &str,
    database: &str,
    limit: usize,
    query_limit: usize,
) {
    let client = match crate::db::postgres::checkout_postgres_client(pool, None, SEARCH_CONNECTION_TIMEOUT).await {
        Ok(client) => client,
        Err(error) => {
            log::warn!("[search] checkout failed for {connection_id}: {error}");
            return;
        }
    };
    let pattern = format!("%{}%", escape_like_pattern(query));
    let sql = if definitions {
        pg_definition_search_sql("$1", supports_package_search(config), query_limit)
    } else {
        pg_metadata_search_sql("$1", supports_package_search(config), query_limit)
    };
    let rows = match client.query(&sql, &[&pattern]).await {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("[search] query failed for {connection_id}: {error}");
            return;
        }
    };
    for row in rows {
        if definitions {
            let values = (0..5)
                .map(|index| {
                    row.try_get::<_, Option<String>>(index)
                        .ok()
                        .flatten()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>();
            append_definition_row(&values, query, definition_hits, connection_id, &config.name, database, limit);
        } else {
            let values = (0..4)
                .map(|index| {
                    row.try_get::<_, Option<String>>(index)
                        .ok()
                        .flatten()
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>();
            append_metadata_row(&values, metadata_hits, connection_id, &config.name, database, limit);
        }
    }
}

async fn search_external_postgres(
    config: &ConnectionConfig,
    session: &crate::plugins::PluginDriverSession,
    query: &str,
    definitions: bool,
    metadata_hits: &mut Vec<MetadataSearchHit>,
    definition_hits: &mut Vec<DefinitionSearchHit>,
    connection_id: &str,
    database: &str,
    limit: usize,
    query_limit: usize,
) {
    let pattern = sql_string(&format!("%{}%", escape_like_pattern(query)));
    let sql = if definitions {
        pg_definition_search_sql(&pattern, supports_package_search(config), query_limit)
    } else {
        pg_metadata_search_sql(&pattern, supports_package_search(config), query_limit)
    };
    let params = serde_json::json!({
        "connection": config,
        "database": database,
        "sql": sql,
        "maxRows": query_limit.clamp(1, 500),
    });
    let result = match session
        .invoke_with_timeout::<crate::db::QueryResult>("executeQuery", params, Some(SEARCH_CONNECTION_TIMEOUT))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            log::warn!("[search] external-driver query failed for {connection_id}: {error}");
            return;
        }
    };
    for row in result.rows {
        if definitions {
            append_definition_row(&row, query, definition_hits, connection_id, &config.name, database, limit);
        } else {
            append_metadata_row(&row, metadata_hits, connection_id, &config.name, database, limit);
        }
    }
}

fn database_from_pool_key(pool_key: &str, connection_id: &str) -> Option<String> {
    let rest = pool_key.strip_prefix(connection_id)?.strip_prefix(':')?;
    let base = rest.split_once(":session:").map(|(base, _)| base).unwrap_or(rest);
    let base = base.split_once(":catalog:").map(|(base, _)| base).unwrap_or(base);
    base.split(':').next().filter(|database| !database.is_empty()).map(str::to_string)
}

/// Lists the exact connection/database pools currently available to global search.
pub async fn list_database_search_scope_targets(state: &AppState) -> Vec<DatabaseSearchScopeTarget> {
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    let mut targets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (pool_key, pool) in connections.iter() {
        let Some(saved_config) = config_for_pool_key(pool_key, &configs) else { continue };
        let connection_id = configs
            .iter()
            .filter(|(id, _)| {
                pool_key.strip_prefix(id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
            })
            .max_by_key(|(id, _)| id.len())
            .map(|(id, _)| id.as_str())
            .unwrap_or(pool_key.as_str());
        let database = match pool {
            PoolKind::ExternalDriver { config, .. } => database_from_pool_key(pool_key, connection_id)
                .or_else(|| config.effective_database().map(str::to_string))
                .or_else(|| saved_config.effective_database().map(str::to_string))
                .unwrap_or_default(),
            _ => database_from_pool_key(pool_key, connection_id)
                .or_else(|| saved_config.effective_database().map(str::to_string))
                .unwrap_or_default(),
        };
        if seen.insert((connection_id.to_string(), database.clone())) {
            targets.push(DatabaseSearchScopeTarget { connection_id: connection_id.to_string(), database });
        }
    }
    targets.sort_by(|a, b| a.connection_id.cmp(&b.connection_id).then_with(|| a.database.cmp(&b.database)));
    targets
}

fn connection_is_selected(targets: Option<&[DatabaseSearchScopeTarget]>, connection_id: &str, database: &str) -> bool {
    targets.is_none_or(|targets| {
        targets.iter().any(|target| {
            target.connection_id == connection_id && (target.database.is_empty() || target.database == database)
        })
    })
}

async fn search_connected_postgres(
    state: &AppState,
    query: &str,
    limit: usize,
    definitions: bool,
    targets: Option<&[DatabaseSearchScopeTarget]>,
) -> (Vec<MetadataSearchHit>, Vec<DefinitionSearchHit>) {
    let mut metadata_hits = Vec::new();
    let mut definition_hits = Vec::new();
    if let Some(targets) = targets {
        for target in targets.iter().filter(|target| !target.database.is_empty()) {
            if let Err(error) = state.get_or_create_pool(&target.connection_id, Some(&target.database)).await {
                log::warn!(
                    "[search] could not open selected target {} / {}: {error}",
                    target.connection_id,
                    target.database
                );
            }
        }
    }
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    let target_count = targets
        .map(<[DatabaseSearchScopeTarget]>::len)
        .unwrap_or_else(|| configs.values().filter(|config| supports_postgres_search(config)).count())
        .max(1);
    let query_limit = limit.div_ceil(target_count);
    let mut searched = std::collections::HashSet::new();
    let mut pool_entries = connections.iter().collect::<Vec<_>>();
    pool_entries.sort_by_key(|(left, _)| *left);
    for (pool_key, pool) in pool_entries {
        if metadata_hits.len() >= limit || definition_hits.len() >= limit {
            break;
        }
        let Some(saved_config) = config_for_pool_key(pool_key, &configs) else { continue };
        if !supports_postgres_search(saved_config) {
            continue;
        }
        let connection_id = configs
            .iter()
            .filter(|(id, _)| {
                pool_key.strip_prefix(id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
            })
            .max_by_key(|(id, _)| id.len())
            .map(|(id, _)| id.as_str())
            .unwrap_or(pool_key.as_str());
        let (database, search_config) = match pool {
            PoolKind::ExternalDriver { config, .. } => (
                database_from_pool_key(pool_key, connection_id)
                    .or_else(|| config.effective_database().map(str::to_string))
                    .or_else(|| saved_config.effective_database().map(str::to_string))
                    .unwrap_or_default(),
                config.as_ref(),
            ),
            _ => (
                database_from_pool_key(pool_key, connection_id)
                    .or_else(|| saved_config.effective_database().map(str::to_string))
                    .unwrap_or_default(),
                saved_config,
            ),
        };
        if !connection_is_selected(targets, connection_id, &database) {
            continue;
        }
        if !searched.insert((connection_id.to_string(), database.clone())) {
            continue;
        }
        match pool {
            PoolKind::Postgres(pg) => {
                search_native_postgres(
                    pg,
                    search_config,
                    query,
                    definitions,
                    &mut metadata_hits,
                    &mut definition_hits,
                    connection_id,
                    &database,
                    limit,
                    query_limit,
                )
                .await;
            }
            PoolKind::ExternalDriver { session, .. } => {
                search_external_postgres(
                    search_config,
                    session.as_ref(),
                    query,
                    definitions,
                    &mut metadata_hits,
                    &mut definition_hits,
                    connection_id,
                    &database,
                    limit,
                    query_limit,
                )
                .await;
            }
        }
    }
    (metadata_hits, definition_hits)
}

/// Searches object and column names across connected PostgreSQL-family pools,
/// including JDBC/external-driver openGauss profiles.
pub async fn search_metadata(state: &AppState, query: &str, limit: usize) -> Vec<MetadataSearchHit> {
    search_metadata_for_targets(state, query, limit, None).await
}

/// Searches object names only in the explicitly selected connection/database targets.
pub async fn search_metadata_for_targets(
    state: &AppState,
    query: &str,
    limit: usize,
    targets: Option<&[DatabaseSearchScopeTarget]>,
) -> Vec<MetadataSearchHit> {
    let query = query.trim();
    if query.is_empty() || targets.is_some_and(|targets| targets.is_empty()) {
        return Vec::new();
    }
    search_connected_postgres(state, query, limit.clamp(1, 500), false, targets).await.0
}

/// Searches routine, package, and view source across connected PostgreSQL-family pools,
/// including JDBC/external-driver openGauss profiles.
pub async fn search_object_definitions(state: &AppState, query: &str, limit: usize) -> Vec<DefinitionSearchHit> {
    search_object_definitions_for_targets(state, query, limit, None).await
}

/// Searches source text only in the explicitly selected connection/database targets.
pub async fn search_object_definitions_for_targets(
    state: &AppState,
    query: &str,
    limit: usize,
    targets: Option<&[DatabaseSearchScopeTarget]>,
) -> Vec<DefinitionSearchHit> {
    let query = query.trim();
    if query.is_empty() || targets.is_some_and(|targets| targets.is_empty()) {
        return Vec::new();
    }
    search_connected_postgres(state, query, limit.clamp(1, 500), true, targets).await.1
}

/// Walks `root` (bounded depth and entry count) and returns files whose name
/// contains `query` (case-insensitive), skipping hidden and VCS directories.
pub fn search_files(root: &str, query: &str, limit: usize) -> Result<Vec<FileSearchHit>, String> {
    let root_path = std::path::PathBuf::from(root);
    if !root_path.is_dir() {
        return Err(format!("Directory not found: {root}"));
    }
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    let mut stack = vec![(root_path.clone(), String::new())];
    let mut visited = 0usize;
    while let Some((dir, rel)) = stack.pop() {
        if hits.len() >= limit || visited > 20_000 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            visited += 1;
            if hits.len() >= limit {
                break;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let relative = if rel.is_empty() { file_name.clone() } else { format!("{rel}/{file_name}") };
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if matches!(file_name.as_str(), "node_modules" | "target" | ".git" | "dist" | "__pycache__") {
                    continue;
                }
                stack.push((path, relative));
                continue;
            }
            let Some(stem) = file_name.rsplit_once('.').map(|(stem, _)| stem).or(Some(&file_name)) else { continue };
            let matches = needle.is_empty()
                || file_name.to_lowercase().contains(&needle)
                || stem.to_lowercase().contains(&needle)
                || relative.to_lowercase().contains(&needle);
            if !matches {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            hits.push(FileSearchHit { path: path.to_string_lossy().to_string(), relative, size });
        }
    }
    hits.sort_by(|a, b| a.relative.cmp(&b.relative));
    hits.truncate(limit);
    Ok(hits)
}

/// Lists subdirectories of `path` (web directory browser).
pub fn list_directories(path: &str) -> Result<Vec<String>, String> {
    let dir = std::path::PathBuf::from(path);
    if !dir.is_dir() {
        return Err(format!("Directory not found: {path}"));
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') {
                out.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Reads a text file (web: opening a file search hit).
pub fn read_text_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Creates a directory tree (mkdir -p), used for project/sql directories.
pub fn ensure_directory(path: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory {path}: {e}"))
}

/// Writes a text file, creating parent directories when missing.
pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    let file = std::path::PathBuf::from(path);
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory {parent:?}: {e}"))?;
        }
    }
    std::fs::write(&file, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// 默认项目目录：HOME 下的 ogdeveloper-projects（web 与桌面统一）。
pub fn default_projects_root() -> String {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    format!("{home}/ogdeveloper-projects")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_wildcards_as_literal_search_text() {
        assert_eq!(escape_like_pattern(r#"rate_100%\done"#), r#"rate\_100\%\\done"#);
    }

    #[test]
    fn metadata_search_includes_columns_signatures_and_optional_packages() {
        let sql = pg_metadata_search_sql("$1", true, 200);
        assert!(sql.contains("'COLUMN'"));
        assert!(sql.contains("pg_get_function_identity_arguments"));
        assert!(sql.contains("pg_catalog.gs_package"));
        assert!(sql.contains("pg_temp_%"));
        assert!(sql.contains("LIMIT 200"));
    }

    #[test]
    fn definition_snippet_is_centered_around_the_match() {
        let source = format!("{}MATCH_HERE{}", "x".repeat(500), "y".repeat(500));
        let snippet = definition_snippet(&source, "match_here");
        assert!(snippet.contains("MATCH_HERE"));
        assert!(snippet.starts_with('…'));
        assert!(snippet.ends_with('…'));
        assert!(snippet.chars().count() <= 602);
    }

    #[test]
    fn filters_search_to_explicit_connection_and_database_targets() {
        let selected = vec![
            DatabaseSearchScopeTarget { connection_id: "profile-a".to_string(), database: "sales".to_string() },
            DatabaseSearchScopeTarget { connection_id: "profile-b".to_string(), database: String::new() },
        ];
        assert!(connection_is_selected(Some(&selected), "profile-a", "sales"));
        assert!(!connection_is_selected(Some(&selected), "profile-a", "hr"));
        assert!(connection_is_selected(Some(&selected), "profile-b", "any_database"));
        assert!(!connection_is_selected(Some(&selected), "profile-c", "sales"));
        assert!(connection_is_selected(None, "profile-c", "sales"));
    }

    #[test]
    fn extracts_database_from_scoped_pool_keys() {
        assert_eq!(database_from_pool_key("conn:analytics", "conn").as_deref(), Some("analytics"));
        assert_eq!(database_from_pool_key("conn:analytics:session:editor-1", "conn").as_deref(), Some("analytics"));
        assert_eq!(database_from_pool_key("conn:analytics:catalog:hive", "conn").as_deref(), Some("analytics"));
        assert_eq!(database_from_pool_key("conn", "conn"), None);
    }

    #[test]
    fn file_search_matches_relative_directory_path() {
        let root = std::env::temp_dir().join(format!("dbx-search-{}", std::process::id()));
        let nested = root.join("business-orders");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("query.sql"), "select 1").unwrap();
        let hits = search_files(root.to_string_lossy().as_ref(), "orders", 10).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].relative, "business-orders/query.sql");
    }
}
