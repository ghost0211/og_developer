//! Live coverage for synonym-aware table DDL (the editor "View DDL" path).
//!
//! `yi_ddd.prod_menu` in the shared test database is a synonym for
//! `yi_prod.prod_menu`. Before the fix, viewing its DDL produced a bogus empty
//! `CREATE TABLE "yi_ddd"."prod_menu" ();` because synonyms have no
//! `pg_class` row. The fixed DDL must carry the synonym definition followed by
//! the resolved target table DDL, and a real table must keep its plain DDL
//! (no synonym header) so same-named relations keep winning name resolution.
//!
//! Run with a desktop data directory that already holds an openGauss connection:
//!
//! ```text
//! DBX_TEST_OPENGAUSS_DATA_DIR="%APPDATA%\com.ogdeveloper.app" \
//! DBX_TEST_OPENGAUSS_DATABASE=tygl_pg \
//!   cargo test -p ogdeveloper-core --no-default-features \
//!     --test live_opengauss_synonym_ddl -- --ignored --nocapture
//! ```
//!
//! The test is strictly read-only: it only issues metadata SELECTs. The
//! connection database is copied before it is opened so the desktop's own
//! storage is never migrated or mutated.

#![allow(clippy::print_stdout)]

use std::path::Path;

use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::schema::get_table_ddl_core;
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

    let plugin_dir = std::env::var_os("DBX_TEST_OPENGAUSS_PLUGIN_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data_dir.join("plugins"));
    let state = AppState::new_with_plugin_dir(storage, plugin_dir);
    (state, config, temp)
}

/// Same endpoint and credentials, but without the JDBC driver profile, so the pool is the native
/// `tokio-postgres` one the synonym DDL path serves.
fn native_variant(config: &ConnectionConfig) -> ConnectionConfig {
    let mut native = config.clone();
    native.driver_profile = None;
    native.driver_label = None;
    native.jdbc_driver_class = None;
    native.jdbc_driver_paths = Vec::new();
    native.connection_string = None;
    native
}

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and the tygl_pg yi_ddd.prod_menu synonym fixture"]
async fn live_opengauss_synonym_ddl_shows_definition_and_target_table() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "tygl_pg".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;

    let native = native_variant(&config);
    state.configs.write().await.insert("live".to_string(), native);
    state.get_or_create_pool("live", Some(&database)).await.expect("create pool");

    // Synonym: definition first, then the resolved target table DDL.
    let ddl = get_table_ddl_core(&state, "live", &database, "yi_ddd", "prod_menu", None).await.expect("synonym ddl");
    println!("synonym ddl:\n{ddl}");
    assert!(
        ddl.contains("CREATE OR REPLACE SYNONYM \"yi_ddd\".\"prod_menu\" FOR \"yi_prod\".\"prod_menu\";"),
        "synonym DDL must start with the synonym definition:\n{ddl}"
    );
    assert!(
        ddl.contains("CREATE TABLE \"yi_prod\".\"prod_menu\" ("),
        "synonym DDL must append the resolved target table DDL:\n{ddl}"
    );
    assert!(
        !ddl.contains("CREATE TABLE \"yi_ddd\".\"prod_menu\" ("),
        "synonym DDL must not emit a bogus empty CREATE TABLE for the synonym itself:\n{ddl}"
    );

    // Real table: unchanged behavior, no synonym header.
    let table_ddl =
        get_table_ddl_core(&state, "live", &database, "yi_prod", "prod_menu", None).await.expect("table ddl");
    println!("table ddl:\n{table_ddl}");
    assert!(
        table_ddl.starts_with("CREATE TABLE \"yi_prod\".\"prod_menu\" ("),
        "real table DDL must keep the regular CREATE TABLE shape:\n{table_ddl}"
    );
    assert!(
        !table_ddl.to_uppercase().contains("SYNONYM"),
        "real table DDL must not pick up synonym output:\n{table_ddl}"
    );
}
