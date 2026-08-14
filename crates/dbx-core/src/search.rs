//! Cross-connection search: object names (metadata) and object definition
//! text, plus host filesystem search for the 项目 (workspace) feature.

use std::time::Duration;

use crate::connection::{AppState, PoolKind};
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MetadataSearchHit {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: String,
    pub object_type: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DefinitionSearchHit {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: String,
    pub object_type: String,
    pub name: String,
    pub snippet: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileSearchHit {
    pub path: String,
    pub relative: String,
    pub size: u64,
}

const SEARCH_CONNECTION_TIMEOUT: Duration = Duration::from_secs(10);

fn pg_metadata_search_sql(query: &str) -> String {
    format!(
        "SELECT n.nspname, c.relname, \
                CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED_VIEW' WHEN 'p' THEN 'TABLE' WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relname ILIKE '%{}%' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
         UNION ALL \
         SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.proname ILIKE '%{}%' AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
         UNION ALL \
         SELECT n.nspname, t.typname, 'TYPE' \
         FROM pg_catalog.pg_type t \
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE t.typname ILIKE '%{}%' AND t.typtype = 'e' \
           AND t.typname NOT LIKE '\\_%' ESCAPE '\\' \
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
         LIMIT 60",
        query.replace('\'', "''"),
        query.replace('\'', "''"),
        query.replace('\'', "''")
    )
}

fn pg_definition_search_sql(query: &str) -> String {
    let escaped = query.replace('\'', "''");
    // openGauss-lite 的 pg_get_functiondef 在 WHERE 中不可用（planner bug：
    // 报 "array_agg is an aggregate function"），且其返回 record 无法直接 ILIKE。
    // 用 pg_proc.prosrc 搜索函数/过程体，视图用 pg_get_viewdef。
    format!(
        "SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, \
                p.prosrc \
         FROM pg_catalog.pg_proc p \
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE p.prosrc ILIKE '%{escaped}%' AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
         UNION ALL \
         SELECT n.nspname, c.relname, 'VIEW', pg_get_viewdef(c.oid)::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid)::text ILIKE '%{escaped}%' AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
         LIMIT 40"
    )
}

async fn search_pg_pool(
    pool: &deadpool_postgres::Pool,
    query: &str,
    definitions: bool,
    hits: &mut Vec<MetadataSearchHit>,
    definitions_out: &mut Vec<DefinitionSearchHit>,
    connection_id: &str,
    connection_name: &str,
    database: &str,
    limit: usize,
) {
    let client = match crate::db::postgres::checkout_postgres_client(pool, None, SEARCH_CONNECTION_TIMEOUT).await {
        Ok(client) => client,
        Err(_) => return,
    };
    let sql = if definitions { pg_definition_search_sql(query) } else { pg_metadata_search_sql(query) };
    let rows = match client.query(&sql, &[]).await {
        Ok(rows) => rows,
        Err(error) => {
            log::warn!("[search] query failed for {}: {}", connection_id, error);
            return;
        }
    };
    for row in rows {
        let schema: String = row.try_get(0).unwrap_or_default();
        let name: String = row.try_get(1).unwrap_or_default();
        let object_type: String = row.try_get(2).unwrap_or_default();
        if definitions {
            if definitions_out.len() >= limit {
                break;
            }
            let raw: String = row.try_get(3).unwrap_or_default();
            // openGauss record 形态 (1,"...") → 剥前缀与尾引号。
            let snippet = raw
                .strip_prefix("(1,\"")
                .and_then(|rest| rest.strip_suffix("\")"))
                .unwrap_or(&raw)
                .chars()
                .take(600)
                .collect();
            definitions_out.push(DefinitionSearchHit {
                connection_id: connection_id.to_string(),
                connection_name: connection_name.to_string(),
                database: database.to_string(),
                schema,
                object_type,
                name,
                snippet,
            });
        } else {
            if hits.len() >= limit {
                break;
            }
            hits.push(MetadataSearchHit {
                connection_id: connection_id.to_string(),
                connection_name: connection_name.to_string(),
                database: database.to_string(),
                schema,
                object_type,
                name,
            });
        }
    }
}

/// Searches object names across every connected PostgreSQL-family pool.
pub async fn search_metadata(state: &AppState, query: &str, limit: usize) -> Vec<MetadataSearchHit> {
    let mut hits = Vec::new();
    let query = query.trim();
    if query.is_empty() {
        return hits;
    }
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    for (pool_key, pool) in connections.iter() {
        if hits.len() >= limit {
            break;
        }
        let PoolKind::Postgres(pg) = pool else { continue };
        let Some(config) = configs.iter().find(|(id, _)| pool_key.starts_with(id.as_str())) else { continue };
        if !matches!(
            config.1.db_type,
            DatabaseType::Postgres
                | DatabaseType::OpenGauss
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Questdb
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
        ) {
            continue;
        }
        let database = config.1.database.clone().unwrap_or_default();
        search_pg_pool(pg, query, false, &mut hits, &mut Vec::new(), config.0, &config.1.name, &database, limit).await;
    }
    hits
}

/// Searches object DEFINITION text across every connected PostgreSQL-family pool.
pub async fn search_object_definitions(state: &AppState, query: &str, limit: usize) -> Vec<DefinitionSearchHit> {
    let mut hits = Vec::new();
    let query = query.trim();
    if query.is_empty() {
        return hits;
    }
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    for (pool_key, pool) in connections.iter() {
        if hits.len() >= limit {
            break;
        }
        let PoolKind::Postgres(pg) = pool else { continue };
        let Some(config) = configs.iter().find(|(id, _)| pool_key.starts_with(id.as_str())) else { continue };
        if !matches!(
            config.1.db_type,
            DatabaseType::Postgres
                | DatabaseType::OpenGauss
                | DatabaseType::Gaussdb
                | DatabaseType::Kwdb
                | DatabaseType::Questdb
                | DatabaseType::Highgo
                | DatabaseType::Vastbase
        ) {
            continue;
        }
        let database = config.1.database.clone().unwrap_or_default();
        search_pg_pool(pg, query, true, &mut Vec::new(), &mut hits, config.0, &config.1.name, &database, limit).await;
    }
    hits
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
                || stem.to_lowercase().contains(&needle);
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
