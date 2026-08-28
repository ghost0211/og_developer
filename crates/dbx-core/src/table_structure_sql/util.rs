use super::dialect::StructureDialect;
use super::types::EditableStructureColumn;
use crate::sql_dialect::is_postgres_reserved_identifier;
use crate::sql_dialect::is_simple_lower_identifier;

pub(super) fn qualified_table(dialect: StructureDialect, schema: Option<&str>, table_name: &str) -> String {
    if matches!(dialect, StructureDialect::Postgres) && schema.is_some_and(|schema| !schema.trim().is_empty()) {
        return format!("{}.{}", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, table_name));
    }
    quote_ident(dialect, table_name)
}

pub(super) fn quote_ident(dialect: StructureDialect, name: &str) -> String {
    match dialect {
        StructureDialect::Postgres => quote_postgres_minimally_quoted(name),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn quote_postgres_minimally_quoted(name: &str) -> String {
    if is_simple_lower_identifier(name) && !is_postgres_reserved_identifier(name) {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

pub(super) fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn is_sql_string_literal(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(inner) = trimmed.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')) else {
        return false;
    };

    let mut chars = inner.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' && chars.next_if_eq(&'\'').is_none() {
            return false;
        }
    }
    true
}

pub(super) fn format_default_for_sql(dialect: StructureDialect, data_type: &str, default_value: &str) -> String {
    let trimmed = default_value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if is_sql_keyword_default(dialect, trimmed) || is_sql_string_literal(trimmed) {
        return trimmed.to_string();
    }
    if is_numeric_type(data_type) {
        if trimmed.parse::<f64>().is_ok() {
            return trimmed.to_string();
        }
        return quote_string(trimmed);
    }
    if is_boolean_type(data_type) {
        let upper = trimmed.to_ascii_uppercase();
        if upper == "TRUE" || upper == "FALSE" {
            return upper;
        }
        if trimmed == "1" {
            return "TRUE".to_string();
        }
        if trimmed == "0" {
            return "FALSE".to_string();
        }
        return quote_string(trimmed);
    }
    quote_string(trimmed)
}

fn is_sql_keyword_default(_dialect: StructureDialect, value: &str) -> bool {
    let upper = value.trim().to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "NULL"
            | "CURRENT_TIMESTAMP"
            | "CURRENT_DATE"
            | "CURRENT_TIME"
            | "LOCALTIMESTAMP"
            | "LOCALTIME"
            | "NOW()"
            | "GEN_RANDOM_UUID()"
    )
}

pub(super) fn is_numeric_type(data_type: &str) -> bool {
    let base = data_type.split('(').next().unwrap_or(data_type).trim().to_ascii_lowercase();
    matches!(
        base.as_str(),
        "smallint"
            | "integer"
            | "int"
            | "int2"
            | "int4"
            | "int8"
            | "bigint"
            | "decimal"
            | "numeric"
            | "real"
            | "double precision"
            | "float"
            | "float4"
            | "float8"
    )
}

pub(super) fn is_boolean_type(data_type: &str) -> bool {
    let base = data_type.split('(').next().unwrap_or(data_type).trim().to_ascii_lowercase();
    matches!(base.as_str(), "bool" | "boolean")
}

pub(super) fn clean(value: &str) -> String {
    value.trim().to_string()
}

pub(super) fn normalize_default(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_string()
}

pub(super) fn original_column_name(column: &EditableStructureColumn) -> &str {
    column.original.as_ref().map(|o| o.name.as_str()).unwrap_or(column.name.as_str())
}
