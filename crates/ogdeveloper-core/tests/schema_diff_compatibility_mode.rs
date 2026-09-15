use ogdeveloper_core::models::connection::DatabaseType;
use ogdeveloper_core::schema_diff::{prepare_schema_diff, SchemaDiffPreparationOptions};
use ogdeveloper_core::script_generator::{generate_rollback_script, IdempotentStrategy, RollbackScriptOptions};
use ogdeveloper_core::sql_dialect::ddl_profile::profile_for_connection;
use ogdeveloper_core::types::{ColumnInfo, ForeignKeyInfo, IndexInfo};

fn options(mode: Option<&str>) -> SchemaDiffPreparationOptions {
    serde_json::from_value(serde_json::json!({
        "databaseType": "opengauss", "targetSqlCompatibility": mode,
        "targetSchema": "team`one", "enableRollback": true,
        "sourceTables": [{"name": "order items", "table_type": "TABLE", "comment": "table comment"}],
        "sourceDetails": [{"name": "order items", "columns": [ColumnInfo {
            name: "select".into(), data_type: "integer".into(), comment: Some("column comment".into()), ..Default::default()
        }], "indexes": [IndexInfo {name:"index`name".into(), columns:vec!["select".into()], ..Default::default()}],
        "foreignKeys": [ForeignKeyInfo {name:"foreign key".into(), column:"select".into(), ref_table:"parent table".into(), ref_column:"key".into(), ..Default::default()}]}],
        "sourcePermissions": [{"grantee":"read`role", "objectType":"TABLE", "objectName":"order items", "privilege":"SELECT", "isGrantable":true}]
    })).expect("fixture options")
}

#[test]
fn connection_mode_controls_every_generated_identifier_and_rollback() {
    for mode in ["B", "M", "mysql", " b ", "A", "PG"] {
        let prepared = prepare_schema_diff(options(Some(mode)));
        let profile = profile_for_connection(DatabaseType::OpenGauss, Some(mode));
        let q = |name: &str| profile.quote_ident(name);
        let table = format!("{}.{}", q("team`one"), q("order items"));
        for expected in [
            format!("CREATE TABLE {table}"),
            q("select"),
            q("index`name"),
            q("foreign key"),
            q("parent table"),
            format!("COMMENT ON COLUMN {table}.{}", q("select")),
        ] {
            assert!(prepared.sync_sql.contains(&expected), "{mode}: missing {expected} in {}", prepared.sync_sql);
        }
        assert!(prepared.diffs[0].sync_sql.as_ref().unwrap().contains(&table));
        assert!(prepared.rollback_sync_sql.as_ref().unwrap().contains(&table));
        let permission = prepared.permission_sync_sql.as_ref().unwrap();
        assert!(
            permission.contains(&format!("ON TABLE {table} TO {} WITH GRANT OPTION", q("read`role"))),
            "{permission}"
        );
        let rollback = generate_rollback_script(
            prepared.rollback_graph.as_ref().unwrap(),
            &RollbackScriptOptions {
                db_type: DatabaseType::OpenGauss,
                target_sql_compatibility: Some(mode.into()),
                target_schema: Some("team`one".into()),
                idempotent_strategy: IdempotentStrategy::None,
                ..Default::default()
            },
        );
        assert!(rollback.contains(&table), "{mode}: {rollback}");
    }
}

#[test]
fn compatibility_overrides_only_opengauss_and_escapes_backticks() {
    assert_eq!(profile_for_connection(DatabaseType::OpenGauss, Some("B")).quote_ident("a`b"), "`a``b`");
    for mode in [None, Some("A"), Some("PG"), Some("unknown")] {
        assert_eq!(profile_for_connection(DatabaseType::OpenGauss, mode).quote_ident("a\"b"), "\"a\"\"b\"");
    }
    assert_eq!(profile_for_connection(DatabaseType::Postgres, Some("B")).quote_ident("name"), "\"name\"");
}

#[test]
fn old_preparation_requests_keep_default_quote_rules() {
    let mut value = serde_json::to_value(options(None)).unwrap();
    value.as_object_mut().unwrap().remove("targetSqlCompatibility");
    let options: SchemaDiffPreparationOptions = serde_json::from_value(value).unwrap();
    assert!(options.target_sql_compatibility.is_none());
    assert!(prepare_schema_diff(options).sync_sql.contains("\"order items\""));
}
