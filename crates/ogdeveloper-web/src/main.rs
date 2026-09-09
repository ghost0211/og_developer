mod auth;
mod error;
mod routes;
mod sse;
mod ssh_prompt;
mod state;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHasher};
use axum::extract::DefaultBodyLimit;
use axum::middleware;
use axum::routing::{delete, get, post};
use axum::Router;
use ogdeveloper_core::connection::AppState;
use ogdeveloper_core::sql_dialect::dialect_loader::{register_core_dialects, DialectPluginLoader, DialectRegistry};
use ogdeveloper_core::sql_dialect::hot_reload::DialectHotReload;
use ogdeveloper_core::storage::Storage;
use state::WebState;
use tokio::sync::RwLock;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::compression::CompressionLayer;
use utoipa::OpenApi;

const XLSX_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DATA_GRID_EXTRACTOR_BODY_LIMIT_BYTES: usize = 96 * 1024 * 1024;

#[derive(OpenApi)]
#[openapi(
    info(title = "ogdeveloper Data Grid Extractor API", description = "HTTP contract for data-grid clipboard extraction."),
    paths(routes::query::extract_data_grid_selection),
    tags((name = "data-grid", description = "Data grid extraction and clipboard formats"))
)]
struct ApiDoc;

async fn openapi_json() -> axum::Json<utoipa::openapi::OpenApi> {
    axum::Json(ApiDoc::openapi())
}

#[cfg(test)]
mod data_grid_extractor_openapi_tests {
    use super::*;

    #[test]
    fn extractor_openapi_contains_the_versioned_request_and_error_responses() {
        let document = serde_json::to_value(ApiDoc::openapi()).expect("serialize extractor OpenAPI document");
        let operation = &document["paths"]["/api/query/extract-data-grid-selection"]["post"];

        assert_eq!(operation["requestBody"]["required"], true);
        assert!(operation["responses"].get("200").is_some());
        assert!(operation["responses"].get("400").is_some());
        assert!(operation["responses"].get("413").is_some());
        assert!(operation["responses"].get("422").is_some());
        assert!(operation["responses"].get("500").is_some());
    }
}

fn web_compression_predicate() -> impl Predicate {
    // XLSX exports are already compressed ZIP archives, so gzip would only add CPU overhead.
    DefaultPredicate::new().and(NotForContentType::const_new(XLSX_CONTENT_TYPE))
}

fn web_body_limit_bytes() -> usize {
    const DEFAULT_MB: usize = 1024;
    let mb = ogdeveloper_core::branding::var("OGDEVELOPER_MAX_UPLOAD_MB")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MB);
    mb.saturating_mul(1024 * 1024)
}

/// Static-asset cache policy: hashed vite build assets are immutable forever,
/// everything else (index.html and the SPA fallback) must revalidate so a
/// redeploy is visible on the next plain refresh.
async fn static_cache_headers(request: axum::extract::Request, next: middleware::Next) -> axum::response::Response {
    let immutable = request.uri().path().contains("/assets/");
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        if immutable {
            axum::http::HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            axum::http::HeaderValue::from_static("no-cache")
        },
    );
    response
}

fn web_agent_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    web_agent_dir_from_env(data_dir, ogdeveloper_core::branding::var("OGDEVELOPER_AGENT_DIR").ok())
}

fn web_agent_dir_from_env(data_dir: &std::path::Path, agent_dir: Option<String>) -> std::path::PathBuf {
    agent_dir.map(std::path::PathBuf::from).unwrap_or_else(|| data_dir.join("agents"))
}

