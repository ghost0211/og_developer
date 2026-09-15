//! Live end-to-end coverage for the SQL completion assistant (the `schema.`
//! lookup in the desktop SQL editor).
//!
//! The property asserted against a real openGauss instance:
//!
//!   Completion must resolve a schema's tables, views and routines from the
//!   server catalogs, independent of what the sidebar tree has expanded so
//!   far. After the openGauss-only narrowing, `completion_assistant_search_core`
//!   had been reduced to a stub returning `Ok(vec![])`, so remote completion
//!   silently returned nothing and only schemas already expanded in the
//!   sidebar produced suggestions.
//!
//! Run with a desktop data directory that already holds an openGauss connection:
//!
//! ```text
//! DBX_TEST_OPENGAUSS_DATA_DIR="%APPDATA%\com.ogdeveloper.app" \
//! DBX_TEST_OPENGAUSS_DATABASE=test_b \
//!   cargo test -p ogdeveloper-core --no-default-features \
//!     --test live_opengauss_completion_assistant -- --ignored --nocapture
//! ```
//!
//! The test only creates and drops its own uniquely named schema. It never
//! touches existing objects, and it copies the connection database to a
//! temporary file so the desktop's own storage is left untouched.

#![allow(clippy::print_stdout)]

use std::path::Path;

use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::query::execute_statements;
use ogdeveloper_core::schema::completion_assistant_search_core;
use ogdeveloper_core::storage::Storage;
use ogdeveloper_core::types::{
    CompletionAssistantCandidate, CompletionAssistantObjectKind, CompletionAssistantRequest,
};

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
    let plugin_dir = std::env::var_os("DBX_TEST_OPENGAUSS_PLUGIN_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data_dir.join("plugins"));
    let state = AppState::new_with_plugin_dir(storage, plugin_dir);
    (state, config, temp)
}

/// Same endpoint and credentials, but without the JDBC driver profile, so the pool is the native
/// `tokio-postgres` one.
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

/// The request shape the desktop sends when the user types `schema.` in the SQL
/// editor (`sqlCompletionLookupTarget` + `listCompletionAssistantTables`).
fn schema_qualified_request(id: &str, database: &str, schema: &str, mask: &str) -> CompletionAssistantRequest {
    CompletionAssistantRequest {
        connection_id: id.to_string(),
        database: database.to_string(),
        schema: Some(schema.to_string()),
        object_kinds: vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View],
        mask: mask.to_string(),
        case_sensitive: false,
        global_search: false,
        max_results: Some(100),
        search_in_comments: false,
        search_in_definitions: false,
        parent_schema: None,
        parent_name: None,
        match_mode: None,
    }
}

fn candidate_names(candidates: &[CompletionAssistantCandidate]) -> Vec<String> {
    candidates.iter().map(|candidate| candidate.name.to_lowercase()).collect()
}

async fn assert_completion_contract(state: &AppState, id: &str, database: &str, schema: &str, label: &str) {
    // Identifiers stay unquoted and lowercase so the fixture is valid in every
    // compatibility mode (A/PG quote with `"`, B with a backtick).
    let statements = vec![
        format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
        format!("CREATE SCHEMA {schema}"),
        format!("CREATE TABLE {schema}.probe_table (id integer PRIMARY KEY, note varchar(64))"),
        format!("CREATE VIEW {schema}.probe_view AS SELECT id FROM {schema}.probe_table"),
        format!("CREATE FUNCTION {schema}.probe_func() RETURNS integer AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql"),
    ];
    execute_statements(state, id, database, &statements, None, None).await.expect("create completion fixture");

    // `schema.` with an empty mask must list the schema's table and view even
    // though nothing about this schema exists in any sidebar cache.
    let request = schema_qualified_request(id, database, schema, "");
    let candidates = completion_assistant_search_core(state, &request).await.expect("schema-qualified completion");
    let names = candidate_names(&candidates);
    if !names.contains(&"probe_table".to_string()) {
        let probe = execute_statements(
            state,
            id,
            database,
            &[
                "SELECT current_database()".to_string(),
                format!("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = '{schema}'"),
                format!("SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '{schema}'"),
            ],
            None,
            None,
        )
        .await;
        panic!("[{label}] `schema.` completion must list probe_table, got {names:?}; probe={probe:?}");
    }
    assert!(
        names.contains(&"probe_view".to_string()),
        "[{label}] `schema.` completion must list probe_view, got {names:?}"
    );

    // A non-empty mask filters by prefix.
    let request = schema_qualified_request(id, database, schema, "probe_ta");
    let candidates = completion_assistant_search_core(state, &request).await.expect("masked completion");
    let names = candidate_names(&candidates);
    assert!(names.contains(&"probe_table".to_string()), "[{label}] mask probe_ta must keep probe_table, got {names:?}");
    assert!(!names.contains(&"probe_view".to_string()), "[{label}] mask probe_ta must drop probe_view, got {names:?}");

    // Routines of an unexpanded schema resolve too.
    let mut request = schema_qualified_request(id, database, schema, "");
    request.object_kinds = vec![CompletionAssistantObjectKind::Function, CompletionAssistantObjectKind::Procedure];
    let candidates = completion_assistant_search_core(state, &request).await.expect("routine completion");
    let names = candidate_names(&candidates);
    assert!(
        names.contains(&"probe_func".to_string()),
        "[{label}] routine completion must list probe_func, got {names:?}"
    );

    let drop = vec![format!("DROP SCHEMA IF EXISTS {schema} CASCADE")];
    execute_statements(state, id, database, &drop, None, None).await.expect("drop completion fixture");
    println!("[{label}] completion assistant resolved schema-qualified objects from catalogs");
}

fn probe_schema(label: &str) -> String {
    // Both driver variants run in parallel against the same database, so the
    // fixture schema must be unique per test, not just per millisecond.
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_millis();
    format!("ogd_completion_probe_{label}_{millis}")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR pointing at a desktop data directory with an openGauss connection"]
async fn live_completion_assistant_resolves_unexpanded_schema_over_jdbc() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;
    assert_eq!(config.db_type, ogdeveloper_core::models::connection::DatabaseType::OpenGauss);

    let schema = probe_schema("jdbc");
    register(&state, "live-completion-jdbc", &config, &database).await;
    assert_completion_contract(&state, "live-completion-jdbc", &database, &schema, "jdbc").await;
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR pointing at a desktop data directory with an openGauss connection"]
async fn live_completion_assistant_resolves_unexpanded_schema_over_native_pool() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;

    let native = native_variant(&config);
    assert!(
        !ogdeveloper_core::connection::opengauss_uses_jdbc_driver(&native),
        "native variant must not select the JDBC driver"
    );
    let schema = probe_schema("native");
    register(&state, "live-completion-native", &native, &database).await;
    assert_completion_contract(&state, "live-completion-native", &database, &schema, "native").await;
}
