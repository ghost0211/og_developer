// ============================================================================
// 12.4 — CLI/Tauri/ogdeveloper-web API Contract Verification
//
// These tests verify that public API types maintain backward-compatible
// serialization contracts (field names, optional field handling) and
// that function signatures haven't changed.
// ============================================================================

use ogdeveloper_core::data_compare::{DataComparePreparation, DataCompareSyncPlan};
use ogdeveloper_core::models::connection::DatabaseType;
use ogdeveloper_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparation, SchemaDiffPreparationOptions};
use ogdeveloper_core::sql_risk::{classify_sql_risk, SqlRisk};
use ogdeveloper_core::types::{ColumnInfo, TableInfo};

// ============================================================================
// Compile-time checks: core function signatures compile
// ============================================================================

/// Verify prepare_schema_diff accepts SchemaDiffPreparationOptions and returns SchemaDiffPreparation
#[test]
fn prepare_schema_diff_function_signature() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        target_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        source_details: vec![],
        target_details: vec![],
        source_functions: vec![],
        target_functions: vec![],
        source_sequences: vec![],
        target_sequences: vec![],
        source_rules: vec![],
        target_rules: vec![],
        source_owners: vec![],
        target_owners: vec![],
        database_type: DatabaseType::Postgres,
        target_schema: None,
        ignore_comments: false,
        cascade_delete: false,
        compare_column_order: false,
        detect_renames: false,
        detect_table_renames: false,
        rename_threshold: 0.5,
        enable_rollback: false,
        batch_patterns: vec![],
        source_dialect: None,
        target_dialect: None,
        compatibility_threshold: 0.5,
        source_permissions: vec![],
        target_permissions: vec![],
        shard_strategy: None,
        resource_constraint: None,
        field_mappings: vec![],
    };
    let _result: SchemaDiffPreparation = prepare_schema_diff(options);
}

/// Verify generate_schema_sync_sql accepts all arg types
#[test]
fn generate_schema_sync_sql_function_signature() {
    let _sql = ogdeveloper_core::schema_diff::generate_schema_sync_sql(
        &[],
        &[],
        &[],
        &[],
        &[],
        DatabaseType::Postgres,
        None,
        false,
        None,
        &[],
    );
}

/// Verify classify_sql_risk function signature
#[test]
fn classify_sql_risk_function_signature() {
    let _risk: SqlRisk = classify_sql_risk("SELECT 1", "postgres").unwrap();
}

// ============================================================================
// Serialization contract: field naming conventions
// ============================================================================

/// SchemaDiffPreparation fields use camelCase in JSON
#[test]
fn schema_diff_preparation_field_names() {
    let result = prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        target_tables: vec![TableInfo {
            name: "t".to_string(),
            table_type: "TABLE".to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }],
        source_details: vec![],
        target_details: vec![],
        source_functions: vec![],
        target_functions: vec![],
        source_sequences: vec![],
        target_sequences: vec![],
        source_rules: vec![],
        target_rules: vec![],
        source_owners: vec![],
        target_owners: vec![],
        database_type: DatabaseType::Postgres,
        target_schema: None,
        ignore_comments: false,
        cascade_delete: false,
        compare_column_order: false,
        detect_renames: false,
        detect_table_renames: false,
        rename_threshold: 0.5,
        enable_rollback: false,
        batch_patterns: vec![],
        source_dialect: None,
        target_dialect: None,
        compatibility_threshold: 0.5,
        source_permissions: vec![],
        target_permissions: vec![],
        shard_strategy: None,
        resource_constraint: None,
        field_mappings: vec![],
    });

    let json = serde_json::to_value(&result).unwrap();
    let obj = json.as_object().unwrap();
    let keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();

    // All keys must be camelCase (no underscores)
    for key in &keys {
        assert!(!key.contains('_'), "Key '{}' should be camelCase, not snake_case", key);
    }

    // Core fields must be present
    assert!(keys.contains(&"diffs"), "diffs field must be present");
    assert!(keys.contains(&"syncSql"), "syncSql field must be present");
}

