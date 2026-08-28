use serde::{Deserialize, Serialize};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplainFormat {
    Json,
    Standard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    /// MySQL supports both a structured JSON plan and the traditional tabular plan.
    /// Omitted formats retain the existing JSON behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ExplainFormat>,
    /// PostgreSQL and SQL Server only: run the statement and report measured
    /// rows/timings. Every other engine ignores the flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyze: Option<bool>,
    pub sql: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSqlBuildResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFilePreviewSqlOptions {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

pub fn build_explain_sql(options: ExplainSqlOptions) -> ExplainSqlBuildResult {
    if !supports_explain_plan(options.database_type) {
        return explain_err("unsupported");
    }

    let source = strip_trailing_semicolons(options.sql.trim());
    if source.is_empty() {
        return explain_err("empty");
    }
    if !is_safe_explain_sql(&source) {
        return explain_err("unsafe");
    }
    if options.analyze == Some(true)
        && options.database_type.is_some_and(|database_type| {
            matches!(database_type, DatabaseType::Postgres | DatabaseType::OpenGauss)
                && is_write_sql_for_database(&source, database_type)
        })
    {
        return explain_err("unsafe");
    }

    let sql = match options.database_type {
        Some(DatabaseType::Postgres | DatabaseType::OpenGauss) if options.analyze == Some(true) => {
            format!("EXPLAIN (ANALYZE, FORMAT JSON) {source}")
        }
        _ => format!("EXPLAIN (FORMAT JSON) {source}"),
    };
    ExplainSqlBuildResult { ok: true, sql: Some(sql), reason: None }
}

pub fn build_dropped_file_preview_sql(options: DroppedFilePreviewSqlOptions) -> Option<String> {
    let lower = options.path.to_lowercase();
    let escaped = options.path.replace('\'', "''");
    let limit = options.limit.unwrap_or(1000).max(1);
    if lower.ends_with(".parquet") {
        return Some(format!("SELECT * FROM read_parquet('{escaped}') LIMIT {limit}"));
    }
    if lower.ends_with(".csv") {
        return Some(format!("SELECT * FROM read_csv('{escaped}') LIMIT {limit}"));
    }
    if lower.ends_with(".tsv") {
        return Some(format!("SELECT * FROM read_csv('{escaped}', delim='\\t') LIMIT {limit}"));
    }
    if lower.ends_with(".json") {
        return Some(format!("SELECT * FROM read_json('{escaped}') LIMIT {limit}"));
    }
    None
}

pub fn supports_explain_plan(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::OpenGauss))
}

pub fn is_safe_explain_sql(sql: &str) -> bool {
    let source = strip_trailing_semicolons(sql.trim());
    !source.is_empty()
        && !has_extra_statement_after_semicolon(&source)
        && is_safe_explain_source(&source)
        && !contains_dangerous_sql_keyword(&source)
}

/// Returns true for databases that support SQL query execution (execute_query / get_sample_data).
/// Non-SQL databases (Redis, MongoDB, Elasticsearch, InfluxDB, VictoriaMetrics, Neo4j, etcd) are excluded.
pub fn supports_sql_query(_database_type: DatabaseType) -> bool {
    !false
}

pub fn is_safe_dameng_autotrace_sql(sql: &str) -> bool {
    let source = strip_trailing_semicolons(sql.trim());
    if source.is_empty() || has_extra_statement_after_semicolon(&source) {
        return false;
    }
    is_safe_explain_source(&source) && !contains_dangerous_sql_keyword(&source)
}

