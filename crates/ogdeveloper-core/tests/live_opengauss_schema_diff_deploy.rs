//! Live end-to-end coverage for the Schema Diff deploy path (the desktop "Deploy" button).
//!
//! Two properties are asserted against a real openGauss instance:
//!
//! 1. `SchemaDiffDeployResult` carries the `status` the desktop renderer switches on. That contract
//!    is invisible to the type checker (`invoke` returns `unknown`), so a rename on either side is
//!    only caught by exercising the real call and reading the real JSON.
//! 2. A failed deploy leaves no partial DDL behind and leaves the pooled connection usable. The
//!    native pool recycles connections with `RecyclingMethod::Fast`, which issues no clean-up query,
//!    so a transaction left open on failure previously poisoned the next checkout with SQLSTATE
//!    25P02 ("current transaction is aborted").
//!
//! Run with a desktop data directory that already holds an openGauss connection:
//!
//! ```text
//! DBX_TEST_OPENGAUSS_DATA_DIR="%APPDATA%\com.ogdeveloper.app" \
//! DBX_TEST_OPENGAUSS_DATABASE=test_b \
//!   cargo test -p ogdeveloper-core --no-default-features \
//!     --test live_opengauss_schema_diff_deploy -- --ignored --nocapture
//! ```
//!
//! The test only creates and drops its own uniquely named schema. It never touches existing objects,
//! and it copies the connection database to a temporary file so the desktop's own storage is left
//! untouched.

#![allow(clippy::print_stdout)]

use std::path::Path;

use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::query::{execute_schema_diff_deploy, execute_statements};
use ogdeveloper_core::storage::Storage;

/// The connection database is copied before it is opened: `Storage::open` runs schema migrations,
/// and a test must never migrate the desktop's live profile.
async fn app_state_from_data_dir(data_dir: &Path) -> (AppState, ConnectionConfig, tempfile::TempDir) {
    let temp = tempfile::tempdir().expect("temp dir");
    let db_path = ogdeveloper_core::storage::storage_db_path(data_dir);
    assert!(db_path.exists(), "connection database not found at {}", db_path.display());
    let copied_db = temp.path().join("connections.db");
    std::fs::copy(&db_path, &copied_db).expect("copy connection database");

    let storage = Storage::open(&copied_db).await.expect("open storage");
    let configs = storage.load_connections().await.expect("load connections");
    let config = configs
        .into_iter()
        .find(|config| config.db_type == ogdeveloper_core::models::connection::DatabaseType::OpenGauss)
        .expect("data directory must contain a saved openGauss connection");

    // The JDBC plugin lives next to the connection database, so read it from the real data dir while
    // keeping the storage copy isolated.
    // Stage a freshly packaged plugin outside the live profile for validation.
    let plugin_dir = std::env::var_os("DBX_TEST_OPENGAUSS_PLUGIN_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data_dir.join("plugins"));
    let state = AppState::new_with_plugin_dir(storage, plugin_dir);
    (state, config, temp)
}

/// Same endpoint and credentials, but without the JDBC driver profile, so the pool is the native
/// `tokio-postgres` one where the rollback fix lives.
fn native_variant(config: &ConnectionConfig) -> ConnectionConfig {
    let mut native = config.clone();
    native.driver_profile = None;
    native.driver_label = None;
    native.jdbc_driver_class = None;
    native.jdbc_driver_paths = Vec::new();
    native.connection_string = None;
    native
}

async fn register(state: &AppState, id: &str, config: &ConnectionConfig, database: &str) {
    state.configs.write().await.insert(id.to_string(), config.clone());
    state.get_or_create_pool(id, Some(database)).await.expect("create pool");
}

fn failed_deploy_statements(schema: &str) -> Vec<String> {
    vec![
        // A name the success case never uses: reusing it would make this first statement fail on
        // "already exists", and then nothing would have been applied to roll back.
        format!("CREATE SCHEMA {schema}"),
        // Succeeds, and must not survive the deploy: a rolled back transaction has to undo it.
        format!("CREATE TABLE {schema}.partial_probe (value integer NOT NULL)"),
        "CREAT TABLE this is not valid sql".to_string(),
    ]
}

async fn schema_exists(state: &AppState, id: &str, database: &str, schema: &str) -> bool {
    let sql = format!("SELECT count(*) AS present FROM information_schema.schemata WHERE schema_name = '{schema}'");
    let results = execute_statements(state, id, database, &[sql], None, None).await.expect("schema probe query");
    let rows = &results[0].rows;
    // A poisoned connection fails here with SQLSTATE 25P02 instead of returning a row.
    rows.first().and_then(|row| row.first()).and_then(|value| value.as_i64()).unwrap_or(-1) > 0
}

async fn assert_deploy_contract(state: &AppState, id: &str, database: &str, label: &str) {
    // Identifiers stay unquoted on purpose: the quoting character is compatibility-mode dependent
    // (double quote in A/PG, backtick in B/M), so a fixture that hardcodes one of them would only
    // test that mode. Names are lowercase alphanumerics, which need no quoting anywhere.
    let created_schema = format!("og_sd_ok_{}", uuid::Uuid::new_v4().simple());
    let failed_schema = format!("og_sd_fail_{}", uuid::Uuid::new_v4().simple());

    // ── Success: the status the renderer needs to show the green "Deploy Successful" header.
    let created =
        execute_schema_diff_deploy(state, id, database, &[format!("CREATE SCHEMA {created_schema}")], None, None)
            .await
            .expect("deploy create schema");
    let payload = serde_json::to_value(&created).expect("serialize deploy result");
    println!("[{label}] committed deploy payload: {payload}");
    assert!(created.success);
    assert_eq!(payload["status"], serde_json::json!("committed"));
    assert_eq!(payload["executedStatements"], serde_json::json!(1));
    assert_eq!(payload["totalStatements"], serde_json::json!(1));
    assert_eq!(payload["error"], serde_json::json!(null));

    // ── Failure: the transaction is rolled back, so nothing may remain behind.
    let failed = execute_schema_diff_deploy(state, id, database, &failed_deploy_statements(&failed_schema), None, None)
        .await
        .expect("deploy failing statements");
    let payload = serde_json::to_value(&failed).expect("serialize deploy result");
    println!("[{label}] rolled back deploy payload: {payload}");
    assert!(!failed.success);
    assert_eq!(payload["status"], serde_json::json!("rolled_back"));
    assert_eq!(payload["executedStatements"], serde_json::json!(0));
    assert_eq!(payload["totalStatements"], serde_json::json!(3));
    let reported = failed.error.clone().unwrap_or_default();
    assert!(!reported.trim().is_empty(), "failure must carry the SQL error");
    // The statement text, not just "db error": `tokio_postgres::Error`'s Display drops the server
    // message, so this guards the conversion that recovers it.
    assert!(
        reported.contains("syntax error") || reported.contains("CREAT"),
        "[{label}] deploy error lost the server message: {reported:?}"
    );

    // The first two statements ran before the third one failed, so this is what proves the rollback:
    // no partial DDL survived, and the pooled connection is still usable afterwards.
    assert!(
        !schema_exists(state, id, database, &failed_schema).await,
        "[{label}] the failed deploy left schema {failed_schema} behind; the transaction was not rolled back"
    );

    // ── The connection recovered instead of being handed over mid-transaction.
    let follow_up =
        execute_schema_diff_deploy(state, id, database, &[format!("DROP SCHEMA {created_schema}")], None, None)
            .await
            .expect("deploy drop schema");
    assert!(follow_up.success, "[{label}] connection unusable after a failed deploy: {:?}", follow_up.error);
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and a JDBC plugin with executeTransaction support"]
async fn live_schema_diff_deploy_reports_status_and_rolls_back_over_jdbc() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    assert_eq!(config.db_type, ogdeveloper_core::models::connection::DatabaseType::OpenGauss);

    register(&state, "live-jdbc", &config, &database).await;
    assert_deploy_contract(&state, "live-jdbc", &database, "jdbc").await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR pointing at a desktop data directory with an openGauss connection"]
async fn live_schema_diff_deploy_reports_status_and_rolls_back_over_native_pool() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;

    let native = native_variant(&config);
    assert!(
        !ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&native),
        "native variant must not select the JDBC driver"
    );
    register(&state, "live-native", &native, &database).await;
    assert_deploy_contract(&state, "live-native", &database, "native").await;
}

