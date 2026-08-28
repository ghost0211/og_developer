use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql::find_statement_at_cursor;
use crate::sql_dialect::quote_table_identifier;
use sqlparser::ast::{GroupByExpr, SelectItem, SetExpr, Statement};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySqlBuildResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPagination {
    pub limit: usize,
    pub offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPaginationExecutionPlanOptions {
    pub sql: String,
    pub query_base_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub pagination: QueryPagination,
    pub use_agent_cursor: bool,
    #[serde(default)]
    pub first_page_uses_actual_sql: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPaginationExecutionPlan {
    pub sql_to_execute: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_sql: Option<String>,
    pub use_agent_result_session: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuerySortDirection {
    Asc,
    Desc,
}

impl QuerySortDirection {
    fn as_sql(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortedQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default)]
    pub result_columns: Vec<String>,
    pub column_index: usize,
    pub column: String,
    pub direction: QuerySortDirection,
}

pub fn build_query_pagination_execution_plan(
    options: QueryPaginationExecutionPlanOptions,
) -> QueryPaginationExecutionPlan {
    let mut plan = QueryPaginationExecutionPlan {
        sql_to_execute: options.sql.clone(),
        page_sql: None,
        page_limit: None,
        page_offset: None,
        count_sql: None,
        use_agent_result_session: false,
    };

    let counted = build_count_query_sql(CountQuerySqlOptions {
        original_sql: options.query_base_sql.clone(),
        database_type: options.database_type,
    });
    if counted.ok {
        plan.count_sql = counted.sql;
    }

    if options.pagination.session_id.is_some() {
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    let can_use_first_page_cursor = options.use_agent_cursor && options.pagination.offset == 0;
    if can_use_first_page_cursor {
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql: options.sql.clone(),
        database_type: options.database_type,
        limit: options.pagination.limit,
        offset: options.pagination.offset,
    });
    if paginated.ok {
        plan.sql_to_execute = paginated.sql.clone().unwrap_or_default();
        plan.page_sql = paginated.sql;
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
    } else if can_use_first_page_cursor {
        // Kingbase JDBC may buffer an entire result in auto-commit mode, so use
        // LIMIT/OFFSET whenever the statement can be rewritten safely. Keep the
        // Agent cursor as a bounded fallback for multi-statement or dialect-
        // specific SQL that the pagination parser cannot transform.
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
    }
    plan
}

pub fn build_paginated_query_sql(options: PaginatedQuerySqlOptions) -> QuerySqlBuildResult {
    let Ok(statement) = single_selectable_statement(&options.original_sql) else {
        return err(single_statement_error_reason(&options.original_sql));
    };
    if unsupported_pagination_type(options.database_type) {
        return err("unsupported");
    }
    let safe_limit = options.limit.max(1);
    let safe_offset = options.offset;

    let dedup_count = dedup_projection_count_without_order_by(&options.original_sql);
    ok(add_standard_limit(&statement, options.database_type, safe_limit, safe_offset, dedup_count))
}

pub fn build_count_query_sql(options: CountQuerySqlOptions) -> QuerySqlBuildResult {
    let Ok(statement) = single_selectable_statement(&options.original_sql) else {
        return err(single_statement_error_reason(&options.original_sql));
    };
    if unsupported_pagination_type(options.database_type) {
        return err("unsupported");
    }
    let alias = quote_table_identifier(options.database_type, "dbx_count");
    ok(derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", &statement, &format!("{alias};")))
}

pub fn build_sorted_query_sql(options: SortedQuerySqlOptions) -> QuerySqlBuildResult {
    let base_sql = options.original_sql.trim();
    if base_sql.is_empty() {
        return err("empty");
    }

    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return err("empty");
    }
    if statement.len() != base_sql.trim_end_matches(';').trim().len() {
        return err("multi");
    }
    if statement.trim_start().to_ascii_uppercase().starts_with("WITH") {
        return err("with");
    }
    if !statement.trim_start().to_ascii_uppercase().starts_with("SELECT") {
        return err("not_select");
    }

    let aliases = build_derived_column_aliases(&options.result_columns);
    let use_derived_column_aliases = true;
    let sort_alias = if use_derived_column_aliases {
        aliases
            .get(options.column_index)
            .or_else(|| {
                options
                    .result_columns
                    .iter()
                    .position(|column| column == &options.column)
                    .and_then(|index| aliases.get(index))
            })
            .cloned()
            .unwrap_or_else(|| fallback_alias(options.column_index))
    } else {
        options.result_columns.get(options.column_index).cloned().unwrap_or_else(|| options.column.clone())
    };
    // Oracle-compatible derived tables do not accept a PostgreSQL-style
    // column alias list. Use the selected column position when duplicate
    // labels would otherwise make ORDER BY ambiguous.
    let sort_reference = quote_table_identifier(options.database_type, &sort_alias);
    let wrapped_statement = statement;

    if use_derived_column_aliases {
        let alias_list = aliases
            .iter()
            .map(|alias| quote_table_identifier(options.database_type, alias))
            .collect::<Vec<_>>()
            .join(", ");
        ok(format!(
            "SELECT * FROM ({wrapped_statement}) t({alias_list}) ORDER BY {sort_reference} {};",
            options.direction.as_sql()
        ))
    } else {
        ok(format!("SELECT * FROM ({wrapped_statement}) t ORDER BY {sort_reference} {};", options.direction.as_sql()))
    }
}

fn ok(sql: String) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: true, sql: Some(sql), reason: None }
}

