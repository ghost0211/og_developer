fn pool_key_for_session(base_pool_key: String, client_session_id: Option<&str>) -> String {
    session_scoped_pool_key(base_pool_key, client_session_id)
}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, Mutex, RwLock};

use crate::database_capabilities;
use crate::db;
use crate::db::http_tunnel::HttpTunnelManager;
use crate::db::proxy_tunnel::ProxyTunnelManager;
use crate::db::ssh_tunnel::TunnelManager;
use crate::models::connection::{
    database_info_from_protocol_value, parse_jdbc_host_port, rewrite_jdbc_url_host, ConnectionConfig,
    ConnectionTestResult, DatabaseConnectionInfo, DatabaseType, TransportLayerConfig,
};
use crate::plugins::{PluginDriverSession, PluginRegistry, PluginRuntimeEnv};
use crate::query_cancel::RunningQueries;
use crate::storage::Storage;
use crate::task_supervisor::TaskSupervisor;

pub const JDBC_PLUGIN_NOT_INSTALLED: &str =
    "JDBC plugin is not installed. Install the optional JDBC plugin to use this connection.";
pub const PRESTOSQL_JDBC_DRIVER_CLASS: &str = "io.prestosql.jdbc.PrestoDriver";
pub const GAUSSDB_M_JDBC_DRIVER_PROFILE: &str = "gaussdb-m";
pub const GAUSSDB_M_JDBC_DRIVER_CLASS: &str = "com.huawei.gaussdb.jdbc.Driver";
/// openGauss connections can route through the official JDBC driver instead of
/// the native PostgreSQL protocol. The native wire protocol (tokio-postgres)
/// cannot complete openGauss's default SHA256 password authentication, while
/// the official driver supports it (AUTH_REQ_SHA256/MD5_SHA256encode).
///
/// The official driver changed its entry class and URL scheme between
/// releases: 6.0 keeps pgJDBC branding (`org.postgresql.Driver` with
/// `jdbc:postgresql://`) while 7.0 uses openGauss branding
/// (`org.opengauss.Driver` with `jdbc:opengauss://`). The pairing is strict,
/// so it is resolved by sniffing the selected jar.
pub const OPENGAUSS_JDBC_DRIVER_PROFILE: &str = "opengauss-jdbc";
pub const OPENGAUSS_JDBC_DRIVER_CLASS: &str = "org.postgresql.Driver";

/// Driver style resolved from the selected jar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenGaussJdbcDriverStyle {
    /// 6.0-style: org.postgresql.Driver + jdbc:postgresql://
    PgBranded,
    /// 7.0-style: org.opengauss.Driver + jdbc:opengauss://
    OpenGaussBranded,
}

impl OpenGaussJdbcDriverStyle {
    pub fn driver_class(self) -> &'static str {
        match self {
            Self::PgBranded => "org.postgresql.Driver",
            Self::OpenGaussBranded => "org.opengauss.Driver",
        }
    }
    pub fn url_scheme(self) -> &'static str {
        match self {
            Self::PgBranded => "postgresql",
            Self::OpenGaussBranded => "opengauss",
        }
    }
}

/// Sniffs the first existing jar in `paths` for the 7.0-style driver entry
/// class. Defaults to the 6.0 pgJDBC-branded style (the bundled jar).
pub fn opengauss_jdbc_driver_style_for_paths(paths: &[String]) -> OpenGaussJdbcDriverStyle {
    for path in paths {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(file) = std::fs::File::open(trimmed) else { continue };
        let Ok(mut archive) = zip::ZipArchive::new(file) else { continue };
        let has_opengauss_entry = archive.by_name("org/opengauss/Driver.class").is_ok();
        let has_pg_entry = !has_opengauss_entry && archive.by_name("org/postgresql/Driver.class").is_ok();
        if has_opengauss_entry {
            return OpenGaussJdbcDriverStyle::OpenGaussBranded;
        }
        if has_pg_entry {
            return OpenGaussJdbcDriverStyle::PgBranded;
        }
    }
    OpenGaussJdbcDriverStyle::PgBranded
}
const POOL_CLOSE_TIMEOUT_SECS: u64 = 3;
const HEALTH_CHECK_POOL_ACQUIRE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub enum PoolKind {
    Postgres(deadpool_postgres::Pool),
    ExternalDriver { driver_id: String, config: Arc<ConnectionConfig>, session: Arc<PluginDriverSession> },
}

enum ConnectionDatabaseInfoSource {
    ExternalDriver { config: Arc<ConnectionConfig>, session: Arc<PluginDriverSession> },
    NativeOpengauss(deadpool_postgres::Pool),
}

/// Held connection for a manual transaction session
pub enum TxnConnection {
    Postgres(Box<deadpool_postgres::Object>),
}

pub struct TransactionSession {
    pub connection: Arc<Mutex<TxnConnection>>,
    pub pool_key: String,
    pub last_activity: std::time::Instant,
    pub busy: bool,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
}

pub struct AppState {
    pub connections: Arc<RwLock<HashMap<String, PoolKind>>>,
    task_supervisor: TaskSupervisor,
    pool_activity: Arc<RwLock<HashMap<String, PoolActivity>>>,
    draining_pools: Arc<std::sync::Mutex<HashMap<String, watch::Sender<bool>>>>,
    connection_attempts: RwLock<HashMap<String, ConnectionAttemptState>>,
    pub configs: RwLock<HashMap<String, ConnectionConfig>>,
    pub running_queries: RunningQueries,
    pub tunnels: TunnelManager,
    pub proxy_tunnels: ProxyTunnelManager,
    pub http_tunnels: HttpTunnelManager,
    pub storage: Storage,
    pub plugins: PluginRegistry,
    /// PostgreSQL TLS cancel context, keyed by pool_key.
    /// Used to reconstruct a TLS connector compatible with the original connection when cancelling.
    postgres_cancel_contexts: Arc<RwLock<HashMap<String, db::postgres::PostgresCancelContext>>>,
    pub transaction_sessions: Arc<RwLock<HashMap<String, TransactionSession>>>,
    /// openGauss PL debugger sessions (dbe_pldebugger two-session model),
    /// keyed by debug session id.
    pub opengauss_debug_sessions: Arc<RwLock<HashMap<String, Arc<crate::opengauss_debug::OpenGaussDebugSession>>>>,
    /// Pools where enabling the gms_output buffer killed the session
    /// (openGauss-lite closes the connection on put_line over the wire).
    /// Output capture is skipped there once learned.
    gms_output_unsupported_pools: Arc<RwLock<std::collections::HashSet<String>>>,
    /// Server-notice receivers for native openGauss/GaussDB pools, keyed by
    /// pool_key. The receiver observes RAISE NOTICE from every connection in
    /// the pool; execution drains the backlog around each query.
    postgres_notice_receivers:
        Arc<RwLock<HashMap<String, tokio::sync::broadcast::Receiver<tokio_postgres::NoticeMessage>>>>,
}

/// 活跃时间以进程内单调时钟的相对毫秒存储（AtomicU64）：热路径每条查询都要
/// 更新它，读锁 + 原子写让并发查询不再在全局写锁上串行化。
/// 基准偏移让测试能构造"过去"的时间点（否则进程刚启动时相对毫秒接近 0）。
const POOL_ACTIVITY_BASE_MS: u64 = 86_400_000;

