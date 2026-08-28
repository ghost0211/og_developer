use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentifierCase {
    Lower,
    Upper,
    Mixed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnectionInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unquoted_identifier_case: Option<IdentifierCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quoted_identifier_case: Option<IdentifierCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jdbc_version: Option<String>,
    /// openGauss-family compatibility mode (A/B/C/PG/M), detected from the
    /// database's datcompatibility attribute. Drives dialect behavior and
    /// object-tree visibility in og developer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sql_compatibility: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_info: Option<DatabaseConnectionInfo>,
}

impl ConnectionTestResult {
    pub fn success(message: impl Into<String>) -> Self {
        Self { message: message.into(), database_info: None }
    }

    pub fn with_database_info(mut self, database_info: Option<DatabaseConnectionInfo>) -> Self {
        self.database_info = database_info;
        self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseInfoEnvelope {
    #[serde(default)]
    database_info: Option<DatabaseConnectionInfo>,
}

pub fn database_info_from_protocol_value(value: &Value) -> Option<DatabaseConnectionInfo> {
    serde_json::from_value::<DatabaseInfoEnvelope>(value.clone()).ok()?.database_info
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
    pub db_type: DatabaseType,
    #[serde(default)]
    pub driver_profile: Option<String>,
    #[serde(default)]
    pub driver_label: Option<String>,
    #[serde(default)]
    pub url_params: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_databases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_schemas: Option<HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub show_system_schemas: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transport_layers: Vec<TransportLayerConfig>,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u64,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ca_cert_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_cert_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_key_path: String,
    #[serde(default)]
    pub connection_string: Option<String>,
    /// Typed configuration for external tabular sources.
    #[serde(default)]
    pub external_config: Option<serde_json::Value>,
    #[serde(default)]
    pub jdbc_driver_class: Option<String>,
    #[serde(default)]
    pub jdbc_driver_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub one_time: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// Explicitly marks every database reachable through this connection as production.
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_production: bool,
    /// Database-level production markers for multi-database connections.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub production_databases: Vec<String>,
    /// Metadata captured from the latest successful connection test for this saved config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_info: Option<DatabaseConnectionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TransportLayerConfig {
    Ssh(SshTunnelConfig),
    Proxy(ProxyTunnelConfig),
    #[serde(rename = "http_tunnel")]
    HttpTunnel(HttpTunnelConfig),
}

impl TransportLayerConfig {
    pub fn id(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(ssh) => &ssh.id,
            TransportLayerConfig::Proxy(proxy) => &proxy.id,
            TransportLayerConfig::HttpTunnel(http) => &http.id,
        }
    }

    pub fn same_type_as(&self, other: &TransportLayerConfig) -> bool {
        matches!(
            (self, other),
            (TransportLayerConfig::Ssh(_), TransportLayerConfig::Ssh(_))
                | (TransportLayerConfig::Proxy(_), TransportLayerConfig::Proxy(_))
                | (TransportLayerConfig::HttpTunnel(_), TransportLayerConfig::HttpTunnel(_))
        )
    }

    pub fn profile_id(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(layer) => &layer.profile_id,
            TransportLayerConfig::Proxy(layer) => &layer.profile_id,
            TransportLayerConfig::HttpTunnel(layer) => &layer.profile_id,
        }
    }