fn err(reason: &str) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn unsupported_pagination_type(_database_type: Option<DatabaseType>) -> bool {
    false
}

fn single_selectable_statement(original_sql: &str) -> Result<String, ()> {
    let base_sql = original_sql.trim();
    if base_sql.is_empty() {
        return Err(());
    }

    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return Err(());
    }
    if !single_statement_matches_base_sql(&statement, base_sql) {
        return Err(());
    }
    let statement_without_leading_comments =
        strip_leading_statement_comments(statement.trim_start_matches(';').trim_start());
    let upper = statement_without_leading_comments.to_ascii_uppercase();
    if upper.starts_with("WITH") {
        if !cte_main_statement_is_select(&statement) {
            return Err(());
        }
    } else if !upper.starts_with("SELECT") {
        return Err(());
    }
    if has_top_level_select_into(&statement) {
        return Err(());
    }

    Ok(statement)
}

fn single_statement_matches_base_sql(statement: &str, base_sql: &str) -> bool {
    let normalized_statement = statement.trim().trim_end_matches(';').trim();
    let normalized_base = base_sql.trim().trim_end_matches(';').trim();
    if normalized_statement.len() == normalized_base.len() {
        return true;
    }
    let base_without_leading_comments =
        strip_leading_statement_comments(normalized_base).trim().trim_end_matches(';').trim();
    normalized_statement == base_without_leading_comments
}

fn cte_main_statement_is_select(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let mut index = match tokens.iter().position(|token| token.text == "WITH") {
        Some(index) => index + 1,
        None => return false,
    };

    if tokens.get(index).is_some_and(|token| token.text == "RECURSIVE") {
        index += 1;
    }

    while let Some(token) = tokens.get(index) {
        if is_with_main_statement_keyword(&token.text) {
            return token.text == "SELECT";
        }
        index += 1;
    }
    false
}

fn is_with_main_statement_keyword(token: &str) -> bool {
    matches!(token, "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE")
}

fn single_statement_error_reason(original_sql: &str) -> &'static str {
    let base_sql = original_sql.trim();
    if base_sql.is_empty() {
        return "empty";
    }
    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return "empty";
    }
    if statement.len() != base_sql.trim_end_matches(';').trim().len() {
        return "multi";
    }
    "not_select"
}