fn explain_err(reason: &str) -> ExplainSqlBuildResult {
    ExplainSqlBuildResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn strip_trailing_semicolons(sql: &str) -> String {
    sql.trim_end().trim_end_matches(';').trim_end().to_string()
}

fn is_safe_explain_source(sql: &str) -> bool {
    let source = strip_sql_comments(sql).trim_start().to_lowercase();
    ["select", "with", "table", "values"].iter().any(|keyword| {
        source == *keyword || source.starts_with(&format!("{keyword} ")) || source.starts_with(&format!("{keyword}\n"))
    })
}

pub fn contains_dangerous_sql_keyword(sql: &str) -> bool {
    let source = strip_sql_comments_and_literals(sql).to_lowercase();
    ["drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"]
        .iter()
        .any(|keyword| contains_word(&source, keyword))
}

/// Keywords that start a read-only SQL statement.
/// Note: FROM is a DuckDB-specific read keyword supporting SELECT-less FROM syntax
/// (e.g. `FROM table SELECT *`). In other databases, a statement starting with FROM
/// is invalid and would be rejected by the database itself, so allowing it poses no risk.
///
/// PRAGMA is intentionally NOT in this list because some PRAGMA statements modify
/// database or session state (e.g. SQLite `PRAGMA journal_mode=WAL`). Instead,
/// read-only PRAGMA forms are handled separately in `is_safe_read_pragma`.
const READ_SQL_KEYWORDS: &[&str] = &["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "FROM"];

/// PRAGMA names that are known to be safe read-only queries in SQLite/DuckDB.
/// Only the function-call form `PRAGMA name(args)` matching these names is allowed.
/// Any PRAGMA with assignment (`PRAGMA name = value`) or not in this list is blocked.
const SAFE_READ_PRAGMA_NAMES: &[&str] = &[
    "TABLE_INFO",
    "TABLE_XINFO",
    "INDEX_LIST",
    "INDEX_INFO",
    "FOREIGN_KEY_LIST",
    "DATABASE_LIST",
    "COMPILE_OPTIONS",
    "DATA_VERSION",
];

/// Returns true if the SQL statement is a write operation (not a pure read).
///
/// Callers that know the connection database type should use
/// [`is_write_sql_for_database`] so executable comments are interpreted using
/// the correct dialect. This untyped helper deliberately remains conservative
/// for executable comments.
pub fn is_write_sql(sql: &str) -> bool {
    is_write_sql_with_database_type(sql, None)
}

/// Returns true if the SQL statement is a write operation for a database
/// dialect. In addition to ordinary write statements, this recognizes MySQL
/// executable comments and file exports, plus PostgreSQL-family/SQL Server
/// `SELECT ... INTO` table creation.
pub fn is_write_sql_for_database(sql: &str, database_type: DatabaseType) -> bool {
    // VictoriaMetrics execution is hard-wired to the read-only query API; MetricsQL
    // does not use SQL verbs and must not be rejected by SQL write classification.
    if false {
        return false;
    }
    if let Some(risk) = classify_search_engine_query_risk(sql, database_type) {
        return risk != SearchEngineQueryRisk::ReadOnly;
    }
    is_write_sql_with_database_type(sql, Some(database_type))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchEngineQueryRisk {
    ReadOnly,
    Write,
    Dangerous,
}

pub(crate) fn classify_search_engine_query_risk(
    source: &str,
    _database_type: DatabaseType,
) -> Option<SearchEngineQueryRisk> {
    if !false {
        return None;
    }
    let source = strip_leading_search_engine_comments(source);
    let request_line = source.lines().next()?.trim();
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let path = parts.next()?;
    let path = path.split('?').next().unwrap_or(path).trim_end_matches('/');
    let segments = path.split('/').filter(|segment| !segment.is_empty()).collect::<Vec<_>>();
    let has_segment = |candidate: &str| segments.iter().any(|segment| segment.eq_ignore_ascii_case(candidate));
    let has_document_id = |candidate: &str| {
        segments
            .iter()
            .position(|segment| segment.eq_ignore_ascii_case(candidate))
            .is_some_and(|index| segments.get(index + 1).is_some_and(|value| !value.is_empty()))
    };

    match method.as_str() {
        "GET" | "HEAD" | "OPTIONS" => Some(SearchEngineQueryRisk::ReadOnly),
        "POST"
            if [
                "_search",
                "_count",
                "_sql",
                "_msearch",
                "_field_caps",
                "_terms_enum",
                "_validate",
                "_explain",
                "_rank_eval",
                "_search_shards",
            ]
            .iter()
            .any(|endpoint| has_segment(endpoint)) =>
        {
            Some(SearchEngineQueryRisk::ReadOnly)
        }
        "POST" if ["_doc", "_create", "_update", "_bulk"].iter().any(|endpoint| has_segment(endpoint)) => {
            Some(SearchEngineQueryRisk::Write)
        }
        "PUT" if has_document_id("_doc") || has_document_id("_create") => Some(SearchEngineQueryRisk::Write),
        "DELETE" if has_document_id("_doc") => Some(SearchEngineQueryRisk::Write),
        "POST" | "PUT" | "PATCH" | "DELETE" => Some(SearchEngineQueryRisk::Dangerous),
        _ => None,
    }
}

fn strip_leading_search_engine_comments(input: &str) -> &str {
    let mut rest = input;
    loop {
        rest = rest.trim_start();
        if let Some(comment) = rest.strip_prefix('#').or_else(|| rest.strip_prefix("//")) {
            rest = comment.split_once('\n').map_or("", |(_, remaining)| remaining);
            continue;
        }
        if let Some(comment) = rest.strip_prefix("/*") {
            rest = comment.split_once("*/").map_or("", |(_, remaining)| remaining);
            continue;
        }
        return rest.trim();
    }
}

fn is_write_sql_with_database_type(sql: &str, database_type: Option<DatabaseType>) -> bool {
    if database_type.is_some_and(|database_type| has_dialect_specific_write(sql, database_type)) {
        return true;
    }

    // The untyped helper remains conservative for MySQL executable comments.
    // Typed callers handle those comments in has_dialect_specific_write above.
    let detect_mysql_executable_comments = database_type.is_none();
    let detect_select_into = database_type.is_none();
    let statements = match database_type {
        Some(database_type) => crate::sql::split_sql_statements_for_database(sql, database_type),
        None => crate::sql::split_sql_statements(sql),
    };

    statements
        .iter()
        .any(|statement| is_write_sql_statement(statement, detect_mysql_executable_comments, detect_select_into))
}

fn is_mysql_compatible_database(_database_type: DatabaseType) -> bool {
    false
}

fn is_postgresql_family_database(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::OpenGauss)
}

/// Detects write-capable syntax that otherwise looks like a read query and is
/// interpreted differently depending on the database dialect.
pub(crate) fn has_dialect_specific_write(sql: &str, database_type: DatabaseType) -> bool {
    let statements = crate::sql::split_sql_statements_for_database(sql, database_type);
    statements.iter().any(|statement| has_dialect_specific_write_statement(statement, database_type))
}

fn has_dialect_specific_write_statement(sql: &str, database_type: DatabaseType) -> bool {
    if is_mysql_compatible_database(database_type) {
        let (cleaned, has_executable_comment) = strip_sql_comments_and_literals_with_metadata(sql, true);
        return has_executable_comment
            || contains_keyword_sequence(&cleaned, "INTO", "OUTFILE")
            || contains_keyword_sequence(&cleaned, "INTO", "DUMPFILE");
    }

    if is_postgresql_family_database(database_type) {
        contains_unquoted_keyword(sql, &PostgreSqlDialect {}, "INTO")
    } else {
        match database_type {
            _ => false,
        }
    }
}

fn contains_keyword_sequence(sql: &str, first: &str, second: &str) -> bool {
    let words = sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').filter(|word| !word.is_empty());

    let mut previous_matches = false;
    for word in words {
        if previous_matches && word.eq_ignore_ascii_case(second) {
            return true;
        }
        previous_matches = word.eq_ignore_ascii_case(first);
    }
    false
}

fn contains_unquoted_keyword(sql: &str, dialect: &dyn sqlparser::dialect::Dialect, keyword: &str) -> bool {
    Tokenizer::new(dialect, sql).tokenize().is_ok_and(|tokens| {
        tokens.into_iter().any(|token| {
            matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(keyword))
        })
    })
}

fn is_write_sql_statement(sql: &str, detect_mysql_executable_comments: bool, detect_select_into: bool) -> bool {
    // 1. Strip comments and string literals
    let (cleaned, has_mysql_executable_comment) =
        strip_sql_comments_and_literals_with_metadata(sql, detect_mysql_executable_comments);
    // MySQL/MariaDB executable comments may contain arbitrary SQL, including
    // writes that are not represented by the outer statement (for example,
    // INTO OUTFILE inside a SELECT). Treat them as writes rather than
    // attempting to parse every supported MySQL dialect extension here.
    if has_mysql_executable_comment {
        return true;
    }
    let trimmed = cleaned.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_uppercase();

    // 2. Check if first keyword is a read keyword
    let starts_with_read = READ_SQL_KEYWORDS.iter().any(|kw| {
        upper.starts_with(kw) && (upper.len() == kw.len() || !upper.as_bytes()[kw.len()].is_ascii_alphanumeric())
    });

    // 3. Special handling for PRAGMA: only allow safe read-only forms
    if !starts_with_read && starts_with_keyword(&upper, "PRAGMA") {
        return !is_safe_read_pragma(&upper);
    }

    // SHOW CREATE returns object metadata; CREATE is part of its read-only syntax.
    if starts_with_show_create(&upper) {
        return false;
    }

    // Untyped callers stay conservative. Typed callers handle SELECT ... INTO
    // only for database families where the syntax performs a write.
    if detect_select_into && starts_with_keyword(&upper, "SELECT") && select_contains_top_level_into(&upper) {
        return true;
    }

    // A statement is a write if it doesn't start with a read keyword,
    // or if it contains embedded dangerous keywords (e.g. CTE-wrapped writes like WITH ... AS (DELETE FROM ...))
    !starts_with_read || contains_dangerous_sql_keyword(sql)
}

fn starts_with_show_create(upper: &str) -> bool {
    let Some(after_show) = upper.strip_prefix("SHOW") else {
        return false;
    };
    if !after_show.is_empty() && after_show.as_bytes()[0].is_ascii_alphanumeric() {
        return false;
    }
    starts_with_keyword(after_show.trim_start(), "CREATE")
}

fn select_contains_top_level_into(upper: &str) -> bool {
    let mut token = String::new();
    let mut depth = 0usize;
    let mut saw_select = false;

    for ch in upper.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            token.push(ch);
            continue;
        }

        if !token.is_empty() {
            if depth == 0 {
                if token == "SELECT" {
                    saw_select = true;
                } else if saw_select && token == "INTO" {
                    return true;
                }
            }
            token.clear();
        }

        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth = depth.saturating_sub(1);
        }
    }

    false
}

