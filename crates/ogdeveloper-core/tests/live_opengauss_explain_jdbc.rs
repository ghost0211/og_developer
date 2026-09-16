//! Live regression for the desktop "Explain Plan" action over the openGauss JDBC driver profile.
//!
//! The desktop runs EXPLAIN through a dedicated client-session pool (`<tabId>:explain`) with no
//! pagination options, which the core dispatches to the JDBC plugin's non-paged `executeQuery`
//! method — unlike the data grid, which always goes through `executeQueryPage`. The plugin's
//! gms_output support probe (`openGaussOutputSupported`) used to wrap the process-wide shared
//! connection in try-with-resources, closing it on the cache-miss path; the outer
//! `conn.createStatement()` then failed with pgjdbc's "This connection has been closed." on the
//! first — and, because the explain pool is shut down after every run, every — Explain click.
//!
//! This test replays that exact request shape against a real openGauss server: a fresh session
//! pool per iteration (fresh plugin JVM, so the probe cache always misses), followed by the
//! session-pool close the store's `finally` block performs.
//!
//! Run with a desktop data directory that already holds an openGauss JDBC-profile connection:
//!
//! ```text
//! $env:DBX_TEST_OPENGAUSS_DATA_DIR = "$env:APPDATA\com.ogdeveloper.app"
//! $env:DBX_TEST_OPENGAUSS_DATABASE = "test_b"
//! $env:DBX_TEST_OPENGAUSS_PLUGIN_DIR = "tmp\explain-live-plugins"   # staged 0.1.30+ package
//! cargo test -p ogdeveloper-core --no-default-features \
//!   --test live_opengauss_explain_jdbc -- --ignored --nocapture
//! ```
//!
//! The connection database is copied to a temporary file before it is opened, so the desktop's
//! own profile is never migrated or mutated.

#![allow(clippy::print_stdout)]

use std::path::Path;

use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::query::{execute_sql_statement_with_options, QueryExecutionOptions};
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

    // Stage a freshly packaged plugin outside the live profile; fall back to the data dir's
    // installed plugin when no staging override is given.
    let plugin_dir = std::env::var_os("DBX_TEST_OPENGAUSS_PLUGIN_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data_dir.join("plugins"));
    let state = AppState::new_with_plugin_dir(storage, plugin_dir);
    (state, config, temp)
}

/// One desktop Explain click: non-paged `executeQuery` on a `<tab>:explain` client session,
/// then the `finally`-block session close. A fresh session id per call forces a brand-new
/// plugin process, so the probe cache-miss path is exercised every time.
async fn explain_once(state: &AppState, id: &str, database: &str, iteration: u32) -> String {
    let client_session_id = format!("live-explain-{iteration}:explain");
    let result = execute_sql_statement_with_options(
        state,
        id,
        database,
        "EXPLAIN (FORMAT JSON) SELECT 1",
        None,
        None,
        QueryExecutionOptions {
            client_session_id: Some(client_session_id.clone()),
            timeout_secs: Some(30),
            ..Default::default()
        },
    )
    .await
    .unwrap_or_else(|err| panic!("explain iteration {iteration} failed: {err}"));

    let closed = state
        .close_client_session_pool(id, Some(database), &client_session_id)
        .await
        .expect("close explain client session pool");
    assert!(closed, "explain session pool must exist to close");

    assert_eq!(result.columns.len(), 1, "EXPLAIN returns a single QUERY PLAN column: {:?}", result.columns);
    let plan = result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value.as_str())
        .expect("EXPLAIN must return one text row")
        .to_string();
    plan
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and a staged JDBC plugin package"]
async fn live_explain_plan_over_jdbc_survives_output_probe_on_fresh_sessions() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    assert_eq!(config.db_type, ogdeveloper_core::models::connection::DatabaseType::OpenGauss);
    assert!(
        ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&config),
        "the saved connection must use the openGauss JDBC driver profile for this regression"
    );

    state.configs.write().await.insert("live-explain".to_string(), config.clone());
    state.get_or_create_pool("live-explain", Some(&database)).await.expect("create base pool");

    // Two iterations: the first reproduces the original failure, the second proves the pool
    // close/recreate cycle the desktop performs after every Explain stays healthy.
    for iteration in 0..2 {
        let plan = explain_once(&state, "live-explain", &database, iteration).await;
        println!("[iteration {iteration}] plan: {}", &plan[..plan.len().min(160)]);
        assert!(plan.contains("\"Plan\"") || plan.contains("Plan"), "unexpected plan payload: {plan}");
    }
}