    /// Builds the concrete layer used at connect time for a layer that
    /// references a shared tunnel profile: the profile supplies the whole
    /// configuration while the referencing layer keeps its own identity,
    /// enabled flag, and profile reference.
    pub fn resolved_from_profile(&self, profile: &TransportLayerConfig) -> TransportLayerConfig {
        let mut resolved = profile.clone();
        let (id, enabled, profile_id) = (self.id().to_string(), self.enabled(), self.profile_id().to_string());
        match &mut resolved {
            TransportLayerConfig::Ssh(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
            TransportLayerConfig::Proxy(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
            TransportLayerConfig::HttpTunnel(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
        }
        resolved
    }

    pub fn scrub_secrets(&mut self) {
        match self {
            TransportLayerConfig::Ssh(layer) => {
                layer.password = String::new();
                layer.key_passphrase = String::new();
            }
            TransportLayerConfig::Proxy(layer) => {
                layer.password = String::new();
            }
            TransportLayerConfig::HttpTunnel(layer) => {
                layer.token = String::new();
            }
        }
    }

    pub fn name(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(layer) => &layer.name,
            TransportLayerConfig::Proxy(layer) => &layer.name,
            TransportLayerConfig::HttpTunnel(layer) => &layer.name,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            TransportLayerConfig::Ssh(layer) => layer.enabled,
            TransportLayerConfig::Proxy(layer) => layer.enabled,
            TransportLayerConfig::HttpTunnel(layer) => layer.enabled,
        }
    }

    pub fn endpoint(&self) -> (&str, u16) {
        match self {
            TransportLayerConfig::Ssh(layer) => (&layer.host, layer.port),
            TransportLayerConfig::Proxy(layer) => (&layer.host, layer.port),
            // HTTP script tunnel layers dial a PHP script URL instead of a host:port
            // endpoint, and are validated as the outermost transport layer.
            TransportLayerConfig::HttpTunnel(_) => ("", 0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub key_passphrase: String,
    #[serde(default = "default_ssh_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default)]
    pub expose_lan: bool,
    #[serde(default)]
    pub use_ssh_agent: bool,
    /// Custom SSH agent socket path (e.g. `~/.ssh/agent.sock`).
    /// When set and `use_ssh_agent` is true, this path is used instead of the
    /// `SSH_AUTH_SOCK` environment variable.
    #[serde(default)]
    pub ssh_agent_sock_path: String,
    /// Login method: `"password"`, `"key"`, `"key+password"`, `"agent"`, or `"none"`.
    /// Empty string means an older saved connection predating this field —
    /// the backend falls back to probing key > password > agent based on
    /// which fields are non-empty. When set to a specific method the backend
    /// only tries that method (after the standard `none` probe).
    /// `"key+password"` tries private key auth first and falls back to
    /// password auth if the key is rejected.
    #[serde(default)]
    pub auth_method: String,
    /// Allow an SSH session exec channel to run `nc` when the server rejects
    /// `direct-tcpip`. Disabled by default because this can bypass a server's
    /// TCP-forwarding policy; enable only for trusted JumpServer/Koko setups.
    #[serde(default, skip_serializing_if = "is_false")]
    pub allow_exec_channel_proxy: bool,
    /// When non-empty, this layer references a shared tunnel profile
    /// (Settings > Tunnels). The profile's configuration replaces this
    /// layer's own fields at connect time; only `id` and `enabled` are
    /// kept from the referencing layer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Optional target for tunnel profile testing. When set, the test connects
    /// to this `host:port`; when empty, the test performs an endpoint-only
    /// liveness probe that requires no external destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_target: Option<String>,
    /// See [`SshTunnelConfig::profile_id`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default = "default_http_tunnel_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    /// See [`SshTunnelConfig::profile_id`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

fn default_true() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

pub fn default_ssh_connect_timeout_secs() -> u64 {
    5
}

pub fn default_http_tunnel_connect_timeout_secs() -> u64 {
    10
}

pub fn default_connect_timeout_secs() -> u64 {
    10
}

pub fn default_query_timeout_secs() -> u64 {
    60
}

pub fn default_idle_timeout_secs() -> u64 {
    60
}

pub fn default_keepalive_interval_secs() -> u64 {
    30
}

fn default_proxy_port() -> u16 {
    1080
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ProxyType {
    #[default]
    Socks5,
    Http,
}

/// Connection types supported by og developer: openGauss over the native
/// PostgreSQL wire protocol (the vendored gaussdb fork), plain PostgreSQL for
/// backwards-compatible saved configurations (same code path), and the
/// openGauss official JDBC driver running as a plugin subprocess.
///
/// Deserializing an unknown `db_type` value fails with serde's "unknown
/// variant" error listing the supported values; it never panics.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    #[default]
    Postgres,
    #[serde(rename = "opengauss", alias = "OpenGauss", alias = "gaussdb")]
    Opengauss,
    Jdbc,
}

impl DatabaseType {
    pub const OpenGauss: DatabaseType = DatabaseType::Opengauss;
}

#[derive(Deserialize)]
struct ConnectionConfigData {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub db_type: DatabaseType,
    #[serde(default)]
    pub driver_profile: Option<String>,
    #[serde(default)]
    pub driver_label: Option<String>,
    #[serde(default)]
    pub url_params: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub visible_databases: Option<Vec<String>>,
    #[serde(default)]
    pub visible_schemas: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    pub show_system_schemas: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub transport_layers: Vec<TransportLayerConfig>,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u64,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub ca_cert_path: String,
    #[serde(default)]
    pub client_cert_path: String,
    #[serde(default)]
    pub client_key_path: String,
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default)]
    pub external_config: Option<serde_json::Value>,
    #[serde(default)]
    pub jdbc_driver_class: Option<String>,
    #[serde(default)]
    pub jdbc_driver_paths: Vec<String>,
    #[serde(default)]
    pub one_time: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub is_production: bool,
    #[serde(default)]
    pub production_databases: Vec<String>,
    #[serde(default)]
    pub database_info: Option<DatabaseConnectionInfo>,
}

impl From<ConnectionConfigData> for ConnectionConfig {
    fn from(data: ConnectionConfigData) -> Self {
        Self {
            id: data.id,
            name: data.name,
            note: data.note,
            db_type: data.db_type,
            driver_profile: data.driver_profile,
            driver_label: data.driver_label,
            url_params: data.url_params,
            host: data.host,
            port: data.port,
            username: data.username,
            password: data.password,
            database: data.database,
            visible_databases: data.visible_databases,
            visible_schemas: data.visible_schemas,
            show_system_schemas: data.show_system_schemas,
            color: data.color,
            transport_layers: data.transport_layers,
            connect_timeout_secs: data.connect_timeout_secs,
            query_timeout_secs: data.query_timeout_secs,
            idle_timeout_secs: data.idle_timeout_secs,
            keepalive_interval_secs: data.keepalive_interval_secs,
            ssl: data.ssl,
            ca_cert_path: data.ca_cert_path,
            client_cert_path: data.client_cert_path,
            client_key_path: data.client_key_path,
            connection_string: data.connection_string,
            external_config: data.external_config,
            jdbc_driver_class: data.jdbc_driver_class,
            jdbc_driver_paths: data.jdbc_driver_paths,
            one_time: data.one_time,
            read_only: data.read_only,
            is_production: data.is_production,
            production_databases: data.production_databases,
            database_info: data.database_info,
        }
    }
}

impl<'de> Deserialize<'de> for ConnectionConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        migrate_legacy_transport_layers(&mut value);
        let data = ConnectionConfigData::deserialize(value).map_err(serde::de::Error::custom)?;
        Ok(data.into())
    }
}

fn migrate_legacy_transport_layers(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if object.get("transport_layers").and_then(Value::as_array).is_some_and(|layers| !layers.is_empty()) {
        return;
    }

    let mut layers = Vec::new();
    let ssh_enabled = object.get("ssh_enabled").and_then(Value::as_bool).unwrap_or(false);
    if ssh_enabled {
        if let Some(ssh_tunnels) = object.get("ssh_tunnels").and_then(Value::as_array) {
            for hop in ssh_tunnels {
                let mut layer = hop.clone();
                if let Some(layer_object) = layer.as_object_mut() {
                    layer_object.insert("type".to_string(), Value::String("ssh".to_string()));
                }
                layers.push(layer);
            }
        }

        if layers.is_empty() && string_field(object, "ssh_host").is_some() {
            let mut layer = serde_json::Map::new();
            layer.insert("type".to_string(), Value::String("ssh".to_string()));
            layer.insert("id".to_string(), Value::String("legacy".to_string()));
            layer.insert("enabled".to_string(), Value::Bool(true));
            copy_string(object, &mut layer, "ssh_host", "host");
            copy_u64(object, &mut layer, "ssh_port", "port", default_ssh_port() as u64);
            copy_string(object, &mut layer, "ssh_user", "user");
            copy_string(object, &mut layer, "ssh_password", "password");
            copy_string(object, &mut layer, "ssh_key_path", "key_path");
            copy_string(object, &mut layer, "ssh_key_passphrase", "key_passphrase");
            copy_u64(
                object,
                &mut layer,
                "ssh_connect_timeout_secs",
                "connect_timeout_secs",
                default_ssh_connect_timeout_secs(),
            );
            copy_bool(object, &mut layer, "ssh_expose_lan", "expose_lan");
            layers.push(Value::Object(layer));
        }
    }

    let proxy_enabled = object.get("proxy_enabled").and_then(Value::as_bool).unwrap_or(false);
    if proxy_enabled && string_field(object, "proxy_host").is_some() {
        let mut layer = serde_json::Map::new();
        layer.insert("type".to_string(), Value::String("proxy".to_string()));
        layer.insert("id".to_string(), Value::String("legacy-proxy".to_string()));
        layer.insert("enabled".to_string(), Value::Bool(true));
        copy_string(object, &mut layer, "proxy_type", "proxy_type");
        copy_string(object, &mut layer, "proxy_host", "host");
        copy_u64(object, &mut layer, "proxy_port", "port", default_proxy_port() as u64);
        copy_string(object, &mut layer, "proxy_username", "username");
        copy_string(object, &mut layer, "proxy_password", "password");
        layers.push(Value::Object(layer));
    }

    if !layers.is_empty() {
        object.insert("transport_layers".to_string(), Value::Array(layers));
    }
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn copy_string(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
) {
    if let Some(value) = object.get(from).and_then(Value::as_str) {
        target.insert(to.to_string(), Value::String(value.to_string()));
    }
}

fn copy_bool(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
) {
    if let Some(value) = object.get(from).and_then(Value::as_bool) {
        target.insert(to.to_string(), Value::Bool(value));
    }
}

fn copy_u64(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
    default: u64,
) {
    let value = object.get(from).and_then(Value::as_u64).filter(|value| *value > 0).unwrap_or(default);
    target.insert(to.to_string(), Value::Number(value.into()));
}

impl ConnectionConfig {
    pub fn canonicalized(&self) -> Self {
        self.clone()
    }

    pub fn effective_transport_layers(&self) -> Vec<TransportLayerConfig> {
        self.transport_layers.iter().filter(|layer| layer.enabled()).cloned().collect()
    }

    pub fn effective_ssh_tunnels(&self) -> Vec<SshTunnelConfig> {
        self.effective_transport_layers()
            .into_iter()
            .filter_map(|layer| match layer {
                TransportLayerConfig::Ssh(ssh) => Some(ssh),
                TransportLayerConfig::Proxy(_) | TransportLayerConfig::HttpTunnel(_) => None,
            })
            .collect()
    }

    pub fn has_effective_transport_layers(&self) -> bool {
        !self.effective_transport_layers().is_empty()
    }

    pub fn has_effective_ssh_tunnels(&self) -> bool {
        self.effective_transport_layers().iter().any(|layer| matches!(layer, TransportLayerConfig::Ssh(_)))
    }

    pub fn effective_connect_timeout_secs(&self) -> u64 {
        if self.connect_timeout_secs == 0 {
            default_connect_timeout_secs()
        } else {
            self.connect_timeout_secs.clamp(1, 300)
        }
    }

    pub fn effective_query_timeout_secs(&self) -> u64 {
        if self.query_timeout_secs == 0 {
            0
        } else {
            self.query_timeout_secs.max(1)
        }
    }

    pub fn effective_database(&self) -> Option<&str> {
        self.database.as_deref().filter(|database| !database.trim().is_empty()).or_else(|| self.default_database())
    }

    fn default_database(&self) -> Option<&'static str> {
        match self.db_type {
            DatabaseType::Postgres | DatabaseType::OpenGauss => Some("postgres"),
            DatabaseType::Jdbc => None,
        }
    }

    pub fn connection_url(&self) -> String {
        self.connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url(&self) -> String {
        self.redacted_connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url_with_host(&self, host: &str, port: u16) -> String {
        let raw_host = host;
        let host = bracket_ipv6(host);
        let db_part = self.effective_database().map(|d| format!("/{}", encode_url_part(d))).unwrap_or_default();
        let params = self.redacted_url_params();

        match self.db_type {
            DatabaseType::Postgres => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_multi_host(raw_host) {
                    format!("postgres://{raw_host}{db_part}{suffix}")
                } else {
                    format!("postgres://{host}:{port}{db_part}{suffix}")
                }
            }
            DatabaseType::OpenGauss => format!("opengauss://{host}:{port}{db_part}"),
            DatabaseType::Jdbc => "jdbc:<redacted>".to_string(),
        }
    }

    pub fn connection_url_with_host(&self, host: &str, port: u16) -> String {
        let raw_host = host;
        let host = bracket_ipv6(host);
        let db_part = self.effective_database().map(|d| format!("/{}", encode_url_part(d))).unwrap_or_default();
        let username = encode_url_part(&self.username);
        let password = encode_url_part(&self.password);
        let params = self.normalized_url_params();

        match self.db_type {
            DatabaseType::Postgres => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_multi_host(raw_host) {
                    // Multi-host: host1:port1,host2:port2 — each host already has its port embedded
                    format!("postgres://{}:{}@{raw_host}{db_part}{suffix}", username, password)
                } else {
                    format!("postgres://{}:{}@{host}:{port}{db_part}{suffix}", username, password)
                }
            }
            DatabaseType::OpenGauss => {
                format!("opengauss://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Jdbc => {
                self.connection_string.as_deref().filter(|value| !value.is_empty()).unwrap_or("jdbc:").to_string()
            }
        }
    }

    fn normalized_url_params(&self) -> String {
        let value = self.url_params.as_deref().unwrap_or("").trim();
        match self.db_type {
            DatabaseType::Postgres => normalize_postgres_url_params(value, self.ssl),
            _ => value.trim_start_matches('?').to_string(),
        }
    }

    fn redacted_url_params(&self) -> String {
        let params = self.normalized_url_params();
        if self.db_type == DatabaseType::Postgres {
            redact_postgres_url_params(&params)
        } else {
            params
        }
    }

    pub(crate) fn validate_native_url_params(&self) -> Result<(), String> {
        if self.db_type == DatabaseType::Postgres {
            validate_postgres_url_params(self.url_params.as_deref().unwrap_or(""))
        } else {
            Ok(())
        }
    }
}

fn normalize_postgres_url_params(value: &str, force_tls: bool) -> String {
    let value = value.trim_start_matches('?');

    let mut timezone: Option<String> = None;
    let mut search_path: Option<String> = None;
    let mut parts: Vec<String> = Vec::new();

    for part in value.split('&').filter(|part| !part.is_empty()) {
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        let key = percent_decode_str(raw_key).decode_utf8_lossy();
        if key.eq_ignore_ascii_case("timezone") || key.eq_ignore_ascii_case("time_zone") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy().trim().to_string();
            if !decoded_value.is_empty() {
                timezone = Some(decoded_value);
            }
        } else if key.eq_ignore_ascii_case("schema") || key.eq_ignore_ascii_case("currentSchema") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy().trim().to_string();
            if !decoded_value.is_empty() {
                search_path = Some(decoded_value);
            }
        } else if key.eq_ignore_ascii_case("ssl-mode") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy();
            match decoded_value.to_ascii_lowercase().replace('_', "-").as_str() {
                "require" | "required" => parts.push("sslmode=require".to_string()),
                "prefer" | "preferred" => parts.push("sslmode=prefer".to_string()),
                "disable" | "disabled" => parts.push("sslmode=disable".to_string()),
                "verify-ca" => parts.push("sslmode=verify-ca".to_string()),
                "verify-full" | "verify-identity" => parts.push("sslmode=verify-full".to_string()),
                _ => {}
            }
        } else if key.eq_ignore_ascii_case("host")
            || key.eq_ignore_ascii_case("hostaddr")
            || key.eq_ignore_ascii_case("port")
            || key.eq_ignore_ascii_case("stringtype")
        {
        } else if key.eq_ignore_ascii_case("charset")
            || key.eq_ignore_ascii_case("require_ssl")
            || key.eq_ignore_ascii_case("verify_ca")
            || key.eq_ignore_ascii_case("verify_identity")
        {
            // Driver-specific parameters may be present in older/imported
            // saved connections. tokio-postgres rejects unknown URL keys.
        } else {
            parts.push(part.to_string());
        }
    }