fn pool_activity_epoch() -> Instant {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

fn pool_activity_now_ms() -> u64 {
    POOL_ACTIVITY_BASE_MS + pool_activity_epoch().elapsed().as_millis() as u64
}

#[cfg_attr(not(test), allow(dead_code))]
struct PoolActivity {
    last_used_at_ms: std::sync::atomic::AtomicU64,
}

impl PoolActivity {
    fn now() -> Self {
        Self { last_used_at_ms: std::sync::atomic::AtomicU64::new(pool_activity_now_ms()) }
    }

    fn touch(&self) {
        self.last_used_at_ms.fetch_max(pool_activity_now_ms(), std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Clone, Copy)]
struct ConnectionAttemptState {
    server_attempt: u64,
    client_attempt: Option<u64>,
}

#[derive(Clone)]
struct PoolRoutingControl {
    pool_activity: Arc<RwLock<HashMap<String, PoolActivity>>>,
    postgres_cancel_contexts: Arc<RwLock<HashMap<String, db::postgres::PostgresCancelContext>>>,
    task_supervisor: TaskSupervisor,
}

pub struct PoolActivityTouch {
    pool_key: String,
    connections: Arc<RwLock<HashMap<String, PoolKind>>>,
    pool_activity: Arc<RwLock<HashMap<String, PoolActivity>>>,
    task_supervisor: TaskSupervisor,
}

impl Drop for PoolActivityTouch {
    fn drop(&mut self) {
        let pool_key = self.pool_key.clone();
        let connections = self.connections.clone();
        let pool_activity = self.pool_activity.clone();
        self.task_supervisor.spawn_replace(format!("pool-activity:{pool_key}"), move |_| async move {
            if !connections.read().await.contains_key(&pool_key) {
                return;
            }
            if let Some(activity) = pool_activity.read().await.get(&pool_key) {
                activity.touch();
                return;
            }
            pool_activity.write().await.insert(pool_key, PoolActivity::now());
        });
    }
}

impl PoolRoutingControl {
    fn stop_keepalive(&self, pool_key: &str) {
        self.task_supervisor.stop(&format!("keepalive:{pool_key}"));
    }

    async fn finish_detach(&self, removed: Vec<(String, PoolKind)>) {
        for (key, _) in &removed {
            self.stop_keepalive(key);
        }
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for (key, _) in &removed {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        self.close_removed_in_background(removed);
    }

    async fn close_pool_with_timeout(&self, pool_key: String, pool: PoolKind) {
        match tokio::time::timeout(Duration::from_secs(POOL_CLOSE_TIMEOUT_SECS), close_pool_kind(pool)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                log::warn!("Failed to close connection pool '{pool_key}': {error}");
            }
            Err(_) => {
                log::warn!("Timed out closing connection pool '{pool_key}' after {POOL_CLOSE_TIMEOUT_SECS}s");
            }
        }
    }

    async fn close_removed(&self, removed: Vec<(String, PoolKind)>) {
        for (pool_key, pool) in removed {
            self.close_pool_with_timeout(pool_key, pool).await;
        }
    }

    fn close_removed_in_background(&self, removed: Vec<(String, PoolKind)>) {
        if removed.is_empty() {
            return;
        }
        let pool_count = removed.len();
        let routing = self.clone();
        let task_key = format!("pool-close:{}", uuid::Uuid::new_v4());
        if !self.task_supervisor.spawn_once(task_key, move |_| async move {
            for (pool_key, pool) in removed {
                routing.close_pool_with_timeout(pool_key, pool).await;
            }
        }) {
            log::debug!("Dropped {pool_count} detached pool handle(s) during application shutdown");
        }
    }
}

pub fn metadata_connection_config(config: &ConnectionConfig) -> ConnectionConfig {
    let mut db_config = config.clone();
    if database_capabilities::is_metadata_connection_scoped(&db_config.db_type) {
        db_config.database = None;
    }
    db_config
}

pub fn database_connection_config(config: &ConnectionConfig, database: Option<&str>) -> ConnectionConfig {
    let mut db_config = if database.is_some() { config.clone() } else { metadata_connection_config(config) };
    if let Some(db) = database {
        db_config.database = Some(db.to_string());
    }
    db_config
}

/// Insert or replace a single `key=value` entry in a connection URL-params string.
pub fn upsert_connection_url_param(params: Option<&str>, key: &str, value: &str) -> String {
    let key = key.trim();
    let value = value.trim();
    let key_lower = key.to_ascii_lowercase();
    let encoded_value = percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string();
    let mut parts: Vec<String> = params
        .unwrap_or("")
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter(|part| !part.trim().is_empty())
        .filter(|part| {
            part.split_once('=')
                .map(|(existing_key, _)| existing_key.trim().to_ascii_lowercase() != key_lower)
                .unwrap_or(true)
        })
        .map(str::to_string)
        .collect();
    parts.push(format!("{key}={encoded_value}"));
    parts.join("&")
}

pub fn opengauss_uses_jdbc_driver(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::OpenGauss
        && config
            .driver_profile
            .as_deref()
            .is_some_and(|profile| profile.eq_ignore_ascii_case(OPENGAUSS_JDBC_DRIVER_PROFILE))
}

pub fn opengauss_jdbc_config_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> ConnectionConfig {
    let mut jdbc_config = config.clone();
    // The driver entry class and URL scheme must match the selected jar:
    // 6.0 ships org.postgresql.Driver + jdbc:postgresql://, 7.0 ships
    // org.opengauss.Driver + jdbc:opengauss:// (strict pairing).
    let style = opengauss_jdbc_driver_style_for_paths(&config.jdbc_driver_paths);
    let native_url = config.redacted_connection_url_with_host(host, port);
    let mut jdbc_url = format!("jdbc:{}://{}", style.url_scheme(), native_url.trim_start_matches("opengauss://"));
    let raw_params = config.url_params.as_deref().unwrap_or("").trim().trim_start_matches('?');
    let explicit_sslmode = raw_params.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        key.trim().eq_ignore_ascii_case("sslmode").then(|| value.trim().to_ascii_lowercase())
    });
    let sslmode =
        explicit_sslmode.unwrap_or_else(|| if config.ssl { "require".to_string() } else { "prefer".to_string() });
    let params = upsert_connection_url_param(Some(raw_params), "sslmode", &sslmode);
    if !params.is_empty() {
        jdbc_url.push('?');
        jdbc_url.push_str(&params);
    }
    jdbc_config.connection_string = Some(jdbc_url);
    jdbc_config.jdbc_driver_class = Some(style.driver_class().to_string());
    jdbc_config
}

impl AppState {
    fn pool_routing_control(&self) -> PoolRoutingControl {
        PoolRoutingControl {
            pool_activity: self.pool_activity.clone(),
            postgres_cancel_contexts: self.postgres_cancel_contexts.clone(),
            task_supervisor: self.task_supervisor.clone(),
        }
    }

    pub fn new(storage: Storage) -> Self {
        Self::new_with_plugin_dir(storage, default_plugin_dir())
    }

    pub fn new_with_plugin_dir(storage: Storage, plugin_dir: PathBuf) -> Self {
        Self::new_with_plugin_dir_and_app_version(storage, plugin_dir, env!("CARGO_PKG_VERSION"))
    }