/// Prints the environment the deploy path sees, so a failure is diagnosable without re-running.
#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR pointing at a desktop data directory with an openGauss connection"]
async fn live_schema_diff_deploy_environment_report() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;

    let connection_id = "live-report";
    register(&state, connection_id, &config, &database).await;
    let info = state.connection_database_info(connection_id, Some(&database)).await.expect("connection database info");

    println!("data dir          : {}", data_dir);
    println!("database          : {database}");
    println!("host:port         : {}:{}", config.host, config.port);
    println!("db_type           : {:?}", config.db_type);
    println!("driver_profile    : {:?}", config.driver_profile);
    println!("uses jdbc driver  : {}", ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&config));
    println!("product           : {:?}", info.as_ref().map(|i| i.product_name.clone()));
    println!("version           : {:?}", info.as_ref().map(|i| i.product_version.clone()));
    println!("sql compatibility : {:?}", info.as_ref().and_then(|i| i.sql_compatibility.clone()));
    println!("current database  : {:?}", info.as_ref().and_then(|i| i.current_database.clone()));

    let databases = execute_statements(
        &state,
        connection_id,
        &database,
        &["SELECT datname FROM pg_database ORDER BY datname".to_string()],
        None,
        None,
    )
    .await
    .expect("list databases");
    let names: Vec<String> = databases[0]
        .rows
        .iter()
        .filter_map(|row| row.first().and_then(|value| value.as_str()).map(str::to_string))
        .collect();
    println!("databases         : {names:?}");
    let catalogs = execute_statements(
        &state, connection_id, &database,
        &["SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname IN ('gs_package', 'pg_job', 'pg_event') ORDER BY 1, 2".to_string()],
        None, None,
    ).await.expect("catalog availability probe");
    println!("mode catalogs     : {:?}", catalogs[0].rows);
}

