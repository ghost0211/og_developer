use crate::models::connection::{ConnectionConfig, TransportLayerConfig};
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const MAIN_PASSWORD_KEY: &str = "password";
pub const SSH_PASSWORD_KEY: &str = "ssh_password";
pub const SSH_KEY_PASSPHRASE_KEY: &str = "ssh_key_passphrase";
pub const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
pub const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";
pub const PROXY_PASSWORD_KEY: &str = "proxy_password";
pub const CONNECTION_STRING_KEY: &str = "connection_string";

pub trait ConnectionSecretStore {
    fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String>;
    fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String>;
    fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String>;
    fn delete_secret_prefix(&self, _connection_id: &str, _key_prefix: &str) -> Result<(), String> {
        Ok(())
    }
}

pub struct FileSecretStore {
    path: PathBuf,
}

impl FileSecretStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_store(&self) -> HashMap<String, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(json) => match serde_json::from_str(&json) {
                Ok(map) => map,
                Err(e) => {
                    log::warn!(
                        "Failed to parse secret store at {:?}: {}. Returning empty store. This may indicate file corruption.",
                        self.path, e
                    );
                    HashMap::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::default(),
            Err(e) => {
                log::warn!("Failed to read secret store at {:?}: {}. Returning empty store.", self.path, e);
                HashMap::default()
            }
        }
    }

    fn write_store(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

impl ConnectionSecretStore for FileSecretStore {
    fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
        let mut map = self.read_store();
        map.insert(secret_account(connection_id, key), secret.to_string());
        self.write_store(&map)
    }

    fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
        let map = self.read_store();
        Ok(map.get(&secret_account(connection_id, key)).cloned())
    }

    fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
        let mut map = self.read_store();
        map.remove(&secret_account(connection_id, key));
        self.write_store(&map)
    }

    fn delete_secret_prefix(&self, connection_id: &str, key_prefix: &str) -> Result<(), String> {
        let mut map = self.read_store();
        let target_prefix = secret_account(connection_id, key_prefix);
        map.retain(|account, _| !account.starts_with(&target_prefix));
        self.write_store(&map)
    }
}

pub fn save_connections_to_file(
    path: &Path,
    configs: &[ConnectionConfig],
    store: &dyn ConnectionSecretStore,
) -> Result<(), String> {
    delete_removed_connection_secrets(path, configs, store)?;
    for config in configs {
        persist_secret(store, &config.id, MAIN_PASSWORD_KEY, &config.password)?;
        delete_secret_prefix(store, &config.id, TRANSPORT_LAYER_SECRET_PREFIX)?;
        for (index, layer) in config.transport_layers.iter().enumerate() {
            persist_transport_layer_secrets(store, &config.id, index, layer)?;
        }
        persist_optional_secret(store, &config.id, CONNECTION_STRING_KEY, config.connection_string.as_deref())?;

        // Clean up legacy transport secret slots
        store.delete_secret(&config.id, SSH_PASSWORD_KEY)?;
        store.delete_secret(&config.id, SSH_KEY_PASSPHRASE_KEY)?;
        store.delete_secret(&config.id, PROXY_PASSWORD_KEY)?;
        delete_secret_prefix(store, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
    }

    write_sanitized_connections(path, configs)
}

pub fn load_connections_from_file(
    path: &Path,
    store: &dyn ConnectionSecretStore,
) -> Result<Vec<ConnectionConfig>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }

    let mut configs = read_connections(path)?;
    let mut needs_rewrite = false;
    for config in &mut configs {
        if config.password.is_empty() {
            if let Some(secret) = store.get_secret(&config.id, MAIN_PASSWORD_KEY)? {
                config.password = secret;
            }
        } else {
            store.set_secret(&config.id, MAIN_PASSWORD_KEY, &config.password)?;
            needs_rewrite = true;
        }

        hydrate_transport_layer_secrets(store, config, &mut needs_rewrite)?;

        match config.connection_string.as_deref().filter(|secret| !secret.is_empty()) {
            Some(secret) => {
                store.set_secret(&config.id, CONNECTION_STRING_KEY, secret)?;
                needs_rewrite = true;
            }
            None => {
                if let Some(secret) = store.get_secret(&config.id, CONNECTION_STRING_KEY)? {
                    config.connection_string = Some(secret);
                }
            }
        }
    }

    if needs_rewrite {
        write_sanitized_connections(path, &configs)?;
    }

    Ok(configs)
}

fn persist_transport_layer_secrets(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    index: usize,
    layer: &TransportLayerConfig,
) -> Result<(), String> {
    match layer {
        TransportLayerConfig::Ssh(ssh) => {
            persist_secret(store, connection_id, &transport_layer_ssh_password_key(index, layer), &ssh.password)?;
            persist_secret(
                store,
                connection_id,
                &transport_layer_ssh_key_passphrase_key(index, layer),
                &ssh.key_passphrase,
            )?;
        }
        TransportLayerConfig::Proxy(proxy) => {
            persist_secret(store, connection_id, &transport_layer_proxy_password_key(index, layer), &proxy.password)?;
        }
        TransportLayerConfig::HttpTunnel(http) => {
            persist_secret(store, connection_id, &transport_layer_http_tunnel_token_key(index, layer), &http.token)?;
        }
    }
    Ok(())
}