/// The session-scoped retry fallback: when the server terminates the JDBC session mid-pool
/// (openGauss `session_timeout`, `pg_terminate_backend`, ...), a read-only statement must be
/// retried once on a pool rebuilt under the SAME session key. Before the fix, openGauss
/// JDBC-profile connections never retried (the check matched only `db_type == jdbc`) and the
/// rebuild dropped the client session id, landing the new pool under the base key where the
/// retry could not find it.
#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and a staged JDBC plugin package"]
async fn live_session_pool_retries_on_fresh_pool_after_server_side_termination() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    assert!(
        ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&config),
        "the saved connection must use the openGauss JDBC driver profile for this regression"
    );

    let connection_id = "live-retry";
    let client_session_id = "live-retry-tab:explain";
    state.configs.write().await.insert(connection_id.to_string(), config.clone());
    state.get_or_create_pool(connection_id, Some(&database)).await.expect("create base pool");

    let session_options = || QueryExecutionOptions {
        client_session_id: Some(client_session_id.to_string()),
        timeout_secs: Some(30),
        ..Default::default()
    };

    // 1. Bring up the session pool and learn which backend serves it.
    let pid_result = execute_sql_statement_with_options(
        &state,
        connection_id,
        &database,
        "SELECT pg_backend_pid()",
        None,
        None,
        session_options(),
    )
    .await
    .expect("session pool probe query");
    let backend_pid = pid_result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value.as_i64())
        .expect("pg_backend_pid must return one integer row");
    println!("session pool backend pid: {backend_pid}");

    // 2. Terminate exactly that backend from the base pool, simulating a server-side
    // session drop underneath a live plugin process.
    let terminated = execute_sql_statement_with_options(
        &state,
        connection_id,
        &database,
        &format!("SELECT pg_terminate_backend({backend_pid})"),
        None,
        None,
        QueryExecutionOptions { timeout_secs: Some(30), ..Default::default() },
    )
    .await
    .expect("terminate backend query");
    println!("pg_terminate_backend result: {:?}", terminated.rows);
    // Give the server a moment to close the socket so the client observes the drop.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 3. The next statement on the SAME client session fails on the dead connection, then
    // must be retried transparently on a pool rebuilt under the same session key.
    let retried =
        execute_sql_statement_with_options(&state, connection_id, &database, "SELECT 1", None, None, session_options())
            .await
            .expect("read-only query must be retried on a rebuilt session pool after server-side termination");
    assert_eq!(retried.rows.first().and_then(|row| row.first()).and_then(|v| v.as_i64()), Some(1));

    // The rebuilt session pool is registered under the session key, so the desktop's
    // `finally`-block close still finds and closes it (no JVM leak).
    let closed = state
        .close_client_session_pool(connection_id, Some(&database), client_session_id)
        .await
        .expect("close rebuilt session pool");
    assert!(closed, "rebuilt session pool must live under the session-scoped key");
}

/// The server reaps sessions that sit idle (openGauss `session_timeout`): the desktop then saw
/// "FATAL: terminating connection due to administrator command" on the first sidebar metadata
/// load after idle, because the stale-pool probe (`testConnection`) only checked the client-side
/// `isClosed()` flag and could not see the kill. The probe must ping the server (JDBC `isValid`),
/// so the dead pool is discarded and rebuilt before the metadata query runs.
#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and a staged JDBC plugin package"]
async fn live_metadata_listing_recovers_after_server_terminates_idle_pool_connection() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    assert!(
        ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&config),
        "the saved connection must use the openGauss JDBC driver profile for this regression"
    );
    let connection_id = "live-meta-reconnect";
    state.configs.write().await.insert(connection_id.to_string(), config);

    // 1. Warm the base pool (`{connection}:{database}`, the key metadata listings use) and
    //    learn which backend serves it.
    let pid_result = execute_sql_statement_with_options(
        &state,
        connection_id,
        &database,
        "SELECT pg_backend_pid()",
        None,
        None,
        QueryExecutionOptions { timeout_secs: Some(30), ..Default::default() },
    )
    .await
    .expect("base pool probe query");
    let backend_pid = pid_result
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|value| value.as_i64())
        .expect("pg_backend_pid must return one integer row");
    println!("base pool backend pid: {backend_pid}");

    // 2. Terminate exactly that backend from a separate session pool, mimicking the server's
    //    idle-session reaper, then close the terminator so only the killed base pool remains.
    let terminator_session = "live-meta-terminate";
    execute_sql_statement_with_options(
        &state,
        connection_id,
        &database,
        &format!("SELECT pg_terminate_backend({backend_pid})"),
        None,
        None,
        QueryExecutionOptions {
            client_session_id: Some(terminator_session.to_string()),
            timeout_secs: Some(30),
            ..Default::default()
        },
    )
    .await
    .expect("terminate backend query");
    state
        .close_client_session_pool(connection_id, Some(&database), terminator_session)
        .await
        .expect("close terminator session pool");
    // Give the server a moment to close the socket so the client observes the drop.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // 3. The first metadata listing after the kill must recover transparently: the stale-pool
    //    probe detects the dead connection, the pool is rebuilt, and the query succeeds.
    let tables = ogdeveloper_core::schema::list_tables_core(
        &state,
        connection_id,
        &database,
        "public",
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("list_tables must recover on a rebuilt pool after server-side termination");
    println!("listTables on rebuilt pool returned {} tables", tables.len());

    // 4. The rebuilt base pool serves follow-up queries.
    let follow_up = execute_sql_statement_with_options(
        &state,
        connection_id,
        &database,
        "SELECT 1",
        None,
        None,
        QueryExecutionOptions { timeout_secs: Some(30), ..Default::default() },
    )
    .await
    .expect("follow-up query on rebuilt pool");
    assert_eq!(follow_up.rows.first().and_then(|row| row.first()).and_then(|v| v.as_i64()), Some(1));

    state.remove_connection_pools(connection_id).await;
}
