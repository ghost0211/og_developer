use ogdeveloper_core::models::connection::DatabaseType;
use ogdeveloper_core::schema_diff::{
    generate_schema_sync_sql, prepare_schema_diff, SchemaDiffPreparationOptions, TableSchemaDetail,
};
use ogdeveloper_core::sql_dialect::descriptor::DialectKind;
use ogdeveloper_core::types::{ColumnInfo, TableInfo};

fn table(name: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: "BASE TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

fn col(name: &str, data_type: &str) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: false,
        is_unique: false,
        extra: None,
        comment: None,
        numeric_precision: None,
        numeric_scale: None,
        character_maximum_length: None,
        enum_values: None,
        character_set: None,
        collation: None,
    }
}

fn detail(name: &str, columns: Vec<ColumnInfo>) -> TableSchemaDetail {
    TableSchemaDetail {
        name: name.to_string(),
        columns,
        indexes: vec![],
        foreign_keys: vec![],
        triggers: vec![],
        ddl: None,
    }
}

#[test]
fn opengauss_to_postgresql_full_chain_diff_and_sql_generation() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("users")],
        target_tables: vec![table("users")],
        source_details: vec![detail(
            "users",
            vec![col("id", "int"), col("name", "varchar(64)"), col("email", "varchar(128)")],
        )],
        target_details: vec![detail(
            "users",
            vec![col("id", "serial"), col("name", "text"), col("email", "varchar(128)"), col("age", "int")],
        )],
        database_type: DatabaseType::Postgres,
        source_dialect: Some(DialectKind::Opengauss),
        target_dialect: Some(DialectKind::Postgres),
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    assert!(!result.diffs.is_empty(), "Should detect differences between openGauss and PG schemas");
    let pg_sql = &result.sync_sql;
    assert!(pg_sql.contains("users"));
}

#[test]
fn schema_sync_sql_generation_postgres() {
    let options = SchemaDiffPreparationOptions {
        source_tables: vec![table("products")],
        target_tables: vec![table("products")],
        source_details: vec![detail("products", vec![col("id", "int"), col("name", "varchar(100)")])],
        target_details: vec![detail(
            "products",
            vec![col("id", "int"), col("name", "text"), col("price", "numeric(10,2)")],
        )],
        database_type: DatabaseType::Postgres,
        source_dialect: Some(DialectKind::Postgres),
        target_dialect: Some(DialectKind::Postgres),
        ..Default::default()
    };

    let result = prepare_schema_diff(options);
    let sql =
        generate_schema_sync_sql(&result.diffs, &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
    assert!(!sql.is_empty());
}