    pub fn new_with_plugin_dir_and_app_version(
        storage: Storage,
        plugin_dir: PathBuf,
        app_version: impl Into<String>,
    ) -> Self {
        let _ = app_version.into();
        let data_dir = storage.data_dir().to_path_buf();
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            task_supervisor: TaskSupervisor::new(),
            pool_activity: Arc::new(RwLock::new(HashMap::new())),
            draining_pools: Arc::new(std::sync::Mutex::new(HashMap::new())),
            connection_attempts: RwLock::new(HashMap::new()),
            configs: RwLock::new(HashMap::new()),
            running_queries: RunningQueries::default(),
            tunnels: TunnelManager::new(data_dir),
            proxy_tunnels: ProxyTunnelManager::new(),
            http_tunnels: HttpTunnelManager::new(),
            storage,
            plugins: PluginRegistry::new(plugin_dir),
            postgres_cancel_contexts: Arc::new(RwLock::new(HashMap::new())),
            gms_output_unsupported_pools: Arc::new(RwLock::new(std::collections::HashSet::new())),
            postgres_notice_receivers: Arc::new(RwLock::new(HashMap::new())),
            transaction_sessions: Arc::new(RwLock::new(HashMap::new())),
            opengauss_debug_sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Kept for API compatibility; the agent driver runtime is gone, so the
    /// agent dir is ignored.
    pub fn new_with_plugin_and_agent_dir_and_app_version(
        storage: Storage,
        plugin_dir: PathBuf,
        agent_dir: PathBuf,
        app_version: impl Into<String>,
    ) -> Self {
        let _ = agent_dir;
        Self::new_with_plugin_dir_and_app_version(storage, plugin_dir, app_version)
    }

    pub fn jdbc_unavailable_error(&self) -> String {
        match self.plugins.find_driver("jdbc") {
            Ok(Some(_)) => "JDBC plugin is installed, but the connection could not be opened.".to_string(),
            Ok(None) => JDBC_PLUGIN_NOT_INSTALLED.to_string(),
            Err(err) => format!("Failed to inspect JDBC plugin: {err}"),
        }
    }

    pub async fn test_external_driver(&self, driver_id: &str, config: &ConnectionConfig) -> Result<String, String> {
        self.test_external_driver_with_info(driver_id, config).await.map(|result| result.message)
    }

    pub async fn test_external_driver_with_info(
        &self,
        driver_id: &str,
        config: &ConnectionConfig,
    ) -> Result<ConnectionTestResult, String> {
        let params = serde_json::json!({ "connection": config });
        let env = self.external_driver_runtime_env(driver_id)?;
        let response = self
            .plugins
            .invoke_driver_with_env_and_timeout::<serde_json::Value>(
                driver_id,
                "testConnection",
                params,
                env,
                Some(external_driver_connect_timeout(config)),
            )
            .await?;
        Ok(ConnectionTestResult::success("Connection successful")
            .with_database_info(database_info_from_protocol_value(&response)))
    }

    pub async fn external_driver_pool(&self, driver_id: &str, config: &ConnectionConfig) -> Result<PoolKind, String> {
        let env = self.external_driver_runtime_env(driver_id)?;
        let session = self.plugins.start_driver_session_with_env(driver_id, env).await?;
        let params = serde_json::json!({ "connection": config });
        session
            .invoke_with_timeout::<serde_json::Value>("connect", params, Some(external_driver_connect_timeout(config)))
            .await?;
        Ok(PoolKind::ExternalDriver { driver_id: driver_id.to_string(), config: Arc::new(config.clone()), session })
    }

    pub fn external_driver_runtime_env(&self, driver_id: &str) -> Result<PluginRuntimeEnv, String> {
        let _ = driver_id;
        Ok(PluginRuntimeEnv::default())
    }

    async fn wait_for_pool_drain(&self, pool_key: &str) {
        loop {
            let receiver = self
                .draining_pools
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(pool_key)
                .map(watch::Sender::subscribe);
            let Some(mut receiver) = receiver else {
                return;
            };
            if *receiver.borrow_and_update() && receiver.changed().await.is_err() {
                return;
            }
        }
    }

    async fn insert_connection_pool_inner(
        &self,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
        wait_for_drain: bool,
    ) -> Result<(), String> {
        if wait_for_drain {
            self.wait_for_pool_drain(&pool_key).await;
        }
        let routing = self.pool_routing_control();
        let previous = loop {
            let mut connections = self.connections.write().await;
            let Ok(mut activity) = self.pool_activity.try_write() else {
                // Idle reclamation reads activity before routing. Never await that lock while
                // holding the routing lock; release and retry to preserve a single lock order.
                drop(connections);
                tokio::task::yield_now().await;
                continue;
            };
            // Abort the old probe while the route cannot change underneath us. A failed
            // candidate never reaches this point, so the existing route keeps its state.
            routing.stop_keepalive(&pool_key);
            activity.insert(pool_key.clone(), PoolActivity::now());
            self.start_keepalive_task(&pool_key, &pool, config);
            break connections.insert(pool_key.clone(), pool);
        };
        if let Some(pool) = previous {
            routing.close_pool_with_timeout(pool_key.clone(), pool).await;
        }
        Ok(())
    }

    pub async fn insert_connection_pool(
        &self,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
    ) -> Result<(), String> {
        self.insert_connection_pool_inner(pool_key, pool, config, true).await
    }

    pub async fn begin_connection_attempt(&self, connection_id: &str) -> u64 {
        self.begin_connection_attempt_with_client_attempt(connection_id, None).await
    }

    pub async fn begin_connection_attempt_with_client_attempt(
        &self,
        connection_id: &str,
        client_attempt: Option<u64>,
    ) -> u64 {
        let mut attempts = self.connection_attempts.write().await;
        let next = attempts.get(connection_id).map(|state| state.server_attempt).unwrap_or(0).wrapping_add(1);
        attempts.insert(connection_id.to_string(), ConnectionAttemptState { server_attempt: next, client_attempt });
        next
    }

    pub async fn supersede_connection_attempt(&self, connection_id: &str) {
        self.begin_connection_attempt(connection_id).await;
    }

    pub async fn supersede_connection_attempt_if_client_attempt(
        &self,
        connection_id: &str,
        client_attempt: u64,
    ) -> bool {
        let mut attempts = self.connection_attempts.write().await;
        let Some(current) = attempts.get(connection_id).copied() else {
            return false;
        };
        if current.client_attempt != Some(client_attempt) {
            return false;
        }
        attempts.insert(
            connection_id.to_string(),
            ConnectionAttemptState { server_attempt: current.server_attempt.wrapping_add(1), client_attempt: None },
        );
        true
    }

    async fn connection_attempt_is_current(&self, connection_id: &str, attempt: u64) -> bool {
        self.connection_attempts.read().await.get(connection_id).map(|state| state.server_attempt) == Some(attempt)
    }

    pub async fn ensure_current_connection_attempt(
        &self,
        connection_id: &str,
        attempt: Option<u64>,
    ) -> Result<(), String> {
        let Some(attempt) = attempt else {
            return Ok(());
        };
        if self.connection_attempt_is_current(connection_id, attempt).await {
            Ok(())
        } else {
            Err("Connection attempt was superseded by a newer attempt".to_string())
        }
    }

    pub async fn insert_connection_pool_for_attempt(
        &self,
        connection_id: &str,
        attempt: u64,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
    ) -> Result<(), String> {
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, Some(attempt)).await {
            self.pool_routing_control().close_pool_with_timeout(pool_key, pool).await;
            return Err(err);
        }
        self.insert_connection_pool(pool_key, pool, config).await
    }

    async fn discard_stale_connection_attempt_pool(
        &self,
        connection_id: &str,
        pool_key: String,
        pool: PoolKind,
        config: &ConnectionConfig,
    ) {
        self.reset_connection_transport_for_config(connection_id, config).await;
        self.pool_routing_control().close_pool_with_timeout(pool_key, pool).await;
    }