/// DataComparePreparation fields use camelCase
#[test]
fn data_compare_preparation_field_names() {
    use ogdeveloper_core::data_compare::{DataCompareResult, DataCompareRow};
    use serde_json::Value;

    let prep = DataComparePreparation {
        result: DataCompareResult {
            added: vec![DataCompareRow {
                key: "1".to_string(),
                key_values: [("id".to_string(), Value::Number(1.into()))].into(),
                values: [("name".to_string(), Value::String("Alice".to_string()))].into(),
            }],
            removed: vec![],
            modified: vec![],
        },
        sync_statements: vec!["INSERT INTO t VALUES (1)".to_string()],
        sync_sql: "INSERT INTO t VALUES (1)".to_string(),
    };

    let json = serde_json::to_value(&prep).unwrap();
    let obj = json.as_object().unwrap();
    for key in obj.keys() {
        assert!(!key.contains('_'), "Key '{}' should be camelCase", key);
    }
    assert!(obj.contains_key("result"), "result must be present");
}

/// DataCompareSyncPlan fields use camelCase
#[test]
fn data_compare_sync_plan_field_names() {
    let plan = DataCompareSyncPlan {
        insert_count: 0,
        update_count: 0,
        delete_count: 0,
        statement_count: 0,
        sync_statements: vec![],
        sync_sql: String::new(),
    };

    let json = serde_json::to_value(&plan).unwrap();
    let obj = json.as_object().unwrap();
    for key in obj.keys() {
        assert!(!key.contains('_'), "Key '{}' should be camelCase", key);
    }
}

// ============================================================================
// Type serialization roundtrip: types used in API boundaries
// ============================================================================

/// Core types must serialize/deserialize consistently
#[test]
fn core_types_serialization_roundtrip() {
    let table = TableInfo {
        name: "users".to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: Some("user table".to_string()),
        parent_schema: Some("public".to_string()),
        parent_name: None,
    };
    let json = serde_json::to_value(&table).unwrap();
    let deserialized: TableInfo = serde_json::from_value(json).unwrap();
    assert_eq!(table.name, deserialized.name);
    assert_eq!(table.comment, deserialized.comment);
}

/// ColumnInfo must serialize/deserialize consistently
#[test]
fn column_info_serialization_roundtrip() {
    let col = ColumnInfo {
        name: "id".to_string(),
        data_type: "int".to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: true,
        is_unique: true,
        extra: None,
        comment: None,
        numeric_precision: Some(10),
        numeric_scale: Some(0),
        character_maximum_length: None,
        enum_values: None,
        character_set: None,
        collation: None,
    };
    let json = serde_json::to_value(&col).unwrap();
    assert_eq!(json.get("is_unique"), Some(&serde_json::json!(true)));
    let deserialized: ColumnInfo = serde_json::from_value(json).unwrap();
    assert_eq!(col.name, deserialized.name);
    assert_eq!(col.numeric_precision, deserialized.numeric_precision);
    assert!(deserialized.is_unique);

    let legacy = serde_json::json!({
        "name": "email",
        "data_type": "varchar",
        "is_nullable": true,
        "column_default": null,
        "is_primary_key": false,
        "extra": null,
        "comment": null,
        "numeric_precision": null,
        "numeric_scale": null,
        "character_maximum_length": 255
    });
    let from_legacy: ColumnInfo = serde_json::from_value(legacy).unwrap();
    assert!(!from_legacy.is_unique);
}

/// TableColumnsResult (get_all_columns) uses snake_case `table_name`, not camelCase.
#[test]
fn table_columns_result_serialization_contract() {
    use ogdeveloper_core::db::TableColumnsResult;

    let result = TableColumnsResult {
        table_name: "users".to_string(),
        columns: vec![ColumnInfo {
            name: "id".to_string(),
            data_type: "int".to_string(),
            is_nullable: false,
            column_default: None,
            is_primary_key: true,
            is_unique: false,
            extra: None,
            comment: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }],
        error: Some("partial".to_string()),
    };
    let json = serde_json::to_value(&result).unwrap();
    let obj = json.as_object().expect("object");
    assert!(obj.contains_key("table_name"));
    assert!(!obj.contains_key("tableName"));
    assert!(obj.contains_key("columns"));
    assert!(obj.contains_key("error"));
    assert_eq!(json["columns"][0]["is_unique"], false);

    let roundtrip: TableColumnsResult = serde_json::from_value(json).unwrap();
    assert_eq!(roundtrip.table_name, "users");
    assert_eq!(roundtrip.error.as_deref(), Some("partial"));
    assert_eq!(roundtrip.columns.len(), 1);
}

