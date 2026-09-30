//! Direct OpenAI Codex (ChatGPT subscription) device-code OAuth and encrypted token vault.
//!
//! This is intentionally independent from the Codex CLI: it never reads `~/.codex`, opens a
//! browser, launches a CLI, or returns OAuth credentials to callers.

use crate::ai::{AiConfig, AiProvider};
use crate::state_persistence::EncryptedPayload;
use crate::storage::Storage;
use base64::Engine as _;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{LazyLock, RwLock as StdRwLock};
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const CODEX_AUTH_ISSUER: &str = "https://auth.openai.com";
pub const CODEX_DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
pub const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const CODEX_RESPONSES_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const DEVICE_SESSION_TTL_SECS: i64 = 15 * 60;
const MAX_DEVICE_SESSIONS: usize = 128;
const VAULT_STATE_PREFIX: &str = "ai/openai-codex/oauth/v1/";
const VAULT_KEY_FILE_NAME: &str = "openai-codex-oauth.key";
const VAULT_KEY_SIZE: usize = 32;
const VAULT_CONTENT_TYPE: &str = "application/vnd.ogdeveloper.codex-oauth+json";

static DEVICE_SESSIONS: LazyLock<RwLock<HashMap<String, std::sync::Arc<DeviceSessionRecord>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));
static VAULT_STORAGE: LazyLock<StdRwLock<Option<Storage>>> = LazyLock::new(|| StdRwLock::new(None));
static TOKEN_REFRESH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthBeginResponse {
    pub session_id: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval_seconds: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexAuthPollStatus {
    Pending,
    Authorized,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthPollResponse {
    pub status: CodexAuthPollStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatusResponse {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthActionResponse {
    pub canceled: bool,
    pub disconnected: bool,
}

#[derive(Debug, Clone)]
struct ProxySettings {
    enabled: bool,
    url: String,
}

impl From<&AiConfig> for ProxySettings {
    fn from(config: &AiConfig) -> Self {
        Self { enabled: config.proxy_enabled, url: config.proxy_url.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionState {
    Pending,
    Authorized { oauth_account_id: String },
    Expired,
    Cancelled,
}

struct DeviceSession {
    device_auth_id: String,
    user_code: String,
    expires_at: i64,
    issuer: String,
    proxy: ProxySettings,
    state: SessionState,
}

struct DeviceSessionRecord {
    session: Mutex<DeviceSession>,
    cancel: CancellationToken,
}

pub struct CodexAccessToken {
    pub bearer: String,
    pub chatgpt_account_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredTokens {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    access_expires_at: i64,
}

impl std::fmt::Debug for StoredTokens {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("StoredTokens").field("credentials", &"<redacted>").finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct UserCodeResponse {
    device_auth_id: String,
    #[serde(alias = "user_code", alias = "usercode")]
    user_code: String,
    #[serde(default = "default_interval")]
    interval: serde_json::Value,
}

fn default_interval() -> serde_json::Value {
    json!(5)
}

#[derive(Deserialize)]
struct DeviceTokenResponse {
    authorization_code: String,
    code_challenge: String,
    code_verifier: String,
}

#[derive(Deserialize)]
struct OAuthTokensResponse {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Deserialize)]
struct OAuthRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Register this process's existing app storage for AI request credential lookup.
/// The copied handle shares the app's established local SQLite storage; only encrypted vault
/// records are written there.
pub fn configure_storage(storage: &Storage) {
    if let Ok(mut current) = VAULT_STORAGE.write() {
        *current = Some(storage.clone());
    }
}

fn configured_storage() -> Result<Storage, String> {
    VAULT_STORAGE
        .read()
        .map_err(|_| "Codex credential storage is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Codex credential storage is unavailable".to_string())
}

/// Start the official device-code flow. This sends only to OpenAI's fixed auth issuer.
pub async fn begin(config: &AiConfig) -> Result<CodexAuthBeginResponse, String> {
    if !matches!(config.provider, AiProvider::OpenaiCodex) {
        return Err("Codex subscription authorization requires provider openai-codex".to_string());
    }
    let proxy = ProxySettings::from(config);
    let client = build_client(&proxy, 30)?;
    let endpoint = format!("{CODEX_AUTH_ISSUER}/api/accounts/deviceauth/usercode");
    let response = client
        .post(endpoint)
        .json(&json!({ "client_id": CODEX_CLIENT_ID }))
        .send()
        .await
        .map_err(|_| "Could not reach the Codex authorization service".to_string())?;
    if !response.status().is_success() {
        return Err(safe_http_error("Codex device-code request", response.status().as_u16()));
    }
    let reply: UserCodeResponse = response
        .json()
        .await
        .map_err(|_| "The Codex authorization service returned an invalid device-code response".to_string())?;
    if reply.device_auth_id.trim().is_empty() || reply.user_code.trim().is_empty() {
        return Err("The Codex authorization service returned an invalid device-code response".to_string());
    }
    let interval_seconds = parse_interval(&reply.interval);
    let now = Utc::now().timestamp();
    let expires_at = now + DEVICE_SESSION_TTL_SECS;
    let session_id = Uuid::new_v4().to_string();
    let session = DeviceSession {
        device_auth_id: reply.device_auth_id,
        user_code: reply.user_code.clone(),
        expires_at,
        issuer: CODEX_AUTH_ISSUER.to_string(),
        proxy,
        state: SessionState::Pending,
    };
    insert_session(session_id.clone(), session).await;
    Ok(CodexAuthBeginResponse {
        session_id,
        user_code: reply.user_code,
        verification_url: CODEX_DEVICE_VERIFICATION_URL.to_string(),
        interval_seconds,
        expires_at: chrono::DateTime::from_timestamp(expires_at, 0)
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(SecondsFormat::Secs, true),
    })
}

async fn insert_session(session_id: String, session: DeviceSession) {
    let now = Utc::now().timestamp();
    let mut sessions = DEVICE_SESSIONS.write().await;
    let existing_ids = sessions.keys().cloned().collect::<Vec<_>>();
    for id in existing_ids {
        let Some(record) = sessions.get(&id).cloned() else {
            continue;
        };
        let mut stored = record.session.lock().await;
        if stored.expires_at <= now && matches!(stored.state, SessionState::Pending) {
            record.cancel.cancel();
            stored.state = SessionState::Expired;
            stored.device_auth_id.clear();
            stored.user_code.clear();
        }
        if stored.expires_at.saturating_add(DEVICE_SESSION_TTL_SECS) <= now {
            record.cancel.cancel();
            if matches!(stored.state, SessionState::Pending) {
                stored.state = SessionState::Cancelled;
                stored.device_auth_id.clear();
                stored.user_code.clear();
            }
            drop(stored);
            sessions.remove(&id);
        }
    }

    // Always enforce the cap, including when all retained records are still pending. Evict the
    // earliest-expiring session and signal cancellation before waiting on its session lock.
    while sessions.len() >= MAX_DEVICE_SESSIONS {
        let mut oldest: Option<(i64, String)> = None;
        for (id, record) in sessions.iter() {
            let expires_at = record.session.lock().await.expires_at;
            if oldest.as_ref().is_none_or(|(oldest_expiry, _)| expires_at < *oldest_expiry) {
                oldest = Some((expires_at, id.clone()));
            }
        }
        let Some((_, oldest_id)) = oldest else {
            break;
        };
        if let Some(record) = sessions.remove(&oldest_id) {
            record.cancel.cancel();
            let mut stored = record.session.lock().await;
            if matches!(stored.state, SessionState::Pending) {
                stored.state = SessionState::Cancelled;
                stored.device_auth_id.clear();
                stored.user_code.clear();
            }
        }
    }

    sessions.insert(
        session_id,
        std::sync::Arc::new(DeviceSessionRecord { session: Mutex::new(session), cancel: CancellationToken::new() }),
    );
}

fn parse_interval(value: &serde_json::Value) -> u64 {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.trim().parse::<u64>().ok())).unwrap_or(5).clamp(1, 60)
}

/// Perform one non-blocking device-token poll. The caller schedules subsequent polls.
pub async fn poll(storage: &Storage, session_id: &str) -> Result<CodexAuthPollResponse, String> {
    poll_with_issuer(storage, session_id, None).await
}

async fn poll_with_issuer(
    storage: &Storage,
    session_id: &str,
    issuer_override_for_tests: Option<&str>,
) -> Result<CodexAuthPollResponse, String> {
    let Some(session) = DEVICE_SESSIONS.read().await.get(session_id).cloned() else {
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    };
    let cancellation = session.cancel.clone();
    let mut session = session.session.lock().await;
    if cancellation.is_cancelled() {
        let account_id = match &session.state {
            SessionState::Authorized { oauth_account_id } => Some(oauth_account_id.clone()),
            _ => None,
        };
        session.state = SessionState::Cancelled;
        session.device_auth_id.clear();
        session.user_code.clear();
        drop(session);
        if let Some(account_id) = account_id {
            let _vault_lock = TOKEN_REFRESH_LOCK.lock().await;
            storage.delete_state(&vault_key(&account_id)).await?;
        }
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }
    match &session.state {
        SessionState::Authorized { oauth_account_id } => {
            return Ok(poll_result(CodexAuthPollStatus::Authorized, Some(oauth_account_id.clone())));
        }
        SessionState::Expired | SessionState::Cancelled => {
            return Ok(poll_result(CodexAuthPollStatus::Expired, None));
        }
        SessionState::Pending => {}
    }
    if cancellation.is_cancelled() || Utc::now().timestamp() >= session.expires_at {
        session.state = if cancellation.is_cancelled() { SessionState::Cancelled } else { SessionState::Expired };
        session.device_auth_id.clear();
        session.user_code.clear();
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }

    let issuer = issuer_override_for_tests.unwrap_or(&session.issuer).trim_end_matches('/').to_string();
    let client = build_client(&session.proxy, 30)?;
    let poll_url = format!("{issuer}/api/accounts/deviceauth/token");
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            session.state = SessionState::Cancelled;
            return Ok(poll_result(CodexAuthPollStatus::Expired, None));
        }
        response = client.post(poll_url).json(&json!({
            "device_auth_id": session.device_auth_id,
            "user_code": session.user_code,
        })).send() => response.map_err(|_| "Could not reach the Codex authorization service".to_string())?,
    };
    if cancellation.is_cancelled() {
        session.state = SessionState::Cancelled;
        session.device_auth_id.clear();
        session.user_code.clear();
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }
    if matches!(response.status().as_u16(), 403 | 404) {
        return Ok(poll_result(CodexAuthPollStatus::Pending, None));
    }
    if !response.status().is_success() {
        return Err(safe_http_error("Codex device authorization", response.status().as_u16()));
    }
    let code: DeviceTokenResponse = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            session.state = SessionState::Cancelled;
            session.device_auth_id.clear();
            session.user_code.clear();
            return Ok(poll_result(CodexAuthPollStatus::Expired, None));
        }
        code = response.json() => code
            .map_err(|_| "The Codex authorization service returned an invalid authorization response".to_string())?,
    };
    if code.authorization_code.is_empty() || code.code_challenge.is_empty() || code.code_verifier.is_empty() {
        return Err("The Codex authorization service returned an invalid authorization response".to_string());
    }
    if cancellation.is_cancelled() {
        session.state = SessionState::Cancelled;
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }

    let tokens = tokio::select! {
        _ = cancellation.cancelled() => {
            session.state = SessionState::Cancelled;
            return Ok(poll_result(CodexAuthPollStatus::Expired, None));
        }
        tokens = exchange_device_code(&client, &issuer, &code.authorization_code, &code.code_verifier) => tokens?,
    };
    if cancellation.is_cancelled() {
        session.state = SessionState::Cancelled;
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }
    let account_id = Uuid::new_v4().to_string();
    let stored = StoredTokens {
        chatgpt_account_id: tokens
            .id_token
            .as_deref()
            .and_then(account_id_from_jwt)
            .or_else(|| account_id_from_jwt(&tokens.access_token)),
        access_expires_at: token_expiry(&tokens.access_token, tokens.expires_in),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
    };
    let _vault_write = tokio::select! {
        _ = cancellation.cancelled() => {
            session.state = SessionState::Cancelled;
            return Ok(poll_result(CodexAuthPollStatus::Expired, None));
        }
        guard = TOKEN_REFRESH_LOCK.lock() => guard,
    };
    save_tokens(storage, &account_id, &stored).await?;
    drop(_vault_write);
    // Cancellation is signaled before cancel() waits for this lock. Recheck after the write so
    // a concurrent unmount removes the just-written record before returning an authorized poll.
    if cancellation.is_cancelled() {
        let _ = storage.delete_state(&vault_key(&account_id)).await;
        session.state = SessionState::Cancelled;
        return Ok(poll_result(CodexAuthPollStatus::Expired, None));
    }
    session.state = SessionState::Authorized { oauth_account_id: account_id.clone() };
    session.device_auth_id.clear();
    session.user_code.clear();
    Ok(poll_result(CodexAuthPollStatus::Authorized, Some(account_id)))
}

fn poll_result(status: CodexAuthPollStatus, oauth_account_id: Option<String>) -> CodexAuthPollResponse {
    CodexAuthPollResponse { status, oauth_account_id }
}

async fn exchange_device_code(
    client: &reqwest::Client,
    issuer: &str,
    authorization_code: &str,
    code_verifier: &str,
) -> Result<OAuthTokensResponse, String> {
    let endpoint = format!("{}/oauth/token", issuer.trim_end_matches('/'));
    let redirect_uri = format!("{}/deviceauth/callback", issuer.trim_end_matches('/'));
    let response = client
        .post(endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", authorization_code),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|_| "Could not reach the Codex token service".to_string())?;
    if !response.status().is_success() {
        return Err(safe_http_error("Codex token exchange", response.status().as_u16()));
    }
    let tokens: OAuthTokensResponse = response
        .json()
        .await
        .map_err(|_| "The Codex token service returned an invalid credential response".to_string())?;
    if tokens.access_token.is_empty() || tokens.refresh_token.is_empty() {
        return Err("The Codex token service returned an incomplete credential response".to_string());
    }
    Ok(tokens)
}

/// Cancel a pending session. If a poll completed at the same time, remove its just-created vault
/// entry too. The session remains as a short-lived tombstone so late polls cannot revive it.
pub async fn cancel(storage: &Storage, session_id: &str) -> Result<CodexAuthActionResponse, String> {
    let Some(session) = DEVICE_SESSIONS.read().await.get(session_id).cloned() else {
        return Ok(action_result(true, false));
    };
    // Cancel before acquiring the data mutex so a poll holding it in HTTP I/O is interrupted.
    session.cancel.cancel();
    let account_id = {
        let mut session = session.session.lock().await;
        let account_id = match &session.state {
            SessionState::Authorized { oauth_account_id } => Some(oauth_account_id.clone()),
            _ => None,
        };
        session.state = SessionState::Cancelled;
        session.device_auth_id.clear();
        session.user_code.clear();
        account_id
    };
    if let Some(account_id) = account_id {
        let _refresh = TOKEN_REFRESH_LOCK.lock().await;
        storage.delete_state(&vault_key(&account_id)).await?;
    }
    Ok(action_result(true, false))
}

pub async fn status(storage: &Storage, oauth_account_id: &str) -> Result<CodexAuthStatusResponse, String> {
    validate_account_id(oauth_account_id)?;
    let _vault_lock = TOKEN_REFRESH_LOCK.lock().await;
    let authenticated = load_tokens(storage, oauth_account_id).await?.is_some();
    Ok(CodexAuthStatusResponse { authenticated, account_label: None })
}

pub async fn disconnect(storage: &Storage, oauth_account_id: &str) -> Result<CodexAuthActionResponse, String> {
    validate_account_id(oauth_account_id)?;
    let _refresh = TOKEN_REFRESH_LOCK.lock().await;
    let key = vault_key(oauth_account_id);
    let removed = storage.load_state(&key).await?.is_some();
    storage.delete_state(&key).await?;
    Ok(action_result(false, removed))
}

fn action_result(canceled: bool, disconnected: bool) -> CodexAuthActionResponse {
    CodexAuthActionResponse { canceled, disconnected }
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    Uuid::parse_str(account_id).map(|_| ()).map_err(|_| "Invalid Codex OAuth account id".to_string())
}

fn vault_key(account_id: &str) -> String {
    format!("{VAULT_STATE_PREFIX}{account_id}")
}

/// Keep the vault encryption key outside SQLite. On Unix it is owner-readable only; on
/// Windows the key inherits the per-user app-data directory ACL. This protects a copied DB,
/// but not a copy of the entire app-data directory or a compromised logged-in user account.
fn load_or_create_vault_key(storage: &Storage) -> Result<String, String> {
    let data_dir = storage.data_dir();
    std::fs::create_dir_all(data_dir).map_err(|_| "Unable to initialize Codex credential storage".to_string())?;
    let path = data_dir.join(VAULT_KEY_FILE_NAME);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    match options.open(&path) {
        Ok(mut file) => {
            let mut key = Vec::with_capacity(VAULT_KEY_SIZE);
            key.extend_from_slice(Uuid::new_v4().as_bytes());
            key.extend_from_slice(Uuid::new_v4().as_bytes());
            if file.write_all(&key).is_err() || file.sync_all().is_err() {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err("Unable to initialize Codex credential encryption".to_string());
            }
            Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|_| "Unable to load Codex credential encryption".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("Codex credential encryption file is invalid".to_string());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::{MetadataExt, PermissionsExt};
                if metadata.mode() & 0o777 != 0o600 {
                    let mut permissions = metadata.permissions();
                    permissions.set_mode(0o600);
                    std::fs::set_permissions(&path, permissions)
                        .map_err(|_| "Unable to protect Codex credential encryption".to_string())?;
                }
            }
            // create_new claims the key path atomically; a concurrent process may still be
            // writing its 32-byte key, so briefly wait for the complete file before failing.
            for _ in 0..50 {
                let key = std::fs::read(&path).map_err(|_| "Unable to load Codex credential encryption".to_string())?;
                if key.len() == VAULT_KEY_SIZE {
                    return Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err("Codex credential encryption file is invalid".to_string())
        }
        Err(_) => Err("Unable to initialize Codex credential encryption".to_string()),
    }
}

async fn save_tokens(storage: &Storage, account_id: &str, tokens: &StoredTokens) -> Result<(), String> {
    let passphrase = load_or_create_vault_key(storage)?;
    let plaintext = serde_json::to_vec(tokens).map_err(|_| "Unable to persist Codex credentials".to_string())?;
    let encrypted = EncryptedPayload::encrypt(&plaintext, &passphrase)
        .map_err(|_| "Unable to encrypt Codex credentials at rest".to_string())?;
    let bytes = serde_json::to_vec(&encrypted).map_err(|_| "Unable to persist Codex credentials".to_string())?;
    storage.save_state(&vault_key(account_id), &bytes, VAULT_CONTENT_TYPE).await
}

async fn load_tokens(storage: &Storage, account_id: &str) -> Result<Option<StoredTokens>, String> {
    let Some((bytes, _)) = storage.load_state(&vault_key(account_id)).await? else {
        return Ok(None);
    };
    let payload: EncryptedPayload =
        serde_json::from_slice(&bytes).map_err(|_| "Stored Codex credentials are unreadable".to_string())?;
    let passphrase = load_or_create_vault_key(storage)?;
    let plaintext =
        payload.decrypt(&passphrase).map_err(|_| "Stored Codex credentials could not be decrypted".to_string())?;
    serde_json::from_slice(&plaintext).map(Some).map_err(|_| "Stored Codex credentials are unreadable".to_string())
}

/// Obtain a valid bearer token for the selected opaque account id, refreshing and persisting
/// rotated tokens when access is near expiry. `rejected_access_token` forces refresh after 401,
/// but does not repeat a refresh already committed by another in-process request.
pub async fn access_token(config: &AiConfig, rejected_access_token: Option<&str>) -> Result<CodexAccessToken, String> {
    let storage = configured_storage()?;
    access_token_with_storage(config, &storage, rejected_access_token, CODEX_AUTH_ISSUER).await
}

async fn access_token_with_storage(
    config: &AiConfig,
    storage: &Storage,
    rejected_access_token: Option<&str>,
    issuer: &str,
) -> Result<CodexAccessToken, String> {
    let _refresh = TOKEN_REFRESH_LOCK.lock().await;
    let account_id = config
        .oauth_account_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "Sign in to ChatGPT to use the Codex subscription provider".to_string())?;
    validate_account_id(account_id)?;
    let current = load_tokens(storage, account_id)
        .await?
        .ok_or_else(|| "This Codex account is disconnected; sign in again".to_string())?;
    if token_is_fresh(&current) && rejected_access_token.is_none_or(|rejected| rejected != current.access_token) {
        return Ok(CodexAccessToken { bearer: current.access_token, chatgpt_account_id: current.chatgpt_account_id });
    }

    let mut current = load_tokens(storage, account_id)
        .await?
        .ok_or_else(|| "This Codex account is disconnected; sign in again".to_string())?;
    if token_is_fresh(&current) && rejected_access_token.is_none_or(|rejected| rejected != current.access_token) {
        return Ok(CodexAccessToken { bearer: current.access_token, chatgpt_account_id: current.chatgpt_account_id });
    }
    let proxy = ProxySettings::from(config);
    let client = build_client(&proxy, 30)?;
    let refreshed = refresh_tokens_at(&client, issuer, &current.refresh_token).await?;
    current.access_expires_at = token_expiry(&refreshed.access_token, refreshed.expires_in);
    current.access_token = refreshed.access_token;
    if let Some(refresh_token) = refreshed.refresh_token.filter(|token| !token.is_empty()) {
        current.refresh_token = refresh_token;
    }
    current.chatgpt_account_id = refreshed
        .id_token
        .as_deref()
        .and_then(account_id_from_jwt)
        .or_else(|| account_id_from_jwt(&current.access_token))
        .or(current.chatgpt_account_id);
    if let Some(id_token) = refreshed.id_token.filter(|token| !token.is_empty()) {
        current.id_token = Some(id_token);
    }
    save_tokens(storage, account_id, &current).await?;
    Ok(CodexAccessToken { bearer: current.access_token, chatgpt_account_id: current.chatgpt_account_id })
}

async fn refresh_tokens_at(
    client: &reqwest::Client,
    issuer: &str,
    refresh_token: &str,
) -> Result<OAuthRefreshResponse, String> {
    let response = client
        .post(format!("{}/oauth/token", issuer.trim_end_matches('/')))
        .json(&json!({
            "grant_type": "refresh_token",
            "client_id": CODEX_CLIENT_ID,
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .map_err(|_| "Could not reach the Codex token service".to_string())?;
    if !response.status().is_success() {
        return Err(safe_http_error("Codex token refresh", response.status().as_u16()));
    }
    let refreshed: OAuthRefreshResponse = response
        .json()
        .await
        .map_err(|_| "The Codex token service returned an invalid refresh response".to_string())?;
    if refreshed.access_token.is_empty() {
        return Err("The Codex token service returned an incomplete refresh response".to_string());
    }
    Ok(refreshed)
}

fn token_is_fresh(tokens: &StoredTokens) -> bool {
    tokens.access_expires_at > Utc::now().timestamp() + 60
}

fn token_expiry(access_token: &str, expires_in: Option<i64>) -> i64 {
    jwt_expiry(access_token).unwrap_or_else(|| Utc::now().timestamp() + expires_in.unwrap_or(3600).clamp(60, 86_400))
}

fn jwt_payload(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn jwt_expiry(token: &str) -> Option<i64> {
    jwt_payload(token)?.get("exp")?.as_i64()
}

fn account_id_from_jwt(token: &str) -> Option<String> {
    let claims = jwt_payload(token)?;
    claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .or_else(|| claims.get("chatgpt_account_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
}

fn safe_http_error(operation: &str, status: u16) -> String {
    format!("{operation} failed (HTTP {status})")
}

pub fn build_responses_client(config: &AiConfig, timeout_secs: u64) -> Result<reqwest::Client, String> {
    build_client(&ProxySettings::from(config), timeout_secs)
}

fn build_client(proxy: &ProxySettings, timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none());
    if proxy.enabled && !proxy.url.trim().is_empty() {
        let proxy_url = if proxy.url.contains("://") {
            proxy.url.trim().to_string()
        } else {
            format!("http://{}", proxy.url.trim())
        };
        builder =
            builder.proxy(reqwest::Proxy::all(&proxy_url).map_err(|_| "Invalid Codex proxy settings".to_string())?);
    }
    builder.build().map_err(|_| "Unable to initialize the Codex network client".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;
    use serde_json::Value;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct MockReply {
        status: u16,
        reason: &'static str,
        body: String,
        delay_millis: u64,
    }

    async fn mock_server(replies: Vec<MockReply>) -> (String, tokio::task::JoinHandle<Vec<(String, String)>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut captured = Vec::new();
            for reply in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                };
                let headers = String::from_utf8_lossy(&request[..head_end]).to_string();
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while request.len() < head_end + content_length {
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                let body = String::from_utf8_lossy(&request[head_end..head_end + content_length]).to_string();
                if reply.delay_millis > 0 {
                    tokio::time::sleep(Duration::from_millis(reply.delay_millis)).await;
                }
                let response = format!(
                    "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    reply.status,
                    reply.reason,
                    reply.body.len(),
                    reply.body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                captured.push((headers, body));
            }
            captured
        });
        (format!("http://{address}"), task)
    }

    async fn test_storage() -> (tempfile::TempDir, Storage) {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::open(&directory.path().join("test.db")).await.unwrap();
        (directory, storage)
    }

    fn test_config() -> AiConfig {
        AiConfig {
            provider: AiProvider::OpenaiCodex,
            api_key: String::new(),
            auth_method: Default::default(),
            endpoint: String::new(),
            model: "gpt-5-codex".to_string(),
            models: Vec::new(),
            api_style: Default::default(),
            proxy_enabled: false,
            proxy_url: String::new(),
            enable_thinking: true,
            reasoning_level: Default::default(),
            runtime_effort: None,
            context_window: None,
            max_retries: None,
            codex_cli_path: None,
            codex_cli_env: HashMap::new(),
            claude_code_cli_path: None,
            claude_code_cli_env: HashMap::new(),
            pi_agent_cli_path: None,
            pi_agent_cli_env: HashMap::new(),
            agent_permission_level: Default::default(),
            oauth_account_id: None,
        }
    }

    #[test]
    fn stored_credentials_debug_output_is_redacted() {
        let stored = StoredTokens {
            access_token: "secret-access".into(),
            refresh_token: "secret-refresh".into(),
            id_token: Some("secret-id".into()),
            chatgpt_account_id: None,
            access_expires_at: 0,
        };
        let debug = format!("{stored:?}");
        assert!(debug.contains("redacted"));
        assert!(!debug.contains("secret-"));
    }

    #[test]
    fn parses_official_device_code_interval_as_string_or_integer() {
        assert_eq!(parse_interval(&json!("5")), 5);
        assert_eq!(parse_interval(&json!(0)), 1);
        assert_eq!(parse_interval(&json!(120)), 60);
    }

    #[tokio::test]
    async fn device_auth_sends_official_fields_and_never_includes_upstream_error_body() {
        let (base, server) = mock_server(vec![MockReply {
            status: 503,
            reason: "Unavailable",
            body: r#"{"error":"do-not-leak-this-secret"}"#.to_string(),
            delay_millis: 0,
        }])
        .await;
        let config = test_config();
        let proxy = ProxySettings::from(&config);
        let client = build_client(&proxy, 5).unwrap();
        let response = client
            .post(format!("{base}/api/accounts/deviceauth/usercode"))
            .json(&json!({ "client_id": CODEX_CLIENT_ID }))
            .send()
            .await
            .unwrap();
        let err = safe_http_error("Codex device-code request", response.status().as_u16());
        let captured = server.await.unwrap();
        let request: Value = serde_json::from_str(&captured[0].1).unwrap();
        assert_eq!(request["client_id"], CODEX_CLIENT_ID);
        assert!(!err.contains("do-not-leak-this-secret"));
        assert!(err.contains("HTTP 503"));
    }

    #[tokio::test]
    async fn device_poll_exchange_persists_encrypted_tokens_and_cancel_removes_them() {
        let (directory, storage) = test_storage().await;
        let token_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "exp": Utc::now().timestamp() + 3600,
                "https://api.openai.com/auth": { "chatgpt_account_id": "workspace-123" }
            }))
            .unwrap(),
        );
        let access = format!("eyJhbGciOiJub25lIn0.{token_payload}.sig");
        let body =
            format!(r#"{{"access_token":"{access}","refresh_token":"refresh-secret-value","id_token":"{access}"}}"#);
        let (issuer, server) = mock_server(vec![
            MockReply {
                status: 200,
                reason: "OK",
                body: r#"{"authorization_code":"auth-code-value","code_challenge":"challenge-value","code_verifier":"verifier-value"}"#.to_string(),
                delay_millis: 0,
            },
            MockReply { status: 200, reason: "OK", body, delay_millis: 0 },
        ])
        .await;
        let session_id = Uuid::new_v4().to_string();
        let session = DeviceSession {
            device_auth_id: "device-id-secret".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            expires_at: Utc::now().timestamp() + 900,
            issuer: issuer.clone(),
            proxy: ProxySettings { enabled: false, url: String::new() },
            state: SessionState::Pending,
        };
        DEVICE_SESSIONS.write().await.insert(
            session_id.clone(),
            std::sync::Arc::new(DeviceSessionRecord { session: Mutex::new(session), cancel: CancellationToken::new() }),
        );
        let result = poll_with_issuer(&storage, &session_id, None).await.unwrap();
        assert_eq!(result.status, CodexAuthPollStatus::Authorized);
        let account_id = result.oauth_account_id.unwrap();
        let stored_raw = storage.load_state(&vault_key(&account_id)).await.unwrap().unwrap().0;
        assert!(!String::from_utf8_lossy(&stored_raw).contains("refresh-secret-value"));
        let key_path = directory.path().join(VAULT_KEY_FILE_NAME);
        let key_bytes = std::fs::read(&key_path).unwrap();
        assert_eq!(key_bytes.len(), VAULT_KEY_SIZE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let tokens = load_tokens(&storage, &account_id).await.unwrap().unwrap();
        assert_eq!(tokens.refresh_token, "refresh-secret-value");
        assert_eq!(tokens.chatgpt_account_id.as_deref(), Some("workspace-123"));
        let captured = server.await.unwrap();
        let token_request_headers = &captured[1].0;
        let token_request_body = &captured[1].1;
        assert!(token_request_headers.to_ascii_lowercase().contains("application/x-www-form-urlencoded"));
        assert!(token_request_body.contains("grant_type=authorization_code"));
        assert!(token_request_body.contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
        assert!(token_request_body.contains("code_verifier=verifier-value"));
        assert!(
            token_request_body.contains("deviceauth%2Fcallback") || token_request_body.contains("deviceauth/callback")
        );
        let canceled = cancel(&storage, &session_id).await.unwrap();
        assert!(canceled.canceled);
        assert!(storage.load_state(&vault_key(&account_id)).await.unwrap().is_none());
        assert!(directory.path().exists());
    }

    #[tokio::test]
    async fn refresh_persists_rotated_refresh_token_without_echoing_service_error() {
        let (_directory, storage) = test_storage().await;
        let account_id = Uuid::new_v4().to_string();
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({ "exp": Utc::now().timestamp() + 7200 })).unwrap());
        save_tokens(
            &storage,
            &account_id,
            &StoredTokens {
                access_token: "old-access".to_string(),
                refresh_token: "old-refresh-secret".to_string(),
                id_token: None,
                chatgpt_account_id: None,
                access_expires_at: 0,
            },
        )
        .await
        .unwrap();
        let new_access = format!("eyJhbGciOiJub25lIn0.{payload}.sig");
        let refresh_body = format!(r#"{{"access_token":"{new_access}","refresh_token":"rotated-refresh-token"}}"#);
        let (issuer, server) =
            mock_server(vec![MockReply { status: 200, reason: "OK", body: refresh_body, delay_millis: 0 }]).await;
        let proxy = ProxySettings { enabled: false, url: String::new() };
        let client = build_client(&proxy, 5).unwrap();
        let refreshed = refresh_tokens_at(&client, &issuer, "old-refresh-secret").await.unwrap();
        let stored = StoredTokens {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token.unwrap(),
            id_token: refreshed.id_token,
            chatgpt_account_id: None,
            access_expires_at: Utc::now().timestamp() + 7000,
        };
        save_tokens(&storage, &account_id, &stored).await.unwrap();
        let persisted = load_tokens(&storage, &account_id).await.unwrap().unwrap();
        assert_eq!(persisted.refresh_token, "rotated-refresh-token");
        let captured = server.await.unwrap();
        let body: Value = serde_json::from_str(&captured[0].1).unwrap();
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["client_id"], CODEX_CLIENT_ID);
        assert_eq!(body["refresh_token"], "old-refresh-secret");
    }

    #[tokio::test]
    async fn cancel_interrupts_partial_device_token_json_body() {
        let (_directory, storage) = test_storage().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (headers_sent, response_started) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
            }

            let body = r#"{"authorization_code":"auth-code","code_challenge":"challenge","code_verifier":"verifier"}"#;
            let split = 12;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(&body.as_bytes()[..split]).await.unwrap();
            socket.flush().await.unwrap();
            let _ = headers_sent.send(());
            tokio::time::sleep(Duration::from_secs(3)).await;
            let _ = socket.write_all(&body.as_bytes()[split..]).await;
        });

        let session_id = Uuid::new_v4().to_string();
        DEVICE_SESSIONS.write().await.insert(
            session_id.clone(),
            std::sync::Arc::new(DeviceSessionRecord {
                session: Mutex::new(DeviceSession {
                    device_auth_id: "device-id".to_string(),
                    user_code: "ABCD-EFGH".to_string(),
                    expires_at: Utc::now().timestamp() + 900,
                    issuer: format!("http://{address}"),
                    proxy: ProxySettings { enabled: false, url: String::new() },
                    state: SessionState::Pending,
                }),
                cancel: CancellationToken::new(),
            }),
        );
        let storage_for_poll = storage.clone();
        let poll_session_id = session_id.clone();
        let polling = tokio::spawn(async move { poll_with_issuer(&storage_for_poll, &poll_session_id, None).await });
        response_started.await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let canceled = tokio::time::timeout(Duration::from_secs(1), cancel(&storage, &session_id))
            .await
            .expect("cancel should interrupt response-body decoding")
            .unwrap();
        assert!(canceled.canceled);
        assert_eq!(polling.await.unwrap().unwrap().status, CodexAuthPollStatus::Expired);
        server.abort();
    }

    #[tokio::test]
    async fn disconnect_reports_whether_encrypted_account_data_was_removed() {
        let (_directory, storage) = test_storage().await;
        let account_id = Uuid::new_v4().to_string();
        save_tokens(
            &storage,
            &account_id,
            &StoredTokens {
                access_token: "access-secret".to_string(),
                refresh_token: "refresh-secret".to_string(),
                id_token: None,
                chatgpt_account_id: Some("workspace-from-jwt".to_string()),
                access_expires_at: Utc::now().timestamp() + 3600,
            },
        )
        .await
        .unwrap();
        assert!(disconnect(&storage, &account_id).await.unwrap().disconnected);
        assert!(!disconnect(&storage, &account_id).await.unwrap().disconnected);
        assert!(load_tokens(&storage, &account_id).await.unwrap().is_none());
    }

    #[test]
    fn account_id_validation_rejects_non_opaque_ids() {
        assert!(validate_account_id("../secrets").is_err());
        assert!(validate_account_id(&Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn codex_http_client_does_not_follow_redirects() {
        let client = build_client(&ProxySettings { enabled: false, url: String::new() }, 5).unwrap();
        let _client: reqwest::Client = client;
    }
}