    fn start_keepalive_task(&self, pool_key: &str, pool: &PoolKind, config: &ConnectionConfig) {
        let interval_secs = config.keepalive_interval_secs;
        let mut target = keepalive_target_from_pool(pool, config);
        if interval_secs == 0 {
            return;
        }
        if target.is_none() {
            log::debug!(
                "Connection keepalive requested for '{pool_key}', but this database driver does not keep a pingable client handle."
            );
            return;
        };

        let key = pool_key.to_string();
        let interval = Duration::from_secs(interval_secs.max(1));
        let timeout = Duration::from_secs(config.effective_connect_timeout_secs().max(1));
        let routing = self.pool_routing_control();
        let connections = self.connections.clone();
        let running_queries = self.running_queries.clone();
        self.task_supervisor.spawn_replace(format!("keepalive:{pool_key}"), move |shutdown| async move {
            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {}
                }

                if running_queries.is_pool_active(&key) {
                    continue;
                }

                if let Some(target) = target.as_mut() {
                    let result = tokio::time::timeout(timeout, ping_keepalive_target(target, timeout)).await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => {
                            log::warn!("Connection keepalive failed for '{key}': {err}; invalidating pool");
                            if !detach_keepalive_target_if_current(&routing, &connections, &key, target).await {
                                log::debug!("Skipping stale keepalive result for replaced pool '{key}'");
                            }
                            break;
                        }
                        Err(_) => {
                            log::warn!(
                                "Connection keepalive timed out for '{key}' after {}s; invalidating pool",
                                timeout.as_secs()
                            );
                            if !detach_keepalive_target_if_current(&routing, &connections, &key, target).await {
                                log::debug!("Skipping stale keepalive timeout for replaced pool '{key}'");
                            }
                            break;
                        }
                    }
                }
            }
        });
    }

    async fn stop_keepalive_task(&self, pool_key: &str) {
        self.task_supervisor.stop(&format!("keepalive:{pool_key}"));
    }

    async fn stop_keepalive_tasks(&self, pool_keys: &[String]) {
        let keys: Vec<String> = pool_keys.iter().map(|pool_key| format!("keepalive:{pool_key}")).collect();
        self.task_supervisor.stop_many(keys.iter().map(String::as_str));
    }

    pub async fn touch_pool_activity(&self, pool_key: &str) {
        // 热路径：读锁下原子更新；仅条目缺失（首次/已被清理）才退化为写锁插入
        if let Some(activity) = self.pool_activity.read().await.get(pool_key) {
            activity.touch();
            return;
        }
        self.pool_activity.write().await.insert(pool_key.to_string(), PoolActivity::now());
    }

    /// Get the PostgreSQL TLS cancel context (used to reconstruct the TLS connector when cancelling a query).
    pub async fn get_postgres_cancel_context(&self, pool_key: &str) -> Option<db::postgres::PostgresCancelContext> {
        self.postgres_cancel_contexts.read().await.get(pool_key).cloned()
    }

    pub async fn is_gms_output_capture_unsupported(&self, pool_key: &str) -> bool {
        self.gms_output_unsupported_pools.read().await.contains(pool_key)
    }

    pub async fn mark_gms_output_capture_unsupported(&self, pool_key: &str) {
        self.gms_output_unsupported_pools.write().await.insert(pool_key.to_string());
    }

    pub async fn get_postgres_notice_receiver(
        &self,
        pool_key: &str,
    ) -> Option<tokio::sync::broadcast::Receiver<tokio_postgres::NoticeMessage>> {
        self.postgres_notice_receivers.read().await.get(pool_key).map(|receiver| receiver.resubscribe())
    }

    pub async fn register_postgres_notice_receiver(
        &self,
        pool_key: &str,
        receiver: tokio::sync::broadcast::Receiver<tokio_postgres::NoticeMessage>,
    ) {
        self.postgres_notice_receivers.write().await.insert(pool_key.to_string(), receiver);
    }

    pub fn pool_activity_touch(&self, pool_key: &str) -> PoolActivityTouch {
        PoolActivityTouch {
            pool_key: pool_key.to_string(),
            connections: self.connections.clone(),
            pool_activity: self.pool_activity.clone(),
            task_supervisor: self.task_supervisor.clone(),
        }
    }

    pub async fn shutdown(&self, deadline: Duration) {
        self.running_queries.cancel_all();
        let removed_pools = self.drain_all_connection_pools().await;
        self.transaction_sessions.write().await.clear();

        let shutdown = async {
            let routing = self.pool_routing_control();
            tokio::join!(
                self.task_supervisor.shutdown(deadline),
                routing.close_removed(removed_pools),
                self.tunnels.stop_all_tunnels(),
                self.proxy_tunnels.stop_all_tunnels(),
                self.http_tunnels.stop_all_tunnels(),
            );
        };
        if tokio::time::timeout(deadline, shutdown).await.is_err() {
            log::warn!("Timed out shutting down DBX runtime resources after {}ms", deadline.as_millis());
        }
    }

    #[cfg(test)]
    pub fn supervised_task_count(&self) -> usize {
        self.task_supervisor.active_count()
    }

    pub async fn get_or_create_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        self.get_or_create_pool_for_session(connection_id, database, None).await
    }

    pub async fn get_or_create_pool_with_catalog(
        &self,
        connection_id: &str,
        database: Option<&str>,
        catalog: Option<&str>,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_with_catalog(connection_id, database, catalog, None).await
    }

    pub async fn get_or_create_pool_for_connection_attempt(
        &self,
        connection_id: &str,
        database: Option<&str>,
        attempt: u64,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_inner(connection_id, database, None, None, Some(attempt)).await
    }

    pub async fn get_or_create_pool_for_session(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_inner(connection_id, database, None, client_session_id, None).await
    }

    /// Kept for API compatibility; the catalog parameter only existed for
    /// Doris/StarRocks federation and is now ignored.
    pub async fn get_or_create_pool_for_session_with_catalog(
        &self,
        connection_id: &str,
        database: Option<&str>,
        catalog: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        let _ = catalog;
        self.get_or_create_pool_for_session_inner(connection_id, database, None, client_session_id, None).await
    }

    pub(crate) async fn get_or_create_metadata_pool_for_session(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        self.get_or_create_pool_for_session_inner(connection_id, database, None, client_session_id, None).await
    }

    async fn get_or_create_pool_for_session_inner(
        &self,
        connection_id: &str,
        database: Option<&str>,
        catalog: Option<&str>,
        client_session_id: Option<&str>,
        connection_attempt: Option<u64>,
    ) -> Result<String, String> {
        let config = {
            let configs = self.configs.read().await;
            configs.get(connection_id).ok_or("Connection config not found")?.clone()
        };
        validate_connection_url_params(&config)?;
        let db_type = Some(config.db_type);
        let validate_existing_pool = should_validate_existing_pool_before_reuse(config.db_type);
        let catalog = catalog.map(str::trim).filter(|value| !value.is_empty());

        let base_pool_key = base_pool_key_for_with_catalog(db_type, connection_id, database, catalog, false);
        let pool_key = session_scoped_pool_key_for(Some(&config), base_pool_key.clone(), client_session_id);

        loop {
            self.wait_for_pool_drain(&pool_key).await;
            let conns = self.connections.read().await;
            if conns.contains_key(&pool_key) {
                drop(conns);
                if !validate_existing_pool || !self.remove_stale_connection_pool(&pool_key).await {
                    self.touch_pool_activity(&pool_key).await;
                    return Ok(pool_key);
                }
                break;
            }
            drop(conns);

            // A reclaim may have removed the pool after the first drain check. Wait
            // for its confirmed close or rollback before deciding to create a new one.
            self.wait_for_pool_drain(&pool_key).await;
            if self.connections.read().await.contains_key(&pool_key) {
                continue;
            }
            break;
        }

        let db_config = database_connection_config(&config, database);

        self.ensure_current_connection_attempt(connection_id, connection_attempt).await?;
        let (host, port) = self.connection_host_port(connection_id, &db_config).await?;
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.reset_connection_transport_for_config(connection_id, &db_config).await;
            return Err(err);
        }
        probe_connection_endpoint(&db_config, &host, port).await?;
        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.reset_connection_transport_for_config(connection_id, &db_config).await;
            return Err(err);
        }
        let url = connection_url_for_endpoint(&db_config, &host, port);
        let connect_timeout = std::time::Duration::from_secs(db_config.effective_connect_timeout_secs());
        let pool = match db_config.db_type {
            DatabaseType::OpenGauss if opengauss_uses_jdbc_driver(&db_config) => {
                let jdbc_config = opengauss_jdbc_config_for_endpoint(&db_config, &host, port);
                self.external_driver_pool("jdbc", &jdbc_config).await?
            }
            DatabaseType::OpenGauss => {
                // ogdeveloper: native wire connections capture RAISE NOTICE for
                // the 输出 result view.
                let (pg_pool, notice_receiver) = db::postgres::connect_with_notices(&url, connect_timeout).await?;
                // Build TLS cancel context for reconstructing TLS connection during cancel
                if let Some(ctx) = db::postgres::build_postgres_cancel_context(&url) {
                    self.postgres_cancel_contexts.write().await.insert(pool_key.clone(), ctx);
                }
                self.register_postgres_notice_receiver(&pool_key, notice_receiver).await;
                PoolKind::Postgres(pg_pool)
            }
            DatabaseType::Postgres => {
                let pg_pool = db::postgres::connect(&url, connect_timeout).await?;
                // Build TLS cancel context for reconstructing TLS connection during cancel
                if let Some(ctx) = db::postgres::build_postgres_cancel_context(&url) {
                    self.postgres_cancel_contexts.write().await.insert(pool_key.clone(), ctx);
                }
                PoolKind::Postgres(pg_pool)
            }
            DatabaseType::Jdbc => {
                let mut jdbc_config = db_config.clone();
                if host != config.host || port != config.port {
                    if let Some(ref url) = jdbc_config.connection_string {
                        jdbc_config.connection_string = Some(rewrite_jdbc_url_host(url, &host, port));
                    }
                }
                self.external_driver_pool("jdbc", &jdbc_config).await?
            }
        };

        if let Err(err) = self.ensure_current_connection_attempt(connection_id, connection_attempt).await {
            self.discard_stale_connection_attempt_pool(connection_id, pool_key.clone(), pool, &db_config).await;
            return Err(err);
        }
        self.insert_connection_pool(pool_key.clone(), pool, &db_config).await?;
        Ok(pool_key)
    }

    /// Returns the enabled transport layers for a connection with tunnel
    /// profile references resolved: a layer carrying a `profile_id` is
    /// replaced by the shared profile from storage (Settings > Tunnels), so
    /// edits to a profile take effect for every connection referencing it.
    /// Fails when a referenced profile no longer exists — connecting without
    /// the intended tunnel would silently bypass it.
    pub async fn resolved_transport_layers(
        &self,
        config: &ConnectionConfig,
    ) -> Result<Vec<TransportLayerConfig>, String> {
        let layers = config.effective_transport_layers();
        if layers.iter().all(|layer| layer.profile_id().is_empty()) {
            return Ok(layers);
        }

        let profiles: HashMap<String, TransportLayerConfig> = self
            .storage
            .load_tunnel_profiles()
            .await?
            .into_iter()
            .map(|profile| (profile.id().to_string(), profile))
            .collect();

        layers
            .into_iter()
            .map(|layer| {
                let profile_id = layer.profile_id();
                if profile_id.is_empty() {
                    return Ok(layer);
                }
                let Some(profile) = profiles.get(profile_id) else {
                    let label = if layer.name().is_empty() { profile_id } else { layer.name() };
                    return Err(format!(
                        "Tunnel profile '{label}' referenced by this connection no longer exists. Re-create it in Settings > Tunnels or edit the connection's tunnel settings."
                    ));
                };
                // Validate the stored reference again at connect time because synced or
                // externally supplied configs may bypass the editor's type constraints.
                if !layer.same_type_as(profile) {
                    return Err(format!(
                        "Tunnel profile '{}' has a different type than the referencing transport layer.",
                        if layer.name().is_empty() { profile_id } else { layer.name() }
                    ));
                }
                Ok(layer.resolved_from_profile(profile))
            })
            .collect()
    }

    /// Tests a shared tunnel profile in isolation (no downstream database), for
    /// the Test button in Settings > Tunnels.
    ///
    /// - SSH: starting an SSH tunnel connects and authenticates eagerly, so a
    ///   successful start verifies host reachability and credentials.
    /// - Proxy (HTTP CONNECT / SOCKS5): performs a standalone handshake test
    ///   against the proxy endpoint to verify reachability and credentials.
    /// - HTTP tunnel: connects lazily (nothing happens until traffic flows), so
    ///   there is nothing to verify here without a target to probe.
    pub async fn test_tunnel_profile(&self, profile: &TransportLayerConfig) -> Result<String, String> {
        match profile {
            TransportLayerConfig::Ssh(ssh) => {
                let ssh = crate::ssh_config::resolve_ssh_tunnel_config(ssh);
                if ssh.host.trim().is_empty() {
                    return Err("SSH host is required.".to_string());
                }
                let timeout = if ssh.connect_timeout_secs == 0 {
                    crate::models::connection::default_ssh_connect_timeout_secs()
                } else {
                    ssh.connect_timeout_secs
                };
                // A throwaway id so the probe never reuses or evicts a live tunnel, and
                // a sentinel forward target: SSH auth completes on connect, before any
                // channel to this target is opened, so it need not be reachable.
                let probe_id = format!("__tunnel_profile_test__:{}", uuid::Uuid::new_v4());
                let result = self
                    .tunnels
                    .start_tunnel(
                        &probe_id,
                        &ssh.host,
                        ssh.port,
                        &ssh.host,
                        ssh.port,
                        &ssh.user,
                        &ssh.password,
                        &ssh.key_path,
                        &ssh.key_passphrase,
                        ssh.use_ssh_agent,
                        &ssh.ssh_agent_sock_path,
                        &ssh.auth_method,
                        timeout,
                        "127.0.0.1",
                        1,
                        false,
                        ssh.allow_exec_channel_proxy,
                    )
                    .await;
                self.tunnels.stop_tunnel(&probe_id).await;
                result.map(|_| "SSH tunnel connection successful".to_string())
            }
            TransportLayerConfig::Proxy(proxy) => {
                if proxy.host.trim().is_empty() {
                    return Err("Proxy host is required.".to_string());
                }
                if proxy.port == 0 {
                    return Err("Proxy port is required.".to_string());
                }
                crate::db::proxy_tunnel::test_proxy_endpoint(
                    proxy.proxy_type,
                    &proxy.host,
                    proxy.port,
                    &proxy.username,
                    &proxy.password,
                    proxy.test_target.as_deref(),
                )
                .await
            }
            TransportLayerConfig::HttpTunnel(_) => {
                Err("Tunnel test is not supported for HTTP tunnel profiles.".to_string())
            }
        }
    }

    pub async fn connection_host_port(
        &self,
        connection_id: &str,
        config: &ConnectionConfig,
    ) -> Result<(String, u16), String> {
        let transport_layers = self.resolved_transport_layers(config).await?;
        if transport_layers.is_empty() {
            return Ok((config.host.clone(), config.port));
        }

        let (remote_host, remote_port) = connection_remote_endpoint(config);
        let local_port = db::transport_layer_tunnel::start_transport_layers(
            connection_id,
            &transport_layers,
            &remote_host,
            remote_port,
            &self.tunnels,
            &self.proxy_tunnels,
            &self.http_tunnels,
        )
        .await?;

        Ok(("127.0.0.1".to_string(), local_port))
    }

    async fn remove_stale_connection_pool(&self, pool_key: &str) -> bool {
        if self.running_queries.is_pool_active(pool_key) {
            return false;
        }

        let stale = {
            let connections = self.connections.read().await;
            let Some(pool) = connections.get(pool_key) else {
                return false;
            };
            match pool {
                PoolKind::Postgres(pool) => {
                    let pool = pool.clone();
                    drop(connections);
                    let timeout = crate::db::connection_timeout();
                    match tokio::time::timeout(HEALTH_CHECK_POOL_ACQUIRE_TIMEOUT, pool.get()).await {
                        Ok(Ok(client)) => match tokio::time::timeout(timeout, client.simple_query("SELECT 1")).await {
                            Ok(Ok(_)) => false,
                            Ok(Err(err)) => {
                                log::warn!("PostgreSQL connection pool '{pool_key}' is stale: {err}");
                                true
                            }
                            Err(_) => {
                                log::warn!("PostgreSQL connection pool '{pool_key}' is stale: health check timed out");
                                true
                            }
                        },
                        Ok(Err(err)) => {
                            log::warn!("PostgreSQL connection pool '{pool_key}' is stale: {err}");
                            true
                        }
                        Err(_) => {
                            log::debug!("PostgreSQL connection pool '{pool_key}' is busy; skipping health probe");
                            false
                        }
                    }
                }
                PoolKind::ExternalDriver { .. } => false,
            }
        };

        if !stale {
            return false;
        }

        self.stop_keepalive_task(pool_key).await;
        self.pool_activity.write().await.remove(pool_key);
        self.postgres_cancel_contexts.write().await.remove(pool_key);
        let removed = self.connections.write().await.remove(pool_key);
        if let Some(pool) = removed {
            self.pool_routing_control().close_pool_with_timeout(pool_key.to_string(), pool).await;
            true
        } else {
            false
        }
    }

    pub async fn reconnect_pool(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        self.reconnect_pool_for_session(connection_id, database, None).await
    }

    pub async fn reconnect_pool_for_session(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        self.reconnect_pool_for_session_with_catalog(connection_id, database, None, client_session_id).await
    }

    pub async fn reconnect_pool_for_session_with_catalog(
        &self,
        connection_id: &str,
        database: Option<&str>,
        catalog: Option<&str>,
        client_session_id: Option<&str>,
    ) -> Result<String, String> {
        let config = {
            let configs = self.configs.read().await;
            configs.get(connection_id).cloned()
        };
        let db_type = config.as_ref().map(|config| config.db_type);
        let catalog = catalog.map(str::trim).filter(|value| !value.is_empty());
        let base_pool_key = base_pool_key_for_with_catalog(db_type, connection_id, database, catalog, true);
        let pool_key = pool_key_for_session(base_pool_key, client_session_id);
        if self.uses_forwarded_transport(connection_id).await {
            self.remove_connection_pools(connection_id).await;
            self.reset_connection_transport(connection_id).await;
        } else {
            self.stop_keepalive_task(&pool_key).await;
            self.pool_activity.write().await.remove(&pool_key);
            self.postgres_cancel_contexts.write().await.remove(&pool_key);
            let removed = self.connections.write().await.remove(&pool_key);
            if let Some(pool) = removed {
                self.pool_routing_control().close_pool_with_timeout(pool_key.clone(), pool).await;
            }
        }
        self.get_or_create_pool_for_session_inner(connection_id, database, catalog, client_session_id, None).await
    }

    pub async fn close_client_session_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: &str,
    ) -> Result<bool, String> {
        let Some((pool_key, pool)) = self.take_client_session_pool(connection_id, database, client_session_id).await?
        else {
            return Ok(false);
        };
        self.pool_routing_control().close_pool_with_timeout(pool_key, pool).await;
        Ok(true)
    }

    pub async fn detach_client_session_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: &str,
    ) -> Result<bool, String> {
        let Some((pool_key, _)) = self.take_client_session_pool(connection_id, database, client_session_id).await?
        else {
            return Ok(false);
        };
        Ok(self.remove_pool_by_key(&pool_key).await)
    }

    async fn take_client_session_pool(
        &self,
        connection_id: &str,
        database: Option<&str>,
        client_session_id: &str,
    ) -> Result<Option<(String, PoolKind)>, String> {
        let session = normalize_client_session_id(Some(client_session_id));
        let Some(session) = session else {
            return Ok(None);
        };
        let config = {
            let configs = self.configs.read().await;
            configs.get(connection_id).cloned()
        };
        let db_type = config.as_ref().map(|config| config.db_type);
        let base_pool_key = base_pool_key_for(db_type, connection_id, database, false);
        let pool_key = session_scoped_pool_key_for(config.as_ref(), base_pool_key.clone(), Some(&session));
        if pool_key == base_pool_key {
            return Ok(None);
        }
        self.stop_keepalive_task(&pool_key).await;
        self.pool_activity.write().await.remove(&pool_key);
        self.postgres_cancel_contexts.write().await.remove(&pool_key);
        let removed = self.connections.write().await.remove(&pool_key);
        Ok(removed.map(|pool| (pool_key, pool)))
    }

    pub async fn remove_pool_by_key(&self, pool_key: &str) -> bool {
        self.stop_keepalive_task(pool_key).await;
        self.pool_activity.write().await.remove(pool_key);
        self.postgres_cancel_contexts.write().await.remove(pool_key);
        let removed = self.connections.write().await.remove(pool_key);
        if let Some(pool) = removed {
            self.pool_routing_control().close_pool_with_timeout(pool_key.to_string(), pool).await;
            true
        } else {
            false
        }
    }

    pub async fn close_database_pool(&self, connection_id: &str, database: Option<&str>) -> Result<bool, String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        let base_pool_key = base_pool_key_for(db_type, connection_id, database, false);
        let session_prefix = format!("{base_pool_key}:session:");
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .keys()
            .filter(|key| *key == &base_pool_key || key.starts_with(&session_prefix))
            .cloned()
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        drop(conns);
        let has_removed = !removed.is_empty();
        self.pool_routing_control().close_removed(removed).await;
        Ok(has_removed)
    }

    pub async fn connection_identifier_quote(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> Result<Option<String>, String> {
        let config = self
            .configs
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
        let pool_key = self.get_or_create_pool(connection_id, database).await?;
        enum IdentifierQuoteSource {
            NativeGaussdb(deadpool_postgres::Pool),
            ExternalDriver { config: Arc<ConnectionConfig>, session: Arc<PluginDriverSession> },
        }
        let source = {
            let connections = self.connections.read().await;
            match connections.get(&pool_key) {
                Some(PoolKind::Postgres(pool)) if config.db_type == DatabaseType::OpenGauss => {
                    Some(IdentifierQuoteSource::NativeGaussdb(pool.clone()))
                }
                Some(PoolKind::ExternalDriver { config, session, .. }) => {
                    Some(IdentifierQuoteSource::ExternalDriver { config: config.clone(), session: session.clone() })
                }
                _ => None,
            }
        };
        match source {
            Some(IdentifierQuoteSource::NativeGaussdb(pool)) => Ok(db::postgres::gaussdb_identifier_quote(&pool).await),
            Some(IdentifierQuoteSource::ExternalDriver { config, session }) => {
                let response = session
                    .invoke_with_timeout::<db::QueryResult>(
                        "executeQuery",
                        serde_json::json!({
                            "connection": config.as_ref(),
                            "sql": db::postgres::GAUSSDB_COMPATIBILITY_SQL,
                            "database": config.effective_database().unwrap_or(""),
                            "schema": null,
                            "maxRows": 1,
                            "timeoutSecs": 5,
                        }),
                        Some(db::connection_timeout()),
                    )
                    .await;
                Ok(response.ok().and_then(|result| gaussdb_identifier_quote_from_query_result(&result)))
            }
            None => Ok(None),
        }
    }

    pub async fn connection_database_info(
        &self,
        connection_id: &str,
        database: Option<&str>,
    ) -> Result<Option<DatabaseConnectionInfo>, String> {
        let config = self
            .configs
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
        let pool_key = self.get_or_create_pool(connection_id, database).await?;
        let source = {
            let connections = self.connections.read().await;
            match connections.get(&pool_key) {
                Some(PoolKind::ExternalDriver { config, session, .. }) => {
                    Some(ConnectionDatabaseInfoSource::ExternalDriver {
                        config: config.clone(),
                        session: session.clone(),
                    })
                }
                Some(PoolKind::Postgres(pool)) if crate::schema::is_opengauss_family_config(&config) => {
                    Some(ConnectionDatabaseInfoSource::NativeOpengauss(pool.clone()))
                }
                _ => None,
            }
        };

        match source {
            Some(ConnectionDatabaseInfoSource::ExternalDriver { config, session }) => {
                let response = session
                    .invoke_with_timeout::<serde_json::Value>(
                        "connectionInfo",
                        serde_json::json!({ "connection": config.as_ref() }),
                        Some(db::connection_timeout()),
                    )
                    .await?;
                let mut info = database_info_from_protocol_value(&response);
                if crate::schema::is_opengauss_family_config(&config) {
                    let compatibility = session
                        .invoke_with_timeout::<db::QueryResult>(
                            "executeQuery",
                            serde_json::json!({
                                "connection": config.as_ref(),
                                "sql": db::postgres::GAUSSDB_COMPATIBILITY_SQL,
                                "database": config.effective_database().unwrap_or(""),
                                "schema": null,
                                "maxRows": 1,
                                "timeoutSecs": 5,
                            }),
                            Some(db::connection_timeout()),
                        )
                        .await
                        .ok()
                        .and_then(|result| db::postgres::sql_compatibility_from_query_result(&result));
                    let product_version = session
                        .invoke_with_timeout::<db::QueryResult>(
                            "executeQuery",
                            serde_json::json!({
                                "connection": config.as_ref(),
                                "sql": db::postgres::OPENGAUSS_VERSION_SQL,
                                "database": config.effective_database().unwrap_or(""),
                                "schema": null,
                                "maxRows": 1,
                                "timeoutSecs": 5,
                            }),
                            Some(db::connection_timeout()),
                        )
                        .await
                        .ok()
                        .and_then(|result| db::postgres::opengauss_product_version_from_query_result(&result));

                    let info = info.get_or_insert_with(DatabaseConnectionInfo::default);
                    let metadata_is_postgresql =
                        info.product_name.as_deref().is_some_and(|name| name.eq_ignore_ascii_case("postgresql"));
                    info.product_name = Some("openGauss".to_string());
                    if let Some(product_version) = product_version {
                        info.product_version = Some(product_version);
                    } else if metadata_is_postgresql {
                        info.product_version = None;
                    }
                    if let Some(compatibility) = compatibility {
                        info.sql_compatibility = Some(compatibility);
                    }
                }
                Ok(info)
            }
            Some(ConnectionDatabaseInfoSource::NativeOpengauss(pool)) => {
                let compatibility = db::postgres::postgres_sql_compatibility(&pool).await;
                let product_version = db::postgres::opengauss_product_version(&pool).await;
                Ok(Some(DatabaseConnectionInfo {
                    product_name: Some("openGauss".to_string()),
                    product_version,
                    current_database: database
                        .map(str::to_string)
                        .or_else(|| config.effective_database().map(str::to_string)),
                    sql_compatibility: compatibility,
                    ..Default::default()
                }))
            }
            None => Ok(None),
        }
    }

    pub async fn save_connection_database_info(
        &self,
        connection_id: &str,
        database_info: Option<DatabaseConnectionInfo>,
    ) -> Result<(), String> {
        self.storage.save_connection_database_info(connection_id, database_info.clone()).await?;
        if let Some(config) = self.configs.write().await.get_mut(connection_id) {
            config.database_info = database_info;
        }
        Ok(())
    }

    pub async fn reset_connection_transport(&self, connection_id: &str) {
        let layer_count = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|config| config.effective_transport_layers().len()).unwrap_or(0)
        };
        self.reset_connection_transport_layers(connection_id, layer_count).await;
    }

    pub async fn reset_connection_transport_for_config(&self, connection_id: &str, config: &ConnectionConfig) {
        let existing_layer_count = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|config| config.effective_transport_layers().len()).unwrap_or(0)
        };
        let layer_count = existing_layer_count.max(config.effective_transport_layers().len());
        self.reset_connection_transport_layers(connection_id, layer_count).await;
    }

    async fn reset_connection_transport_layers(&self, connection_id: &str, layer_count: usize) {
        db::transport_layer_tunnel::stop_transport_layers(
            connection_id,
            layer_count,
            &self.tunnels,
            &self.proxy_tunnels,
            &self.http_tunnels,
        )
        .await;
        self.tunnels.stop_tunnel(connection_id).await;
        self.proxy_tunnels.stop_tunnel(connection_id).await;
        self.http_tunnels.stop_tunnel(connection_id).await;
    }

    /// Health-check the base connection pool for a given connection_id.
    /// Returns `Ok(())` if the pool exists and is healthy, `Err` otherwise.
    /// If the pool is unhealthy it is removed from the map so subsequent
    /// `get_or_create_pool` calls will transparently recreate it.
    pub async fn check_connection_health(&self, connection_id: &str) -> Result<(), String> {
        let db_type = {
            let configs = self.configs.read().await;
            configs.get(connection_id).map(|c| c.db_type)
        };
        let pool_key = base_pool_key_for(db_type, connection_id, None, false);

        // Check if pool exists first
        {
            let connections = self.connections.read().await;
            if !connections.contains_key(&pool_key) {
                return Err("No active connection pool found".to_string());
            }
        }

        // `remove_stale_connection_pool` returns true if the pool was stale (and removed)
        if self.remove_stale_connection_pool(&pool_key).await {
            return Err("Connection pool is unhealthy".to_string());
        }
        Ok(())
    }

    pub async fn refresh_connections(&self) {
        // Clone pool handles under a short-lived read lock, then release it
        // before performing I/O-heavy health checks to avoid blocking writers.
        let checks: Vec<(String, PoolKind)> = {
            let conns = self.connections.read().await;
            conns.iter().map(|(key, pool)| (key.clone(), clone_pool_kind(pool))).collect()
        };

        let mut dead_pools = Vec::new();
        let timeout = crate::db::connection_timeout();

        // Check cloned pools (async I/O, no lock held)
        for (key, pool) in &checks {
            let healthy = match pool {
                PoolKind::Postgres(p) => match tokio::time::timeout(timeout, p.get()).await {
                    Ok(Ok(client)) => match tokio::time::timeout(timeout, client.simple_query("SELECT 1")).await {
                        Ok(Ok(_)) => true,
                        Ok(Err(e)) => {
                            log::warn!("PostgreSQL connection pool '{key}' is unhealthy: {e}");
                            false
                        }
                        Err(_) => {
                            log::warn!("PostgreSQL connection pool '{key}' is unhealthy: health check timed out");
                            false
                        }
                    },
                    Ok(Err(e)) => {
                        log::warn!("PostgreSQL connection pool '{key}' is unhealthy: {e}");
                        false
                    }
                    Err(_) => {
                        log::warn!("PostgreSQL connection pool '{key}' is unhealthy: get connection timed out");
                        false
                    }
                },
                PoolKind::ExternalDriver { .. } => true,
            };
            if !healthy {
                dead_pools.push(key.clone());
            }
        }

        // Remove dead pools
        if !dead_pools.is_empty() {
            let mut conns = self.connections.write().await;
            let mut removed = Vec::with_capacity(dead_pools.len());
            for key in &dead_pools {
                if let Some(pool) = conns.remove(key) {
                    removed.push((key.clone(), pool));
                }
            }
            drop(conns);
            self.pool_routing_control().finish_detach(removed).await;
        }

        // Re-establish SSH tunnels that have died
        let tunnel_connection_ids: Vec<String> = {
            let configs = self.configs.read().await;
            configs.iter().filter(|(_, c)| c.has_effective_transport_layers()).map(|(id, _)| id.clone()).collect()
        };
        for connection_id in tunnel_connection_ids {
            self.reset_connection_transport(&connection_id).await;
            // Tunnels will be re-created on next pool access via connection_host_port
        }
    }

    pub async fn remove_connection_pools(&self, connection_id: &str) {
        let removed = self.drain_connection_pools(connection_id).await;
        self.pool_routing_control().close_removed(removed).await;
    }

    pub async fn remove_connection_pools_detached(&self, connection_id: &str) {
        let removed = self.drain_connection_pools(connection_id).await;
        self.pool_routing_control().close_removed_in_background(removed);
    }

    async fn drain_all_connection_pools(&self) -> Vec<(String, PoolKind)> {
        let pool_keys = self.connections.read().await.keys().cloned().collect::<Vec<_>>();
        self.stop_keepalive_tasks(&pool_keys).await;
        self.pool_activity.write().await.clear();
        self.postgres_cancel_contexts.write().await.clear();
        self.draining_pools.lock().unwrap_or_else(|error| error.into_inner()).clear();
        self.connections.write().await.drain().collect()
    }

    pub async fn remove_external_driver_pools(&self, driver_id: &str) {
        let removed = self.drain_external_driver_pools(driver_id).await;
        self.pool_routing_control().close_removed(removed).await;
    }

    async fn drain_connection_pools(&self, connection_id: &str) -> Vec<(String, PoolKind)> {
        let pool_prefix = format!("{connection_id}:");
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .keys()
            .filter(|k| *k == connection_id || k.starts_with(&pool_prefix))
            .cloned()
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            let mut cancel_contexts = self.postgres_cancel_contexts.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
                cancel_contexts.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        drop(conns);
        removed
    }

    async fn drain_external_driver_pools(&self, driver_id: &str) -> Vec<(String, PoolKind)> {
        let keys_to_remove: Vec<String> = self
            .connections
            .read()
            .await
            .iter()
            .filter_map(|(key, pool)| match pool {
                PoolKind::ExternalDriver { driver_id: pool_driver_id, .. } if pool_driver_id == driver_id => {
                    Some(key.clone())
                }
                _ => None,
            })
            .collect();
        self.stop_keepalive_tasks(&keys_to_remove).await;
        {
            let mut activity = self.pool_activity.write().await;
            for key in &keys_to_remove {
                activity.remove(key);
            }
        }
        let mut conns = self.connections.write().await;
        let mut removed = Vec::with_capacity(keys_to_remove.len());
        for key in keys_to_remove {
            if let Some(pool) = conns.remove(&key) {
                removed.push((key, pool));
            }
        }
        removed
    }

    async fn uses_forwarded_transport(&self, connection_id: &str) -> bool {
        let configs = self.configs.read().await;
        configs.get(connection_id).is_some_and(|config| config.has_effective_transport_layers())
    }
}