// ============================================================================
// DatabaseType serialization consistency
// ============================================================================

#[test]
fn database_type_serialization() {
    let json = serde_json::to_value(DatabaseType::Postgres).unwrap();
    assert_eq!(json, "postgres", "DatabaseType serializes using snake_case");

    let json = serde_json::to_value(DatabaseType::Opengauss).unwrap();
    assert_eq!(json, "opengauss", "DatabaseType serializes using snake_case");
}

// ============================================================================
// Tauri command argument compatibility: Option parameters
// ============================================================================

/// Verify that the types used as Tauri command args serialize/deserialize properly.
/// Tauri passes these as JSON from the frontend, so serde roundtrip must work.
#[test]
fn option_types_work_in_tauri_command_boundary() {
    // Simulate how Tauri passes optional params from JS frontend
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TauriLikeCommand {
        diffs: Vec<ogdeveloper_core::schema_diff::TableDiff>,
        function_diffs: Option<Vec<ogdeveloper_core::schema_diff::FunctionDiff>>,
        cascade_delete: Option<bool>,
        target_schema: Option<String>,
    }

    // Without optional params (frontend omitting them)
    let input = serde_json::json!({
        "diffs": [],
        "functionDiffs": null,
        "cascadeDelete": null,
        "targetSchema": null
    });
    let cmd: TauriLikeCommand = serde_json::from_value(input).unwrap();
    assert!(cmd.function_diffs.is_none());
    assert!(cmd.cascade_delete.is_none());

    // With explicit values
    let input = serde_json::json!({
        "diffs": [],
        "cascadeDelete": true
    });
    let cmd: TauriLikeCommand = serde_json::from_value(input).unwrap();
    assert_eq!(cmd.cascade_delete, Some(true));
}

// ============================================================================
// Web API request compatibility
// ============================================================================

/// Verify GenerateSchemaSyncSqlRequest contract matches the core function signature
#[test]
fn web_api_schema_sync_request_fields() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)]
    struct WebApiRequest {
        diffs: Vec<ogdeveloper_core::schema_diff::TableDiff>,
        function_diffs: Option<Vec<ogdeveloper_core::schema_diff::FunctionDiff>>,
        sequence_diffs: Option<Vec<ogdeveloper_core::schema_diff::SequenceDiff>>,
        rule_diffs: Option<Vec<ogdeveloper_core::schema_diff::RuleDiff>>,
        owner_diffs: Option<Vec<ogdeveloper_core::schema_diff::OwnerDiff>>,
        database_type: DatabaseType,
        target_schema: Option<String>,
        cascade_delete: Option<bool>,
    }

    let json = serde_json::json!({
        "diffs": [],
        "databaseType": "postgres"
    });
    let req: WebApiRequest = serde_json::from_value(json).unwrap();
    assert!(req.diffs.is_empty());
    assert_eq!(req.database_type, DatabaseType::Postgres);
    assert!(req.target_schema.is_none());
    assert!(req.cascade_delete.is_none());
}

// ============================================================================
// SqlRisk enum backward compat: JSON serialization
// ============================================================================

#[test]
fn sql_risk_json_representation() {
    assert_eq!(serde_json::to_value(SqlRisk::ReadOnly).unwrap(), "ReadOnly");
    assert_eq!(serde_json::to_value(SqlRisk::Write).unwrap(), "Write");
    assert_eq!(serde_json::to_value(SqlRisk::Ddl).unwrap(), "Ddl");
    assert_eq!(serde_json::to_value(SqlRisk::Transaction).unwrap(), "Transaction");
}

// ============================================================================
// ExternalDriver JSON-RPC contract verification
// ============================================================================