fn normalize_public_base_path(value: Option<String>) -> String {
    let trimmed = value
        .unwrap_or_else(|| "/".to_string())
        .split(['?', '#'])
        .next()
        .unwrap_or("/")
        .trim()
        .trim_matches('/')
        .to_string();
    if trimmed.chars().any(|ch| ch.is_ascii_control() || ch.is_ascii_whitespace() || matches!(ch, ';' | ',')) {
        panic!("OGDEVELOPER_PUBLIC_BASE_PATH contains invalid characters");
    }
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        format!("/{trimmed}")
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ogdeveloper_web=info,tower_http=info".parse().unwrap()),
        )
        .init();

    rustls::crypto::aws_lc_rs::default_provider().install_default().expect("Failed to install rustls crypto provider");

    // Data directory
    let data_dir =
        ogdeveloper_core::branding::var("OGDEVELOPER_DATA_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            // og developer: keep the web data directory distinct from upstream ogdeveloper-web.
            std::path::PathBuf::from(home).join(".og-developer-web")
        });
    std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

    let app_state = {
        let db_path = ogdeveloper_core::storage::storage_db_path(&data_dir);
        let storage = Storage::open(&db_path).await.expect("Failed to open storage");
        storage.migrate_from_json(&data_dir).await.expect("Failed to migrate JSON data");

        // Initialize core dialect registry and load external plugin dialects
        register_core_dialects();
        let registry = DialectRegistry::global();
        let plugin_dirs = vec![data_dir.join("plugins").join("dialects")];
        let load_result = DialectPluginLoader::scan_and_load(registry, &plugin_dirs);
        log::info!(
            "Dialect plugins loaded: {} success, {} errors, {} skipped",
            load_result.loaded.len(),
            load_result.errors.len(),
            load_result.skipped.len()
        );

        // Start dialect YAML hot-reload watcher
        let watch_dirs = plugin_dirs.clone();
        tokio::spawn(async move {
            if let Err(e) = DialectHotReload::run_forever(watch_dirs, DialectRegistry::global()).await {
                log::error!("Dialect hot-reload watcher exited: {e}");
            }
        });
        log::info!("Dialect hot-reload watcher started");

        Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            data_dir.join("plugins"),
            web_agent_dir(&data_dir),
            env!("CARGO_PKG_VERSION"),
        ))
    };

    // og developer: keep the bundled openGauss JDBC driver fresh (best-effort,
    // offline-safe). The desktop app additionally seeds the jar from its
    // bundled resource; the web server only syncs from Maven Central.
    {
        let plugins_root = app_state.plugins.root_dir().to_path_buf();
        tokio::spawn(async move {
            match ogdeveloper_core::jdbc::sync_opengauss_driver_from_maven(&plugins_root).await {
                Ok(Some(version)) => log::info!("openGauss JDBC driver updated to {version}"),
                Ok(None) => {}
                Err(err) => log::debug!("openGauss JDBC driver sync skipped: {err}"),
            }
        });
    }

    // Password hash: env var takes priority, then database
    let password_disabled = ogdeveloper_core::branding::var("OGDEVELOPER_DISABLE_PASSWORD")
        .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);

    let password_hash = if password_disabled {
        None
    } else if let Ok(pw) = ogdeveloper_core::branding::var("OGDEVELOPER_PASSWORD") {
        let salt = SaltString::generate(&mut OsRng);
        Some(Argon2::default().hash_password(pw.as_bytes(), &salt).expect("Failed to hash password").to_string())
    } else {
        app_state.storage.load_password_hash().await.unwrap_or(None)
    };

    let public_base_path =
        normalize_public_base_path(ogdeveloper_core::branding::var("OGDEVELOPER_PUBLIC_BASE_PATH").ok());

    let web_state = Arc::new(WebState {
        app: app_state,
        data_dir,
        public_base_path: public_base_path.clone(),
        password_disabled,
        password_hash: RwLock::new(password_hash),
        sessions: RwLock::new(HashSet::new()),
        sse_channels: RwLock::new(HashMap::new()),
        transfer_progress_channels: RwLock::new(HashMap::new()),
        table_import_channels: RwLock::new(HashMap::new()),
        sql_file_executions: RwLock::new(HashMap::new()),
        login_rate_limit: tokio::sync::Mutex::new(state::LoginRateLimit { fail_count: 0, locked_until: None }),
        export_files: RwLock::new(HashMap::new()),
        ssh_prompts: Arc::new(ssh_prompt::SshPromptHub::new()),
    });

    ssh_prompt::install_web_ssh_prompt_bridge(web_state.ssh_prompts.clone());

    // API routes
    let api = Router::new()
        // Auth
        .route("/auth/login", post(auth::login))
        .route("/auth/check", get(auth::check))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/change-password", post(auth::change_password))
        .route("/auth/logout", post(auth::logout))
        // Connection
        .route("/connection/test", post(routes::connection::test_connection))
        .route("/connection/test-info", post(routes::connection::test_connection_with_info))
        .route("/connection/connect", post(routes::connection::connect_db))
        .route("/connection/database-info", post(routes::connection::connected_database_info))
        .route("/connection/database-info/save", post(routes::connection::save_connection_database_info))
        .route("/connection/final-proxy-port", post(routes::connection::connection_final_proxy_port))
        .route("/connection/disconnect", post(routes::connection::disconnect_db))
        .route("/connection/check-health", post(routes::connection::check_connection_health))
        .route("/connection/identifier-quote", post(routes::connection::connection_identifier_quote))
        .route("/connection/close-database", post(routes::connection::close_database_connection))
        .route("/connection/save", post(routes::connection::save_connections))
        .route("/connection/list", get(routes::connection::load_connections))
        .route("/plugins", get(routes::plugins::list_plugins))
        // JDBC
        .route("/jdbc/drivers", get(routes::jdbc::list_jdbc_drivers).post(routes::jdbc::import_jdbc_drivers))
        .route(
            "/jdbc/drivers/maven",
            get(routes::jdbc::list_jdbc_maven_bundles).post(routes::jdbc::install_jdbc_driver_from_maven),
        )
        .route("/jdbc/drivers/local", get(routes::jdbc::list_jdbc_local_bundles))
        .route("/jdbc/drivers/prestosql", post(routes::jdbc::install_prestosql_jdbc_driver))
        .route("/jdbc/drivers/maven/{bundle_id}", delete(routes::jdbc::delete_jdbc_maven_bundle))
        .route("/jdbc/drivers/local/{bundle_id}", delete(routes::jdbc::delete_jdbc_local_bundle))
        .route("/jdbc/drivers/{name}", delete(routes::jdbc::delete_jdbc_driver))
        .route("/jdbc/plugin/status", get(routes::jdbc::get_jdbc_plugin_status))
        .route("/jdbc/plugin/install", post(routes::jdbc::install_jdbc_plugin))
        .route("/jdbc/plugin/install-local", post(routes::jdbc::install_jdbc_plugin_local))
        .route("/jdbc/plugin/uninstall", post(routes::jdbc::uninstall_jdbc_plugin))
        // System
        .route("/system/fonts", get(routes::jdbc::list_system_fonts))
        .route("/ssh/config-hosts", get(routes::ssh_config::list_ssh_config_hosts))
        .route("/ssh/prompts", get(routes::ssh_prompt::stream_ssh_prompts))
        .route("/ssh/prompts/pending", get(routes::ssh_prompt::list_pending_ssh_prompts))
        .route("/ssh/prompts/resolve", post(routes::ssh_prompt::resolve_ssh_prompt))
        // Tunnel profiles
        .route("/tunnel-profiles/list", get(routes::tunnel_profiles::load_tunnel_profiles))
        .route("/tunnel-profiles/save", post(routes::tunnel_profiles::save_tunnel_profiles))
        .route("/tunnel-profiles/test", post(routes::tunnel_profiles::test_tunnel_profile))
        // Schema
        .route("/schema/databases", get(routes::schema::list_databases))
        .route("/schema/database-storage", post(routes::schema::list_database_storage))
        .route("/schema/sqlserver/completion-context", get(routes::schema::get_sqlserver_completion_context))
        .route("/schema/doris/catalogs", get(routes::schema::list_doris_catalogs))
        .route("/schema/doris/catalog-databases", get(routes::schema::list_doris_catalog_databases))
        .route("/schema/sqlserver/linked-servers", get(routes::schema::list_sqlserver_linked_servers))
        .route("/schema/sqlserver/linked-server-catalogs", get(routes::schema::list_sqlserver_linked_server_catalogs))
        .route("/schema/sqlserver/linked-server-schemas", get(routes::schema::list_sqlserver_linked_server_schemas))
        .route("/schema/sqlserver/linked-server-tables", get(routes::schema::list_sqlserver_linked_server_tables))
        .route("/schema/sqlserver/column-metadata", get(routes::schema::get_sqlserver_column_metadata))
        .route("/schema/schemas", get(routes::schema::list_schemas))
        .route("/schema/tables", get(routes::schema::list_tables))
        .route("/schema/objects", get(routes::schema::list_objects))
        .route("/schema/object-statistics", get(routes::schema::list_object_statistics))
        .route("/schema/completion-objects", get(routes::schema::list_completion_objects))
        .route("/schema/completion-assistant", post(routes::schema::completion_assistant_search))
        .route("/schema/object-source", get(routes::schema::get_object_source))
        .route("/search/files", get(routes::search::search_files))
        .route("/search/database-targets", get(routes::search::list_database_targets))
        .route("/sessions/list", get(routes::sessions::list_sessions))
        .route("/sessions/kill", post(routes::sessions::kill_session))
        .route("/search/metadata", post(routes::search::search_metadata))
        .route("/search/object-definitions", post(routes::search::search_object_definitions))
        .route("/fs/list-dir", get(routes::search::list_dir))
        .route("/fs/read-text", get(routes::search::read_text_file))
        .route("/fs/write-text", post(routes::search::write_text_file))
        .route("/fs/ensure-dir", get(routes::search::ensure_directory))
        .route("/fs/default-projects-root", get(routes::search::default_projects_root))
        .route("/schema/columns", get(routes::schema::list_columns))
        .route("/schema/all-columns", get(routes::schema::get_all_columns))
        .route("/schema/data-types", get(routes::schema::list_data_types))
        .route("/schema/indexes", get(routes::schema::list_indexes))
        .route("/schema/foreign-keys", get(routes::schema::list_foreign_keys))
        .route("/schema/triggers", get(routes::schema::list_triggers))
        .route("/schema/constraints", get(routes::schema::list_constraints))
        .route("/schema/partitions", get(routes::schema::list_partitions))
        .route("/schema/subpartitions", get(routes::schema::list_subpartitions))
        .route("/schema/functions", get(routes::schema::list_functions))
        .route("/schema/opengauss-package-subprograms", get(routes::schema::list_opengauss_package_subprograms))
        .route("/debug/start", post(routes::debug::start))
        .route("/debug/step", post(routes::debug::step))
        .route("/debug/locals", post(routes::debug::locals))
        .route("/debug/set-var", post(routes::debug::set_var))
        .route("/debug/backtrace", post(routes::debug::backtrace))
        .route("/debug/breakpoints", post(routes::debug::breakpoints))
        .route("/debug/breakpoints/add", post(routes::debug::add_breakpoint))
        .route("/debug/breakpoints/delete", post(routes::debug::delete_breakpoint))
        .route("/debug/breakpoints/toggle", post(routes::debug::toggle_breakpoint))
        .route("/debug/stop", post(routes::debug::stop))
        .route("/debug/call-result", post(routes::debug::call_result))
        .route("/schema/sequences", get(routes::schema::list_sequences))
        .route("/schema/rules", get(routes::schema::list_rules))
        .route("/schema/owners", get(routes::schema::list_owners))
        .route("/schema/extensions", get(routes::schema::list_extensions))
        .route("/schema/available-extensions", get(routes::schema::list_available_extensions))
        .route("/schema/synonym-target", get(routes::schema::resolve_synonym_target))
        .route("/schema/type-attributes", get(routes::schema::list_type_attributes))
        .route("/schema/object-references", get(routes::schema::list_object_references))
        .route("/schema/invalid-objects", get(routes::schema::list_invalid_objects))
        .route("/schema/recompile-object", post(routes::schema::recompile_object))
        .route("/schema/opengauss-profiler-status", get(routes::schema::opengauss_profiler_status))
        .route("/schema/opengauss-profiler-run", post(routes::schema::opengauss_profiler_run))
        .route("/schema/ddl", get(routes::schema::get_ddl))
        .route("/dialect/data-types", get(routes::dialect::list_data_types))
        .route("/schema-diff/prepare", post(routes::schema_diff::prepare_schema_diff))
        .route("/schema-diff/generate-sync-sql", post(routes::schema_diff::generate_schema_sync_sql))
        .route(
            "/schema/cache",
            post(routes::schema_cache::save_schema_cache).get(routes::schema_cache::load_schema_cache),
        )
        .route("/schema/cache-prefix", delete(routes::schema_cache::delete_schema_cache_prefix))
        .route(
            "/tab-runtime-cache",
            post(routes::tab_runtime_cache::save_tab_runtime_cache)
                .get(routes::tab_runtime_cache::load_tab_runtime_cache)
                .delete(routes::tab_runtime_cache::delete_tab_runtime_cache),
        )
        .route("/tab-runtime-cache/metadata", get(routes::tab_runtime_cache::list_tab_runtime_cache_metadata))
        .route("/tab-runtime-cache/prune", post(routes::tab_runtime_cache::prune_tab_runtime_cache))
        .route("/tab-runtime-cache/owner", delete(routes::tab_runtime_cache::delete_tab_runtime_cache_owner))
        // Query
        .route("/query/execute", post(routes::query::execute_query))
        .route("/query/execute-multi", post(routes::query::execute_multi))
        .route("/query/execute-batch", post(routes::query::execute_batch))
        .route("/query/execute-script", post(routes::query::execute_script))
        .route("/query/execute-in-transaction", post(routes::query::execute_in_transaction))
        .route("/query/execute-script-2pc", post(routes::query::execute_script_with_2pc))
        .route("/query/analyze-sql-references", post(routes::query::analyze_sql_references))
        .route("/query/find-statement-at-cursor", post(routes::query::find_statement_at_cursor))
        .route("/query/prepare-pagination-plan", post(routes::query::prepare_query_pagination_execution_plan))
        .route("/query/build-sorted-sql", post(routes::query::build_sorted_query_sql))
        .route("/query/build-explain-sql", post(routes::query::build_explain_sql))
        .route("/query/build-dropped-file-preview-sql", post(routes::query::build_dropped_file_preview_sql))
        .route("/query/get-explain-info", post(routes::query::get_explain_info))
        .route("/query/build-create-user-sql", post(routes::query::build_create_user_sql))
        .route("/query/build-table-select-sql", post(routes::query::build_table_select_sql))
        .route("/query/build-database-search-sql", post(routes::query::build_database_search_sql))
        .route("/query/build-search-result-where", post(routes::query::build_search_result_where))
        .route("/query/build-rename-object-sql", post(routes::query::build_rename_object_sql))
        .route("/query/build-create-database-sql", post(routes::query::build_create_database_sql))
        .route("/query/build-sqlite-attach-database-sql", post(routes::query::build_sqlite_attach_database_sql))
        .route("/query/build-drop-object-sql", post(routes::query::build_drop_object_sql))
        .route("/query/build-drop-table-sql", post(routes::query::build_drop_table_sql))
        .route("/query/build-drop-table-child-object-sql", post(routes::query::build_drop_table_child_object_sql))
        .route("/query/build-empty-table-sql", post(routes::query::build_empty_table_sql))
        .route("/query/build-truncate-table-sql", post(routes::query::build_truncate_table_sql))
        .route("/query/build-drop-database-sql", post(routes::query::build_drop_database_sql))
        .route("/query/build-create-schema-sql", post(routes::query::build_create_schema_sql))
        .route("/query/build-update-database-properties-sql", post(routes::query::build_update_database_properties_sql))
        .route("/query/build-drop-schema-sql", post(routes::query::build_drop_schema_sql))
        .route("/query/build-duplicate-table-structure-sql", post(routes::query::build_duplicate_table_structure_sql))
        .route("/query/build-copy-table-data-sql", post(routes::query::build_copy_table_data_sql))
        .route(
            "/query/build-executable-object-source-statements",
            post(routes::query::build_executable_object_source_statements),
        )
        .route("/query/build-executable-object-source-sql", post(routes::query::build_executable_object_source_sql))
        .route("/query/build-editable-object-source", post(routes::query::build_editable_object_source))
        .route(
            "/query/build-routine-rename-object-source-statements",
            post(routes::query::build_routine_rename_object_source_statements),
        )
        .route("/query/build-view-ddl-sql", post(routes::query::build_view_ddl_sql))
        .route("/query/build-table-structure-change-sql", post(routes::query::build_table_structure_change_sql))
        .route(
            "/query/preview-sqlite-table-structure-change",
            post(routes::query::preview_sqlite_table_structure_change),
        )
        .route("/query/apply-sqlite-table-structure-change", post(routes::query::apply_sqlite_table_structure_change))
        .route("/query/build-create-table-sql", post(routes::query::build_create_table_sql))
        .route("/query/build-single-column-alter-sql", post(routes::query::build_single_column_alter_sql))
        .route("/query/analyze-editability", post(routes::query::analyze_editable_query_editability))
        .route("/query/prepare-data-grid-save", post(routes::query::prepare_data_grid_save))
        .route("/query/data-grid-extractor-openapi.json", get(openapi_json))
        .route(
            "/query/extract-data-grid-selection",
            post(routes::query::extract_data_grid_selection)
                .layer(DefaultBodyLimit::max(DATA_GRID_EXTRACTOR_BODY_LIMIT_BYTES)),
        )
        .route(
            "/query/build-data-grid-copy-update-statements",
            post(routes::query::build_data_grid_copy_update_statements),
        )
        .route(
            "/query/build-data-grid-copy-insert-statement",
            post(routes::query::build_data_grid_copy_insert_statement),
        )
        .route(
            "/query/build-data-grid-context-filter-condition",
            post(routes::query::build_data_grid_context_filter_condition),
        )
        .route(
            "/query/build-data-grid-column-value-filter-condition",
            post(routes::query::build_data_grid_column_value_filter_condition),
        )
        .route(
            "/query/build-data-grid-column-values-filter-condition",
            post(routes::query::build_data_grid_column_values_filter_condition),
        )
        .route(
            "/query/build-data-grid-column-distinct-values-sql",
            post(routes::query::build_data_grid_column_distinct_values_sql),
        )
        .route("/query/build-data-grid-count-sql", post(routes::query::build_data_grid_count_sql))
        .route("/query/build-hive-table-properties-sql", post(routes::query::build_hive_table_properties_sql))
        .route("/query/build-export-insert-statements", post(routes::query::build_export_insert_statements))
        .route("/query/build-export-sql-insert", post(routes::query::build_export_sql_insert))
        .route("/query/build-database-sql-export", post(routes::query::build_database_sql_export))
        .route("/data-compare/prepare", post(routes::data_compare::prepare_data_compare))
        .route("/data-compare/prepare-from-tables", post(routes::data_compare::prepare_data_compare_from_tables))
        .route("/data-compare/prepare-missing-target", post(routes::data_compare::prepare_data_compare_missing_target))
        .route("/data-compare/build-sync-plan", post(routes::data_compare::build_data_compare_sync_plan))
        .route("/query/cancel", post(routes::query::cancel_query))
        .route("/query/close-session", post(routes::query::close_query_session))
        .route("/query/close-client-session", post(routes::query::close_client_connection_session))
        .route("/export/query-result-json", post(routes::text_export::export_query_result_json))
        .route("/export/query-result-markdown", post(routes::text_export::export_query_result_markdown))
        // History
        .route("/history", get(routes::history::load_history).delete(routes::history::clear_history))
        .route("/history/save", post(routes::history::save_history))
        .route("/history/search", post(routes::history::search_history))
        .route("/history/options", get(routes::history::load_history_connection_options))
        .route("/history/{id}", delete(routes::history::delete_history_entry))
        // Saved SQL
        .route(
            "/saved-sql",
            get(routes::saved_sql::load_saved_sql_library).post(routes::saved_sql::save_saved_sql_file),
        )
        .route(
            "/saved-sql/{id}",
            get(routes::saved_sql::load_saved_sql_file).delete(routes::saved_sql::delete_saved_sql_file),
        )
        .route("/saved-sql/folders", post(routes::saved_sql::save_saved_sql_folder))
        .route("/saved-sql/folders/{id}", delete(routes::saved_sql::delete_saved_sql_folder))
        // AI
        .route("/ai/config", post(routes::ai::save_ai_config).get(routes::ai::load_ai_config))
        .route("/ai/provider-config", post(routes::ai::save_ai_provider_config))
        .route("/ai/provider-configs", get(routes::ai::load_ai_provider_configs))
        .route("/ai/chat-selection", post(routes::ai::save_ai_chat_selection).get(routes::ai::load_ai_chat_selection))
        .route("/ai/configs", post(routes::ai::save_ai_configs).get(routes::ai::load_ai_configs))
        .route("/ai/default-config", post(routes::ai::set_default_ai_config))
        .route("/ai/config-item", post(routes::ai::save_ai_config_item))
        .route("/ai/config/{config_id}", delete(routes::ai::delete_ai_config))
        .route("/ai/conversation", post(routes::ai::save_ai_conversation))
        .route("/ai/conversations", get(routes::ai::load_ai_conversations))
        .route("/ai/conversation/{id}", delete(routes::ai::delete_ai_conversation))
        .route("/ai/complete", post(routes::ai::ai_complete))
        .route("/ai/stream", post(routes::ai::ai_stream))
        .route("/ai/agent-stream", post(routes::ai::ai_agent_stream))
        .route("/ai/cancel-stream", post(routes::ai::ai_cancel_stream))
        .route("/ai/test-connection", post(routes::ai::ai_test_connection))
        .route("/ai/models", post(routes::ai::ai_list_models))
        .route("/ai/model-effort", post(routes::ai::ai_resolve_model_effort))
        // Prompt templates
        .route(
            "/prompt-templates",
            get(routes::prompt_template::load_prompt_templates).post(routes::prompt_template::save_prompt_template),
        )
        .route("/prompt-templates/{id}", delete(routes::prompt_template::delete_prompt_template))
        .route(
            "/prompt-templates/global-instructions",
            get(routes::prompt_template::get_global_instructions).put(routes::prompt_template::set_global_instructions),
        )
        // Transfer
        .route("/transfer/start", post(routes::transfer::start_transfer))
        .route("/transfer/ownership-preview", post(routes::transfer::preview_transfer_ownership))
        .route("/transfer/progress/{transferId}", get(routes::transfer::transfer_progress))
        .route("/transfer/cancel", post(routes::transfer::cancel_transfer))
        .route("/transfer/sort-tables-by-fk", post(routes::transfer::sort_tables_by_fk_dependency))
        // Database export
        .route("/export/database", post(routes::database_export::start_database_export))
        .route("/export/database/progress/{exportId}", get(routes::database_export::database_export_progress))
        .route("/export/database/cancel", post(routes::database_export::cancel_database_export))
        .route("/export/database/download/{exportId}", get(routes::database_export::database_export_download))
        // Table export
        .route("/export/table", post(routes::table_export::start_table_export))
        .route("/export/table/progress/{exportId}", get(routes::table_export::table_export_progress))
        .route("/export/table/download/{exportId}", get(routes::table_export::table_export_download))
        .route("/export/table/cancel", post(routes::table_export::cancel_table_export))
        // Query result export
        .route("/export/query-result", post(routes::query_result_export::start_query_result_export))
        .route(
            "/export/query-result/progress/{exportId}",
            get(routes::query_result_export::query_result_export_progress),
        )
        .route(
            "/export/query-result/download/{exportId}",
            get(routes::query_result_export::query_result_export_download),
        )
        .route("/export/query-result/cancel", post(routes::query_result_export::cancel_query_result_export))
        // SQL file
        .route(
            "/sql-file/preview",
            post(routes::sql_file::preview_sql_file)
                .layer(DefaultBodyLimit::max(routes::sql_file::SQL_FILE_UPLOAD_MAX_BYTES.saturating_add(1024 * 1024))),
        )
        .route("/sql-file/execute", post(routes::sql_file::execute_sql_file))
        .route("/sql-file/progress/{executionId}", get(routes::sql_file::sql_file_progress))
        .route("/sql-file/cancel", post(routes::sql_file::cancel_sql_file))
        // Table import
        .route("/import/preview", post(routes::table_import::preview_import))
        .route("/import/preview-source", post(routes::table_import::preview_uploaded_import))
        .route("/import/source/release", post(routes::table_import::release_import_source))
        .route("/import/execute", post(routes::table_import::execute_import))
        .route("/import/progress/{importId}", get(routes::table_import::import_progress))
        .route("/import/cancel", post(routes::table_import::cancel_import))
        // Update
        .route("/version", get(routes::update::get_version))
        .route("/update/check", get(routes::update::check_for_updates))
        .route("/changelog", get(routes::update::fetch_changelog))
        // Layout
        .route("/layout/sidebar", post(routes::layout::save_sidebar_layout).get(routes::layout::load_sidebar_layout))
        // App settings
        .route(
            "/app-settings/pinned-tree-node-ids",
            get(routes::app_settings::load_pinned_tree_node_ids).post(routes::app_settings::save_pinned_tree_node_ids),
        )
        .route(
            "/app-settings/max-agent-turns",
            get(routes::app_settings::load_max_agent_turns).put(routes::app_settings::save_max_agent_turns),
        )
        .route(
            "/app-settings/max-retries",
            get(routes::app_settings::load_max_retries).put(routes::app_settings::save_max_retries),
        )
        .route("/app-settings/config/decrypt", post(routes::app_settings::decrypt_config));

    let api = api
        .layer(middleware::from_fn_with_state(web_state.clone(), auth::auth_middleware))
        .with_state(web_state.clone());

    // Build app
    let mut app = Router::new()
        .nest("/api", api)
        .layer(DefaultBodyLimit::max(web_body_limit_bytes()))
        .layer(CompressionLayer::new().compress_when(web_compression_predicate()))
        .layer(tower_http::trace::TraceLayer::new_for_http());

    // Static file serving
    if let Ok(static_dir) = ogdeveloper_core::branding::var("OGDEVELOPER_STATIC_DIR") {
        use tower_http::services::{ServeDir, ServeFile};
        let index_path = format!("{}/index.html", static_dir);
        let serve_dir = ServeDir::new(&static_dir).not_found_service(ServeFile::new(&index_path));
        // Cache policy: hashed build assets (dist/assets/*) are immutable, but
        // index.html (and the SPA fallback) must always revalidate — otherwise
        // browsers keep serving a stale app for hours after a redeploy
        // (heuristic caching from Last-Modified), which looks like "the fix
        // did not land".
        let serve_router = Router::new().fallback_service(serve_dir).layer(middleware::from_fn(static_cache_headers));
        app = app.fallback_service(serve_router);
    }

    if public_base_path != "/" {
        app = Router::new().nest(&public_base_path, app);
    }

    // Bind address
    let port: u16 =
        ogdeveloper_core::branding::var("OGDEVELOPER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4224);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!("ogdeveloper Web server starting on http://{}", addr);
    if public_base_path != "/" {
        tracing::info!("Serving ogdeveloper Web under context path {}", public_base_path);
    }
    if password_disabled {
        tracing::info!("Password protection is disabled");
    } else if ogdeveloper_core::branding::var("OGDEVELOPER_PASSWORD").is_ok() {
        tracing::info!("Password protection is enabled");
    }

    let listener = tokio::net::TcpListener::bind(addr).await.expect("Failed to bind address");
    let shutdown_state = web_state.app.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            if let Err(error) = tokio::signal::ctrl_c().await {
                tracing::warn!("Failed to listen for shutdown signal: {error}");
            }
        })
        .await
        .expect("Server error");
    shutdown_state.shutdown(std::time::Duration::from_secs(3)).await;
}