/// Check if a PRAGMA statement is a safe read-only form.
/// Allows: PRAGMA table_info(...), PRAGMA index_list(...), etc.
/// Blocks: PRAGMA name = value, PRAGMA name(value), or unknown PRAGMA names.
fn is_safe_read_pragma(upper_stripped: &str) -> bool {
    // Skip "PRAGMA" keyword to get the rest
    let rest = upper_stripped.strip_prefix("PRAGMA").unwrap_or("").trim_start();

    if rest.is_empty() {
        return false;
    }

    // Extract the pragma name (first word)
    let name_end = rest.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(rest.len());
    let pragma_name = &rest[..name_end];

    // Check if it's in the safe list
    if !SAFE_READ_PRAGMA_NAMES.contains(&pragma_name) {
        return false;
    }

    // Check the form after the name: must be function-call style "(...)" or end of statement
    let after_name = rest[name_end..].trim_start();
    if after_name.is_empty() {
        // PRAGMA table_info (no args) — safe
        return true;
    }
    if after_name.starts_with('(') {
        // PRAGMA table_info(users) — safe read form
        return true;
    }
    // PRAGMA table_info = something or other unsafe form — blocked
    false
}

fn starts_with_keyword(upper: &str, keyword: &str) -> bool {
    upper.starts_with(keyword)
        && (upper.len() == keyword.len() || !upper.as_bytes()[keyword.len()].is_ascii_alphanumeric())
}