    let mut connection_options: Vec<(&str, String)> = Vec::new();
    if let Some(search_path) = search_path {
        connection_options.push(("search_path=", format!("-c search_path={search_path}")));
    }
    if let Some(timezone) = timezone {
        connection_options.push(("timezone=", format!("-c TimeZone={timezone}")));
    }

    if connection_options.is_empty() {
        if !parts.iter().any(|part| url_param_key_is(part, "sslmode")) {
            // Match libpq/JDBC: absent mode prefers TLS and falls back to plaintext.
            // Explicit ssl toggle still forces require; users can opt into disable.
            parts.insert(0, if force_tls { "sslmode=require" } else { "sslmode=prefer" }.to_string());
        }
        return parts.join("&");
    }

    if let Some(options_index) = parts.iter().position(|part| {
        part.split_once('=')
            .map(|(raw_key, _)| percent_decode_str(raw_key).decode_utf8_lossy().eq_ignore_ascii_case("options"))
            .unwrap_or(false)
    }) {
        let (raw_key, raw_value) = parts[options_index].split_once('=').unwrap_or(("options", ""));
        let options_value = percent_decode_str(raw_value).decode_utf8_lossy();
        let lower_options = options_value.to_ascii_lowercase();
        let appended_options = connection_options
            .into_iter()
            .filter_map(|(needle, option)| (!lower_options.contains(needle)).then_some(option))
            .collect::<Vec<_>>()
            .join(" ");
        if !appended_options.is_empty() {
            let combined = format!("{} {}", options_value.trim(), appended_options).trim().to_string();
            parts[options_index] = format!("{raw_key}={}", encode_url_part(&combined));
        }
    } else {
        let combined = connection_options.into_iter().map(|(_, option)| option).collect::<Vec<_>>().join(" ");
        parts.push(format!("options={}", encode_url_part(&combined)));
    }

