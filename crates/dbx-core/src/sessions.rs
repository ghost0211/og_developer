//! 会话管理：列出连接上的后端会话（pg_stat_activity）并支持终止。

use std::time::Duration;

use crate::connection::{AppState, PoolKind};
use crate::models::connection::DatabaseType;

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
WHERE a.pid <> pg_backend_pid() \
ORDER BY a.backend_start";

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
pub async fn list_sessions(state: &AppState) -> Vec<SessionInfo> {
    let mut out = Vec::new();
    let configs = state.configs.read().await;
    let connections = state.connections.read().await;
    for (pool_key, pool) in connections.iter() {
        let PoolKind::Postgres(pg) = pool else { continue };
        let Some((connection_id, config)) = configs.iter().find(|(id, _)| pool_key.starts_with(id.as_str())) else {
            continue;
        };
        if !matches!(
            config.db_type,
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
        collect_pg_sessions(pg, connection_id, &config.name, &mut out).await;
    }
    out
}

/// 将 int8 会话 pid 收窄为 int4（原生 PostgreSQL 的 pg_terminate_backend 重载）。
/// openGauss 的 pid 是 int8 线程号，超出 int4 范围时拒绝转换——
/// 盲目 as i32 截断会把大 pid 映射到可能存在的其他小 pid，误杀正常会话。
fn pid_to_int4(pid: i64) -> Result<i32, String> {
    i32::try_from(pid).map_err(|_| format!("Failed to terminate session {pid}: pid out of int4 range"))
}

/// Terminates a backend session with `pg_terminate_backend` on the
/// connection's own pool.
pub async fn kill_session(state: &AppState, connection_id: &str, pid: i64) -> Result<(), String> {
    if pid <= 0 {
        return Err("Invalid session pid".to_string());
    }
    let connections = state.connections.read().await;
    let pool = connections
        .iter()
        .find(|(pool_key, _)| pool_key.starts_with(connection_id))
        .and_then(|(_, pool)| match pool {
            PoolKind::Postgres(pg) => Some(pg.clone()),
            _ => None,
        })
        .ok_or_else(|| "Connection not found".to_string())?;
    drop(connections);
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
    use super::pid_to_int4;

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