/// Exercises the same preparation output the desktop deploys, including reverse DDL.
async fn assert_generated_deploy(state: &AppState, id: &str, database: &str) {
    use ogdeveloper_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparationOptions};

    use ogdeveloper_core::types::ColumnInfo;

    let info = state.connection_database_info(id, Some(database)).await.expect("database info").expect("info");
    let mode = info.sql_compatibility.expect("detected compatibility mode");
    let quote = if matches!(mode.as_str(), "B" | "M" | "MYSQL") { '`' } else { '"' };
    let schema = format!("og_sd_gen_{}", uuid::Uuid::new_v4().simple());
    let setup = execute_schema_diff_deploy(state, id, database, &[format!("CREATE SCHEMA {schema}")], None, None)
        .await
        .expect("create fixture schema");
    assert!(setup.success, "{:?}", setup.error);

    // Return an error first so the fixture schema is cleaned up even when a regression fails.
    let outcome: Result<(), String> = async {
        let column = ColumnInfo { name: "select".to_string(), data_type: "integer".to_string(), ..Default::default() };
        let added_column = ColumnInfo { name: "extra value".to_string(), data_type: "integer".to_string(), ..Default::default() };
        let table = serde_json::json!({ "name": "order items", "table_type": "TABLE" });
        let initial_detail = serde_json::json!({ "name": "order items", "columns": [column.clone()] });
        let mut options: SchemaDiffPreparationOptions = serde_json::from_value(serde_json::json!({
            "databaseType": "opengauss", "targetSchema": schema, "targetSqlCompatibility": mode,
            "sourceTables": [table.clone()], "sourceDetails": [initial_detail.clone()], "enableRollback": true
        })).map_err(|e| e.to_string())?;
        let created = prepare_schema_diff(options.clone());
        if !created.sync_sql.contains(&format!("{quote}order items{quote}")) {
            return Err(format!("wrong identifiers in {}: {}", mode, created.sync_sql));
        }
        let run = |sql: &str| vec![sql.to_string()];
        let result = execute_schema_diff_deploy(state, id, database, &run(&created.sync_sql), Some(&schema), None)
            .await.map_err(|e| e.to_string())?;
        if !result.success { return Err(format!("generated CREATE failed: {:?}\n{}", result.error, created.sync_sql)); }

        options.target_tables = options.source_tables.clone();
        options.target_details = options.source_details.clone();
        options.source_details[0].columns.push(added_column);
        options.source_details[0].columns.push(ColumnInfo {
            name: "second value".to_string(), data_type: "integer".to_string(), ..Default::default()
        });
        let altered = prepare_schema_diff(options);
        let result = execute_schema_diff_deploy(state, id, database, &run(&altered.sync_sql), Some(&schema), None)
            .await.map_err(|e| e.to_string())?;
        if !result.success { return Err(format!("generated ALTER failed: {:?}\n{}", result.error, altered.sync_sql)); }
        let probe = format!("SELECT count(*) FROM information_schema.columns WHERE table_schema = '{schema}' AND table_name = 'order items'");
        let count = execute_statements(state, id, database, std::slice::from_ref(&probe), None, None).await?;
        if count[0].rows[0][0].as_i64() != Some(3) { return Err("generated ALTER did not add both columns".to_string()); }

        let rollback = altered.rollback_sync_sql.as_deref().ok_or("missing ALTER rollback")?;
        let result = execute_schema_diff_deploy(state, id, database, &run(rollback), Some(&schema), None)
            .await.map_err(|e| e.to_string())?;
        if !result.success { return Err(format!("generated ALTER rollback failed: {:?}\n{rollback}", result.error)); }
        let count = execute_statements(state, id, database, &[probe], None, None).await?;
        if count[0].rows[0][0].as_i64() != Some(1) { return Err("ALTER rollback did not remove the column".to_string()); }
        let rollback = created.rollback_sync_sql.as_deref().ok_or("missing CREATE rollback")?;
        let result = execute_schema_diff_deploy(state, id, database, &run(rollback), Some(&schema), None)
            .await.map_err(|e| e.to_string())?;
        if !result.success { return Err(format!("generated CREATE rollback failed: {:?}\n{rollback}", result.error)); }
        println!("[{id}] {database} mode {mode}: generated CREATE, ALTER and reverse DDL passed");
        Ok(())
    }.await;
    let cleanup =
        execute_schema_diff_deploy(state, id, database, &[format!("DROP SCHEMA {schema} CASCADE")], None, None)
            .await
            .expect("cleanup fixture schema");
    assert!(cleanup.success, "cleanup failed: {:?}", cleanup.error);
    outcome.expect("generated DDL deploy and rollback");
}

#[tokio::test]
#[ignore = "requires a live openGauss connection and a JDBC plugin with executeTransaction support"]
async fn live_generated_schema_diff_deploys_and_reverses_over_both_drivers() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "test_b".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    register(&state, "generated-native", &native_variant(&config), &database).await;
    assert_generated_deploy(&state, "generated-native", &database).await;
    register(&state, "generated-jdbc", &config, &database).await;
    assert_generated_deploy(&state, "generated-jdbc", &database).await;
}