fn hydrate_transport_layer_secrets(
    store: &dyn ConnectionSecretStore,
    config: &mut ConnectionConfig,
    needs_rewrite: &mut bool,
) -> Result<(), String> {
    for (index, layer) in config.transport_layers.iter_mut().enumerate() {
        match layer {
            TransportLayerConfig::Ssh(ssh) => {
                if ssh.password.is_empty() {
                    let key = transport_layer_ssh_password_key(index, ssh);
                    if let Some(secret) = store.get_secret(&config.id, &key)? {
                        ssh.password = secret;
                    } else if index == 0 {
                        if let Some(secret) = store.get_secret(&config.id, SSH_PASSWORD_KEY)? {
                            ssh.password = secret;
                            *needs_rewrite = true;
                        }
                    }
                } else {
                    persist_secret(store, &config.id, &transport_layer_ssh_password_key(index, ssh), &ssh.password)?;
                    *needs_rewrite = true;
                }

                if ssh.key_passphrase.is_empty() {
                    let key = transport_layer_ssh_key_passphrase_key(index, ssh);
                    if let Some(secret) = store.get_secret(&config.id, &key)? {
                        ssh.key_passphrase = secret;
                    } else if index == 0 {
                        if let Some(secret) = store.get_secret(&config.id, SSH_KEY_PASSPHRASE_KEY)? {
                            ssh.key_passphrase = secret;
                            *needs_rewrite = true;
                        }
                    }
                } else {
                    persist_secret(
                        store,
                        &config.id,
                        &transport_layer_ssh_key_passphrase_key(index, ssh),
                        &ssh.key_passphrase,
                    )?;
                    *needs_rewrite = true;
                }
            }
            TransportLayerConfig::Proxy(proxy) => {
                if proxy.password.is_empty() {
                    let key = transport_layer_proxy_password_key(index, proxy);
                    if let Some(secret) = store.get_secret(&config.id, &key)? {
                        proxy.password = secret;
                    } else if index == 0 {
                        if let Some(secret) = store.get_secret(&config.id, PROXY_PASSWORD_KEY)? {
                            proxy.password = secret;
                            *needs_rewrite = true;
                        }
                    }
                } else {
                    persist_secret(
                        store,
                        &config.id,
                        &transport_layer_proxy_password_key(index, proxy),
                        &proxy.password,
                    )?;
                    *needs_rewrite = true;
                }
            }
            TransportLayerConfig::HttpTunnel(http) => {
                if http.token.is_empty() {
                    let key = transport_layer_http_tunnel_token_key(index, http);
                    if let Some(secret) = store.get_secret(&config.id, &key)? {
                        http.token = secret;
                    }
                } else {
                    persist_secret(
                        store,
                        &config.id,
                        &transport_layer_http_tunnel_token_key(index, http),
                        &http.token,
                    )?;
                    *needs_rewrite = true;
                }
            }
        }
    }
    Ok(())
}

fn transport_layer_slot_name(index: usize, layer: &impl TransportLayerIdentity) -> String {
    let id = layer.id().trim();
    if id.is_empty() {
        index.to_string()
    } else {
        id.to_string()
    }
}

pub trait TransportLayerIdentity {
    fn id(&self) -> &str;
}

impl TransportLayerIdentity for TransportLayerConfig {
    fn id(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(ssh) => &ssh.id,
            TransportLayerConfig::Proxy(proxy) => &proxy.id,
            TransportLayerConfig::HttpTunnel(http) => &http.id,
        }
    }
}

impl TransportLayerIdentity for crate::models::connection::SshTunnelConfig {
    fn id(&self) -> &str {
        &self.id
    }
}

impl TransportLayerIdentity for crate::models::connection::ProxyTunnelConfig {
    fn id(&self) -> &str {
        &self.id
    }
}

impl TransportLayerIdentity for crate::models::connection::HttpTunnelConfig {
    fn id(&self) -> &str {
        &self.id
    }
}

fn transport_layer_ssh_password_key(index: usize, layer: &impl TransportLayerIdentity) -> String {
    format!("{TRANSPORT_LAYER_SECRET_PREFIX}{}.ssh_password", transport_layer_slot_name(index, layer))
}

fn transport_layer_ssh_key_passphrase_key(index: usize, layer: &impl TransportLayerIdentity) -> String {
    format!("{TRANSPORT_LAYER_SECRET_PREFIX}{}.ssh_key_passphrase", transport_layer_slot_name(index, layer))
}

fn transport_layer_proxy_password_key(index: usize, layer: &impl TransportLayerIdentity) -> String {
    format!("{TRANSPORT_LAYER_SECRET_PREFIX}{}.proxy_password", transport_layer_slot_name(index, layer))
}

fn transport_layer_http_tunnel_token_key(index: usize, layer: &impl TransportLayerIdentity) -> String {
    format!("{TRANSPORT_LAYER_SECRET_PREFIX}{}.http_tunnel_token", transport_layer_slot_name(index, layer))
}

