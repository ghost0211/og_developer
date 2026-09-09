use super::identifiers::{normalize_where_input, qualified_table_name, quote_table_identifier};
use super::types::{TableDataSelectSqlOptions, TableSelectSqlOptions};
use crate::models::connection::DatabaseType;

pub fn build_count_table_sql(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
    format!("SELECT COUNT(*) AS row_count FROM {}", qualified_table_name(database_type, schema, table_name))
}

pub fn build_table_data_select_sql(options: TableDataSelectSqlOptions) -> String {
    let database_type = options.database_type;
    let limit = options.limit.unwrap_or(100);
    let table = qualified_table_name(database_type, options.schema.as_deref(), &options.table_name);
    let predicate = normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let order = options
        .order_by
        .as_deref()
        .filter(|order| !order.trim().is_empty())
        .map(|order_by| format!(" ORDER BY {order_by}"))
        .unwrap_or_default();
    let offset = options.offset.unwrap_or(0);
    let select_columns = build_select_columns(database_type, &options.columns);
    let offset_clause = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };

    format!("SELECT {select_columns} FROM {table}{where_clause}{order} LIMIT {limit}{offset_clause}")
}

pub fn build_table_select_sql(options: TableSelectSqlOptions) -> String {
    let database_type = options.database_type;
    let table = qualified_table_name(database_type, options.schema, options.table_name);
    let limit = options.limit;
    let select_columns = build_select_columns(database_type, options.columns);
    format!("SELECT {select_columns} FROM {table} LIMIT {limit}")
}

fn build_select_columns(database_type: Option<DatabaseType>, columns: &[String]) -> String {
    if columns.is_empty() {
        "*".to_string()
    } else {
        columns.iter().map(|column| quote_table_identifier(database_type, column)).collect::<Vec<_>>().join(", ")
    }
}