    if !parts.iter().any(|part| url_param_key_is(part, "sslmode")) {
        parts.insert(0, if force_tls { "sslmode=require" } else { "sslmode=prefer" }.to_string());
    }

    parts.join("&")
}

fn redact_postgres_url_params(value: &str) -> String {
    value
        .split('&')
        .filter(|part| !part.is_empty() && !url_param_key_is(part, "password"))
        .collect::<Vec<_>>()
        .join("&")
}

fn validate_postgres_url_params(value: &str) -> Result<(), String> {
    for part in value.trim().trim_start_matches('?').split('&').filter(|part| !part.is_empty()) {
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        if !percent_decode_str(raw_key).decode_utf8_lossy().eq_ignore_ascii_case("stringtype") {
            continue;
        }

        let string_type = percent_decode_str(raw_value).decode_utf8_lossy();
        if string_type.eq_ignore_ascii_case("unspecified") || string_type.eq_ignore_ascii_case("varchar") {
            continue;
        }

        let value = if string_type.is_empty() { "<empty>" } else { string_type.as_ref() };
        return Err(format!(
            "Unsupported value for PostgreSQL stringtype parameter: {value}. Expected 'unspecified' or 'varchar'."
        ));
    }

    Ok(())
}

fn url_param_key_is(part: &str, expected: &str) -> bool {
    let key = part.split_once('=').map(|(key, _)| key).unwrap_or(part);
    percent_decode_str(key).decode_utf8_lossy().eq_ignore_ascii_case(expected)
}

pub fn parse_jdbc_host_port(url: &str) -> Option<(String, u16)> {
    let rest = jdbc_transport_rest(url)?;

    // jdbc:oracle:thin:@host:port:SID  or  jdbc:oracle:thin:@//host:port/service
    if let Some(after) = rest.strip_prefix("oracle:") {
        let at_pos = after.find('@')?;
        let after_at = &after[at_pos + 1..];
        if after_at.trim_start().starts_with('(') {
            let host = oracle_descriptor_value(after_at, "HOST")?;
            let port = oracle_descriptor_value(after_at, "PORT")?;
            return Some((host, port.parse().ok()?));
        }
        let after_at = after_at.strip_prefix("//").unwrap_or(after_at);
        let host_port = after_at.split(&['/', ':', '?'][..]).next()?;
        let port_str = after_at.strip_prefix(host_port)?.strip_prefix(':')?.split(&[':', '/', ';', '?'][..]).next()?;
        return Some((host_port.to_string(), port_str.parse().ok()?));
    }

    // jdbc:sqlserver://host:port;prop=val  or  jdbc:sqlserver://host\instance:port;...
    if let Some(after) = rest.strip_prefix("sqlserver://") {
        let authority = after.split(';').next().unwrap_or(after);
        let authority = authority.split('\\').next().unwrap_or(authority);
        return match authority.rsplit_once(':') {
            Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
            None => Some((authority.to_string(), 1433)),
        };
    }

    // Generic: jdbc:subprotocol://[user:pass@]host:port[/path][?query]
    let scheme_end = rest.find("://")?;
    let after_scheme = &rest[scheme_end + 3..];
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let authority = authority.split('?').next().unwrap_or(authority);
    let host_port = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    match host_port.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
        None => None,
    }
}

