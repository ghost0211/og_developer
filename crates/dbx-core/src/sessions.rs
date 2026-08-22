//! 会话管理：列出连接上的后端会话（pg_stat_activity）并支持终止。

use std::time::Duration;

use serde_json::Value;

use crate::connection::{AppState, PoolKind};
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::plugins::PluginDriverSession;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub connection_id: String,
    pub connection_name: String,
    pub pid: i64,
    pub username: String,
    pub database: String,
    pub application_name: String,
    pub client_addr: String,
    pub state: String,
    pub query: String,
    pub backend_start: String,
}

const SESSIONS_SQL: &str = "SELECT a.pid, \
       COALESCE(a.usename, '') , \
       COALESCE(a.datname, ''), \
       COALESCE(a.application_name, ''), \
       COALESCE(a.client_addr::text, ''), \
       COALESCE(a.state, ''), \
       left(COALESCE(a.query, ''), 300), \
       COALESCE(a.backend_start::text, '') \
FROM pg_catalog.pg_stat_activity a \
ORDER BY a.backend_start";

const EXTERNAL_SESSION_MAX_ROWS: usize = 1000;

fn is_postgres_session_config(config: &ConnectionConfig) -> bool {
    matches!(
        config.db_type,
        DatabaseType::Postgres
            | DatabaseType::OpenGauss
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Questdb
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
    ) || config.driver_profile.as_deref().is_some_and(|profile| {
        profile.eq_ignore_ascii_case("opengauss")
            || profile.eq_ignore_ascii_case("opengauss-jdbc")
            || profile.eq_ignore_ascii_case("gaussdb")
    })
}

fn json_value_to_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

fn json_value_to_i64(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(value)) => {
            value.as_i64().or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        }
        Some(Value::String(value)) => value.trim().parse().ok(),
        _ => None,
    }
}

fn json_value_to_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(value)) => Some(*value),
        Some(Value::Number(value)) => value.as_i64().map(|value| value != 0),
        Some(Value::String(value)) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "1" | "yes" => Some(true),
            "false" | "f" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn session_info_from_values(row: &[Value], connection_id: &str, connection_name: &str) -> Option<SessionInfo> {
    let pid = json_value_to_i64(row.first())?;
    if pid <= 0 {
        return None;
    }
    Some(SessionInfo {
        connection_id: connection_id.to_string(),
        connection_name: connection_name.to_string(),
        pid,
        username: json_value_to_string(row.get(1)),
        database: json_value_to_string(row.get(2)),
        application_name: json_value_to_string(row.get(3)),
        client_addr: json_value_to_string(row.get(4)),
        state: json_value_to_string(row.get(5)),
        query: json_value_to_string(row.get(6)),
        backend_start: json_value_to_string(row.get(7)),
    })
}

fn external_query_timeout(config: &ConnectionConfig) -> Option<Duration> {
    match config.effective_query_timeout_secs() {
        0 => None,
        seconds => Some(Duration::from_secs(seconds.min(300))),
    }
}

async fn collect_external_sessions(
    config: &ConnectionConfig,
    session: &PluginDriverSession,
    connection_id: &str,
    connection_name: &str,
    out: &mut Vec<SessionInfo>,
) {
    let params = serde_json::json!({
        "connection": config,
        "sql": SESSIONS_SQL,
        "database": config.effective_database().unwrap_or(""),
        "schema": Value::Null,
        "maxRows": EXTERNAL_SESSION_MAX_ROWS,
    });
    let result = match session
        .invoke_with_timeout::<crate::db::QueryResult>("executeQuery", params, external_query_timeout(config))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            log::warn!("[sessions] failed to list external-driver sessions for {connection_id}: {error}");
            return;
        }
    };
    for row in result.rows {
        if let Some(session) = session_info_from_values(&row, connection_id, connection_name) {
            out.push(session);
        }
    }
}

async fn collect_pg_sessions(
    pool: &deadpool_postgres::Pool,
    connection_id: &str,
    connection_name: &str,
    out: &mut Vec<SessionInfo>,
) {
    let client = match crate::db::postgres::checkout_postgres_client(pool, None, Duration::from_secs(8)).await {
        Ok(client) => client,
        Err(_) => return,
    };
    let rows = match client.query(SESSIONS_SQL, &[]).await {
        Ok(rows) => rows,
        Err(_) => return,
    };
    for row in rows {
        let pid = row.try_get::<_, i64>(0).or_else(|_| row.try_get::<_, i32>(0).map(i64::from)).unwrap_or(0);
        out.push(SessionInfo {
            connection_id: connection_id.to_string(),
            connection_name: connection_name.to_string(),
            pid,
            username: row.try_get(1).unwrap_or_default(),
            database: row.try_get(2).unwrap_or_default(),
            application_name: row.try_get(3).unwrap_or_default(),
            client_addr: row.try_get(4).unwrap_or_default(),
            state: row.try_get(5).unwrap_or_default(),
            query: row.try_get(6).unwrap_or_default(),
            backend_start: row.try_get(7).unwrap_or_default(),
        });
    }
}