#[cfg(test)]
mod tests {
    use super::{normalize_public_base_path, web_agent_dir_from_env, web_compression_predicate, XLSX_CONTENT_TYPE};
    use axum::body::Body;
    use axum::http::header::CONTENT_TYPE;
    use axum::http::Response;
    use tower_http::compression::predicate::Predicate;

    fn compression_response(content_type: &str) -> Response<Body> {
        Response::builder().header(CONTENT_TYPE, content_type).body(Body::from(vec![b'x'; 64])).unwrap()
    }

    #[test]
    fn web_compression_skips_streams_and_precompressed_exports() {
        let predicate = web_compression_predicate();

        assert!(predicate.should_compress(&compression_response("application/json")));
        assert!(!predicate.should_compress(&compression_response("text/event-stream")));
        assert!(!predicate.should_compress(&compression_response(XLSX_CONTENT_TYPE)));
    }

    #[test]
    fn normalize_public_base_path_defaults_to_root() {
        assert_eq!(normalize_public_base_path(None), "/");
        assert_eq!(normalize_public_base_path(Some("".to_string())), "/");
        assert_eq!(normalize_public_base_path(Some("/".to_string())), "/");
    }

    #[test]
    fn normalize_public_base_path_trims_and_preserves_segments() {
        assert_eq!(normalize_public_base_path(Some("dbx".to_string())), "/dbx");
        assert_eq!(normalize_public_base_path(Some("/dbx/".to_string())), "/dbx");
        assert_eq!(normalize_public_base_path(Some("/tools/dbx/?v=1".to_string())), "/tools/dbx");
    }

    #[test]
    #[should_panic(expected = "OGDEVELOPER_PUBLIC_BASE_PATH contains invalid characters")]
    fn normalize_public_base_path_rejects_invalid_characters() {
        normalize_public_base_path(Some("/dbx admin".to_string()));
    }

    #[test]
    fn web_agent_dir_defaults_under_data_dir() {
        let data_dir = std::path::PathBuf::from("/app/data");
        assert_eq!(web_agent_dir_from_env(&data_dir, None), data_dir.join("agents"));
    }

    #[test]
    fn web_agent_dir_uses_explicit_env_override() {
        let data_dir = std::path::PathBuf::from("/app/data");
        assert_eq!(
            web_agent_dir_from_env(&data_dir, Some("/custom/agents".to_string())),
            std::path::PathBuf::from("/custom/agents")
        );
    }
}