fn jdbc_transport_rest(url: &str) -> Option<&str> {
    if let Some(rest) = url.strip_prefix("jdbc:").or_else(|| url.strip_prefix("JDBC:")) {
        return Some(rest);
    }

    let rest = url.strip_prefix("jdbcx:").or_else(|| url.strip_prefix("JDBCX:"))?;
    if let Some(scheme_end) = rest.find("://") {
        let scheme = &rest[..scheme_end];
        return Some(match scheme.rfind(':') {
            Some(extension_end) => &rest[extension_end + 1..],
            None => rest,
        });
    }

    // Oracle's descriptor and thin URL forms do not contain `://`. In an
    // extended JDBCX URL the vendor transport follows the first colon.
    let tail = rest.split_once(':').map(|(_, tail)| tail);
    match tail {
        Some(tail) if tail.get(.."oracle:".len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case("oracle:")) => {
            Some(tail)
        }
        _ => Some(rest),
    }
}

pub fn rewrite_jdbc_url_host(url: &str, new_host: &str, new_port: u16) -> String {
    let normalized_url = url.to_ascii_uppercase();
    let normalized_rest = jdbc_transport_rest(url).map(str::to_ascii_uppercase).unwrap_or_default();
    if normalized_rest.starts_with("ORACLE:") && normalized_url.contains("(HOST=") && normalized_url.contains("(PORT=")
    {
        return rewrite_oracle_descriptor_host(url, new_host, new_port);
    }

    let Some((old_host, old_port)) = parse_jdbc_host_port(url) else {
        return url.to_string();
    };
    let old_authority = format!("{old_host}:{old_port}");
    let new_authority = format!("{new_host}:{new_port}");
    url.replacen(&old_authority, &new_authority, 1)
}

fn oracle_descriptor_value(descriptor: &str, key: &str) -> Option<String> {
    let key = format!("({key}=");
    let start = descriptor.to_ascii_uppercase().find(&key)?;
    let value_start = start + key.len();
    let value_end = descriptor[value_start..].find(')')? + value_start;
    Some(descriptor[value_start..value_end].trim().to_string())
}

fn rewrite_oracle_descriptor_host(url: &str, new_host: &str, new_port: u16) -> String {
    let rewritten_host = replace_oracle_descriptor_value(url, "HOST", new_host);
    replace_oracle_descriptor_value(&rewritten_host, "PORT", &new_port.to_string())
}

fn replace_oracle_descriptor_value(input: &str, key: &str, value: &str) -> String {
    let token = format!("({key}=");
    let Some(start) = input.to_ascii_uppercase().find(&token) else {
        return input.to_string();
    };
    let value_start = start + token.len();
    let Some(value_end) = input[value_start..].find(')').map(|offset| value_start + offset) else {
        return input.to_string();
    };
    format!("{}{}{}", &input[..value_start], value, &input[value_end..])
}