fn has_top_level_select_into(sql: &str) -> bool {
    let mut saw_select = false;
    for token in top_level_sql_tokens(sql) {
        if !saw_select {
            saw_select = token.text == "SELECT";
            continue;
        }
        if token.text == "INTO" {
            return true;
        }
    }
    false
}

fn skip_leading_sql_comments(sql: &str, mut index: usize) -> usize {
    loop {
        index = skip_sql_whitespace(sql, index);
        if sql[index..].starts_with("--") {
            index += 2;
            while index < sql.len() && next_char(sql, index) != '\n' {
                index += next_char(sql, index).len_utf8();
            }
            continue;
        }
        if sql[index..].starts_with("/*") {
            index += 2;
            while index < sql.len() {
                let ch = next_char(sql, index);
                let next = next_char_at(sql, index + ch.len_utf8());
                index += ch.len_utf8();
                if ch == '*' && next == Some('/') {
                    index += 1;
                    break;
                }
            }
            continue;
        }
        return index;
    }
}

fn strip_leading_statement_comments(sql: &str) -> &str {
    &sql[skip_leading_sql_comments(sql, 0)..]
}

fn skip_sql_whitespace(sql: &str, mut index: usize) -> usize {
    while index < sql.len() && next_char(sql, index).is_whitespace() {
        index += next_char(sql, index).len_utf8();
    }
    index
}

fn has_top_level_limit(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "LIMIT")
}

fn top_level_limit_row_count(sql: &str) -> Option<usize> {
    let token = top_level_sql_tokens(sql).into_iter().find(|token| token.text == "LIMIT")?;
    parse_standard_limit_row_count(sql, token.start + token.text.len())
}

fn parse_standard_limit_row_count(sql: &str, start: usize) -> Option<usize> {
    let mut cursor = skip_sql_whitespace(sql, start);
    let first = parse_usize_literal(sql, &mut cursor)?;
    cursor = skip_sql_whitespace(sql, cursor);
    if sql.get(cursor..)?.starts_with(',') {
        cursor = skip_sql_whitespace(sql, cursor + 1);
        return parse_usize_literal(sql, &mut cursor);
    }
    Some(first)
}

fn parse_usize_literal(sql: &str, cursor: &mut usize) -> Option<usize> {
    let start = *cursor;
    while *cursor < sql.len() && sql.as_bytes()[*cursor].is_ascii_digit() {
        *cursor += 1;
    }
    if *cursor == start {
        return None;
    }
    sql[start..*cursor].parse().ok()
}

fn add_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    dedup_projection_count: Option<usize>,
) -> String {
    let order_sql = dedup_projection_count.map_or(String::new(), format_positional_order_by);

    if has_top_level_limit(statement) {
        if !order_sql.is_empty() {
            // For dedup queries (DISTINCT / GROUP BY) without user ORDER BY,
            // wrap the query to guarantee deterministic LIMIT/OFFSET pagination.
            // The inner query preserves DISTINCT semantics; the outer query
            // adds ORDER BY on positional columns to ensure consistent row
            // ordering across pages in distributed databases like Doris.
            return add_outer_standard_limit(statement, database_type, limit, offset, &order_sql);
        }
        // A user/top-level LIMIT can still be wider than the selected grid page size.
        // Wrap it so the first page respects the UI page limit while preserving the user's cap.
        if offset > 0 || top_level_limit_row_count(statement).is_some_and(|row_count| row_count > limit) {
            return add_outer_standard_limit(statement, database_type, limit, offset, "");
        }
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    let limit_sql = format!("{order_sql} LIMIT {limit}{offset_sql}");

    append_sql_suffix(statement, &format!("{limit_sql};"))
}

fn add_outer_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    order_sql: &str,
) -> String {
    let alias = quote_table_identifier(database_type, "dbx_page");
    derived_table_sql("SELECT * FROM", statement, &format!("{alias}{order_sql} LIMIT {limit} OFFSET {offset};"))
}

