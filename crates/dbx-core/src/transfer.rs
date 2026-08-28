use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::DatabaseType;

static CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

const MAX_TRANSFER_WRITE_SQL_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferOwnershipPreview {
    pub statements: Vec<String>,
}

pub fn validate_transfer_request(_req: &TransferRequest) -> Result<(), String> {
    Ok(())
}

pub async fn preview_transfer_ownership(
    _app: &AppState,
    _req: &TransferRequest,
    _source_db_type: &DatabaseType,
    _target_db_type: &DatabaseType,
    _source_pool_key: &str,
    _target_pool_key: &str,
) -> Result<TransferOwnershipPreview, String> {
    Ok(TransferOwnershipPreview::default())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SqlBatchLimits {
    pub max_rows: usize,
    pub target_sql_bytes: usize,
    pub hard_sql_bytes: Option<usize>,
}

impl SqlBatchLimits {
    pub(crate) fn for_database(_db_type: &DatabaseType, requested_max_rows: usize) -> Self {
        let max_rows = requested_max_rows.max(1);
        let target_sql_bytes = MAX_TRANSFER_WRITE_SQL_BYTES;
        Self { max_rows, target_sql_bytes, hard_sql_bytes: None }
    }

    pub(crate) fn with_hard_sql_bytes(mut self, hard_sql_bytes: Option<usize>) -> Self {
        self.hard_sql_bytes = hard_sql_bytes;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    #[default]
    Append,
    Overwrite,
    Upsert,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferTableNameCase {
    #[default]
    Preserve,
    Lower,
    Upper,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferContent {
    #[default]
    DataOnly,
    StructureAndData,
    StructureOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub transfer_id: String,
    pub source_connection_id: String,
    pub source_database: String,
    pub source_schema: String,
    #[serde(default)]
    pub source_catalog: Option<String>,
    pub target_connection_id: String,
    pub target_database: String,
    pub target_schema: String,
    #[serde(default)]
    pub target_catalog: Option<String>,
    pub tables: Vec<String>,
    pub mode: TransferMode,
    #[serde(default)]
    pub table_name_case: TransferTableNameCase,
    #[serde(default)]
    pub content: TransferContent,
    #[serde(default)]
    pub batch_size: Option<usize>,
    #[serde(default)]
    pub objects: Vec<TransferObjectSelection>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferObjectKind {
    Table,
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Event,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObjectSelection {
    pub name: String,
    pub object_type: TransferObjectKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransferObjectFamily {
    Postgres,
}

pub fn transfer_object_family(db_type: &DatabaseType) -> Option<TransferObjectFamily> {
    match *db_type {
        DatabaseType::Postgres | DatabaseType::Opengauss => Some(TransferObjectFamily::Postgres),
        _ => None,
    }
}

pub fn is_same_transfer_family(a: &DatabaseType, b: &DatabaseType) -> bool {
    match (transfer_object_family(a), transfer_object_family(b)) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => false,
    }
}

pub fn transfer_object_kinds_for_family(family: &TransferObjectFamily) -> Vec<TransferObjectKind> {
    use TransferObjectKind::*;
    match family {
        TransferObjectFamily::Postgres => vec![Table, View, MaterializedView, Procedure, Function, Trigger, Sequence],
    }
}

pub fn transfer_object_kinds(db_type: &DatabaseType) -> Vec<TransferObjectKind> {
    transfer_object_family(db_type).map(|f| transfer_object_kinds_for_family(&f)).unwrap_or_default()
}

pub fn should_copy_data(content: &TransferContent) -> bool {
    !matches!(content, TransferContent::StructureOnly)
}

pub fn should_transfer_schema_objects(content: &TransferContent) -> bool {
    !matches!(content, TransferContent::DataOnly)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Pending,
    Running,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub table: String,
    pub table_index: usize,
    pub total_tables: usize,
    pub rows_transferred: u64,
    pub total_rows: Option<u64>,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub terminal: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferObjectOutcome {
    pub transferred: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

pub fn quote_identifier(name: &str, _db_type: &DatabaseType) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn quote_identifier_with_identifier_quote(
    name: &str,
    _db_type: &DatabaseType,
    identifier_quote: Option<&str>,
) -> String {
    let quote = identifier_quote.unwrap_or("\"");
    format!("{quote}{}{quote}", name.replace(quote, &format!("{quote}{quote}")))
}

pub fn quote_postgres_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn format_pg_array_sql_literal(arr: &[serde_json::Value]) -> String {
    let elems: Vec<String> = arr
        .iter()
        .map(|v| match v {
            serde_json::Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
            serde_json::Value::Null => "NULL".to_string(),
            _ => v.to_string(),
        })
        .collect();
    format!("'{{{}}}'", elems.join(","))
}

pub fn format_ch_array_sql_literal(arr: &[serde_json::Value]) -> String {
    format_pg_array_sql_literal(arr)
}

pub fn is_identity_column_extra(extra: Option<&str>) -> bool {
    extra.is_some_and(|e| {
        e.to_ascii_lowercase().contains("identity") || e.to_ascii_lowercase().contains("auto_increment")
    })
}

pub fn is_mysql_generated_column_extra(extra: Option<&str>) -> bool {
    extra.is_some_and(|e| e.to_ascii_lowercase().contains("generated") || e.to_ascii_lowercase().contains("vritual"))
}

pub fn wrap_dameng_identity_insert_sql_for_table(insert_sql: &str, _full_table: &str) -> String {
    insert_sql.to_string()
}

pub fn qualified_table(table: &str, schema: &str, db_type: &DatabaseType, _catalog: Option<&str>) -> String {
    if schema.trim().is_empty() {
        quote_identifier(table, db_type)
    } else {
        format!("{}.{}", quote_identifier(schema, db_type), quote_identifier(table, db_type))
    }
}

pub fn qualified_table_with_identifier_quote(
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    _catalog: Option<&str>,
    identifier_quote: Option<&str>,
) -> String {
    if schema.trim().is_empty() {
        quote_identifier_with_identifier_quote(table, db_type, identifier_quote)
    } else {
        format!(
            "{}.{}",
            quote_identifier_with_identifier_quote(schema, db_type, identifier_quote),
            quote_identifier_with_identifier_quote(table, db_type, identifier_quote)
        )
    }
}

fn postgres_integer_bounds(data_type: &str) -> Option<(i128, i128)> {
    let lower = data_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ' ']).next().unwrap_or("");
    match base {
        "smallint" | "int2" | "smallserial" | "serial2" => Some((i16::MIN as i128, i16::MAX as i128)),
        "integer" | "int" | "int4" | "serial" | "serial4" => Some((i32::MIN as i128, i32::MAX as i128)),
        "bigint" | "int8" | "bigserial" | "serial8" => Some((i64::MIN as i128, i64::MAX as i128)),
        _ => None,
    }
}

pub fn normalize_integer_literal(raw: &str, _db_type: &DatabaseType, column_type: Option<&str>) -> Option<String> {
    let bounds = column_type.and_then(postgres_integer_bounds)?;
    let trimmed = raw.trim();
    let integer_text = trimmed.strip_suffix(".0").unwrap_or(trimmed);
    let parsed: i128 = integer_text.parse().ok()?;
    (parsed >= bounds.0 && parsed <= bounds.1).then(|| integer_text.to_string())
}

pub fn escape_value(val: &serde_json::Value, db_type: &DatabaseType) -> String {
    escape_value_typed(val, db_type, None)
}

pub fn escape_value_typed(val: &serde_json::Value, db_type: &DatabaseType, column_type: Option<&str>) -> String {
    match val {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        serde_json::Value::Number(n) => {
            if let Some(integer_literal) = normalize_integer_literal(&n.to_string(), db_type, column_type) {
                return integer_literal;
            }
            n.to_string()
        }
        serde_json::Value::String(s) => {
            if let Some(integer_literal) = normalize_integer_literal(s, db_type, column_type) {
                return integer_literal;
            }
            format!("'{}'", s.replace('\'', "''"))
        }
        serde_json::Value::Array(arr) => format_pg_array_sql_literal(arr),
        serde_json::Value::Object(o) => {
            let json = serde_json::to_string(o).unwrap_or_default();
            format!("'{}'", json.replace('\\', "\\\\").replace('\'', "''"))
        }
    }
}

pub fn map_column_type(source_type: &str, _source_db: &DatabaseType, _target_db: &DatabaseType) -> String {
    let t = source_type.trim().to_ascii_lowercase();
    let base = t.split(['(', ' ', '\t', '\n']).next().unwrap_or("").trim_matches('"');
    match base {
        "int" | "integer" | "mediumint" => "INTEGER".into(),
        "smallint" => "SMALLINT".into(),
        "bigint" => "BIGINT".into(),
        "tinyint" | "bool" | "boolean" => "BOOLEAN".into(),
        "float" | "float4" | "real" => "REAL".into(),
        "double" | "double precision" | "float8" => "DOUBLE PRECISION".into(),
        "decimal" | "numeric" | "number" => {
            if t.contains('(') {
                format!("DECIMAL{}", &t[t.find('(').unwrap()..])
            } else {
                "NUMERIC".into()
            }
        }
        "varchar" | "nvarchar" | "character varying" | "varchar2" => {
            if t.contains('(') {
                format!("VARCHAR{}", &t[t.find('(').unwrap()..])
            } else {
                "VARCHAR(255)".into()
            }
        }
        "char" | "nchar" | "character" => {
            if t.contains('(') {
                format!("CHAR{}", &t[t.find('(').unwrap()..])
            } else {
                "CHAR(1)".into()
            }
        }
        "text" | "longtext" | "mediumtext" | "clob" | "nclob" => "TEXT".into(),
        "bytea" | "blob" | "longblob" | "mediumblob" | "tinyblob" | "raw" | "binary" | "varbinary" => "BYTEA".into(),
        "date" => "DATE".into(),
        "time" | "timetz" => "TIME".into(),
        "timestamp" | "timestamptz" | "datetime" | "datetime2" | "smalldatetime" => "TIMESTAMP".into(),
        "json" | "jsonb" => "JSONB".into(),
        "uuid" => "UUID".into(),
        _ => source_type.to_string(),
    }
}

pub fn generate_create_table_ddl(
    columns: &[db::ColumnInfo],
    table: &str,
    _source_schema: &str,
    target_schema: &str,
    target_db: &DatabaseType,
    source_db: &DatabaseType,
    _table_comment: Option<&str>,
    catalog: Option<&str>,
) -> String {
    let full_table = qualified_table(table, target_schema, target_db, catalog);
    let mut col_lines = Vec::with_capacity(columns.len());
    let mut pks = Vec::new();

    for c in columns {
        let qname = quote_identifier(&c.name, target_db);
        let mapped_type = map_column_type(&c.data_type, source_db, target_db);
        let not_null = if !c.is_nullable { " NOT NULL" } else { "" };
        col_lines.push(format!("  {qname} {mapped_type}{not_null}"));
        if c.is_primary_key {
            pks.push(qname);
        }
    }

    let mut ddl = format!("CREATE TABLE IF NOT EXISTS {full_table} (\n{}\n)", col_lines.join(",\n"));
    if !pks.is_empty() {
        ddl = format!(
            "CREATE TABLE IF NOT EXISTS {full_table} (\n{},\n  PRIMARY KEY ({})\n)",
            col_lines.join(",\n"),
            pks.join(", ")
        );
    }
    ddl
}

pub fn generate_comment_ddl(
    columns: &[db::ColumnInfo],
    table: &str,
    schema: &str,
    target_db: &DatabaseType,
    table_comment: Option<&str>,
) -> Vec<String> {
    let full_table = qualified_table(table, schema, target_db, None);
    let mut statements = Vec::new();

    if let Some(comment) = table_comment {
        let trimmed = comment.trim();
        if !trimmed.is_empty() {
            let escaped = trimmed.replace('\'', "''");
            statements.push(format!("COMMENT ON TABLE {full_table} IS '{escaped}'"));
        }
    }

    for c in columns {
        if let Some(ref comment) = c.comment {
            let trimmed = comment.trim();
            if !trimmed.is_empty() {
                let escaped = trimmed.replace('\'', "''");
                let qcol = quote_identifier(&c.name, target_db);
                statements.push(format!("COMMENT ON COLUMN {full_table}.{qcol} IS '{escaped}'"));
            }
        }
    }

    statements
}

fn value_rows_sql(
    rows: &[Vec<serde_json::Value>],
    column_types: &[Option<String>],
    db_type: &DatabaseType,
) -> Vec<String> {
    rows.iter()
        .map(|row| {
            let values: Vec<String> = row
                .iter()
                .enumerate()
                .map(|(i, v)| escape_value_typed(v, db_type, column_types.get(i).and_then(|opt| opt.as_deref())))
                .collect();
            format!("({})", values.join(", "))
        })
        .collect()
}

pub fn generate_insert(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> String {
    generate_insert_typed(columns, &vec![None; columns.len()], rows, table, schema, db_type, None)
}

pub fn generate_insert_typed(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    catalog: Option<&str>,
) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let full_table = qualified_table(table, schema, db_type, catalog);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let value_rows = value_rows_sql(rows, column_types, db_type);
    format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"))
}

pub(crate) fn generate_insert_typed_sql_batches(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    catalog: Option<&str>,
    limits: SqlBatchLimits,
) -> Result<Vec<(String, usize)>, String> {
    let mut batches = Vec::new();
    for chunk in rows.chunks(limits.max_rows.max(1)) {
        let sql = generate_insert_typed(columns, column_types, chunk, table, schema, db_type, catalog);
        batches.push((sql, chunk.len()));
    }
    Ok(batches)
}

pub fn generate_upsert(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
) -> String {
    generate_upsert_typed(columns, &vec![None; columns.len()], rows, table, schema, db_type, pk_columns, None)
}

pub fn generate_upsert_typed(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
    catalog: Option<&str>,
) -> String {
    if rows.is_empty() || pk_columns.is_empty() {
        return String::new();
    }

    let full_table = qualified_table(table, schema, db_type, catalog);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let value_rows = value_rows_sql(rows, column_types, db_type);

    let mut non_pk_columns = Vec::with_capacity(columns.len().saturating_sub(pk_columns.len()));
    for c in columns {
        if !pk_columns.contains(c) {
            non_pk_columns.push(c);
        }
    }

    let pk_list = pk_columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let mut sql = format!("INSERT INTO {full_table} ({col_list}) VALUES\n{}", value_rows.join(",\n"));
    if non_pk_columns.is_empty() {
        sql.push_str(&format!("\nON CONFLICT ({pk_list}) DO NOTHING"));
    } else {
        let update_set = non_pk_columns
            .iter()
            .map(|c| {
                let qc = quote_identifier(c, db_type);
                format!("{qc} = EXCLUDED.{qc}")
            })
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!("\nON CONFLICT ({pk_list}) DO UPDATE SET {update_set}"));
    }
    sql
}

fn generate_transfer_write_sql(
    mode: &TransferMode,
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    pk_columns: &[String],
    catalog: Option<&str>,
) -> String {
    match mode {
        TransferMode::Upsert => {
            generate_upsert_typed(columns, column_types, rows, table, schema, db_type, pk_columns, catalog)
        }
        _ => generate_insert_typed(columns, column_types, rows, table, schema, db_type, catalog),
    }
}

pub fn pagination_sql(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
) -> String {
    let full_table = qualified_table(table, schema, db_type, None);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    format!("SELECT {col_list} FROM {full_table} LIMIT {limit} OFFSET {offset}")
}

pub fn pagination_sql_with_order(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
    order_by_columns: &[String],
    catalog: Option<&str>,
) -> String {
    let full_table = qualified_table(table, schema, db_type, catalog);
    let col_list = columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
    let order_by = if order_by_columns.is_empty() {
        String::new()
    } else {
        let cols = order_by_columns.iter().map(|c| quote_identifier(c, db_type)).collect::<Vec<_>>().join(", ");
        format!(" ORDER BY {cols}")
    };
    format!("SELECT {col_list} FROM {full_table}{order_by} LIMIT {limit} OFFSET {offset}")
}

#[allow(clippy::too_many_arguments)]
pub fn pagination_sql_with_filter_order(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
    where_input: Option<&str>,
    order_by: Option<&str>,
    default_order_columns: &[String],
) -> String {
    pagination_sql_with_filter_order_and_identifier_quote(
        columns,
        table,
        schema,
        db_type,
        offset,
        limit,
        where_input,
        order_by,
        default_order_columns,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn pagination_sql_with_filter_order_and_identifier_quote(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    offset: u64,
    limit: usize,
    where_input: Option<&str>,
    order_by: Option<&str>,
    default_order_columns: &[String],
    identifier_quote: Option<&str>,
) -> String {
    let full_table = qualified_table_with_identifier_quote(table, schema, db_type, None, identifier_quote);
    let col_list = columns
        .iter()
        .map(|c| quote_identifier_with_identifier_quote(c, db_type, identifier_quote))
        .collect::<Vec<_>>()
        .join(", ");
    let predicate = crate::sql_dialect::normalize_where_input(where_input);
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let order_clause = if let Some(ob) = order_by.filter(|s| !s.trim().is_empty()) {
        format!(" ORDER BY {ob}")
    } else if !default_order_columns.is_empty() {
        let cols = default_order_columns
            .iter()
            .map(|c| quote_identifier_with_identifier_quote(c, db_type, identifier_quote))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" ORDER BY {cols}")
    } else {
        String::new()
    };
    format!("SELECT {col_list} FROM {full_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}")
}

pub fn count_sql(table: &str, schema: &str, db_type: &DatabaseType, catalog: Option<&str>) -> String {
    count_sql_with_where(table, schema, db_type, None, catalog)
}

pub fn count_sql_with_where(
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    where_input: Option<&str>,
    catalog: Option<&str>,
) -> String {
    count_sql_with_where_and_identifier_quote(table, schema, db_type, where_input, catalog, None)
}

pub fn count_sql_with_where_and_identifier_quote(
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    where_input: Option<&str>,
    catalog: Option<&str>,
    identifier_quote: Option<&str>,
) -> String {
    let full_table = qualified_table_with_identifier_quote(table, schema, db_type, catalog, identifier_quote);
    let predicate = crate::sql_dialect::normalize_where_input(where_input);
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    format!("SELECT COUNT(*) FROM {full_table}{where_clause}")
}

pub fn keyset_pagination_sql(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    primary_keys: &[String],
    last_pk_values: &[serde_json::Value],
    limit: usize,
) -> String {
    keyset_pagination_sql_with_identifier_quote(
        columns,
        table,
        schema,
        db_type,
        primary_keys,
        last_pk_values,
        limit,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn keyset_pagination_sql_with_identifier_quote(
    columns: &[String],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    primary_keys: &[String],
    last_pk_values: &[serde_json::Value],
    limit: usize,
    identifier_quote: Option<&str>,
) -> String {
    let full_table = qualified_table_with_identifier_quote(table, schema, db_type, None, identifier_quote);
    let col_list = columns
        .iter()
        .map(|c| quote_identifier_with_identifier_quote(c, db_type, identifier_quote))
        .collect::<Vec<_>>()
        .join(", ");
    let order = primary_keys
        .iter()
        .map(|pk| format!("{} ASC", quote_identifier_with_identifier_quote(pk, db_type, identifier_quote)))
        .collect::<Vec<_>>()
        .join(", ");

    let where_clause = if primary_keys.is_empty() || last_pk_values.is_empty() {
        String::new()
    } else {
        let conds: Vec<String> = primary_keys
            .iter()
            .zip(last_pk_values.iter())
            .map(|(pk, val)| {
                let qpk = quote_identifier_with_identifier_quote(pk, db_type, identifier_quote);
                let lit = escape_value(val, db_type);
                format!("{qpk} > {lit}")
            })
            .collect();
        format!(" WHERE {}", conds.join(" AND "))
    };
    format!("SELECT {col_list} FROM {full_table}{where_clause} ORDER BY {order} LIMIT {limit}")
}

pub async fn execute_on_pool(state: &AppState, pool_key: &str, sql: &str) -> Result<db::QueryResult, String> {
    execute_on_pool_with_max_rows(state, pool_key, sql, None).await
}

pub async fn execute_read_on_pool(state: &AppState, pool_key: &str, sql: &str) -> Result<db::QueryResult, String> {
    execute_on_pool_with_max_rows(state, pool_key, sql, None).await
}

pub async fn execute_read_on_pool_with_max_rows(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    execute_on_pool_with_max_rows(state, pool_key, sql, max_rows).await
}

pub async fn execute_on_pool_with_max_rows(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<db::QueryResult, String> {
    crate::query::check_read_only_for_connection(state, pool_key, sql).await?;
    let connections = state.connections.read().await;
    let pool = connections
        .get(pool_key)
        .or_else(|| connections.get(pool_key.split(':').next().unwrap_or(pool_key)))
        .ok_or_else(|| "Connection not found".to_string())?;

    match pool {
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::execute_query_with_max_rows(&p, sql, max_rows).await
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            session
                .invoke::<db::QueryResult>(
                    "executeQuery",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "sql": sql,
                        "maxRows": max_rows,
                    }),
                )
                .await
        }
    }
}

pub async fn get_db_type(state: &AppState, connection_id: &str) -> Result<DatabaseType, String> {
    let configs = state.configs.read().await;
    configs.get(connection_id).map(|c| c.db_type).ok_or_else(|| format!("Connection config not found: {connection_id}"))
}

pub async fn get_columns_for_transfer(
    state: &AppState,
    pool_key: &str,
    _connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    _catalog: Option<&str>,
) -> Result<Vec<db::ColumnInfo>, String> {
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or_else(|| "Pool not found".to_string())?;
    let schema = schema.to_string();
    let table = table.to_string();
    match pool {
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            db::postgres::get_columns(&p, &schema, &table).await
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let config = config.clone();
            let session = session.clone();
            drop(connections);
            session
                .invoke::<Vec<db::ColumnInfo>>(
                    "getColumns",
                    serde_json::json!({
                        "connection": config.as_ref(),
                        "database": database,
                        "schema": schema,
                        "table": table,
                    }),
                )
                .await
        }
    }
}

pub fn sort_table_names_by_dependencies(
    tables: &[String],
    dependencies: &HashMap<String, HashSet<String>>,
    _reverse: bool,
) -> Vec<String> {
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for table in tables {
        in_degree.entry(table.as_str()).or_insert(0);
        if let Some(deps) = dependencies.get(table) {
            for dep in deps {
                if tables.iter().any(|t| t == dep) {
                    *in_degree.entry(table.as_str()).or_insert(0) += 1;
                    dependents.entry(dep.as_str()).or_default().push(table.as_str());
                }
            }
        }
    }

    let mut queue: std::collections::VecDeque<&str> =
        tables.iter().map(String::as_str).filter(|t| in_degree.get(t).copied().unwrap_or_default() == 0).collect();

    let mut sorted = Vec::new();
    while let Some(table) = queue.pop_front() {
        sorted.push(table.to_string());
        if let Some(deps) = dependents.get(table) {
            for &dep in deps {
                let deg = in_degree.get_mut(dep).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push_back(dep);
                }
            }
        }
    }

    for table in tables {
        if !sorted.contains(table) {
            sorted.push(table.clone());
        }
    }

    sorted
}

pub async fn sort_tables_by_fk_dependency(
    state: &AppState,
    pool_key: &str,
    _database: &str,
    schema: &str,
    tables: &[String],
) -> Result<Vec<String>, String> {
    let connections = state.connections.read().await;
    let pool = connections.get(pool_key).ok_or_else(|| "Pool not found".to_string())?;

    match pool {
        PoolKind::Postgres(p) => {
            let p = p.clone();
            drop(connections);
            let mut dependencies: HashMap<String, HashSet<String>> = HashMap::new();
            for table in tables {
                let fks = db::postgres::list_foreign_keys(&p, schema, table).await.unwrap_or_default();
                let deps: HashSet<String> = fks.into_iter().map(|fk| fk.ref_table).collect();
                dependencies.insert(table.clone(), deps);
            }
            Ok(sort_table_names_by_dependencies(tables, &dependencies, false))
        }
        _ => Ok(tables.to_vec()),
    }
}

pub async fn is_cancelled(transfer_id: &str) -> bool {
    let cancelled = CANCELLED.read().await;
    cancelled.contains(transfer_id)
}

pub async fn set_cancelled(transfer_id: &str) {
    let mut cancelled = CANCELLED.write().await;
    cancelled.insert(transfer_id.to_string());
}

pub async fn clear_cancelled(transfer_id: &str) {
    let mut cancelled = CANCELLED.write().await;
    cancelled.remove(transfer_id);
}

pub async fn transfer_schema_objects<F>(
    _state: &AppState,
    _request: &TransferRequest,
    _source_pool_key: &str,
    _target_pool_key: &str,
    _progress_callback: F,
) -> Result<TransferObjectOutcome, String>
where
    F: FnMut(TransferProgress),
{
    Ok(TransferObjectOutcome::default())
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_table<F>(
    state: &AppState,
    request: &TransferRequest,
    table: &str,
    table_index: usize,
    source_db_type: &DatabaseType,
    target_db_type: &DatabaseType,
    source_pool_key: &str,
    target_pool_key: &str,
    mut progress_callback: F,
) -> Result<u64, String>
where
    F: FnMut(TransferProgress),
{
    let total_tables = request.tables.len();
    let target_table = table.to_string();

    let columns = get_columns_for_transfer(
        state,
        source_pool_key,
        &request.source_connection_id,
        &request.source_database,
        &request.source_schema,
        table,
        request.source_catalog.as_deref(),
    )
    .await?;

    if columns.is_empty() {
        return Err(format!("No columns found for table {table}"));
    }

    let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let col_types: Vec<Option<String>> = columns.iter().map(|c| Some(c.data_type.clone())).collect();

    if should_transfer_schema_objects(&request.content) {
        let ddl = generate_create_table_ddl(
            &columns,
            &target_table,
            &request.source_schema,
            &request.target_schema,
            target_db_type,
            source_db_type,
            None,
            request.target_catalog.as_deref(),
        );
        let _ = execute_on_pool(state, target_pool_key, &ddl).await;

        let comment_ddl = generate_comment_ddl(&columns, &target_table, &request.target_schema, target_db_type, None);
        for comment_stmt in comment_ddl {
            let _ = execute_on_pool(state, target_pool_key, &comment_stmt).await;
        }
    }

    if !should_copy_data(&request.content) {
        return Ok(0);
    }

    if request.mode == TransferMode::Overwrite {
        let full_table =
            qualified_table(&target_table, &request.target_schema, target_db_type, request.target_catalog.as_deref());
        let truncate_sql = format!("TRUNCATE TABLE {full_table}");
        let _ = execute_on_pool(state, target_pool_key, &truncate_sql).await;
    }

    let pks: Vec<String> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
    let batch_size = request.batch_size.unwrap_or(1000).max(1);
    let mut offset = 0u64;
    let mut total_transferred = 0u64;

    loop {
        if is_cancelled(&request.transfer_id).await {
            return Err("Transfer cancelled".to_string());
        }

        let select_sql = pagination_sql(&col_names, table, &request.source_schema, source_db_type, offset, batch_size);
        let read_result = execute_on_pool(state, source_pool_key, &select_sql).await?;
        if read_result.rows.is_empty() {
            break;
        }

        let rows_count = read_result.rows.len() as u64;
        let write_sql = generate_transfer_write_sql(
            &request.mode,
            &col_names,
            &col_types,
            &read_result.rows,
            &target_table,
            &request.target_schema,
            target_db_type,
            &pks,
            request.target_catalog.as_deref(),
        );

        execute_on_pool(state, target_pool_key, &write_sql).await?;
        total_transferred += rows_count;
        offset += rows_count;

        progress_callback(TransferProgress {
            transfer_id: request.transfer_id.clone(),
            table: table.to_string(),
            table_index,
            total_tables,
            rows_transferred: total_transferred,
            total_rows: None,
            status: TransferStatus::Running,
            error: None,
            terminal: false,
        });

        if rows_count < batch_size as u64 {
            break;
        }
    }

    Ok(total_transferred)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transfer_family_postgres() {
        assert_eq!(transfer_object_family(&DatabaseType::Postgres), Some(TransferObjectFamily::Postgres));
        assert_eq!(transfer_object_family(&DatabaseType::OpenGauss), Some(TransferObjectFamily::Postgres));
    }
}