fn gaussdb_identifier_quote_from_query_result(result: &db::QueryResult) -> Option<String> {
    let compatibility_mode = result.rows.first()?.first()?.as_str()?;
    db::postgres::gaussdb_identifier_quote_for_compatibility_mode(compatibility_mode).map(str::to_string)
}

enum KeepaliveTarget {
    Postgres(deadpool_postgres::Pool),
}

#[derive(Debug)]
enum KeepaliveError {
    Legacy(String),
}

impl std::fmt::Display for KeepaliveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Legacy(error) => formatter.write_str(error),
        }
    }
}

impl From<String> for KeepaliveError {
    fn from(error: String) -> Self {
        Self::Legacy(error)
    }
}

impl KeepaliveTarget {
    fn matches_pool(&self, pool: &PoolKind) -> bool {
        let _ = pool;
        true
    }
}

async fn remove_keepalive_pool_if_current(
    connections: &Arc<RwLock<HashMap<String, PoolKind>>>,
    pool_key: &str,
    target: &KeepaliveTarget,
) -> Option<PoolKind> {
    let mut pools = connections.write().await;
    if pools.get(pool_key).is_some_and(|pool| target.matches_pool(pool)) {
        pools.remove(pool_key)
    } else {
        None
    }
}

async fn detach_keepalive_target_if_current(
    routing: &PoolRoutingControl,
    connections: &Arc<RwLock<HashMap<String, PoolKind>>>,
    pool_key: &str,
    target: &KeepaliveTarget,
) -> bool {
    let Some(pool) = remove_keepalive_pool_if_current(connections, pool_key, target).await else {
        return false;
    };
    routing.finish_detach(vec![(pool_key.to_string(), pool)]).await;
    true
}