/// Check whether a SQL statement is allowed under read-only mode.
/// Returns Err with a descriptive message if the statement is a write operation.
pub fn check_read_only(sql: &str, connection_name: &str, database_type: DatabaseType) -> Result<(), String> {
    if is_write_sql_for_database(sql, database_type) {
        return Err(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. Write operation (including stored procedure calls) blocked.",
            connection_name
        ));
    }
    Ok(())
}

fn contains_word(source: &str, word: &str) -> bool {
    let bytes = source.as_bytes();
    let word_bytes = word.as_bytes();
    if word_bytes.is_empty() || bytes.len() < word_bytes.len() {
        return false;
    }

    for idx in 0..=bytes.len() - word_bytes.len() {
        if &bytes[idx..idx + word_bytes.len()] != word_bytes {
            continue;
        }
        let before = idx.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        let after = bytes.get(idx + word_bytes.len()).copied();
        if !is_identifier_byte(before) && !is_identifier_byte(after) {
            return true;
        }
    }
    false
}

fn is_identifier_byte(byte: Option<u8>) -> bool {
    byte.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn has_extra_statement_after_semicolon(sql: &str) -> bool {
    let stripped = strip_sql_comments_and_literals(sql);
    stripped.split(';').skip(1).any(|part| !part.trim().is_empty())
}

pub(crate) fn strip_sql_comments(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
                output.push(' ');
            }
            continue;
        }

        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            in_line_comment = true;
            continue;
        }
        if ch == '#' {
            in_line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            if let Some(body) = read_mysql_executable_comment_body(&mut chars) {
                output.push(' ');
                output.push_str(&strip_sql_comments(&body));
                output.push(' ');
            } else {
                in_block_comment = true;
            }
            continue;
        }

        output.push(ch);
    }

    output
}