fn delete_removed_connection_secrets(
    path: &Path,
    configs: &[ConnectionConfig],
    store: &dyn ConnectionSecretStore,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let existing_configs = read_connections(path)?;
    let active_ids: HashSet<&str> = configs.iter().map(|c| c.id.as_str()).collect();

    for existing in existing_configs {
        if !active_ids.contains(existing.id.as_str()) {
            store.delete_secret(&existing.id, MAIN_PASSWORD_KEY)?;
            store.delete_secret(&existing.id, SSH_PASSWORD_KEY)?;
            store.delete_secret(&existing.id, SSH_KEY_PASSPHRASE_KEY)?;
            store.delete_secret(&existing.id, PROXY_PASSWORD_KEY)?;
            store.delete_secret(&existing.id, CONNECTION_STRING_KEY)?;
            delete_secret_prefix(store, &existing.id, SSH_TUNNEL_SECRET_PREFIX)?;
            delete_secret_prefix(store, &existing.id, TRANSPORT_LAYER_SECRET_PREFIX)?;
        }
    }

    Ok(())
}

fn persist_secret(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        store.delete_secret(connection_id, key)
    } else {
        store.set_secret(connection_id, key, secret)
    }
}

fn persist_optional_secret(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key: &str,
    secret: Option<&str>,
) -> Result<(), String> {
    match secret.filter(|value| !value.is_empty()) {
        Some(value) => store.set_secret(connection_id, key, value),
        None => store.delete_secret(connection_id, key),
    }
}

fn delete_secret_prefix(
    store: &dyn ConnectionSecretStore,
    connection_id: &str,
    key_prefix: &str,
) -> Result<(), String> {
    store.delete_secret_prefix(connection_id, key_prefix)
}

fn read_connections(path: &Path) -> Result<Vec<ConnectionConfig>, String> {
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

fn write_sanitized_connections(path: &Path, configs: &[ConnectionConfig]) -> Result<(), String> {
    let sanitized = sanitize_connections(configs);
    let json = serde_json::to_string_pretty(&sanitized).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn sanitize_connections(configs: &[ConnectionConfig]) -> Vec<ConnectionConfig> {
    configs
        .iter()
        .cloned()
        .map(|mut config| {
            config.password.clear();
            for layer in &mut config.transport_layers {
                match layer {
                    TransportLayerConfig::Ssh(ssh) => {
                        ssh.password.clear();
                        ssh.key_passphrase.clear();
                    }
                    TransportLayerConfig::Proxy(proxy) => {
                        proxy.password.clear();
                    }
                    TransportLayerConfig::HttpTunnel(http) => {
                        http.token.clear();
                    }
                }
            }
            config.connection_string = None;
            config
        })
        .collect()
}

pub fn secret_account(connection_id: &str, key: &str) -> String {
    format!("connection:{connection_id}:{key}")
}

#[cfg(test)]
mod tests {
    use super::{load_connections_from_file, save_connections_to_file, ConnectionSecretStore, MAIN_PASSWORD_KEY};
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemorySecretStore {
        values: RefCell<HashMap<String, String>>,
        deleted: RefCell<Vec<String>>,
    }

    impl MemorySecretStore {
        fn account(connection_id: &str, key: &str) -> String {
            super::secret_account(connection_id, key)
        }
    }

    impl ConnectionSecretStore for MemorySecretStore {
        fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
            self.values.borrow_mut().insert(Self::account(connection_id, key), secret.to_string());
            Ok(())
        }

        fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(&Self::account(connection_id, key)).cloned())
        }

        fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
            let account = Self::account(connection_id, key);
            self.values.borrow_mut().remove(&account);
            self.deleted.borrow_mut().push(account);
            Ok(())
        }

        fn delete_secret_prefix(&self, connection_id: &str, key_prefix: &str) -> Result<(), String> {
            let account_prefix = Self::account(connection_id, key_prefix);
            let mut values = self.values.borrow_mut();
            let mut deleted = self.deleted.borrow_mut();
            values.retain(|account, _| {
                if account.starts_with(&account_prefix) {
                    deleted.push(account.clone());
                    false
                } else {
                    true
                }
            });
            Ok(())
        }
    }

    fn test_connection_config(id: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "Test DB".to_string(),
            note: String::new(),
            db_type: DatabaseType::OpenGauss,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "localhost".to_string(),
            port: 5432,
            username: "gaussdb".to_string(),
            password: "db-password".to_string(),
            database: Some("postgres".to_string()),
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            color: None,
            transport_layers: vec![],
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            connection_string: None,
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: vec![],
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    #[test]
    fn save_connections_persists_passwords_and_sanitizes_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("connections.json");
        let store = MemorySecretStore::default();

        let config = test_connection_config("conn-1");
        save_connections_to_file(&file_path, &[config], &store).unwrap();

        assert_eq!(store.get_secret("conn-1", MAIN_PASSWORD_KEY).unwrap().as_deref(), Some("db-password"));

        let loaded = load_connections_from_file(&file_path, &store).unwrap();
        assert_eq!(loaded[0].password, "db-password");
    }
}