fn encode_url_part(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn bracket_ipv6(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Returns `true` when `host` contains two or more comma-separated entries
/// where each entry already embeds its own `:port` suffix.
///
/// A single entry such as `db.example.com:5432` is **not** multi-host —
/// the scalar `port` parameter must be appended separately.
fn is_multi_host(host: &str) -> bool {
    let count = host.split(',').count();
    count >= 2
}

#[cfg(test)]
mod tests {
    use super::{
        database_info_from_protocol_value, default_query_timeout_secs, default_ssh_connect_timeout_secs,
        ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, DatabaseType, IdentifierCase,
        ProxyTunnelConfig, ProxyType, TransportLayerConfig,
    };
    use std::str::FromStr;

    #[test]
    fn default_query_timeout_is_sixty_seconds() {
        assert_eq!(default_query_timeout_secs(), 60);
    }

    #[test]
    fn supported_database_types_use_stable_wire_names() {
        assert_eq!(serde_json::to_string(&DatabaseType::Postgres).unwrap(), "\"postgres\"");
        assert_eq!(serde_json::to_string(&DatabaseType::OpenGauss).unwrap(), "\"opengauss\"");
        assert_eq!(serde_json::to_string(&DatabaseType::Jdbc).unwrap(), "\"jdbc\"");
        assert_eq!(serde_json::from_str::<DatabaseType>("\"opengauss\"").unwrap(), DatabaseType::OpenGauss);
    }

    #[test]
    fn unsupported_database_type_fails_with_clear_error() {
        let err = serde_json::from_str::<DatabaseType>("\"mysql\"").unwrap_err();
        let message = err.to_string();
        assert!(message.contains("unknown variant"), "unexpected error: {message}");
        assert!(message.contains("opengauss"), "error should list supported variants: {message}");
    }

    #[test]
    fn connection_test_result_uses_camel_case_and_omits_missing_details() {
        let result =
            ConnectionTestResult::success("Connection successful").with_database_info(Some(DatabaseConnectionInfo {
                product_name: Some("openGauss".to_string()),
                unquoted_identifier_case: Some(IdentifierCase::Lower),
                ..DatabaseConnectionInfo::default()
            }));

        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["message"], "Connection successful");
        assert_eq!(value["databaseInfo"]["productName"], "openGauss");
        assert_eq!(value["databaseInfo"]["unquotedIdentifierCase"], "lower");
        assert!(value["databaseInfo"].get("driverName").is_none());
    }

    #[test]
    fn protocol_database_info_parser_accepts_details_and_legacy_responses() {
        let parsed = database_info_from_protocol_value(&serde_json::json!({
            "ok": true,
            "databaseInfo": {
                "productName": "openGauss",
                "currentDatabase": "app",
                "serverCharset": "utf8",
                "jdbcVersion": "4.2"
            }
        }))
        .unwrap();
        assert_eq!(parsed.product_name.as_deref(), Some("openGauss"));
        assert_eq!(parsed.current_database.as_deref(), Some("app"));
        assert_eq!(parsed.server_charset.as_deref(), Some("utf8"));
        assert_eq!(parsed.jdbc_version.as_deref(), Some("4.2"));
        assert_eq!(database_info_from_protocol_value(&serde_json::json!({ "ok": true })), None);
    }

    fn opengauss_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "id".to_string(),
            name: "name".to_string(),
            note: String::new(),
            db_type: DatabaseType::OpenGauss,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "10.1.2.3".to_string(),
            port: 5432,
            username: username.to_string(),
            password: password.to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: super::default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: super::default_idle_timeout_secs(),
            keepalive_interval_secs: super::default_keepalive_interval_secs(),
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

    #[test]
    fn legacy_mcp_access_is_ignored_and_not_serialized() {
        let legacy: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "db_type": "opengauss",
            "host": "127.0.0.1",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "mcp_access": "read_only"
        }))
        .unwrap();
        assert!(serde_json::to_value(&legacy).unwrap().get("mcp_access").is_none());
        assert!(!legacy.read_only);
    }

    #[test]
    fn legacy_removed_driver_fields_are_ignored_on_deserialize() {
        // Saved configs from the multi-database era carry redis_*/etcd_* fields;
        // they must be ignored instead of breaking deserialization.
        let legacy: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "db_type": "opengauss",
            "host": "127.0.0.1",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "redis_connection_mode": "sentinel",
            "redis_sentinel_master": "mymaster",
            "etcd_endpoints": "http://127.0.0.1:2379",
            "gbase_server": "gbase01",
            "informix_server": "ol_informix",
            "agent_java_options": ["-Xmx1g"],
            "attached_databases": [{ "name": "aux", "path": "/tmp/aux.db" }],
            "init_script": "INSTALL httpfs;",
            "sysdba": true,
            "oracle_connection_type": "tns"
        }))
        .unwrap();
        assert_eq!(legacy.db_type, DatabaseType::OpenGauss);
        let serialized = serde_json::to_value(&legacy).unwrap();
        for key in ["redis_connection_mode", "etcd_endpoints", "gbase_server", "informix_server", "init_script"] {
            assert!(serialized.get(key).is_none(), "removed field {key} should not serialize");
        }
    }

    #[test]
    fn connection_note_is_optional_and_round_trips_when_present() {
        let config = opengauss_config("root", "secret", Some("app"));
        let value = serde_json::to_value(&config).unwrap();
        assert!(value.get("note").is_none());
        assert!(serde_json::from_value::<ConnectionConfig>(value).unwrap().note.is_empty());

        let mut config = config;
        config.note = "Production reporting".to_string();
        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["note"], "Production reporting");
        assert_eq!(serde_json::from_value::<ConnectionConfig>(value).unwrap().note, config.note);
    }

    #[test]
    fn database_identifier_whitespace_is_preserved_and_percent_encoded() {
        let mut config = opengauss_config("root", "secret", Some(" analytics "));

        assert_eq!(config.effective_database(), Some(" analytics "));
        assert_eq!(config.connection_url(), "opengauss://root:secret@10.1.2.3:5432/%20analytics%20");

        config.db_type = DatabaseType::Postgres;
        assert_eq!(config.effective_database(), Some(" analytics "));
        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:5432/%20analytics%20?sslmode=prefer");
    }

    #[test]
    fn whitespace_only_database_uses_database_type_default() {
        let mut config = opengauss_config("root", "secret", Some("   "));
        assert_eq!(config.effective_database(), Some("postgres"));

        config.db_type = DatabaseType::Postgres;
        assert_eq!(config.effective_database(), Some("postgres"));
    }

    #[test]
    fn connection_config_database_info_survives_json_round_trip() {
        let mut config = opengauss_config("root", "secret", Some("app"));
        config.database_info = Some(DatabaseConnectionInfo {
            product_name: Some("openGauss".to_string()),
            product_version: Some("6.0.0".to_string()),
            current_database: Some("app".to_string()),
            server_charset: Some("utf8".to_string()),
            ..DatabaseConnectionInfo::default()
        });

        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["database_info"]["productVersion"], "6.0.0");

        let restored: ConnectionConfig = serde_json::from_value(value).unwrap();
        assert_eq!(restored.database_info, config.database_info);
    }

    #[test]
    fn legacy_single_ssh_config_migrates_to_transport_layer() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "opengauss",
            "host": "10.1.2.3",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_host": "bastion.example.com",
            "ssh_port": 2200,
            "ssh_user": "deploy",
            "ssh_password": "secret",
            "ssh_connect_timeout_secs": 0,
            "ssh_expose_lan": true
        }))
        .unwrap();

        let hops = config.effective_ssh_tunnels();
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].id, "legacy");
        assert_eq!(hops[0].host, "bastion.example.com");
        assert_eq!(hops[0].port, 2200);
        assert_eq!(hops[0].user, "deploy");
        assert_eq!(hops[0].password, "secret");
        assert_eq!(hops[0].connect_timeout_secs, default_ssh_connect_timeout_secs());
        assert!(hops[0].expose_lan);
    }

    #[test]
    fn missing_connection_timeout_defaults_to_ten_seconds() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "opengauss",
            "host": "10.1.2.3",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null
        }))
        .unwrap();

        assert_eq!(config.connect_timeout_secs, 10);
        assert_eq!(config.effective_connect_timeout_secs(), 10);
    }

    #[test]
    fn legacy_ssh_tunnels_migrate_to_ordered_transport_layers() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "opengauss",
            "host": "10.1.2.3",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_tunnels": [
                { "id": "first", "host": "a", "port": 22, "user": "u" },
                { "id": "second", "host": "b", "port": 2200, "user": "u" }
            ]
        }))
        .unwrap();

        let hops = config.effective_ssh_tunnels();
        assert_eq!(hops.iter().map(|hop| hop.id.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
    }

    #[test]
    fn legacy_proxy_config_migrates_to_transport_layer() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "opengauss",
            "host": "10.1.2.3",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "proxy_enabled": true,
            "proxy_type": "http",
            "proxy_host": "proxy.example.com",
            "proxy_port": 8080,
            "proxy_username": "alice",
            "proxy_password": "secret"
        }))
        .unwrap();

        assert_eq!(config.transport_layers.len(), 1);
        match &config.transport_layers[0] {
            TransportLayerConfig::Proxy(proxy) => {
                assert_eq!(proxy.id, "legacy-proxy");
                assert_eq!(proxy.proxy_type, ProxyType::Http);
                assert_eq!(proxy.host, "proxy.example.com");
                assert_eq!(proxy.port, 8080);
                assert_eq!(proxy.username, "alice");
                assert_eq!(proxy.password, "secret");
            }
            _ => panic!("expected proxy layer"),
        }
    }

    #[test]
    fn existing_transport_layers_take_precedence_over_legacy_fields() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "opengauss",
            "host": "10.1.2.3",
            "port": 5432,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_host": "legacy.example.com",
            "transport_layers": [{ "type": "proxy", "id": "proxy", "host": "proxy", "port": 1080 }]
        }))
        .unwrap();

        assert_eq!(config.transport_layers.len(), 1);
        assert!(matches!(&config.transport_layers[0], TransportLayerConfig::Proxy(proxy) if proxy.id == "proxy"));
    }

    #[test]
    fn serialized_connection_config_omits_legacy_transport_fields() {
        let mut config = opengauss_config("root", "", None);
        config.transport_layers = vec![TransportLayerConfig::Proxy(ProxyTunnelConfig {
            profile_id: String::new(),
            id: "proxy".to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "proxy".to_string(),
            port: 1080,
            username: String::new(),
            password: String::new(),
            test_target: None,
        })];

        let saved = serde_json::to_value(config).unwrap();

        assert!(saved.get("transport_layers").is_some());
        for key in ["ssh_tunnels", "ssh_host", "ssh_password", "proxy_host", "proxy_password", "proxy_enabled"] {
            assert!(saved.get(key).is_none(), "legacy key {key} should not serialize");
        }
    }

    #[test]
    fn query_timeout_zero_disables_timeout() {
        let mut config = opengauss_config("root", "", None);
        config.query_timeout_secs = 0;

        assert_eq!(config.effective_query_timeout_secs(), 0);
    }

    #[test]
    fn query_timeout_preserves_long_running_exports() {
        let mut config = opengauss_config("root", "", None);
        config.query_timeout_secs = 3600;

        assert_eq!(config.effective_query_timeout_secs(), 3600);
    }

    #[test]
    fn opengauss_url_defaults_to_postgres_database() {
        let config = opengauss_config("gauss", "secret", None);

        assert_eq!(config.connection_url(), "opengauss://gauss:secret@10.1.2.3:5432/postgres");
        assert_eq!(config.redacted_connection_url(), "opengauss://10.1.2.3:5432/postgres");
    }

    #[test]
    fn jdbc_url_uses_connection_string() {
        let mut config = opengauss_config("gauss", "secret", None);
        config.db_type = DatabaseType::Jdbc;
        config.connection_string = Some("jdbc:opengauss://db.example.com:5432/postgres".to_string());

        assert_eq!(config.connection_url(), "jdbc:opengauss://db.example.com:5432/postgres");
        assert_eq!(config.redacted_connection_url(), "jdbc:<redacted>");
    }

    #[test]
    fn postgres_url_appends_custom_params() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("sslmode=disable".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=disable");
    }

    #[test]
    fn postgres_url_prefers_tls_by_default() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer");
    }

    #[test]
    fn postgres_tls_switch_adds_require_sslmode() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.ssl = true;

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=require");
    }

    #[test]
    fn postgres_url_normalizes_timezone_param_into_options() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("sslmode=require&timezone=Asia/Shanghai".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=require&options=%2Dc%20TimeZone%3DAsia%2FShanghai"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c TimeZone=Asia/Shanghai"));
    }

    #[test]
    fn postgres_url_maps_schema_param_into_search_path_options() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("schema=public".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dpublic"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=public"));
    }

    #[test]
    fn postgres_url_maps_current_schema_param_into_search_path_options() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("currentSchema=app".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dapp"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
    }

    #[test]
    fn postgres_url_ignores_jdbc_stringtype_param() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("currentSchema=public&stringtype=unspecified".to_string());

        assert_eq!(config.validate_native_url_params(), Ok(()));
        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dpublic"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=public"));
    }

    #[test]
    fn postgres_url_accepts_encoded_jdbc_varchar_stringtype_param() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("currentSchema=app&%73tringtype=%76aRcHaR".to_string());

        assert_eq!(config.validate_native_url_params(), Ok(()));
        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dapp"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
    }

    #[test]
    fn postgres_url_rejects_invalid_or_empty_jdbc_stringtype_param() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;

        config.url_params = Some("stringtype=invalid".to_string());
        assert_eq!(
            config.validate_native_url_params().unwrap_err(),
            "Unsupported value for PostgreSQL stringtype parameter: invalid. Expected 'unspecified' or 'varchar'."
        );

        config.url_params = Some("  ?%73tringtype=  ".to_string());
        assert_eq!(
            config.validate_native_url_params().unwrap_err(),
            "Unsupported value for PostgreSQL stringtype parameter: <empty>. Expected 'unspecified' or 'varchar'."
        );
    }

    #[test]
    fn postgres_url_uses_only_the_structured_endpoint() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some(
            "HOST=origin.example.com&%68ostaddr=203.0.113.10&%70ort=6432&currentSchema=app&application_name=dbx"
                .to_string(),
        );

        let url = config.connection_url_with_host("127.0.0.1", 6543);

        assert_eq!(
            url,
            "postgres://postgres:secret@127.0.0.1:6543/test?sslmode=prefer&application_name=dbx&options=%2Dc%20search%5Fpath%3Dapp"
        );
        let pg_config = tokio_postgres::Config::from_str(&url).unwrap();
        assert_eq!(pg_config.get_hosts().len(), 1);
        assert_eq!(pg_config.get_ports(), &[6543]);
        assert!(pg_config.get_hostaddrs().is_empty());
        assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
    }

    #[test]
    fn postgres_url_query_password_keeps_priority_but_is_redacted() {
        let mut config = opengauss_config("postgres", "field-secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("%70assword=query-secret&application_name=dbx".to_string());

        let url = config.connection_url();
        let pg_config = tokio_postgres::Config::from_str(&url).unwrap();
        assert_eq!(pg_config.get_password(), Some(b"query-secret".as_slice()));
        assert_eq!(
            config.redacted_connection_url(),
            "postgres://10.1.2.3:5432/test?sslmode=prefer&application_name=dbx"
        );
    }

    #[test]
    fn postgres_url_redacts_case_insensitive_and_encoded_password_keys() {
        let mut config = opengauss_config("postgres", "field-secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("PASSWORD=upper-secret&%70assword=encoded-secret&application_name=dbx".to_string());

        let url = config.redacted_connection_url();

        assert_eq!(url, "postgres://10.1.2.3:5432/test?sslmode=prefer&application_name=dbx");
        assert!(!url.contains("upper-secret"));
        assert!(!url.contains("encoded-secret"));
    }

    #[test]
    fn postgres_url_ignores_mysql_only_params_from_saved_connections() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("ssl-mode=preferred&charset=utf8mb4".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer");
        tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    }

    #[test]
    fn postgres_url_maps_mysql_ssl_mode_require_to_sslmode() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("ssl-mode=required&verify_ca=false&verify_identity=false".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=require");
        tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    }

    #[test]
    fn postgres_url_appends_timezone_to_existing_options() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("options=-c%20statement_timeout%3D5000&TimeZone=UTC".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=%2Dc%20statement%5Ftimeout%3D5000%20%2Dc%20TimeZone%3DUTC"
        );
    }

    #[test]
    fn postgres_url_keeps_existing_options_timezone() {
        let mut config = opengauss_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("options=-c%20TimeZone%3DUTC&timezone=Asia/Shanghai".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:5432/test?sslmode=prefer&options=-c%20TimeZone%3DUTC"
        );
    }

    #[test]
    fn postgres_url_defaults_to_postgres_database_when_omitted() {
        let mut config = opengauss_config("root", "secret", None);
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:5432/postgres?sslmode=prefer");
    }

    #[test]
    fn postgres_url_defaults_to_postgres_database_when_empty() {
        let mut config = opengauss_config("root", "secret", Some(""));
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:5432/postgres?sslmode=prefer");
    }

    #[test]
    fn parse_jdbc_host_port_postgresql() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:postgresql://myhost:5432/mydb").unwrap();
        assert_eq!(h, "myhost");
        assert_eq!(p, 5432);
    }

    #[test]
    fn parse_jdbc_host_port_opengauss() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:opengauss://db.example.com:5432/app").unwrap();
        assert_eq!(h, "db.example.com");
        assert_eq!(p, 5432);
    }

    #[test]
    fn parse_jdbcx_host_port_with_and_without_extension() {
        assert_eq!(
            super::parse_jdbc_host_port("jdbcx:prql:postgresql://pg.example.com:5432/app"),
            Some(("pg.example.com".to_string(), 5432))
        );
        assert_eq!(
            super::parse_jdbc_host_port("jdbcx:query:sqlserver://sql.example.com:1433;databaseName=app"),
            Some(("sql.example.com".to_string(), 1433))
        );
    }

    #[test]
    fn parse_jdbc_host_port_with_userinfo() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:postgresql://user:pass@pghost:5433/db").unwrap();
        assert_eq!(h, "pghost");
        assert_eq!(p, 5433);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_thin() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:oracle:thin:@orahost:1521:ORCL").unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_service() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:oracle:thin:@//orahost:1521/service").unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_descriptor() {
        let (h, p) = super::parse_jdbc_host_port(
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))",
        )
        .unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn rewrite_jdbc_url_host_oracle_descriptor() {
        let url =
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))";

        assert_eq!(
            super::rewrite_jdbc_url_host(url, "127.0.0.1", 11521),
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=11521))(CONNECT_DATA=(SERVICE_NAME=orcl)))"
        );
    }

    #[test]
    fn parse_jdbc_host_port_sqlserver() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:sqlserver://mshost:1433;databaseName=master").unwrap();
        assert_eq!(h, "mshost");
        assert_eq!(p, 1433);
    }

    #[test]
    fn parse_jdbc_host_port_sqlserver_no_port() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:sqlserver://mshost;databaseName=master").unwrap();
        assert_eq!(h, "mshost");
        assert_eq!(p, 1433);
    }

    #[test]
    fn parse_jdbc_host_port_no_port_returns_none() {
        assert!(super::parse_jdbc_host_port("jdbc:postgresql://myhost/mydb").is_none());
    }

    #[test]
    fn parse_jdbc_host_port_invalid_returns_none() {
        assert!(super::parse_jdbc_host_port("not-a-jdbc-url").is_none());
    }

    #[test]
    fn rewrite_jdbc_url_postgresql() {
        let url = "jdbc:postgresql://myhost:5432/mydb";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:postgresql://127.0.0.1:54321/mydb");
    }

    #[test]
    fn rewrite_jdbcx_url_preserves_extension() {
        let url = "jdbcx:script:mysql://db.example.com:3306/app";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 13306);
        assert_eq!(rewritten, "jdbcx:script:mysql://127.0.0.1:13306/app");

        let sqlserver = "jdbcx:query:sqlserver://sql.example.com:1433;databaseName=app";
        let rewritten = super::rewrite_jdbc_url_host(sqlserver, "127.0.0.1", 11433);
        assert_eq!(rewritten, "jdbcx:query:sqlserver://127.0.0.1:11433;databaseName=app");
    }

    #[test]
    fn rewrite_jdbcx_oracle_descriptor() {
        let url = "jdbcx:web:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 11521);
        assert_eq!(
            rewritten,
            "jdbcx:web:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=11521))(CONNECT_DATA=(SERVICE_NAME=orcl)))"
        );
    }

    #[test]
    fn rewrite_jdbc_url_oracle() {
        let url = "jdbc:oracle:thin:@orahost:1521:ORCL";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:oracle:thin:@127.0.0.1:54321:ORCL");
    }

    #[test]
    fn rewrite_jdbc_url_sqlserver() {
        let url = "jdbc:sqlserver://mshost:1433;databaseName=master";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:sqlserver://127.0.0.1:54321;databaseName=master");
    }

    #[test]
    fn rewrite_jdbc_url_unparseable_returns_original() {
        let url = "jdbc:custom:some-opaque-string";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, url);
    }
}