fn derived_table_sql(prefix: &str, statement: &str, suffix: &str) -> String {
    format!("{prefix} ({}) {suffix}", statement_for_sql_suffix(statement))
}

fn append_sql_suffix(statement: &str, suffix: &str) -> String {
    let separator = if sql_suffix_needs_newline(statement) { "\n" } else { " " };
    format!("{}{separator}{}", statement.trim_end(), suffix.trim_start())
}

fn statement_for_sql_suffix(statement: &str) -> String {
    let trimmed = statement.trim_end();
    if sql_suffix_needs_newline(trimmed) {
        format!("{trimmed}\n")
    } else {
        trimmed.to_string()
    }
}

fn sql_suffix_needs_newline(sql: &str) -> bool {
    let Some(last_line_start) = sql.rfind(['\n', '\r']).map(|index| index + 1) else {
        return line_has_open_line_comment(sql);
    };
    line_has_open_line_comment(&sql[last_line_start..])
}

fn line_has_open_line_comment(line: &str) -> bool {
    let mut index = 0;
    while index < line.len() {
        let ch = next_char(line, index);
        let next = next_char_at(line, index + ch.len_utf8());
        if matches!(ch, '\'' | '"' | '`') {
            index = skip_sql_quoted(line, index, ch);
            continue;
        }
        if ch == '[' {
            index = skip_sql_bracket_identifier(line, index);
            continue;
        }
        if ch == '/' && next == Some('*') {
            index += 2;
            while index < line.len() {
                let current = next_char(line, index);
                let following = next_char_at(line, index + current.len_utf8());
                index += current.len_utf8();
                if current == '*' && following == Some('/') {
                    index += 1;
                    break;
                }
            }
            continue;
        }
        if ch == '-' && next == Some('-') {
            return true;
        }
        if ch == '#' {
            return true;
        }
        index += ch.len_utf8();
    }
    false
}

/// For dedup queries (DISTINCT / GROUP BY) without an ORDER BY clause, generate
/// a positional `ORDER BY 1, 2, ..., N` clause so that LIMIT/OFFSET pagination
/// returns deterministic results across pages.  This is especially important for
/// distributed databases (e.g. Doris, StarRocks) where tablet scan order varies
/// between independent query executions.
fn format_positional_order_by(column_count: usize) -> String {
    if column_count == 0 {
        return String::new();
    }
    let cols: Vec<String> = (1..=column_count).map(|i| i.to_string()).collect();
    format!(" ORDER BY {}", cols.join(", "))
}