pub fn strip_sql_comments_and_literals(sql: &str) -> String {
    strip_sql_comments_and_literals_with_metadata(sql, false).0
}

fn strip_sql_comments_and_literals_with_metadata(sql: &str, detect_mysql_executable_comments: bool) -> (String, bool) {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick_quote = false;
    let mut has_mysql_executable_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_single_quote {
            if ch == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                } else {
                    in_single_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if in_double_quote {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                } else {
                    in_double_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if in_backtick_quote {
            if ch == '`' {
                if chars.peek() == Some(&'`') {
                    chars.next();
                } else {
                    in_backtick_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            in_line_comment = true;
            continue;
        }
        if ch == '#' {
            in_line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            if detect_mysql_executable_comments && is_mysql_executable_comment_start(&chars) {
                has_mysql_executable_comment = true;
            }
            in_block_comment = true;
            continue;
        }
        if ch == '\'' {
            in_single_quote = true;
            output.push(' ');
            continue;
        }
        if ch == '"' {
            in_double_quote = true;
            output.push(' ');
            continue;
        }
        if ch == '`' {
            in_backtick_quote = true;
            output.push(' ');
            continue;
        }

        output.push(ch);
    }

    (output, has_mysql_executable_comment)
}

/// `/*! ... */` is executable in MySQL, while `/*M! ... */` (optionally
/// followed by a version number) is executable in MariaDB.
fn is_mysql_executable_comment_start(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
    let mut marker = chars.clone();
    match marker.next() {
        Some('!') => true,
        Some('M') => marker.next() == Some('!'),
        _ => false,
    }
}

fn read_mysql_executable_comment_body<I>(chars: &mut std::iter::Peekable<I>) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let marker = chars.peek().copied()?;
    if marker == '!' {
        chars.next();
    } else if marker == 'M' {
        chars.next();
        if chars.peek() != Some(&'!') {
            return None;
        }
        chars.next();
    } else {
        return None;
    }

    let mut body = String::new();
    let mut skipping_version = true;
    while let Some(ch) = chars.next() {
        if ch == '*' && chars.peek() == Some(&'/') {
            chars.next();
            return Some(body);
        }
        if skipping_version && (ch.is_ascii_digit() || ch.is_whitespace()) {
            continue;
        }
        skipping_version = false;
        body.push(ch);
    }
    Some(body)
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_postgres_json_explain_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            format: None,
            analyze: None,
            sql: " select * from users where id = 1; ".to_string(),
        });
        assert_eq!(result.sql.as_deref(), Some("EXPLAIN (FORMAT JSON) select * from users where id = 1"));
    }

    #[test]
    fn builds_opengauss_json_explain_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Opengauss),
            format: None,
            analyze: Some(true),
            sql: "SELECT * FROM users;".to_string(),
        });
        assert_eq!(result.sql.as_deref(), Some("EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM users"));
    }

    #[test]
    fn detects_write_sql_for_postgres() {
        assert!(is_write_sql_for_database("INSERT INTO users VALUES (1)", DatabaseType::Postgres));
        assert!(is_write_sql_for_database("UPDATE users SET name = 'a'", DatabaseType::Postgres));
        assert!(is_write_sql_for_database("DELETE FROM users", DatabaseType::Postgres));
        assert!(!is_write_sql_for_database("SELECT * FROM users", DatabaseType::Postgres));
    }
}
