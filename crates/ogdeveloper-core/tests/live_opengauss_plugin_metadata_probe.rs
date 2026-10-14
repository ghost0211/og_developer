//! Live regression coverage for plugin metadata and view DDL in PG compatibility mode.
//!
//! Fixture (created in the shared test database `tygl_pg`, schema `yi_ddd`):
//! - `ogt_mv_probe` — MATERIALIZED VIEW (relkind 'm'), table comment set;
//! - `ogt_v_probe` — VIEW (relkind 'v'), view + column comments set.
//!
//! Reproduces two user reports against the real JDBC plugin session:
//! 1. The sidebar "materialized views" group stays empty because plugin
//!    `listTables` never returns relkind 'm' rows.
//! 2. "View DDL" for a view renders a bogus CREATE TABLE.
//!
//! Run:
//! ```text
//! DBX_TEST_OPENGAUSS_DATA_DIR="%APPDATA%\com.ogdeveloper.app" \
//! DBX_TEST_OPENGAUSS_DATABASE=tygl_pg \
//!   cargo test -p ogdeveloper-core --no-default-features \
//!     --test live_opengauss_plugin_metadata_probe -- --ignored --nocapture
//! ```
//!
//! Metadata reads are strictly read-only. The connection database is copied
//! before opening it; DBX_TEST_OPENGAUSS_PLUGIN_DIR can point to an isolated
//! build of the plugin, leaving the desktop's installed plugin untouched.

#![allow(clippy::print_stdout)]

use std::path::Path;

use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::models::connection::ConnectionConfig;
use ogdeveloper_core::storage::Storage;

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