/// Lists backend sessions across every connected PostgreSQL-family pool.
///
/// Native PostgreSQL-family connections use the Rust pool directly. JDBC
/// openGauss/GaussDB connections are external-driver pools, so their query
/// must be dispatched through the already-running JDBC plugin session instead
/// of being silently skipped.
pub async fn list_sessions(state: &AppState) -> Vec<SessionInfo> {
    let mut out = Vec::new();
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    for (pool_key, pool) in connections.iter() {
        let Some((connection_id, config)) = configs.iter().find(|(id, _)| pool_key.starts_with(id.as_str())) else {
            continue;
        };
        if !is_postgres_session_config(config) {
            continue;
        }
        match pool {
            PoolKind::Postgres(pg) => collect_pg_sessions(pg, connection_id, &config.name, &mut out).await,
            PoolKind::ExternalDriver { config: external_config, session, .. } => {
                collect_external_sessions(external_config, session, connection_id, &config.name, &mut out).await;
            }
            _ => {}
        }
    }
    out
}

/// 将 int8 会话 pid 收窄为 int4（原生 PostgreSQL 的 pg_terminate_backend 重载）。
/// openGauss 的 pid 是 int8 线程号，超出 int4 范围时拒绝转换——
/// 盲目 as i32 截断会把大 pid 映射到可能存在的其他小 pid，误杀正常会话。
fn pid_to_int4(pid: i64) -> Result<i32, String> {
    i32::try_from(pid).map_err(|_| format!("Failed to terminate session {pid}: pid out of int4 range"))
}

async fn kill_external_session(
    config: &ConnectionConfig,
    session: &PluginDriverSession,
    pid: i64,
) -> Result<(), String> {
    let sql = format!("SELECT pg_terminate_backend({pid})");
    let params = serde_json::json!({
        "connection": config,
        "sql": sql,
        "database": config.effective_database().unwrap_or(""),
        "schema": Value::Null,
        "maxRows": 1,
    });
    let result = session
        .invoke_with_timeout::<crate::db::QueryResult>("executeQuery", params, external_query_timeout(config))
        .await?;
    if json_value_to_bool(result.rows.first().and_then(|row| row.first())).unwrap_or(false) {
        Ok(())
    } else {
        Err(format!("Failed to terminate session {pid}"))
    }
}

/// Terminates a backend session with `pg_terminate_backend` on the
/// connection's own pool.
pub async fn kill_session(state: &AppState, connection_id: &str, pid: i64) -> Result<(), String> {
    if pid <= 0 {
        return Err("Invalid session pid".to_string());
    }
    let connections = state.connections.read().await;
    let (external, native_pool) = connections
        .iter()
        .find(|(pool_key, _)| pool_key.starts_with(connection_id))
        .map(|(_, pool)| match pool {
            PoolKind::ExternalDriver { config, session, .. } if is_postgres_session_config(config) => {
                (Some((config.clone(), session.clone())), None)
            }
            PoolKind::Postgres(pg) => (None, Some(pg.clone())),
            _ => (None, None),
        })
        .unwrap_or((None, None));
    drop(connections);

    if let Some((config, session)) = external {
        return kill_external_session(&config, &session, pid).await;
    }

    let pool = native_pool.ok_or_else(|| "Connection not found".to_string())?;
    let client = crate::db::postgres::checkout_postgres_client(&pool, None, Duration::from_secs(8)).await?;
    // openGauss 的 pid 是 int8（线程号），原生 PostgreSQL 是 int4；按类型回退。
    let terminated_i64 = client
        .query_opt("SELECT pg_terminate_backend($1)", &[&pid])
        .await
        .map_err(|e| e.to_string())
        .and_then(|row| row.map(|r| r.try_get::<_, bool>(0)).transpose().map_err(|e| e.to_string()));
    match terminated_i64 {
        Ok(Some(terminated)) if terminated => Ok(()),
        Ok(Some(false)) => Err(format!("Failed to terminate session {pid}")),
        _ => {
            let pid_i32 = pid_to_int4(pid)?;
            let terminated_i32 = client
                .query_opt("SELECT pg_terminate_backend($1::int4)", &[&pid_i32])
                .await
                .map_err(|e| e.to_string())?
                .and_then(|row| row.try_get::<_, bool>(0).ok())
                .unwrap_or(false);
            if terminated_i32 {
                Ok(())
            } else {
                Err(format!("Failed to terminate session {pid}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{pid_to_int4, SESSIONS_SQL};

    #[test]
    fn sessions_sql_includes_the_current_backend() {
        assert!(!SESSIONS_SQL.contains("pg_backend_pid"));
    }

    #[test]
    fn external_session_rows_accept_string_pids() {
        let row = vec![
            Value::String("136879632545472".to_string()),
            Value::String("chentao".to_string()),
            Value::String("ogdev_a".to_string()),
            Value::String("PostgreSQL JDBC Driver".to_string()),
            Value::String("127.0.0.1".to_string()),
            Value::String("active".to_string()),
            Value::String("SELECT 1".to_string()),
            Value::String("2026-08-22".to_string()),
        ];
        let session = super::session_info_from_values(&row, "conn", "test").expect("valid session row");
        assert_eq!(session.pid, 136879632545472);
        assert_eq!(session.state, "active");
    }

    #[test]
    fn pid_to_int4_accepts_native_postgres_pids() {
        assert_eq!(pid_to_int4(12345).unwrap(), 12345);
        assert_eq!(pid_to_int4(i32::MAX as i64).unwrap(), i32::MAX);
    }

    #[test]
    fn pid_to_int4_rejects_opengauss_int8_thread_ids() {
        // openGauss 的 pid 是 int8 线程号，截断后可能命中其他会话——必须拒绝。
        assert!(pid_to_int4(136_880_036_247_232).is_err());
        assert!(pid_to_int4(i32::MAX as i64 + 1).is_err());
        assert!(pid_to_int4(i64::MAX).is_err());
    }
}
