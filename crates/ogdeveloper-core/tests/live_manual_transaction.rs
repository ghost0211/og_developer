use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::{ConnectionConfig, DatabaseType};
use ogdeveloper_core::query::{begin_manual_transaction, commit_manual_transaction, execute_in_manual_transaction};
use ogdeveloper_core::storage::Storage;

fn live_config(prefix: &str, db_type: DatabaseType, default_port: u16) -> ConnectionConfig {
    let host = std::env::var(format!("{prefix}_HOST")).expect("live DB host env var");
    let port = std::env::var(format!("{prefix}_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default_port);
    let username = std::env::var(format!("{prefix}_USER")).expect("live DB user env var");
    let password = std::env::var(format!("{prefix}_PASSWORD")).expect("live DB password env var");
    let database = std::env::var(format!("{prefix}_DATABASE")).expect("live DB database env var");

    serde_json::from_value(serde_json::json!({
        "id": format!("manual-txn-{prefix}"),
        "name": format!("Manual transaction {prefix}"),
        "db_type": db_type,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live connection config should deserialize")
}

async fn app_state_with_config(config: ConnectionConfig) -> (AppState, std::path::PathBuf) {
    let db_path = std::env::temp_dir().join(format!("dbx-live-manual-txn-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = Storage::open(&db_path).await.expect("open temp storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);
    (state, db_path)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* env vars pointing at writable PostgreSQL"]
async fn live_manual_transaction_postgres_preserves_typed_selects_and_empty_metadata() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432);
    let database = config.database.clone().expect("database");
    let (state, db_path) = app_state_with_config(config.clone()).await;

    let txn = begin_manual_transaction(&state, &config.id, &database, None).await.expect("begin");
    let typed = execute_in_manual_transaction(
        &state,
        &txn,
        "SELECT 1::int4 AS id, 'pg'::text AS label, true AS ok",
        &database,
        None,
        Some(10),
    )
    .await
    .expect("typed select");
    assert_eq!(typed[0].columns, vec!["id", "label", "ok"]);
    assert_eq!(typed[0].rows, vec![vec![serde_json::json!(1), serde_json::json!("pg"), serde_json::json!(true)]]);

    let empty = execute_in_manual_transaction(
        &state,
        &txn,
        "SELECT 1::int4 AS id, 'empty'::text AS label WHERE false",
        &database,
        None,
        Some(10),
    )
    .await
    .expect("empty select");
    assert_eq!(empty[0].columns, vec!["id", "label"]);
    assert!(empty[0].rows.is_empty());

    commit_manual_transaction(&state, &txn).await.expect("commit");
    let _ = std::fs::remove_file(db_path);
}