#[tokio::test]
#[ignore = "requires DBX_TEST_OPENGAUSS_DATA_DIR and the tygl_pg yi_ddd probe fixtures"]
async fn live_plugin_metadata_probe() {
    let data_dir = std::env::var("DBX_TEST_OPENGAUSS_DATA_DIR").expect("DBX_TEST_OPENGAUSS_DATA_DIR");
    let database = std::env::var("DBX_TEST_OPENGAUSS_DATABASE").unwrap_or_else(|_| "tygl_pg".to_string());
    let (state, config, _temp) = app_state_from_data_dir(Path::new(&data_dir)).await;

    // Keep the JDBC driver profile: the pool must be the ExternalDriver (plugin)
    // one the desktop sidebar actually uses.
    state.configs.write().await.insert("live".to_string(), config.clone());
    let pool = state.get_or_create_pool("live", Some(&database)).await.expect("create pool");
    let pool_kind = {
        let connections = state.connections.read().await;
        connections
            .get(&pool)
            .map(|kind| match kind {
                ogdeveloper_core::connection::PoolKind::Postgres(_) => "native-postgres".to_string(),
                ogdeveloper_core::connection::PoolKind::ExternalDriver { .. } => "external-driver".to_string(),
            })
            .unwrap_or_else(|| "missing".to_string())
    };
    assert_eq!(pool_kind, "external-driver", "test must cover the JDBC metadata path");

    // 1) Sidebar listing path: the plugin listTables must surface the mview
    // (previously the openGauss JDBC driver metadata dropped relkind 'm').
    let tables =
        ogdeveloper_core::schema::list_tables_core(&state, "live", &database, "yi_ddd", None, None, None, None, None)
            .await
            .expect("list tables");
    for table in &tables {
        println!("listTables row: name={} type={}", table.name, table.table_type);
    }
    let mv = tables.iter().find(|table| table.name == "ogt_mv_probe");
    assert!(mv.is_some(), "materialized view must be listed: {tables:?}");
    assert_eq!(
        mv.map(|table| table.table_type.as_str()),
        Some("MATERIALIZED_VIEW"),
        "materialized view must carry the MATERIALIZED_VIEW type: {tables:?}"
    );
    let view = tables.iter().find(|table| table.name == "ogt_v_probe");
    assert_eq!(view.map(|table| table.table_type.as_str()), Some("VIEW"), "view must keep its VIEW type: {tables:?}");
    assert!(
        tables.iter().any(|table| table.name == "prod_menu" || table.table_type == "TABLE"),
        "regular tables must still be listed: {tables:?}"
    );

    let objects =
        ogdeveloper_core::schema::list_objects_core(&state, "live", &database, "yi_ddd", None, None, None, None, None)
            .await
            .expect("list objects");
    assert!(
        objects.iter().any(|object| object.name == "ogt_mv_probe" && object.object_type == "MATERIALIZED_VIEW"),
        "object browser must also list the materialized view: {objects:?}"
    );

    // 2) View DDL path via the same core function the dialog calls.
    let view_ddl =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_ddd", "ogt_v_probe", None)
            .await
            .expect("view ddl");
    println!("view ddl:\n{view_ddl}");
    assert!(
        view_ddl.starts_with("CREATE OR REPLACE VIEW \"yi_ddd\".\"ogt_v_probe\" AS\n"),
        "view DDL must use CREATE OR REPLACE VIEW, not CREATE TABLE:\n{view_ddl}"
    );
    assert!(view_ddl.contains("prod_menu"), "view DDL must carry the view definition:\n{view_ddl}");
    assert!(
        view_ddl.contains("COMMENT ON VIEW \"yi_ddd\".\"ogt_v_probe\" IS '探针视图-验证视图DDL';"),
        "view DDL must carry the view comment:\n{view_ddl}"
    );
    assert!(
        view_ddl.contains("COMMENT ON COLUMN \"yi_ddd\".\"ogt_v_probe\".\"menu_name\" IS '视图-菜单名称';"),
        "view DDL must carry column comments:\n{view_ddl}"
    );

    let mv_ddl =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_ddd", "ogt_mv_probe", None)
            .await
            .expect("mview ddl");
    println!("mview ddl:\n{mv_ddl}");
    assert!(
        mv_ddl.starts_with("CREATE MATERIALIZED VIEW \"yi_ddd\".\"ogt_mv_probe\" AS\n"),
        "materialized view DDL must use CREATE MATERIALIZED VIEW, not CREATE TABLE:\n{mv_ddl}"
    );
    assert!(mv_ddl.contains("prod_menu"), "mview DDL must carry the view definition:\n{mv_ddl}");
    assert!(
        mv_ddl.contains("COMMENT ON MATERIALIZED VIEW \"yi_ddd\".\"ogt_mv_probe\" IS '探针物化视图-验证列表与DDL';"),
        "mview DDL must carry the materialized view comment:\n{mv_ddl}"
    );

    // 3) A real table keeps the regular CREATE TABLE shape (no view branch leak).
    let table_ddl =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_prod", "prod_menu", None)
            .await
            .expect("table ddl");
    assert!(
        table_ddl.starts_with("CREATE TABLE \"yi_prod\".\"prod_menu\" ("),
        "real table DDL must keep the CREATE TABLE shape:\n{table_ddl}"
    );

    // Native metadata listing must keep the same kinds too (the catalog SQL
    // is also used by ordinary PostgreSQL connections).
    let mut native = config.clone();
    native.driver_profile = None;
    native.driver_label = None;
    native.jdbc_driver_class = None;
    native.jdbc_driver_paths.clear();
    native.connection_string = None;
    state.configs.write().await.insert("live-native".to_string(), native);
    let native_tables = ogdeveloper_core::schema::list_tables_core(
        &state,
        "live-native",
        &database,
        "yi_ddd",
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("native relation listing");
    assert!(native_tables.iter().any(|table| table.name == "ogt_mv_probe" && table.table_type == "MATERIALIZED_VIEW"));
    assert!(native_tables.iter().any(|table| table.name == "ogt_v_probe" && table.table_type == "VIEW"));

    // 3b) View/materialized view "references" must list each referenced
    // relation exactly once with the friendly kind. The pg_depend path used to
    // return the raw relkind ("r") while the source-parse path returned
    // "table" with a detail suffix, so the same table appeared twice.
    let view_refs = ogdeveloper_core::schema::list_object_references_core(
        &state,
        "live-native",
        &database,
        "yi_ddd",
        "view",
        "ogt_v_probe",
        "references",
    )
    .await
    .expect("view references");
    println!("view references: {view_refs:?}");
    let prod_menu_refs: Vec<_> = view_refs.iter().filter(|r| r.schema == "yi_prod" && r.name == "prod_menu").collect();
    assert_eq!(prod_menu_refs.len(), 1, "referenced table must appear exactly once: {view_refs:?}");
    assert_eq!(prod_menu_refs[0].object_type, "table", "raw relkind must be normalized: {view_refs:?}");
    assert!(
        prod_menu_refs[0].detail.is_none(),
        "authoritative pg_depend row must win without a detail suffix: {view_refs:?}"
    );

    let mv_refs = ogdeveloper_core::schema::list_object_references_core(
        &state,
        "live-native",
        &database,
        "yi_ddd",
        "materialized_view",
        "ogt_mv_probe",
        "references",
    )
    .await
    .expect("materialized view references");
    let mv_prod_menu: Vec<_> = mv_refs.iter().filter(|r| r.schema == "yi_prod" && r.name == "prod_menu").collect();
    assert_eq!(mv_prod_menu.len(), 1, "materialized view references must dedupe: {mv_refs:?}");
    assert_eq!(mv_prod_menu[0].object_type, "table", "raw relkind must be normalized: {mv_refs:?}");

    // Both views reference yi_prod.prod_menu directly, not the same-named
    // yi_ddd.prod_menu synonym. Source candidates used to invent that second
    // relationship because it belongs to the view's own schema.
    assert_eq!(view_refs.len(), 1, "view must not infer synonym aliases: {view_refs:?}");
    assert_eq!(mv_refs.len(), 1, "materialized view must not infer synonym aliases: {mv_refs:?}");
    for (object_type, object_name) in [("view", "ogt_v_probe"), ("materialized_view", "ogt_mv_probe")] {
        let jdbc_refs = ogdeveloper_core::schema::list_object_references_core(
            &state,
            "live",
            &database,
            "yi_ddd",
            object_type,
            object_name,
            "references",
        )
        .await
        .expect("JDBC session view references through metadata pool");
        assert_eq!(jdbc_refs.len(), 1, "{object_type}: must not infer synonym aliases: {jdbc_refs:?}");
        assert_eq!(jdbc_refs[0].schema, "yi_prod");
        assert_eq!(jdbc_refs[0].name, "prod_menu");
        assert_eq!(jdbc_refs[0].object_type, "table");
        assert!(jdbc_refs[0].detail.is_none());
    }
    // Genuine synonym -> table dependencies must remain available.
    let synonym_refs = ogdeveloper_core::schema::list_object_references_core(
        &state,
        "live-native",
        &database,
        "yi_ddd",
        "synonym",
        "prod_menu",
        "references",
    )
    .await
    .expect("synonym target reference");
    assert_eq!(synonym_refs.len(), 1, "synonym reference must be retained: {synonym_refs:?}");
    assert_eq!(synonym_refs[0].schema, "yi_prod");
    assert_eq!(synonym_refs[0].name, "prod_menu");
    assert_eq!(synonym_refs[0].object_type, "table");

    // 3c) Column-type dropdown: the catalog query must exclude array types
    // (typcategory 'A', `_`-prefixed) and table/sequence row types. This test
    // database has `app_role_user` (table row type) and `seq_auth_user_account`
    // (sequence row type) which the unfiltered pg_type scan leaked into the
    // structure editor dropdown.
    let native_types = ogdeveloper_core::schema::list_data_types_core(&state, "live-native", &database, "public", None)
        .await
        .expect("native data types");
    assert_column_type_list(&native_types, "native");

    // 5) Missing relations fail on both metadata paths; they must not turn
    // into an empty CREATE TABLE shell in the DDL dialog or structure editor.
    let missing = "ogt_missing_relation_probe";
    let missing_native =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live-native", &database, "yi_ddd", missing, None)
            .await
            .expect_err("missing relation must fail through the native path");
    println!("native missing relation error: {missing_native}");
    assert!(missing_native.contains("not found"), "unexpected native error: {missing_native}");
    let missing_jdbc = ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_ddd", missing, None)
        .await
        .expect_err("missing relation must fail through the JDBC-only path");
    println!("JDBC-only missing relation error: {missing_jdbc}");
    assert_eq!(missing_jdbc, "Relation \"yi_ddd\".\"ogt_missing_relation_probe\" not found");

    // 4) Make only native metadata attempt a closed localhost endpoint. The
    // already-open external session retains its original endpoint/config.
    // This covers JDBC-only DDL without changing the desktop profile or DB.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve local port");
    let unused_port = listener.local_addr().expect("local address").port();
    drop(listener);
    {
        let mut configs = state.configs.write().await;
        let config = configs.get_mut("live").expect("live config");
        config.host = "127.0.0.1".to_string();
        config.port = unused_port;
        config.connect_timeout_secs = 1;
    }
    let jdbc_view_ddl =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_ddd", "ogt_v_probe", None)
            .await
            .expect("JDBC-only view ddl");
    let jdbc_mv_ddl =
        ogdeveloper_core::schema::get_table_ddl_core(&state, "live", &database, "yi_ddd", "ogt_mv_probe", None)
            .await
            .expect("JDBC-only materialized view ddl");
    assert_eq!(jdbc_view_ddl, view_ddl, "JDBC fallback must preserve view definition and comments");
    assert_eq!(jdbc_mv_ddl, mv_ddl, "JDBC fallback must preserve materialized view definition and comments");
    println!("JDBC-only view/materialized view DDL matches native output");

    // JDBC-only listDataTypes: the plugin must use the pg_type catalog query,
    // not the driver's getTypeInfo() (which leaks `_`-arrays and row types).
    let jdbc_types = ogdeveloper_core::schema::list_data_types_core(&state, "live", &database, "public", None)
        .await
        .expect("JDBC-only data types");
    assert_column_type_list(&jdbc_types, "jdbc");
}

fn assert_column_type_list(types: &[String], label: &str) {
    println!("{label} data types: {} entries", types.len());
    for expected in ["int4", "uuid", "text", "varchar", "tsvector"] {
        assert!(types.iter().any(|t| t == expected), "{label}: missing base type {expected}: {types:?}");
    }
    assert!(
        !types.iter().any(|t| t.starts_with('_')),
        "{label}: array types (`_` prefix) must be filtered out: {:?}",
        types.iter().filter(|t| t.starts_with('_')).collect::<Vec<_>>()
    );
    for leaked in [
        "app_role_user",
        "app_system",
        "auth_user_account",
        "seq_auth_user_account",
        "snapshot_name",
        "cardinal_number",
    ] {
        assert!(
            !types.iter().any(|t| t == leaked),
            "{label}: row type / internal domain {leaked} must be filtered out"
        );
    }
}