fn keepalive_target_from_pool(pool: &PoolKind, config: &ConnectionConfig) -> Option<KeepaliveTarget> {
    let _ = config;
    match pool {
        PoolKind::Postgres(pool) => Some(KeepaliveTarget::Postgres(pool.clone())),
        _ => None,
    }
}

async fn ping_keepalive_target(target: &mut KeepaliveTarget, timeout: Duration) -> Result<(), KeepaliveError> {
    let _ = timeout;
    match target {
        KeepaliveTarget::Postgres(pool) => {
            let client = pool.get().await.map_err(|e| format!("PostgreSQL pool error: {e}"))?;
            client.simple_query("SELECT 1").await.map(|_| ()).map_err(|error| KeepaliveError::Legacy(error.to_string()))
        }
    }
}

fn connection_remote_endpoint(config: &ConnectionConfig) -> (String, u16) {
    if config.db_type == DatabaseType::Jdbc {
        config
            .connection_string
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(parse_jdbc_host_port)
            .unwrap_or_else(|| (config.host.clone(), config.port))
    } else {
        (config.host.clone(), config.port)
    }
}

fn normalize_client_session_id(client_session_id: Option<&str>) -> Option<String> {
    client_session_id.map(str::trim).filter(|session| !session.is_empty()).map(|session| session.replace(':', "_"))
}

