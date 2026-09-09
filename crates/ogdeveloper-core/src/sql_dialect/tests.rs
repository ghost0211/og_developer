use super::*;
use crate::models::connection::DatabaseType;

#[test]
fn quotes_identifiers_by_database_type() {
    assert_eq!(quote_table_identifier(Some(DatabaseType::Postgres), "user\"name"), "\"user\"\"name\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Opengauss), "\"MixedCase\""), "\"MixedCase\"");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "users_1"), "users_1");
    assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "user name"), "user name");
}

#[test]
fn quotes_gaussdb_jdbc_identifiers_selectively() {
    assert_eq!(quote_table_data_identifier(Some(DatabaseType::Opengauss), "schema_01", Some("\"")), "\"schema_01\"");
    assert_eq!(
        quote_table_data_identifier(Some(DatabaseType::Opengauss), "\"AlreadyQuoted\"", Some("\"")),
        "\"AlreadyQuoted\""
    );
}

#[test]
fn qualifies_schema_only_for_schema_aware_databases() {
    assert_eq!(qualified_table_name(Some(DatabaseType::Postgres), Some("public"), "users"), "\"public\".\"users\"");
    assert_eq!(qualified_table_name(Some(DatabaseType::Opengauss), Some("public"), "users"), "\"public\".\"users\"");
}

#[test]
fn maps_table_pagination_strategy_by_database_type() {
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Postgres)), TablePaginationStrategy::LimitOffset);
    assert_eq!(table_pagination_strategy(Some(DatabaseType::Opengauss)), TablePaginationStrategy::LimitOffset);
    assert_eq!(table_pagination_strategy(None), TablePaginationStrategy::LimitOffset);
}

#[test]
fn builds_select_sql_with_limit_syntax_for_database_type() {
    let columns = vec!["id".to_string(), "name".to_string()];
    let keys = vec!["id".to_string()];

    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public"),
            table_name: "users",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM \"public\".\"users\" LIMIT 100"
    );
    assert_eq!(
        build_table_select_sql(TableSelectSqlOptions {
            database_type: Some(DatabaseType::Opengauss),
            schema: Some("public"),
            table_name: "users",
            columns: &columns,
            order_columns: &keys,
            limit: 100,
        }),
        "SELECT \"id\", \"name\" FROM \"public\".\"users\" LIMIT 100"
    );
}

#[test]
fn test_default_dialect_features() {
    assert!(is_schema_aware(DatabaseType::Postgres));
    assert!(is_schema_aware(DatabaseType::Opengauss));
}