#[cfg(unix)]
#[tokio::test]
async fn external_driver_schema_and_query_contract_includes_connection() {
    use ogdeveloper_core::connection::{AppState, PoolKind};
    use ogdeveloper_core::models::connection::ConnectionConfig;
    use ogdeveloper_core::plugins::{PluginDriverManifest, PluginManifest, PluginRegistry, PluginRuntimeEnv};
    use ogdeveloper_core::query::{execute_sql_statement, QueryExecutionOptions};
    use ogdeveloper_core::schema::{get_columns_core, list_databases_core, list_schemas_core, list_tables_core};
    use ogdeveloper_core::storage::Storage;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    let dir = std::env::temp_dir().join(format!("dbx-contract-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let executable = dir.join("plugin.sh");
    let calls = dir.join("calls.log");
    let script = format!(
        r#"#!/bin/sh
CALLS='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CALLS"
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  method=$(printf '%s' "$line" | sed -E 's/.*"method":"([^"]+)".*/\1/')
  case "$method" in
    connect)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"ok":true}}}}\n' "$id"
      ;;
    listDatabases)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[{{"name":"postgres"}}]}}\n' "$id"
      ;;
    listSchemas)
      printf '{{"jsonrpc":"2.0","id":%s,"result":["public"]}}\n' "$id"
      ;;
    listSchemaInfos)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[{{"name":"public","comment":null}}]}}\n' "$id"
      ;;
    listDataTypes)
      printf '{{"jsonrpc":"2.0","id":%s,"result":["int4","text"]}}\n' "$id"
      ;;
    listTables)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[{{"name":"t1","table_type":"BASE TABLE"}}]}}\n' "$id"
      ;;
    listObjects)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[{{"name":"t1","object_type":"TABLE","schema":"public"}}]}}\n' "$id"
      ;;
    listObjectStatistics)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    getColumns)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[{{"name":"id","data_type":"integer","is_nullable":false,"column_default":null,"is_primary_key":false}}]}}\n' "$id"
      ;;
    listIndexes)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    listForeignKeys)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    listTriggers)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    listFunctions)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    listSequences)
      printf '{{"jsonrpc":"2.0","id":%s,"result":[]}}\n' "$id"
      ;;
    getTableDdl)
      printf '{{"jsonrpc":"2.0","id":%s,"result":"CREATE TABLE public.t1 (id integer);"}}\n' "$id"
      ;;
    getObjectSource)
      printf '{{"jsonrpc":"2.0","id":%s,"result":"SELECT 1;"}}\n' "$id"
      ;;
    getExplainInfo)
      printf '{{"jsonrpc":"2.0","id":%s,"result":{{"plan":"Seq Scan on t1"}}}}\n' "$id"
      ;;
    executeQuery)
      sql=$(printf '%s' "$line" | sed -E 's/.*"sql":"([^"]+)".*/\1/')
      case "$sql" in
        *pg_get_tabledef*)
          printf '{{"jsonrpc":"2.0","id":%s,"result":{{"columns":["val"],"column_types":["text"],"rows":[["CREATE TABLE public.t1 (id integer);"]],"affected_rows":0,"execution_time_ms":0}}}}\n' "$id"
          ;;
        *pg_database*)
          printf '{{"jsonrpc":"2.0","id":%s,"result":{{"columns":["datname"],"column_types":["text"],"rows":[["postgres"]],"affected_rows":0,"execution_time_ms":0}}}}\n' "$id"
          ;;
        *pg_class*|*pg_views*|*pg_proc*|*gs_source*|*pg_matviews*)
          printf '{{"jsonrpc":"2.0","id":%s,"result":{{"columns":["source"],"column_types":["text"],"rows":[["SELECT 1;"]],"affected_rows":0,"execution_time_ms":0}}}}\n' "$id"
          ;;
        *)
          printf '{{"jsonrpc":"2.0","id":%s,"result":{{"columns":["val"],"column_types":["text"],"rows":[["hello"]],"affected_rows":0,"execution_time_ms":0}}}}\n' "$id"
          ;;
      esac
      ;;
    *)
      printf '{{"jsonrpc":"2.0","id":%s,"result":null}}\n' "$id"
      ;;
  esac