/// Detect dedup queries (SELECT DISTINCT, GROUP BY, HAVING) that lack a
/// top-level ORDER BY clause.  Returns the number of projection items so that
/// a positional ORDER BY can be injected for deterministic pagination.
///
/// Returns `None` for:
///   - Non-SELECT queries
///   - Queries without dedup semantics
///   - Queries that already specify ORDER BY
///   - Wildcard projections (`SELECT *`)
///   - Parse failures
fn dedup_projection_count_without_order_by(sql: &str) -> Option<usize> {
    let dialect = GenericDialect {};
    let statements = Parser::parse_sql(&dialect, sql).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    // Reject if the query already has an ORDER BY clause.
    if query.order_by.is_some() {
        return None;
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    let has_distinct = select.distinct.is_some();
    let has_group_by = !matches!(&select.group_by, GroupByExpr::Expressions(exprs, _) if exprs.is_empty());
    let has_having = select.having.is_some();
    if !has_distinct && !has_group_by && !has_having {
        return None;
    }
    // Wildcard projections cannot be used with positional ORDER BY.
    if select.projection.len() == 1 && matches!(select.projection.first(), Some(SelectItem::Wildcard(_))) {
        return None;
    }
    Some(select.projection.len())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlToken {
    text: String,
    start: usize,
}

fn top_level_sql_tokens(sql: &str) -> Vec<SqlToken> {
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut depth = 0usize;

    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());

        if ch == '-' && next == Some('-') {
            i += 2;
            while i < sql.len() && next_char(sql, i) != '\n' {
                i += next_char(sql, i).len_utf8();
            }
            continue;
        }

        if ch == '/' && next == Some('*') {
            i += 2;
            while i < sql.len() {
                let current = next_char(sql, i);
                let following = next_char_at(sql, i + current.len_utf8());
                if current == '*' && following == Some('/') {
                    i += 2;
                    break;
                }
                i += current.len_utf8();
            }
            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            i = skip_sql_quoted(sql, i, ch);
            continue;
        }

        if ch == '[' {
            i = skip_sql_bracket_identifier(sql, i);
            continue;
        }

        if ch == '(' {
            depth += 1;
            i += ch.len_utf8();
            continue;
        }

        if ch == ')' {
            depth = depth.saturating_sub(1);
            i += ch.len_utf8();
            continue;
        }

        if depth == 0 && is_sql_token_start(ch) {
            let start = i;
            i += ch.len_utf8();
            while i < sql.len() && is_sql_token_part(next_char(sql, i)) {
                i += next_char(sql, i).len_utf8();
            }
            tokens.push(SqlToken { text: sql[start..i].to_ascii_uppercase(), start });
            continue;
        }

        i += ch.len_utf8();
    }

    tokens
}

fn skip_sql_quoted(sql: &str, pos: usize, quote: char) -> usize {
    let mut i = pos + quote.len_utf8();
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == quote {
            if next == Some(quote) {
                i += ch.len_utf8() + quote.len_utf8();
                continue;
            }
            return i + ch.len_utf8();
        }
        if quote == '\'' && ch == '\\' {
            i += ch.len_utf8();
            if i < sql.len() {
                i += next_char(sql, i).len_utf8();
            }
            continue;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn skip_sql_bracket_identifier(sql: &str, pos: usize) -> usize {
    let mut i = pos + 1;
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == ']' {
            if next == Some(']') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn is_sql_token_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_sql_token_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '#')
}

fn next_char(sql: &str, index: usize) -> char {
    sql[index..].chars().next().unwrap_or('\0')
}

fn next_char_at(sql: &str, index: usize) -> Option<char> {
    if index >= sql.len() {
        None
    } else {
        sql[index..].chars().next()
    }
}

fn build_derived_column_aliases(result_columns: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    result_columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let base = normalize_alias_base(column, index);
            let count = seen.entry(base.clone()).and_modify(|value| *value += 1).or_insert(1);
            if *count == 1 {
                base
            } else {
                format!("{base}_{count}")
            }
        })
        .collect()
}

fn normalize_alias_base(column: &str, index: usize) -> String {
    let compact = column.split_whitespace().collect::<Vec<_>>().join("_");
    let safe = compact
        .chars()
        .map(|ch| if ch.is_alphanumeric() || matches!(ch, '_' | '$') { ch } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if safe.is_empty() {
        fallback_alias(index)
    } else {
        safe
    }
}

fn fallback_alias(index: usize) -> String {
    format!("column_{}", index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_pagination_uses_limit_offset() {
        let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT name FROM products".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 200,
        });
        assert_eq!(paginated.sql.as_deref(), Some("SELECT name FROM products LIMIT 100 OFFSET 200;"));

        let counted = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT name FROM products".to_string(),
            database_type: Some(DatabaseType::Postgres),
        });
        assert_eq!(
            counted.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT name FROM products) \"dbx_count\";")
        );
    }

    #[test]
    fn opengauss_pagination_uses_limit_offset() {
        let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT name FROM products".to_string(),
            database_type: Some(DatabaseType::Opengauss),
            limit: 50,
            offset: 0,
        });
        assert_eq!(paginated.sql.as_deref(), Some("SELECT name FROM products LIMIT 50;"));
    }
}
