use crate::models::connection::DatabaseType;

use super::capabilities::is_schema_aware;

pub fn qualified_table_name(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
    let supports_qualifier = database_type.is_some_and(is_schema_aware);
    if supports_qualifier
        && database_type != Some(DatabaseType::Jdbc)
        && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        return format!(
            "{}.{}",
            quote_table_identifier(database_type, schema.unwrap()),
            quote_table_identifier(database_type, table_name)
        );
    }
    quote_table_identifier(database_type, table_name)
}

/// Like `qualified_table_name`, kept for call sites that parse 3-part source
/// names. Only the PostgreSQL family remains, which has no external-catalog
/// addressing, so `catalog`/`database` no longer influence the result.
pub fn qualified_table_name_with_catalog(
    database_type: Option<DatabaseType>,
    _catalog: Option<&str>,
    schema: Option<&str>,
    _database: Option<&str>,
    table_name: &str,
) -> String {
    qualified_table_name(database_type, schema, table_name)
}

pub fn quote_table_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    if database_type == Some(DatabaseType::OpenGauss) && is_explicitly_quoted_identifier(name) {
        return name.to_string();
    }
    match database_type {
        Some(DatabaseType::Jdbc) => name.to_string(),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn quote_table_data_identifier(
    database_type: Option<DatabaseType>,
    name: &str,
    _identifier_quote: Option<&str>,
) -> String {
    quote_table_identifier(database_type, name)
}

pub fn table_data_qualified_table_name(
    database_type: Option<DatabaseType>,
    schema: Option<&str>,
    table_name: &str,
    _identifier_quote: Option<&str>,
) -> String {
    qualified_table_name(database_type, schema, table_name)
}

pub fn uses_connection_identifier_quote(_database_type: Option<DatabaseType>, _identifier_quote: Option<&str>) -> bool {
    false
}

fn is_explicitly_quoted_identifier(name: &str) -> bool {
    name.len() >= 2
        && ((name.starts_with('"') && name.ends_with('"'))
            || (name.starts_with('`') && name.ends_with('`'))
            || (name.starts_with('[') && name.ends_with(']')))
}

pub(crate) fn is_simple_lower_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_lowercase())
        && chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_lowercase() || ch.is_ascii_digit())
}

pub(crate) fn is_postgres_reserved_identifier(name: &str) -> bool {
    matches!(
        name,
        "all"
            | "analyse"
            | "analyze"
            | "and"
            | "any"
            | "array"
            | "as"
            | "asc"
            | "asymmetric"
            | "authorization"
            | "binary"
            | "both"
            | "case"
            | "cast"
            | "check"
            | "collate"
            | "collation"
            | "column"
            | "concurrently"
            | "constraint"
            | "create"
            | "cross"
            | "current_catalog"
            | "current_date"
            | "current_role"
            | "current_schema"
            | "current_time"
            | "current_timestamp"
            | "current_user"
            | "default"
            | "deferrable"
            | "desc"
            | "distinct"
            | "do"
            | "else"
            | "end"
            | "except"
            | "false"
            | "fetch"
            | "for"
            | "foreign"
            | "freeze"
            | "from"
            | "full"
            | "grant"
            | "group"
            | "having"
            | "ilike"
            | "in"
            | "initially"
            | "inner"
            | "intersect"
            | "into"
            | "is"
            | "isnull"
            | "join"
            | "lateral"
            | "leading"
            | "left"
            | "like"
            | "limit"
            | "localtime"
            | "localtimestamp"
            | "natural"
            | "not"
            | "notnull"
            | "null"
            | "offset"
            | "on"
            | "only"
            | "or"
            | "order"
            | "outer"
            | "overlaps"
            | "placing"
            | "primary"
            | "references"
            | "returning"
            | "right"
            | "select"
            | "session_user"
            | "similar"
            | "some"
            | "symmetric"
            | "system_user"
            | "table"
            | "tablesample"
            | "then"
            | "to"
            | "trailing"
            | "true"
            | "union"
            | "unique"
            | "user"
            | "using"
            | "variadic"
            | "verbose"
            | "when"
            | "where"
            | "window"
            | "with"
            // openGauss-only reserved words (pg_get_keywords catcode 'R' on openGauss);
            // quoting these on a PG server is harmless and keeps DDL safe on openGauss.
            | "authid"
            | "buckets"
            | "excluded"
            | "groupparent"
            | "imcstored"
            | "minus"
            | "modify"
            | "nocycle"
            | "performance"
            | "procedure"
            | "reject"
            | "rownum"
            | "self"
            | "share_memory"
            | "shrink"
            | "sysdate"
            | "unimcstored"
            | "verify"
    )
}

pub fn normalize_where_input(where_input: Option<&str>) -> String {
    let trimmed = where_input.unwrap_or("").trim().trim_end_matches(';').trim();
    let mut chars = trimmed.chars();
    let prefix = chars.by_ref().take(5).collect::<String>();
    if prefix.eq_ignore_ascii_case("where") {
        chars.as_str().trim().to_string()
    } else {
        trimmed.to_string()
    }
}