pub fn task_client_session_id(task_kind: &str, task_id: &str) -> String {
    format!("{task_kind}:{task_id}")
}

fn session_scoped_pool_key(base_pool_key: String, client_session_id: Option<&str>) -> String {
    normalize_client_session_id(client_session_id)
        .map(|session| format!("{base_pool_key}:session:{session}"))
        .unwrap_or(base_pool_key)
}

pub(crate) fn config_for_pool_key<'a>(
    pool_key: &str,
    configs: &'a HashMap<String, ConnectionConfig>,
) -> Option<&'a ConnectionConfig> {
    configs
        .iter()
        .filter(|(connection_id, _)| {
            pool_key.strip_prefix(connection_id.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with(':'))
        })
        .max_by_key(|(connection_id, _)| connection_id.len())
        .map(|(_, config)| config)
}

fn session_scoped_pool_key_for(
    _config: Option<&ConnectionConfig>,
    base_pool_key: String,
    client_session_id: Option<&str>,
) -> String {
    session_scoped_pool_key(base_pool_key, client_session_id)
}

fn clone_pool_kind(pool: &PoolKind) -> PoolKind {
    match pool {
        PoolKind::Postgres(p) => PoolKind::Postgres(p.clone()),
        PoolKind::ExternalDriver { driver_id, config, session } => {
            PoolKind::ExternalDriver { driver_id: driver_id.clone(), config: config.clone(), session: session.clone() }
        }
    }
}