done
"#,
        calls.display()
    );
    std::fs::write(&executable, script).unwrap();
    let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions).unwrap();

    let manifest = PluginManifest {
        id: "jdbc".to_string(),
        name: "JDBC".to_string(),
        version: "test".to_string(),
        protocol_version: 1,
        description: String::new(),
        executable: Some("plugin.sh".to_string()),
        drivers: vec![PluginDriverManifest {
            id: "jdbc".to_string(),
            label: "JDBC".to_string(),
            kind: "external".to_string(),
            database_type: Some("jdbc".to_string()),
        }],
    };

    let plugins_dir = dir.join("plugins");
    let plugin_jdbc_dir = plugins_dir.join("jdbc");
    std::fs::create_dir_all(&plugin_jdbc_dir).unwrap();
    std::fs::write(plugin_jdbc_dir.join("manifest.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
    std::fs::copy(&executable, plugin_jdbc_dir.join("plugin.sh")).unwrap();

    let pm = PluginRegistry::new(plugins_dir.clone());
    let session =
        pm.start_driver_session_with_env("jdbc", PluginRuntimeEnv::default()).await.expect("start mock session");

    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new_with_plugin_dir(storage, plugins_dir);

    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-contract-1",
        "name": "Test JDBC",
        "db_type": "opengauss",
        "driver_profile": "opengauss-jdbc",
        "host": "127.0.0.1",
        "port": 5432,
        "username": "gaussdb",
        "password": "password",
        "database": "postgres",
        "query_timeout_secs": 30
    }))
    .unwrap();

    state.configs.write().await.insert(config.id.clone(), config.clone());
    state.connections.write().await.insert(
        config.id.clone(),
        PoolKind::ExternalDriver {
            driver_id: "jdbc".to_string(),
            config: Arc::new(config.clone()),
            session: session.clone(),
        },
    );
    state.connections.write().await.insert(
        format!("{}:postgres", config.id),
        PoolKind::ExternalDriver {
            driver_id: "jdbc".to_string(),
            config: Arc::new(config.clone()),
            session: session.clone(),
        },
    );

    // 1. Verify list_databases_core sends "connection".
    // Postgres-family configs enumerate databases via SQL on the same session
    // (the openGauss JDBC driver's getCatalogs() only reports the current
    // database), so this exercises the mock's executeQuery ("postgres" row).
    let dbs = list_databases_core(&state, &config.id).await.expect("list_databases_core succeeds");
    assert_eq!(dbs.len(), 1);
    assert_eq!(dbs[0].name, "postgres");

    // 1b. Non-postgres-family (plain jdbc) configs still use the plugin's
    // listDatabases method.
    let jdbc_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-contract-jdbc",
        "name": "Test Plain JDBC",
        "db_type": "jdbc",
        "driver_profile": "jdbc",
        "host": "127.0.0.1",
        "port": 5432,
        "username": "sa",
        "password": "password",
        "database": "postgres",
        "query_timeout_secs": 30
    }))
    .unwrap();
    state.configs.write().await.insert(jdbc_config.id.clone(), jdbc_config.clone());
    state.connections.write().await.insert(
        jdbc_config.id.clone(),
        PoolKind::ExternalDriver {
            driver_id: "jdbc".to_string(),
            config: Arc::new(jdbc_config.clone()),
            session: session.clone(),
        },
    );
    let jdbc_dbs = list_databases_core(&state, &jdbc_config.id).await.expect("list_databases_core (jdbc) succeeds");
    assert_eq!(jdbc_dbs.len(), 1);
    assert_eq!(jdbc_dbs[0].name, "postgres");

    // 2. Verify list_schemas_core sends "connection"
    let schemas = list_schemas_core(&state, &config.id, "postgres").await.expect("list_schemas_core succeeds");
    assert_eq!(schemas, vec!["public".to_string()]);

    // 3. Verify list_schema_infos_core sends "connection"
    let schema_infos = ogdeveloper_core::schema::list_schema_infos_core(&state, &config.id, "postgres", None)
        .await
        .expect("list_schema_infos_core succeeds");
    assert_eq!(schema_infos.len(), 1);

    // 4. Verify list_data_types_core sends "connection"
    let types = ogdeveloper_core::schema::list_data_types_core(&state, &config.id, "postgres", "public", None)
        .await
        .expect("list_data_types_core succeeds");
    assert_eq!(types.len(), 2);

    // 5. Verify list_tables_core sends "connection"
    let tables = list_tables_core(&state, &config.id, "postgres", "public", None, None, None, None, None)
        .await
        .expect("list_tables_core succeeds");
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].name, "t1");

    // 6. Verify list_objects_core sends "connection"
    let objs = ogdeveloper_core::schema::list_objects_core(
        &state, &config.id, "postgres", "public", None, None, None, None, None,
    )
    .await
    .expect("list_objects_core succeeds");
    assert_eq!(objs.len(), 1);

    // 7. Verify get_columns_core sends "connection"
    let cols =
        get_columns_core(&state, &config.id, "postgres", "public", "t1").await.expect("get_columns_core succeeds");
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].name, "id");

    // 8. Verify list_indexes_core sends "connection"
    let idxs = ogdeveloper_core::schema::list_indexes_core(&state, &config.id, "postgres", "public", "t1", None)
        .await
        .expect("list_indexes_core succeeds");
    assert!(idxs.is_empty());

    // 9. Verify list_foreign_keys_core sends "connection"
    let fks = ogdeveloper_core::schema::list_foreign_keys_core(&state, &config.id, "postgres", "public", "t1", None)
        .await
        .expect("list_foreign_keys_core succeeds");
    assert!(fks.is_empty());

    // 10. Verify list_triggers_core sends "connection"
    let trigs = ogdeveloper_core::schema::list_triggers_core(&state, &config.id, "postgres", "public", "t1", None)
        .await
        .expect("list_triggers_core succeeds");
    assert!(trigs.is_empty());

    // 11. Verify list_functions_core sends "connection"
    let fns = ogdeveloper_core::schema::list_functions_core(&state, &config.id, "postgres", "public")
        .await
        .expect("list_functions_core succeeds");
    assert!(fns.is_empty());

    // 12. Verify list_sequences_core sends "connection"
    let seqs = ogdeveloper_core::schema::list_sequences_core(&state, &config.id, "postgres", "public")
        .await
        .expect("list_sequences_core succeeds");
    assert!(seqs.is_empty());

    // 13. Verify get_table_ddl_core sends "connection"
    let ddl = ogdeveloper_core::schema::get_table_ddl_core(&state, &config.id, "postgres", "public", "t1", None)
        .await
        .expect("get_table_ddl_core succeeds");
    assert!(ddl.contains("CREATE TABLE"));

    // 14. Verify get_object_source_core sends "connection"
    let src = ogdeveloper_core::schema::get_object_source_core(
        &state,
        &config.id,
        "postgres",
        "public",
        "v1",
        &ogdeveloper_core::types::ObjectSourceKind::View,
        None,
        None,
    )
    .await
    .expect("get_object_source_core succeeds");
    assert_eq!(src.source, "SELECT 1;");

    // 15. Verify get_agent_explain_info_core sends "connection"
    let plan = ogdeveloper_core::agent_explain::get_agent_explain_info_core(
        &state,
        &config.id,
        Some("postgres"),
        Some("public"),
        "SELECT * FROM t1",
        Some("explain"),
    )
    .await
    .expect("get_agent_explain_info_core succeeds");
    assert_eq!(plan, "Seq Scan on t1");

    // 16. Verify execute_sql_statement sends "connection"
    let res =
        execute_sql_statement(&state, &config.id, "postgres", "SELECT 1", None, None, QueryExecutionOptions::default())
            .await
            .expect("execute_sql_statement succeeds");
    assert_eq!(res.rows.len(), 1);

    // Read logged JSON-RPC requests
    let logged = std::fs::read_to_string(&calls).expect("read calls log");
    let lines: Vec<&str> = logged.lines().collect();
    // openGauss-family JDBC metadata (indexes, foreign keys, triggers,
    // functions, sequences) resolves through the native wire driver pool; only
    // the remaining plugin methods issue RPCs, all of which must carry
    // "connection".
    assert!(lines.len() >= 12, "Expected at least 12 RPC calls, got {}", lines.len());

    for line in lines {
        let val: serde_json::Value = serde_json::from_str(line).unwrap();
        let method = val.get("method").and_then(|m| m.as_str()).unwrap();
        let params = val.get("params").expect("params must be present");
        let conn =
            params.get("connection").unwrap_or_else(|| panic!("method {method} params must contain 'connection'"));
        assert!(conn.is_object(), "method {method} 'connection' must be an object");
        let conn_id = conn.get("id").and_then(|i| i.as_str());
        assert!(
            matches!(conn_id, Some("conn-contract-1") | Some("conn-contract-jdbc")),
            "method {method} connection id must match a test config, got {conn_id:?}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}