async fn close_pool_kind(pool: PoolKind) -> Result<(), String> {
    match pool {
        PoolKind::Postgres(p) => p.close(),
        PoolKind::ExternalDriver { session, .. } => {
            session.shutdown().await;
        }
    }
    Ok(())
}

fn base_pool_key_for(
    db_type: Option<DatabaseType>,
    connection_id: &str,
    database: Option<&str>,
    include_elasticsearch_single_pool: bool,
) -> String {
    base_pool_key_for_with_catalog(db_type, connection_id, database, None, include_elasticsearch_single_pool)
}

fn base_pool_key_for_with_catalog(
    db_type: Option<DatabaseType>,
    connection_id: &str,
    database: Option<&str>,
    catalog: Option<&str>,
    include_elasticsearch_single_pool: bool,
) -> String {
    let _ = include_elasticsearch_single_pool;
    let is_single_connection_pool = db_type.as_ref().is_some_and(database_capabilities::is_single_connection_pool);

    let key = if is_single_connection_pool {
        connection_id.to_string()
    } else {
        match database.filter(|db| !db.trim().is_empty()) {
            Some(db) => format!("{connection_id}:{db}"),
            None => connection_id.to_string(),
        }
    };
    match catalog.map(str::trim).filter(|value| !value.is_empty()) {
        Some(catalog) => format!("{key}:catalog:{catalog}"),
        None => key,
    }
}

fn should_validate_existing_pool_before_reuse(db_type: DatabaseType) -> bool {
    // PostgreSQL uses deadpool's Fast recycling and the query executor's
    // ReconnectAndRetry path. An eager SELECT 1 here would add a network
    // round-trip before every query without improving recovery behavior.
    !matches!(db_type, DatabaseType::Postgres)
}

fn default_plugin_dir() -> PathBuf {
    default_dbx_dir().join("plugins")
}

pub fn default_agent_dir() -> PathBuf {
    default_dbx_dir().join("agents")
}

fn default_dbx_dir() -> PathBuf {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".dbx")
}

pub fn connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let normalized = native_postgres_url_config(config);
    let config = normalized.as_ref().unwrap_or(config);
    if host == config.host && port == config.port {
        config.connection_url()
    } else {
        config.connection_url_with_host(host, port)
    }
}

pub fn redacted_connection_url_for_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let normalized = native_postgres_url_config(config);
    let config = normalized.as_ref().unwrap_or(config);
    if host == config.host && port == config.port {
        config.redacted_connection_url()
    } else {
        config.redacted_connection_url_with_host(host, port)
    }
}

/// External driver (plugin/JDBC) connect timeout: JVM/bridge startup can be
/// much slower than a native TCP connect, so keep a 30s floor.
pub fn agent_connect_timeout(config: &ConnectionConfig) -> std::time::Duration {
    const EXTERNAL_DRIVER_CONNECT_TIMEOUT_FLOOR_SECS: u64 = 30;
    std::time::Duration::from_secs(
        config.effective_connect_timeout_secs().max(EXTERNAL_DRIVER_CONNECT_TIMEOUT_FLOOR_SECS),
    )
}

fn external_driver_connect_timeout(config: &ConnectionConfig) -> std::time::Duration {
    agent_connect_timeout(config)
}

fn native_postgres_url_config(config: &ConnectionConfig) -> Option<ConnectionConfig> {
    match config.db_type {
        DatabaseType::OpenGauss => {
            let mut normalized = config.clone();
            normalized.database = normalized.effective_database().map(str::to_string);
            normalized.db_type = DatabaseType::Postgres;
            Some(normalized)
        }
        _ => None,
    }
}

fn validate_connection_url_params(config: &ConnectionConfig) -> Result<(), String> {
    let normalized = native_postgres_url_config(config);
    normalized.as_ref().unwrap_or(config).validate_native_url_params()
}

pub async fn probe_connection_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> Result<(), String> {
    if !uses_tcp_probe(config, host, port) {
        return Ok(());
    }
    let timeout = std::time::Duration::from_secs(config.effective_connect_timeout_secs());

    let entries = connection_probe_endpoints(host, port);

    if entries.is_empty() {
        return Err("no host entries to probe".to_string());
    }

    // Probe each node sequentially; return success on the first reachable node.
    // This matches the failover semantics of the real connection path.
    let mut last_error = String::new();
    for (entry_host, entry_port) in &entries {
        match db::probe_tcp_endpoint(&format!("{:?}", config.db_type), entry_host, *entry_port, timeout).await {
            Ok(()) => return Ok(()),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

fn connection_probe_endpoints(host: &str, default_port: u16) -> Vec<(String, u16)> {
    host.split(',').filter_map(|part| parse_connection_probe_endpoint(part.trim(), default_port)).collect()
}

fn parse_connection_probe_endpoint(endpoint: &str, default_port: u16) -> Option<(String, u16)> {
    if endpoint.is_empty() {
        return None;
    }
    if let Some(rest) = endpoint.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = rest[..close].to_string();
        let port = rest
            .get(close + 1..)
            .and_then(|suffix| suffix.strip_prefix(':'))
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Some((host, port));
    }
    if endpoint.matches(':').count() == 1 {
        if let Some((host, raw_port)) = endpoint.rsplit_once(':') {
            if let Ok(port) = raw_port.parse::<u16>() {
                return Some((host.to_string(), port));
            }
        }
    }
    Some((endpoint.to_string(), default_port))
}

fn uses_tcp_probe(config: &ConnectionConfig, host: &str, port: u16) -> bool {
    if false && config.connection_string.as_deref().is_some_and(|value| !value.is_empty()) {
        return false;
    }
    if database_capabilities::skips_tcp_probe(&config.db_type) {
        return false;
    }
    if is_original_endpoint(config, host, port) {
        return false;
    }
    true
}

fn is_original_endpoint(config: &ConnectionConfig, host: &str, port: u16) -> bool {
    host == config.host && port == config.port
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use crate::storage::Storage;

    fn opengauss_config(database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn-og".to_string(),
            name: "openGauss".to_string(),
            note: String::new(),
            db_type: DatabaseType::Opengauss,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "gaussdb".to_string(),
            password: "secret".to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 30,
            query_timeout_secs: 300,
            idle_timeout_secs: 600,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            connection_string: None,
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn postgres_config(database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn-pg".to_string(),
            name: "PostgreSQL".to_string(),
            note: String::new(),
            db_type: DatabaseType::Postgres,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "postgres".to_string(),
            password: "secret".to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 30,
            query_timeout_secs: 300,
            idle_timeout_secs: 600,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            connection_string: None,
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    #[tokio::test]
    async fn metadata_connection_config_preserves_config_database() {
        let config = opengauss_config(None);
        let meta = metadata_connection_config(&config);
        assert_eq!(meta.database, None);
    }

    #[tokio::test]
    async fn postgres_connection_url_redacts_password() {
        let config = postgres_config(Some("mydb"));
        let url = redacted_connection_url_for_endpoint(&config, "127.0.0.1", 5432);
        assert!(!url.contains("secret"));
        assert!(url.contains("127.0.0.1:5432"));
    }

    #[tokio::test]
    async fn opengauss_jdbc_config_generation() {
        let mut config = opengauss_config(Some("testdb"));
        config.driver_profile = Some(OPENGAUSS_JDBC_DRIVER_PROFILE.to_string());
        config.jdbc_driver_class = Some(OPENGAUSS_JDBC_DRIVER_CLASS.to_string());

        assert!(opengauss_uses_jdbc_driver(&config));
        let jdbc_cfg = opengauss_jdbc_config_for_endpoint(&config, "127.0.0.1", 5432);
        assert!(jdbc_cfg.connection_string.as_deref().unwrap().starts_with("jdbc:"));
    }

    #[tokio::test]
    async fn app_state_pool_lifecycle_test() {
        let temp_dir = std::env::temp_dir().join(format!("dbx-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let storage = Storage::open(&temp_dir.join("storage.db")).await.unwrap();
        let app = AppState::new(storage);

        let config = opengauss_config(Some("testdb"));
        app.configs.write().await.insert(config.id.clone(), config.clone());

        assert!(app.configs.read().await.contains_key(&config.id));
        app.remove_connection_pools(&config.id).await;
    }
}
