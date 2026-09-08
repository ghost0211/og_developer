// SPDX-License-Identifier: Apache-2.0
//
// og developer — modified from upstream dbx (https://github.com/t8y2/dbx,
// Apache-2.0, Copyright (c) dbx contributors) for openGauss support:
// openGauss reuses the gaussdb() SQL dialect profile (PL/SQL blocks,
// `/` line terminator) so package/function scripts are not split wrongly.
// See NOTICE for the full list of modifications.

use serde::{Deserialize, Serialize};
use sqlparser::dialect::OracleDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::models::connection::DatabaseType;

pub const MIN_FUZZY_FILTER_CHARS: usize = 2;

pub fn fuzzy_filter_enabled(filter: &str) -> bool {
    filter.trim().chars().count() >= MIN_FUZZY_FILTER_CHARS
}

pub fn fuzzy_subsequence_match(text: &str, filter: &str) -> bool {
    let filter = filter.trim().to_lowercase();
    if filter.is_empty() {
        return true;
    }

    let text = text.to_lowercase();
    let mut chars = text.chars();
    for needle in filter.chars() {
        if !chars.any(|candidate| candidate == needle) {
            return false;
        }
    }
    true
}

pub fn contains_or_fuzzy_match(text: &str, filter: &str) -> bool {
    let filter = filter.trim().to_lowercase();
    if filter.is_empty() {
        return true;
    }

    let text = text.to_lowercase();
    text.contains(&filter) || (fuzzy_filter_enabled(&filter) && fuzzy_subsequence_match(&text, &filter))
}

pub fn fuzzy_like_pattern_with_escape(value: &str, mut escape: impl FnMut(&str) -> String) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "%%".to_string();
    }

    let mut pattern = String::with_capacity(value.len() * 2 + 2);
    pattern.push('%');
    for ch in value.chars() {
        pattern.push_str(&escape(&ch.to_string()));
        pattern.push('%');
    }
    pattern
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileRequest {
    pub execution_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub continue_on_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFilePreview {
    pub file_name: String,
    pub file_path: String,
    pub size_bytes: u64,
    pub preview: String,
    pub can_execute_without_selected_database: bool,
    #[serde(default)]
    pub establishes_database_context: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SqlFileStatus {
    Started,
    Running,
    StatementDone,
    StatementFailed,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlFileStatementAction {
    Execute(String),
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlFileImportStatementKind {
    Execute,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlFileImportStatement {
    pub kind: SqlFileImportStatementKind,
    pub sql: String,
    pub source_sqls: Vec<String>,
    pub source_statement_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SqlDialectProfile {
    supports_hash_line_comments: bool,
    supports_oracle_plsql_blocks: bool,
    supports_slash_line_block_delimiter: bool,
    supports_custom_delimiter_commands: bool,
    supports_mysql_routine_blocks: bool,
    supports_dollar_quoted_strings: bool,
    supports_postgres_dollar_quoted_routines: bool,
    supports_hana_do_blocks: bool,
    supports_go_batch_separator: bool,
    keeps_sqlserver_module_batch_at_cursor: bool,
}

impl Default for SqlDialectProfile {
    fn default() -> Self {
        Self {
            supports_hash_line_comments: false,
            supports_oracle_plsql_blocks: false,
            supports_slash_line_block_delimiter: false,
            supports_custom_delimiter_commands: true,
            supports_mysql_routine_blocks: false,
            supports_dollar_quoted_strings: true,
            supports_postgres_dollar_quoted_routines: false,
            supports_hana_do_blocks: false,
            supports_go_batch_separator: false,
            keeps_sqlserver_module_batch_at_cursor: false,
        }
    }
}

impl SqlDialectProfile {
    fn for_database_type(db_type: DatabaseType) -> Self {
        // openGauss shares GaussDB's PL/SQL heritage: package/procedure bodies
        // use Oracle-style blocks, scripts may terminate blocks with a `/` line,
        // and dollar-quoted routine bodies are also valid.
        if matches!(db_type, DatabaseType::OpenGauss) {
            return Self::gaussdb();
        }

        if Self::is_oracle_like_database(db_type) {
            return Self::oracle_like();
        }

        if false {
            return Self::sql_server();
        }

        if Self::is_mysql_compatible_database(db_type) {
            return Self::mysql_compatible();
        }

        if false {
            return Self::sap_hana();
        }

        Self::default()
    }

    fn mysql_compatible() -> Self {
        Self { supports_hash_line_comments: true, supports_mysql_routine_blocks: true, ..Self::default() }
    }

    fn oracle_like() -> Self {
        Self { supports_oracle_plsql_blocks: true, supports_slash_line_block_delimiter: true, ..Self::default() }
    }

    fn gaussdb() -> Self {
        Self { supports_postgres_dollar_quoted_routines: true, ..Self::oracle_like() }
    }

    fn sql_server() -> Self {
        Self { supports_go_batch_separator: true, keeps_sqlserver_module_batch_at_cursor: true, ..Self::default() }
    }

    fn sap_hana() -> Self {
        Self { supports_hana_do_blocks: true, ..Self::default() }
    }

    fn is_mysql_compatible_database(_db_type: DatabaseType) -> bool {
        false
    }

    fn is_oracle_like_database(_db_type: DatabaseType) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SqlParsingOptions {
    profile: SqlDialectProfile,
}

impl SqlParsingOptions {
    pub fn for_database_type(db_type: DatabaseType) -> Self {
        Self::from_profile(SqlDialectProfile::for_database_type(db_type))
    }

    pub fn mysql_compatible() -> Self {
        Self::from_profile(SqlDialectProfile::mysql_compatible())
    }

    fn from_profile(profile: SqlDialectProfile) -> Self {
        Self { profile }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileProgress {
    pub execution_id: String,
    pub status: SqlFileStatus,
    pub statement_index: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u128,
    pub statement_summary: String,
    pub error: Option<String>,
    /// When processing multiple files, the 0-based index of the current file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_index: Option<usize>,
    /// When processing multiple files, the name of the current file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

pub fn decode_sql_file_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..]).map(|text| text.to_string()).map_err(|_| sql_file_encoding_error());
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_sql_file_with_encoding(&bytes[2..], encoding_rs::UTF_16LE);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_sql_file_with_encoding(&bytes[2..], encoding_rs::UTF_16BE);
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_string());
    }

    decode_sql_file_with_encoding(bytes, encoding_rs::GBK)
}

fn decode_sql_file_with_encoding(bytes: &[u8], encoding: &'static encoding_rs::Encoding) -> Result<String, String> {
    let (text, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        return Err(sql_file_encoding_error());
    }
    Ok(text.into_owned())
}

fn sql_file_encoding_error() -> String {
    "Unsupported SQL file encoding. Save the file as UTF-8, UTF-8 with BOM, UTF-16 with BOM, or GBK, then try again."
        .to_string()
}

#[derive(Default)]
pub struct SqlStatementSplitter {
    buffer: String,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    dollar_quote_tag: Option<String>,
    postgres_dollar_quoted_routine: bool,
    previous: Option<char>,
    custom_delimiter: Option<String>,
    options: SqlParsingOptions,
}

impl SqlStatementSplitter {
    pub fn with_options(options: SqlParsingOptions) -> Self {
        Self { options, ..Self::default() }
    }

    pub fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut statements = Vec::new();
        let chars = chunk.chars().collect::<Vec<_>>();
        let mut i = 0;

        while i < chars.len() {
            if let Some(tag) = &self.dollar_quote_tag {
                let tag_chars = tag.chars().collect::<Vec<_>>();
                if starts_with_chars(&chars, i, &tag_chars) {
                    for tag_ch in &tag_chars {
                        self.buffer.push(*tag_ch);
                        self.previous = Some(*tag_ch);
                    }
                    i += tag_chars.len();
                    self.dollar_quote_tag = None;
                    continue;
                }

                let ch = chars[i];
                self.buffer.push(ch);
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            let ch = chars[i];
            let next = chars.get(i + 1).copied();

            if self.in_line_comment {
                self.buffer.push(ch);
                if ch == '\n' {
                    self.in_line_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if self.in_block_comment {
                self.buffer.push(ch);
                if self.previous == Some('*') && ch == '/' {
                    self.in_block_comment = false;
                }
                self.previous = Some(ch);
                i += 1;
                continue;
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
                if self.previous == Some('-') && ch == '-' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if self.previous == Some('/') && ch == '*' {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if ch == '-' && next == Some('-') {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if self.options.profile.supports_hash_line_comments && ch == '#' {
                    self.in_line_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if ch == '/' && next == Some('*') {
                    self.in_block_comment = true;
                    self.buffer.push(ch);
                    self.previous = Some(ch);
                    i += 1;
                    continue;
                }
                if let Some(tag) = self
                    .options
                    .profile
                    .supports_dollar_quoted_strings
                    .then(|| dollar_quote_tag_at(&chars, i))
                    .flatten()
                {
                    if self.custom_delimiter.is_none() && !self.on_delimiter_line() {
                        if self.options.profile.supports_postgres_dollar_quoted_routines
                            && starts_with_postgres_dollar_quoted_routine_prefix(&self.buffer)
                        {
                            self.postgres_dollar_quoted_routine = true;
                        }
                        for tag_ch in tag.chars() {
                            self.buffer.push(tag_ch);
                            self.previous = Some(tag_ch);
                        }
                        i += tag.chars().count();
                        self.dollar_quote_tag = Some(tag);
                        continue;
                    }
                }
            }

            match ch {
                '\'' if !self.in_double_quote && !self.in_backtick && !has_odd_trailing_backslashes(&self.buffer) => {
                    self.in_single_quote = !self.in_single_quote;
                    self.buffer.push(ch);
                }
                '"' if !self.in_single_quote && !self.in_backtick && !has_odd_trailing_backslashes(&self.buffer) => {
                    self.in_double_quote = !self.in_double_quote;
                    self.buffer.push(ch);
                }
                '`' if !self.in_single_quote && !self.in_double_quote => {
                    self.in_backtick = !self.in_backtick;
                    self.buffer.push(ch);
                }
                ';' if !self.in_single_quote && !self.in_double_quote && !self.in_backtick => {
                    if (self.options.profile.supports_custom_delimiter_commands && self.on_delimiter_line())
                        || self.custom_delimiter.is_some()
                    {
                        self.buffer.push(ch);
                    } else if self.options.profile.supports_mysql_routine_blocks
                        && starts_with_mysql_routine_block(&self.buffer)
                    {
                        let mut candidate = self.buffer.clone();
                        candidate.push(ch);
                        if mysql_routine_block_is_complete(&candidate) {
                            // The final semicolon is the client-side statement delimiter.
                            // Keep semicolons inside BEGIN...END, but do not send the
                            // delimiter after END to the MySQL server.
                            self.push_current_statement(&mut statements);
                        } else {
                            self.buffer.push(ch);
                        }
                    } else if self.options.profile.supports_oracle_plsql_blocks
                        && !self.postgres_dollar_quoted_routine
                        && starts_with_oracle_plsql_block(&self.buffer)
                    {
                        self.buffer.push(ch);
                        if oracle_plsql_block_is_complete(&self.buffer) {
                            self.push_current_statement(&mut statements);
                        }
                    } else if self.options.profile.supports_hana_do_blocks && starts_with_hana_do_block(&self.buffer) {
                        self.buffer.push(ch);
                        if hana_do_block_is_complete(&self.buffer) {
                            self.push_current_statement(&mut statements);
                        }
                    } else {
                        self.push_current_statement(&mut statements);
                    }
                }
                _ => self.buffer.push(ch),
            }

            if !self.in_single_quote && !self.in_double_quote && !self.in_backtick && self.dollar_quote_tag.is_none() {
                if ch == '\n' {
                    let buf_end = self.buffer.len() - 1;
                    let last_line_start = self.buffer[..buf_end].rfind('\n').map_or(0, |p| p + 1);
                    let last_line = self.buffer[last_line_start..buf_end].trim();
                    if self.options.profile.supports_slash_line_block_delimiter && last_line == "/" {
                        let before = self.buffer[..last_line_start].trim();
                        if has_executable_sql_with_options(before, self.options) {
                            statements.push(before.to_string());
                        }
                        self.buffer.clear();
                        self.postgres_dollar_quoted_routine = false;
                        self.previous = None;
                        i += 1;
                        continue;
                    }
                    if let Some(new_delim) = self
                        .options
                        .profile
                        .supports_custom_delimiter_commands
                        .then(|| parse_delimiter_command(last_line))
                        .flatten()
                    {
                        self.custom_delimiter = if new_delim == ";" { None } else { Some(new_delim.to_string()) };
                        if last_line_start > 0 {
                            let before = self.buffer[..last_line_start].trim();
                            if has_executable_sql_with_options(before, self.options) {
                                statements.push(before.to_string());
                            }
                        }
                        self.buffer.clear();
                        self.postgres_dollar_quoted_routine = false;
                        self.previous = None;
                        i += 1;
                        continue;
                    }
                }
                if let Some(delim) = self.custom_delimiter.clone() {
                    if self.buffer.ends_with(delim.as_str()) {
                        self.buffer.truncate(self.buffer.len() - delim.len());
                        self.push_current_statement(&mut statements);
                    }
                }
            }

            self.previous = Some(ch);
            i += 1;
        }

        statements
    }

    pub fn finish(mut self) -> Vec<String> {
        let mut statements = Vec::new();
        let trimmed = self.buffer.trim();
        let last_line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
        if self.options.profile.supports_custom_delimiter_commands && parse_delimiter_command(last_line).is_some() {
            let before = trimmed.rsplit_once('\n').map(|x| x.0).unwrap_or("").trim();
            if has_executable_sql_with_options(before, self.options) {
                statements.push(before.to_string());
            }
            self.buffer.clear();
        } else if self.options.profile.supports_slash_line_block_delimiter && last_line == "/" {
            let before = trimmed.rsplit_once('\n').map(|x| x.0).unwrap_or("").trim();
            if has_executable_sql_with_options(before, self.options) {
                statements.push(before.to_string());
            }
            self.buffer.clear();
        } else if let Some(ref delim) = self.custom_delimiter {
            if self.buffer.ends_with(delim.as_str()) {
                self.buffer.truncate(self.buffer.len() - delim.len());
            }
        }
        self.push_current_statement(&mut statements);
        statements
    }

    fn push_current_statement(&mut self, statements: &mut Vec<String>) {
        let statement = self.buffer.trim();
        if has_executable_sql_with_options(statement, self.options) {
            statements.push(statement.to_string());
        }
        self.buffer.clear();
        self.postgres_dollar_quoted_routine = false;
        self.previous = None;
    }

    fn on_delimiter_line(&self) -> bool {
        let start = self.buffer.rfind('\n').map_or(0, |p| p + 1);
        let line = self.buffer[start..].trim_start().as_bytes();
        line.len() >= 9 && line[..9].eq_ignore_ascii_case(b"delimiter")
    }
}

fn has_odd_trailing_backslashes(sql: &str) -> bool {
    sql.as_bytes().iter().rev().take_while(|byte| **byte == b'\\').count() % 2 == 1
}

pub fn split_sql_statements(sql: &str) -> Vec<String> {
    split_sql_statements_with_options(sql, SqlParsingOptions::default())
}

pub fn split_sql_statements_for_database(sql: &str, db_type: DatabaseType) -> Vec<String> {
    split_sql_statements_with_options(sql, SqlParsingOptions::for_database_type(db_type))
}

pub fn split_sql_statements_with_options(sql: &str, options: SqlParsingOptions) -> Vec<String> {
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(sql);
    statements.extend(splitter.finish());
    statements
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlStatementRange {
    pub text: String,
    pub start: usize,
    pub end: usize,
}

pub fn find_statement_at_cursor(sql: &str, cursor_pos: usize) -> String {
    find_statement_at_cursor_with_options(sql, cursor_pos, SqlParsingOptions::default())
}

pub fn find_statement_at_cursor_for_database(sql: &str, cursor_pos: usize, db_type: DatabaseType) -> String {
    if false {
        return find_sqlserver_statement_at_cursor(sql, cursor_pos);
    }
    find_statement_at_cursor_with_options(sql, cursor_pos, SqlParsingOptions::for_database_type(db_type))
}

pub fn find_statement_at_cursor_with_options(sql: &str, cursor_pos: usize, options: SqlParsingOptions) -> String {
    let statements = split_sql_statement_ranges_with_options(sql, options);
    let cursor = utf16_offset_to_byte_index(sql, cursor_pos);

    for (idx, statement) in statements.iter().enumerate() {
        if cursor > statement.start && cursor < statement.end {
            return statement_text_at_cursor(sql, statement, cursor, options);
        }

        if cursor == statement.start {
            if cursor_has_sql_after_cursor_on_line(sql, cursor) {
                return statement_text_at_cursor(sql, statement, cursor, options);
            }
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| statements.get(prev_idx)) {
                return statement_text_at_cursor(sql, prev, cursor, options);
            }
            return statement_text_at_cursor(sql, statement, cursor, options);
        }

        if cursor < statement.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| statements.get(prev_idx)) {
                return statement_text_at_cursor(sql, prev, cursor, options);
            }
            return statement_text_at_cursor(sql, statement, cursor, options);
        }
    }

    statements
        .last()
        .map(|statement| statement_text_at_cursor(sql, statement, cursor, options))
        .unwrap_or_else(|| sql.trim().to_string())
}

fn cursor_has_sql_after_cursor_on_line(sql: &str, cursor: usize) -> bool {
    let line_end = sql[cursor..].find('\n').map_or(sql.len(), |offset| cursor + offset);
    sql[cursor..line_end].chars().any(|ch| !ch.is_whitespace())
}

fn statement_text_at_cursor(
    sql: &str,
    statement: &SqlStatementRange,
    cursor: usize,
    options: SqlParsingOptions,
) -> String {
    let soft_ranges = split_statement_range_at_blank_lines(sql, statement, options);
    find_statement_text_in_ranges(sql, &soft_ranges, cursor).unwrap_or_else(|| statement.text.clone())
}

fn find_statement_text_in_ranges(sql: &str, ranges: &[SqlStatementRange], cursor: usize) -> Option<String> {
    for (idx, range) in ranges.iter().enumerate() {
        if cursor > range.start && cursor < range.end {
            return Some(range.text.clone());
        }

        if cursor == range.start {
            if cursor_has_sql_after_cursor_on_line(sql, cursor) {
                return Some(range.text.clone());
            }
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| ranges.get(prev_idx)) {
                return Some(prev.text.clone());
            }
            return Some(range.text.clone());
        }

        if cursor < range.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| ranges.get(prev_idx)) {
                return Some(prev.text.clone());
            }
            return Some(range.text.clone());
        }
    }

    ranges.last().map(|range| range.text.clone())
}

fn split_statement_range_at_blank_lines(
    sql: &str,
    statement: &SqlStatementRange,
    options: SqlParsingOptions,
) -> Vec<SqlStatementRange> {
    if options.profile.supports_oracle_plsql_blocks && starts_with_oracle_plsql_block(&statement.text) {
        return vec![statement.clone()];
    }
    if options.profile.supports_hana_do_blocks && starts_with_hana_do_block(&statement.text) {
        return vec![statement.clone()];
    }

    let mut ranges = Vec::new();
    let mut scanner = SqlScanner::with_profile(options.profile);
    let mut current_start = statement.start;
    let mut line_start = statement.start;
    let mut line_has_non_whitespace = false;
    let mut blank_line_run = 0usize;

    for (relative_idx, ch) in sql[statement.start..statement.end].char_indices() {
        let idx = statement.start + relative_idx;
        if ch == '\n' {
            if !line_has_non_whitespace && !scanner.is_masked() {
                blank_line_run += 1;
            } else {
                blank_line_run = 0;
            }
            scanner.step(sql, idx, ch);
            line_start = idx + ch.len_utf8();
            line_has_non_whitespace = false;
            continue;
        }

        if !line_has_non_whitespace && !ch.is_whitespace() {
            if blank_line_run >= 2
                && !scanner.is_masked()
                && has_executable_sql_with_options(&sql[current_start..line_start], options)
                && starts_with_soft_statement_keyword(&sql[line_start..statement.end], options)
            {
                push_statement_range(&mut ranges, sql, current_start, line_start, options);
                current_start = line_start;
            }
            blank_line_run = 0;
            line_has_non_whitespace = true;
        }

        scanner.step(sql, idx, ch);
    }

    push_statement_range(&mut ranges, sql, current_start, statement.end, options);
    if ranges.is_empty() {
        vec![statement.clone()]
    } else {
        ranges
    }
}

fn starts_with_soft_statement_keyword(sql: &str, options: SqlParsingOptions) -> bool {
    if options.profile.supports_hana_do_blocks && starts_with_executable_sql_keyword_with_options(sql, &["DO"], options)
    {
        return true;
    }
    starts_with_executable_sql_keyword_with_options(
        sql,
        &[
            "CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "TRUNCATE", "GRANT", "REVOKE",
            "COMMENT", "EXPLAIN", "SHOW", "DESCRIBE", "USE", "SET", "CALL", "EXEC", "EXECUTE", "BEGIN", "COMMIT",
            "ROLLBACK", "DECLARE", "ANALYZE", "VACUUM", "PRAGMA", "REFRESH", "COPY",
        ],
        options,
    )
}

fn split_sql_statement_ranges_with_options(sql: &str, options: SqlParsingOptions) -> Vec<SqlStatementRange> {
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut dollar_quote_tag: Option<String> = None;
    let mut custom_delimiter: Option<String> = None;
    let mut postgres_dollar_quoted_routine = false;

    while i < sql.len() {
        if let Some(tag) = &dollar_quote_tag {
            if sql[i..].starts_with(tag) {
                i += tag.len();
                dollar_quote_tag = None;
                continue;
            }
            i += next_char_len(sql, i);
            continue;
        }

        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());

        if in_line_comment {
            i += ch.len_utf8();
            if ch == '\n' {
                in_line_comment = false;
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                i += 2;
                in_block_comment = false;
            } else {
                i += ch.len_utf8();
            }
            continue;
        }

        if !in_single_quote && !in_double_quote && !in_backtick {
            if ch == '-' && next == Some('-') {
                in_line_comment = true;
                i += 2;
                continue;
            }
            if options.profile.supports_hash_line_comments && ch == '#' {
                in_line_comment = true;
                i += ch.len_utf8();
                continue;
            }
            if ch == '/' && next == Some('*') {
                in_block_comment = true;
                i += 2;
                continue;
            }
            if let Some(tag) =
                options.profile.supports_dollar_quoted_strings.then(|| dollar_quote_tag_at_str(sql, i)).flatten()
            {
                if custom_delimiter.is_none() && !is_on_delimiter_line(sql, start, i) {
                    if options.profile.supports_postgres_dollar_quoted_routines
                        && starts_with_postgres_dollar_quoted_routine_prefix(&sql[start..i])
                    {
                        postgres_dollar_quoted_routine = true;
                    }
                    i += tag.len();
                    dollar_quote_tag = Some(tag);
                    continue;
                }
            }
            if ch == '\n' {
                let line_start = sql[..i].rfind('\n').map_or(0, |pos| pos + 1);
                let line = sql[line_start..i].trim();
                if options.profile.supports_slash_line_block_delimiter && line == "/" {
                    push_statement_range(&mut ranges, sql, start, line_start, options);
                    start = i + ch.len_utf8();
                    postgres_dollar_quoted_routine = false;
                    i = start;
                    continue;
                }
                if let Some(new_delimiter) =
                    options.profile.supports_custom_delimiter_commands.then(|| parse_delimiter_command(line)).flatten()
                {
                    let before = sql[start..line_start].trim();
                    if has_executable_sql_with_options(before, options) {
                        push_statement_range(&mut ranges, sql, start, line_start, options);
                    }
                    custom_delimiter = if new_delimiter == ";" { None } else { Some(new_delimiter.to_string()) };
                    start = i + ch.len_utf8();
                    postgres_dollar_quoted_routine = false;
                    i = start;
                    continue;
                }
            }
        }

        match ch {
            '\'' if !in_double_quote && !in_backtick && !is_escaped_single_quote(sql, i) => {
                in_single_quote = !in_single_quote;
                i += ch.len_utf8();
            }
            '"' if !in_single_quote && !in_backtick => {
                in_double_quote = !in_double_quote;
                i += ch.len_utf8();
            }
            '`' if !in_single_quote && !in_double_quote => {
                in_backtick = !in_backtick;
                i += ch.len_utf8();
            }
            ';' if !(in_single_quote
                || in_double_quote
                || in_backtick
                || custom_delimiter.is_some()
                || (options.profile.supports_custom_delimiter_commands && is_on_delimiter_line(sql, start, i))) =>
            {
                let is_mysql_routine =
                    options.profile.supports_mysql_routine_blocks && starts_with_mysql_routine_block(&sql[start..i]);
                if is_mysql_routine {
                    if !mysql_routine_block_is_complete(&sql[start..i + ch.len_utf8()]) {
                        i += ch.len_utf8();
                        continue;
                    }
                    push_statement_range(&mut ranges, sql, start, i, options);
                } else {
                    let is_oracle_plsql = options.profile.supports_oracle_plsql_blocks
                        && !postgres_dollar_quoted_routine
                        && starts_with_oracle_plsql_block(&sql[start..i]);
                    if is_oracle_plsql {
                        if !oracle_plsql_block_is_complete(&sql[start..i + ch.len_utf8()]) {
                            i += ch.len_utf8();
                            continue;
                        }
                        push_statement_range(&mut ranges, sql, start, i + ch.len_utf8(), options);
                    } else if options.profile.supports_hana_do_blocks && starts_with_hana_do_block(&sql[start..i]) {
                        if !hana_do_block_is_complete(&sql[start..i + ch.len_utf8()]) {
                            i += ch.len_utf8();
                            continue;
                        }
                        push_statement_range(&mut ranges, sql, start, i + ch.len_utf8(), options);
                    } else {
                        push_statement_range(&mut ranges, sql, start, i, options);
                    }
                }
                i += ch.len_utf8();
                start = i;
                postgres_dollar_quoted_routine = false;
            }
            _ => {
                i += ch.len_utf8();
                if !in_single_quote && !in_double_quote && !in_backtick {
                    if let Some(delimiter) = &custom_delimiter {
                        if sql[start..i].ends_with(delimiter) {
                            let end = i - delimiter.len();
                            push_statement_range(&mut ranges, sql, start, end, options);
                            start = i;
                            postgres_dollar_quoted_routine = false;
                        }
                    }
                }
            }
        }
    }

    let trimmed = sql[start..].trim();
    let last_line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
    if options.profile.supports_custom_delimiter_commands && parse_delimiter_command(last_line).is_some() {
        if let Some(line_start) = sql[start..].rfind('\n').map(|pos| start + pos + 1) {
            push_statement_range(&mut ranges, sql, start, line_start, options);
        }
    } else if options.profile.supports_slash_line_block_delimiter && last_line == "/" {
        if let Some(line_start) = sql[start..].rfind('\n').map(|pos| start + pos + 1) {
            push_statement_range(&mut ranges, sql, start, line_start, options);
        }
    } else {
        push_statement_range(&mut ranges, sql, start, sql.len(), options);
    }

    ranges
}

fn push_statement_range(
    ranges: &mut Vec<SqlStatementRange>,
    sql: &str,
    start: usize,
    end: usize,
    options: SqlParsingOptions,
) {
    let Some((relative_start, relative_end)) = executable_sql_bounds(&sql[start..end], options) else {
        return;
    };
    let statement_start = start + relative_start;
    let statement_end = start + relative_end;
    let text = sql[statement_start..statement_end].to_string();
    if !text.is_empty() {
        ranges.push(SqlStatementRange { text, start: statement_start, end: statement_end });
    }
}

fn utf16_offset_to_byte_index(sql: &str, offset: usize) -> usize {
    let mut utf16_seen = 0;
    for (byte_index, ch) in sql.char_indices() {
        if utf16_seen >= offset {
            return byte_index;
        }
        utf16_seen += ch.len_utf16();
        if utf16_seen > offset {
            return byte_index + ch.len_utf8();
        }
    }
    sql.len()
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

fn next_char_len(sql: &str, index: usize) -> usize {
    next_char(sql, index).len_utf8()
}

fn is_escaped_single_quote(sql: &str, index: usize) -> bool {
    index > 0 && sql.as_bytes().get(index - 1) == Some(&b'\\')
}

fn is_on_delimiter_line(sql: &str, range_start: usize, index: usize) -> bool {
    let line_start = sql[range_start..index].rfind('\n').map_or(range_start, |pos| range_start + pos + 1);
    sql[line_start..index]
        .trim_start()
        .as_bytes()
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"delimiter"))
}

fn dollar_quote_tag_at_str(sql: &str, index: usize) -> Option<String> {
    let rest = &sql[index..];
    if !rest.starts_with('$') {
        return None;
    }
    let end = rest[1..].find('$')? + 1;
    let tag = &rest[..=end];
    if tag.len() == 2 {
        return Some(tag.to_string());
    }
    let name = &tag[1..tag.len() - 1];
    if !name.chars().all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return None;
    }
    Some(tag.to_string())
}

pub fn split_sql_batches(sql: &str) -> Vec<String> {
    let ranges = split_sql_batch_ranges(sql, SqlDialectProfile::sql_server());
    if ranges.is_empty() {
        let trimmed = sql.trim();
        return if trimmed.is_empty() { Vec::new() } else { vec![trimmed.to_string()] };
    }
    ranges.into_iter().map(|range| range.text).collect()
}

fn split_sql_batch_ranges(sql: &str, profile: SqlDialectProfile) -> Vec<SqlStatementRange> {
    let mut batches = Vec::new();
    let mut current_start = 0;
    let lines: Vec<&str> = sql.split('\n').collect();
    let mut offset = 0;
    let mut scanner = SqlScanner::with_profile(profile);

    for line in &lines {
        let line_start = offset;
        let line_end = offset + line.len();
        offset = line_end + 1; // +1 for the '\n'

        let trimmed = line.trim();
        let is_batch_separator = profile.supports_go_batch_separator
            && !scanner.is_masked()
            && (trimmed.eq_ignore_ascii_case("go")
                || trimmed.to_ascii_lowercase().starts_with("go ") && trimmed[2..].trim().is_empty());
        if is_batch_separator {
            push_batch_range(&mut batches, sql, current_start, line_start);
            current_start = line_end.min(sql.len());
            if current_start < sql.len() && sql.as_bytes()[current_start] == b'\n' {
                current_start += 1;
            }
        } else {
            for (relative_idx, ch) in line.char_indices() {
                scanner.step(sql, line_start + relative_idx, ch);
            }
        }
        if line_end < sql.len() {
            scanner.step(sql, line_end, '\n');
        }
    }

    push_batch_range(&mut batches, sql, current_start, sql.len());
    batches
}

fn push_batch_range(ranges: &mut Vec<SqlStatementRange>, sql: &str, start: usize, end: usize) {
    let Some((relative_start, relative_end)) = executable_sql_bounds(&sql[start..end], SqlParsingOptions::default())
    else {
        return;
    };
    let statement_start = start + relative_start;
    let statement_end = start + relative_end;
    let text = sql[statement_start..statement_end].to_string();
    if !text.is_empty() {
        ranges.push(SqlStatementRange { text, start: statement_start, end: statement_end });
    }
}

fn find_sqlserver_statement_at_cursor(sql: &str, cursor_pos: usize) -> String {
    let profile = SqlDialectProfile::sql_server();
    let cursor = utf16_offset_to_byte_index(sql, cursor_pos);
    let batches = split_sql_batch_ranges(sql, profile);

    for (idx, batch) in batches.iter().enumerate() {
        if cursor >= batch.start && cursor <= batch.end {
            if profile.keeps_sqlserver_module_batch_at_cursor && starts_with_sqlserver_module_ddl(&batch.text) {
                return batch.text.clone();
            }
            let relative_cursor = sql[..cursor].encode_utf16().count() - sql[..batch.start].encode_utf16().count();
            return find_statement_at_cursor_with_options(&batch.text, relative_cursor, SqlParsingOptions::default());
        }

        if cursor < batch.start {
            if let Some(prev) = idx.checked_sub(1).and_then(|prev_idx| batches.get(prev_idx)) {
                if profile.keeps_sqlserver_module_batch_at_cursor && starts_with_sqlserver_module_ddl(&prev.text) {
                    return prev.text.clone();
                }
                let relative_cursor = prev.text.encode_utf16().count();
                return find_statement_at_cursor_with_options(
                    &prev.text,
                    relative_cursor,
                    SqlParsingOptions::default(),
                );
            }
            return batch.text.clone();
        }
    }

    batches.last().map(|batch| batch.text.clone()).unwrap_or_else(|| sql.trim().to_string())
}

fn starts_with_sqlserver_module_ddl(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 4);
    if tokens.len() >= 4
        && tokens[0].eq_ignore_ascii_case("CREATE")
        && tokens[1].eq_ignore_ascii_case("OR")
        && tokens[2].eq_ignore_ascii_case("ALTER")
    {
        return is_sqlserver_module_keyword(&tokens[3]);
    }

    tokens.len() >= 2
        && (tokens[0].eq_ignore_ascii_case("CREATE") || tokens[0].eq_ignore_ascii_case("ALTER"))
        && is_sqlserver_module_keyword(&tokens[1])
}

fn is_sqlserver_module_keyword(token: &str) -> bool {
    ["FUNCTION", "PROC", "PROCEDURE", "TRIGGER", "VIEW"].iter().any(|keyword| token.eq_ignore_ascii_case(keyword))
}

fn starts_with_mysql_routine_block(sql: &str) -> bool {
    is_mysql_routine_ddl_start(sql) && mysql_routine_tokens(sql).iter().any(|token| token.eq_ignore_ascii_case("BEGIN"))
}

fn is_mysql_routine_ddl_start(sql: &str) -> bool {
    let executable = leading_executable_sql_with_options(sql, SqlParsingOptions::mysql_compatible());
    let tokens = first_sql_tokens(executable, 16);
    if tokens.first().is_none_or(|token| !token.eq_ignore_ascii_case("CREATE")) {
        return false;
    }

    for token in tokens.iter().skip(1) {
        if ["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"].iter().any(|keyword| token.eq_ignore_ascii_case(keyword)) {
            return true;
        }
        if [
            "DATABASE",
            "INDEX",
            "LOGFILE",
            "ROLE",
            "SCHEMA",
            "SERVER",
            "SPATIAL",
            "TABLE",
            "TEMPORARY",
            "UNIQUE",
            "USER",
            "VIEW",
        ]
        .iter()
        .any(|keyword| token.eq_ignore_ascii_case(keyword))
        {
            return false;
        }
    }

    false
}

fn mysql_routine_block_is_complete(sql: &str) -> bool {
    if !starts_with_mysql_routine_block(sql) {
        return false;
    }

    let tokens = mysql_routine_tokens(sql);
    let mut begin_depth = 0usize;
    let mut saw_begin = false;

    for (index, token) in tokens.iter().enumerate() {
        if token == ";" {
            continue;
        }
        if token.eq_ignore_ascii_case("BEGIN") {
            if previous_mysql_routine_word(&tokens, index).is_some_and(|previous| previous.eq_ignore_ascii_case("END"))
            {
                continue;
            }
            saw_begin = true;
            begin_depth += 1;
            continue;
        }
        if token.eq_ignore_ascii_case("END") && saw_begin {
            if next_mysql_routine_word(&tokens, index).is_some_and(is_mysql_control_block_suffix) {
                continue;
            }
            begin_depth = begin_depth.saturating_sub(1);
        }
    }

    saw_begin && begin_depth == 0 && tokens.last().is_some_and(|token| token == ";")
}

fn is_mysql_control_block_suffix(token: &str) -> bool {
    ["IF", "LOOP", "CASE", "REPEAT", "WHILE"].iter().any(|keyword| token.eq_ignore_ascii_case(keyword))
}

fn previous_mysql_routine_word(tokens: &[String], index: usize) -> Option<&str> {
    tokens[..index].iter().rev().find(|token| token.as_str() != ";").map(String::as_str)
}

fn next_mysql_routine_word(tokens: &[String], index: usize) -> Option<&str> {
    tokens.get(index + 1..)?.iter().find(|token| token.as_str() != ";").map(String::as_str)
}

fn mysql_routine_tokens(sql: &str) -> Vec<String> {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick = false;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }

        if in_block_comment {
            if ch == '*' && next == Some('/') {
                in_block_comment = false;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }

        if in_single_quote {
            if ch == '\\' && next.is_some() {
                i += 2;
                continue;
            }
            if ch == '\'' {
                if next == Some('\'') {
                    i += 2;
                    continue;
                }
                in_single_quote = false;
            }
            i += 1;
            continue;
        }

        if in_double_quote {
            if ch == '\\' && next.is_some() {
                i += 2;
                continue;
            }
            if ch == '"' {
                if next == Some('"') {
                    i += 2;
                    continue;
                }
                in_double_quote = false;
            }
            i += 1;
            continue;
        }

        if in_backtick {
            if ch == '`' {
                if next == Some('`') {
                    i += 2;
                    continue;
                }
                in_backtick = false;
            }
            i += 1;
            continue;
        }

        if ch == '-' && next == Some('-') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if ch == '#' {
            in_line_comment = true;
            i += 1;
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block_comment = true;
            i += 2;
            continue;
        }
        if ch == '\'' {
            in_single_quote = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double_quote = true;
            i += 1;
            continue;
        }
        if ch == '`' {
            in_backtick = true;
            i += 1;
            continue;
        }
        if ch == ';' {
            tokens.push(";".to_string());
            i += 1;
            continue;
        }
        if ch == '_' || ch.is_ascii_alphabetic() {
            let start = i;
            i += 1;
            while i < chars.len() && is_sql_ident_char(chars[i]) {
                i += 1;
            }
            tokens.push(chars[start..i].iter().collect::<String>().to_ascii_uppercase());
            continue;
        }

        i += 1;
    }

    tokens
}

fn first_sql_tokens(sql: &str, limit: usize) -> Vec<String> {
    let mut tokens = Vec::new();
    for token in sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_') {
        if token.is_empty() {
            continue;
        }
        tokens.push(token.to_string());
        if tokens.len() >= limit {
            break;
        }
    }
    tokens
}

fn parse_delimiter_command(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let rest = if bytes.len() > 10
        && (bytes[..10].eq_ignore_ascii_case(b"delimiter ") || bytes[..10].eq_ignore_ascii_case(b"delimiter\t"))
    {
        Some(&line[10..])
    } else {
        None
    };
    rest.map(|r| r.trim()).filter(|r| !r.is_empty())
}

pub fn statement_summary(statement: &str) -> String {
    const MAX_LEN: usize = 120;

    let collapsed = statement.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_LEN {
        return collapsed;
    }

    collapsed.chars().take(MAX_LEN).collect()
}

pub fn prepare_sql_file_statement(
    statement: &str,
    db_type: &DatabaseType,
    driver_profile: Option<&str>,
) -> SqlFileStatementAction {
    let statement = statement.trim();
    let is_mysql_compatible_target = is_mysql_compatible_import_target(db_type, driver_profile);
    if is_mysql_compatible_target && is_mysql_lock_table_statement(statement) {
        return SqlFileStatementAction::Skip;
    }

    let Some(body) = mysql_executable_comment_body(statement) else {
        if is_mysql_compatible_target && is_mysql_session_restore_statement(statement) {
            return SqlFileStatementAction::Skip;
        }
        return SqlFileStatementAction::Execute(statement.to_string());
    };

    if !is_mysql_compatible_target {
        return SqlFileStatementAction::Skip;
    }

    let body = body.trim();
    if body.is_empty() || is_mysql_key_toggle_statement(body) || is_mysql_session_restore_statement(body) {
        return SqlFileStatementAction::Skip;
    }

    SqlFileStatementAction::Execute(body.to_string())
}

pub fn optimize_sql_file_import_statements(
    statements: &[String],
    db_type: Option<DatabaseType>,
    driver_profile: Option<&str>,
) -> Vec<SqlFileImportStatement> {
    let mut optimized = Vec::new();
    let mut pending_insert: Option<PendingInsertBatch> = None;

    for statement in statements {
        let action = db_type
            .as_ref()
            .map(|db_type| prepare_sql_file_statement(statement, db_type, driver_profile))
            .unwrap_or_else(|| SqlFileStatementAction::Execute(statement.trim().to_string()));

        match action {
            SqlFileStatementAction::Skip => {
                flush_pending_insert(&mut optimized, &mut pending_insert);
                optimized.push(SqlFileImportStatement {
                    kind: SqlFileImportStatementKind::Skip,
                    sql: statement.trim().to_string(),
                    source_sqls: vec![statement.trim().to_string()],
                    source_statement_count: 1,
                });
            }
            SqlFileStatementAction::Execute(sql) => {
                let options = db_type.map(SqlParsingOptions::for_database_type).unwrap_or_default();
                if let Some(insert) = parse_mergeable_insert(&sql, options) {
                    match pending_insert.as_mut() {
                        Some(batch) if batch.can_accept(&insert) => batch.push(insert),
                        Some(_) => {
                            flush_pending_insert(&mut optimized, &mut pending_insert);
                            pending_insert = Some(PendingInsertBatch::new(insert));
                        }
                        None => {
                            pending_insert = Some(PendingInsertBatch::new(insert));
                        }
                    }
                } else {
                    flush_pending_insert(&mut optimized, &mut pending_insert);
                    optimized.push(SqlFileImportStatement {
                        kind: SqlFileImportStatementKind::Execute,
                        sql: sql.clone(),
                        source_sqls: vec![sql],
                        source_statement_count: 1,
                    });
                }
            }
        }
    }

    flush_pending_insert(&mut optimized, &mut pending_insert);
    optimized
}

fn flush_pending_insert(optimized: &mut Vec<SqlFileImportStatement>, pending_insert: &mut Option<PendingInsertBatch>) {
    if let Some(batch) = pending_insert.take() {
        optimized.push(SqlFileImportStatement {
            kind: SqlFileImportStatementKind::Execute,
            sql: batch.to_sql(),
            source_sqls: batch.source_sqls,
            source_statement_count: batch.source_statement_count,
        });
    }
}

const SQL_FILE_INSERT_BATCH_MAX_STATEMENTS: usize = 500;
const SQL_FILE_INSERT_BATCH_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
struct MergeableInsert {
    prefix: String,
    prefix_key: String,
    values: String,
    sql: String,
}

#[derive(Debug, Clone)]
struct PendingInsertBatch {
    prefix: String,
    prefix_key: String,
    values: Vec<String>,
    source_sqls: Vec<String>,
    source_statement_count: usize,
    byte_len: usize,
}

impl PendingInsertBatch {
    fn new(insert: MergeableInsert) -> Self {
        let byte_len = insert.prefix.len() + insert.values.len() + 16;
        Self {
            prefix: insert.prefix,
            prefix_key: insert.prefix_key,
            values: vec![insert.values],
            source_sqls: vec![insert.sql],
            source_statement_count: 1,
            byte_len,
        }
    }

    fn can_accept(&self, insert: &MergeableInsert) -> bool {
        self.prefix_key == insert.prefix_key
            && self.source_statement_count < SQL_FILE_INSERT_BATCH_MAX_STATEMENTS
            && self.byte_len + insert.values.len() + 3 <= SQL_FILE_INSERT_BATCH_MAX_BYTES
    }

    fn push(&mut self, insert: MergeableInsert) {
        self.byte_len += insert.values.len() + 3;
        self.values.push(insert.values);
        self.source_sqls.push(insert.sql);
        self.source_statement_count += 1;
    }

    fn to_sql(&self) -> String {
        if self.source_statement_count == 1 {
            return self.source_sqls.first().cloned().unwrap_or_default();
        }
        format!("{} VALUES\n{}", self.prefix, self.values.join(",\n"))
    }
}

fn parse_mergeable_insert(sql: &str, options: SqlParsingOptions) -> Option<MergeableInsert> {
    let executable = leading_executable_sql_with_options(sql, options).trim().trim_end_matches(';').trim();
    if !starts_with_keyword(executable, "insert") {
        return None;
    }

    let (values_start, values_end) = find_top_level_values_keyword(executable)?;
    let prefix_without_values = executable[..values_start].trim_end();
    let values = executable[values_end..].trim();
    let values = parse_insert_values_tail(values)?;

    let prefix = prefix_without_values.to_string();
    Some(MergeableInsert {
        prefix_key: normalize_insert_prefix_key(&prefix),
        prefix,
        values,
        sql: executable.to_string(),
    })
}

fn find_top_level_values_keyword(sql: &str) -> Option<(usize, usize)> {
    let mut scanner = SqlScanner::default();
    let mut depth = 0usize;

    for (idx, ch) in sql.char_indices() {
        scanner.step(sql, idx, ch);
        if scanner.is_masked() {
            continue;
        }

        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => {
                for keyword in ["values", "value"] {
                    if keyword_at(sql, idx, keyword) {
                        return Some((idx, idx + keyword.len()));
                    }
                }
            }
            _ => {}
        }
    }

    None
}

fn parse_insert_values_tail(tail: &str) -> Option<String> {
    let tail = tail.trim().trim_end_matches(';').trim();
    if tail.is_empty() {
        return None;
    }

    let mut scanner = SqlScanner::default();
    let mut depth = 0usize;
    let mut saw_tuple = false;
    let mut expecting_tuple = true;

    for (idx, ch) in tail.char_indices() {
        scanner.step(tail, idx, ch);
        if scanner.is_masked() {
            continue;
        }

        if expecting_tuple {
            if ch.is_whitespace() || (saw_tuple && ch == ',') {
                continue;
            }
            if ch != '(' {
                return None;
            }
            expecting_tuple = false;
            saw_tuple = true;
            depth = 1;
            continue;
        }

        match ch {
            '(' => depth += 1,
            ')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    expecting_tuple = true;
                }
            }
            ',' if depth == 0 => {}
            _ if depth == 0 && !ch.is_whitespace() => return None,
            _ => {}
        }
    }

    if saw_tuple && depth == 0 {
        Some(tail.to_string())
    } else {
        None
    }
}

#[derive(Default)]
struct SqlScanner {
    profile: SqlDialectProfile,
    in_single_quote: bool,
    in_double_quote: bool,
    in_backtick: bool,
    in_line_comment: bool,
    in_block_comment: bool,
    dollar_quote_tag: Option<String>,
    previous: Option<char>,
}

impl SqlScanner {
    fn with_profile(profile: SqlDialectProfile) -> Self {
        Self { profile, ..Self::default() }
    }

    fn step(&mut self, sql: &str, idx: usize, ch: char) {
        if let Some(tag) = self.dollar_quote_tag.clone() {
            if sql[idx..].starts_with(&tag) {
                self.dollar_quote_tag = None;
            }
            self.previous = Some(ch);
            return;
        }

        let next = next_char_at(sql, idx + ch.len_utf8());
        if self.in_line_comment {
            if ch == '\n' {
                self.in_line_comment = false;
            }
            self.previous = Some(ch);
            return;
        }
        if self.in_block_comment {
            if self.previous == Some('*') && ch == '/' {
                self.in_block_comment = false;
            }
            self.previous = Some(ch);
            return;
        }

        if !self.in_single_quote && !self.in_double_quote && !self.in_backtick {
            if (ch == '-' && next == Some('-')) || (self.profile.supports_hash_line_comments && ch == '#') {
                self.in_line_comment = true;
            } else if ch == '/' && next == Some('*') {
                self.in_block_comment = true;
            } else if let Some(tag) =
                self.profile.supports_dollar_quoted_strings.then(|| dollar_quote_tag_at_str(sql, idx)).flatten()
            {
                self.dollar_quote_tag = Some(tag);
            }
        }

        match ch {
            '\'' if !self.in_double_quote && !self.in_backtick && self.previous != Some('\\') => {
                self.in_single_quote = !self.in_single_quote;
            }
            '"' if !self.in_single_quote && !self.in_backtick && self.previous != Some('\\') => {
                self.in_double_quote = !self.in_double_quote;
            }
            '`' if !self.in_single_quote && !self.in_double_quote => {
                self.in_backtick = !self.in_backtick;
            }
            _ => {}
        }
        self.previous = Some(ch);
    }

    fn is_masked(&self) -> bool {
        self.in_single_quote
            || self.in_double_quote
            || self.in_backtick
            || self.in_line_comment
            || self.in_block_comment
            || self.dollar_quote_tag.is_some()
    }
}

fn keyword_at(sql: &str, idx: usize, keyword: &str) -> bool {
    let end = idx + keyword.len();
    sql.get(idx..end).is_some_and(|candidate| candidate.eq_ignore_ascii_case(keyword))
        && sql[..idx].chars().next_back().is_none_or(|ch| !is_sql_ident_char(ch))
        && sql.get(end..).and_then(|tail| tail.chars().next()).is_none_or(|ch| !is_sql_ident_char(ch))
}

fn starts_with_keyword(sql: &str, keyword: &str) -> bool {
    sql.get(..keyword.len()).is_some_and(|candidate| candidate.eq_ignore_ascii_case(keyword))
        && sql.get(keyword.len()..).and_then(|tail| tail.chars().next()).is_none_or(|ch| !is_sql_ident_char(ch))
}

fn is_sql_ident_char(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()
}

fn normalize_insert_prefix_key(prefix: &str) -> String {
    let mut scanner = SqlScanner::default();
    let mut key = String::with_capacity(prefix.len());
    let mut previous_space = false;

    for (idx, ch) in prefix.char_indices() {
        scanner.step(prefix, idx, ch);
        if scanner.in_single_quote
            || scanner.in_double_quote
            || scanner.in_backtick
            || scanner.dollar_quote_tag.is_some()
        {
            key.push(ch);
            previous_space = false;
            continue;
        }

        if ch.is_whitespace() {
            if !previous_space {
                key.push(' ');
            }
            previous_space = true;
        } else {
            key.push(ch.to_ascii_lowercase());
            previous_space = false;
        }
    }

    key.trim().to_string()
}

pub fn starts_with_executable_sql_keyword(sql: &str, keywords: &[&str]) -> bool {
    starts_with_executable_sql_keyword_with_options(sql, keywords, SqlParsingOptions::default())
}

pub fn starts_with_executable_sql_keyword_for_database(sql: &str, keywords: &[&str], db_type: DatabaseType) -> bool {
    starts_with_executable_sql_keyword_with_options(sql, keywords, SqlParsingOptions::for_database_type(db_type))
}

pub fn starts_with_duckdb_result_sql_keyword(sql: &str) -> bool {
    starts_with_executable_sql_keyword(
        sql,
        &[
            "SELECT",
            "SHOW",
            "DESCRIBE",
            "EXPLAIN",
            "WITH",
            "PRAGMA",
            "FROM",
            "SUMMARIZE",
            "SUMMARISE",
            "PIVOT",
            "UNPIVOT",
        ],
    )
}

pub fn starts_with_executable_sql_keyword_with_options(
    sql: &str,
    keywords: &[&str],
    options: SqlParsingOptions,
) -> bool {
    let Some(token) = first_executable_sql_token_with_options(sql, options) else {
        return false;
    };
    keywords.iter().any(|keyword| executable_sql_keyword_matches(token, keyword))
}

fn executable_sql_keyword_matches(token: &str, keyword: &str) -> bool {
    token.eq_ignore_ascii_case(keyword)
        || (keyword.eq_ignore_ascii_case("DESCRIBE") && token.eq_ignore_ascii_case("DESC"))
}

fn is_mysql_compatible_import_profile(profile: &str) -> bool {
    matches!(
        profile,
        "mariadb"
            | "tidb"
            | "oceanbase"
            | "custom_mysql"
            | "doris"
            | "starrocks"
            | "manticoresearch"
            | "selectdb"
            | "goldendb"
    )
}

fn is_mysql_compatible_import_target(_db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    false
        || driver_profile
            .map(|profile| profile.to_ascii_lowercase())
            .is_some_and(|profile| is_mysql_compatible_import_profile(&profile))
}

fn mysql_executable_comment_body(statement: &str) -> Option<&str> {
    let bytes = statement.as_bytes();
    let start = leading_mysql_executable_comment_start(statement)?;
    let body_start = if bytes.get(start + 2) == Some(&b'!') { start + 3 } else { start + 4 };
    let mut body_start = body_start;
    while body_start < bytes.len() && (bytes[body_start].is_ascii_digit() || bytes[body_start].is_ascii_whitespace()) {
        body_start += 1;
    }

    let close = find_block_comment_close(bytes, body_start)?;
    if has_executable_sql(&statement[close + 2..]) {
        return None;
    }

    Some(&statement[body_start..close])
}

fn leading_mysql_executable_comment_start(statement: &str) -> Option<usize> {
    let bytes = statement.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                return Some(i);
            }

            let close = find_block_comment_close(bytes, i + 2)?;
            i = close + 2;
            continue;
        }

        return None;
    }

    None
}

fn find_block_comment_close(bytes: &[u8], mut start: usize) -> Option<usize> {
    while start + 1 < bytes.len() {
        if bytes[start] == b'*' && bytes[start + 1] == b'/' {
            return Some(start);
        }
        start += 1;
    }
    None
}

fn is_mysql_key_toggle_statement(statement: &str) -> bool {
    let upper = statement.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    upper.starts_with("ALTER TABLE ") && (upper.ends_with(" ENABLE KEYS") || upper.ends_with(" DISABLE KEYS"))
}

fn is_mysql_lock_table_statement(statement: &str) -> bool {
    let executable = leading_executable_sql(statement);
    let upper = executable.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    upper == "UNLOCK TABLES" || (upper.starts_with("LOCK TABLES ") && upper.ends_with(" WRITE"))
}

fn is_mysql_session_restore_statement(statement: &str) -> bool {
    let executable = leading_executable_sql_with_options(statement, SqlParsingOptions::mysql_compatible());
    let upper = executable.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase();
    if !upper.starts_with("SET ") {
        return false;
    }

    let assignment = upper.trim_start_matches("SET ").trim();
    if assignment.starts_with('@') {
        return false;
    }

    assignment.contains("= @OLD_")
        || assignment.contains("=@OLD_")
        || assignment.contains("= @SAVED_")
        || assignment.contains("=@SAVED_")
}

fn leading_executable_sql(sql: &str) -> &str {
    leading_executable_sql_with_options(sql, SqlParsingOptions::default())
}

fn leading_executable_sql_with_options(sql: &str, options: SqlParsingOptions) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i >= bytes.len() {
            break;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if options.profile.supports_hash_line_comments && bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                break;
            }

            let Some(close) = find_block_comment_close(bytes, i + 2) else {
                return &sql[sql.len()..];
            };
            i = close + 2;
            continue;
        }

        break;
    }

    &sql[i..]
}

fn first_executable_sql_token_with_options(sql: &str, options: SqlParsingOptions) -> Option<&str> {
    let bytes = sql.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b'(') {
            i += 1;
        }

        if i >= bytes.len() {
            break;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if options.profile.supports_hash_line_comments && bytes[i] == b'#' {
            i += 1;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            if i + 2 < bytes.len() && (bytes[i + 2] == b'!' || (i + 3 < bytes.len() && &bytes[i + 2..i + 4] == b"M!")) {
                i += if bytes[i + 2] == b'!' { 3 } else { 4 };
                while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i].is_ascii_whitespace()) {
                    i += 1;
                }
                break;
            }

            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        break;
    }

    let start = i;
    while i < bytes.len() && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'_') {
        i += 1;
    }

    (i > start).then_some(&sql[start..i])
}

fn starts_with_oracle_plsql_block(sql: &str) -> bool {
    OraclePlSqlBlock::parse(sql).starts_block()
}

fn starts_with_postgres_dollar_quoted_routine_prefix(sql: &str) -> bool {
    let block = OraclePlSqlBlock::parse(sql);
    let Some(first) = block.tokens.first() else {
        return false;
    };
    if !first.is_word("CREATE") {
        return false;
    }
    let tokens = OraclePlSqlBlock::skip_create_modifiers(&block.tokens[1..]);
    tokens.first().is_some_and(|token| token.is_any_word(&["FUNCTION", "PROCEDURE"]))
        && block.tokens.iter().rev().find_map(OraclePlSqlToken::as_word) == Some("AS")
}

fn oracle_plsql_block_is_complete(sql: &str) -> bool {
    OraclePlSqlBlock::parse(sql).is_complete()
}

fn starts_with_hana_do_block(sql: &str) -> bool {
    HanaDoBlock::parse(sql).starts_block()
}

fn hana_do_block_is_complete(sql: &str) -> bool {
    HanaDoBlock::parse(sql).is_complete()
}

struct HanaDoBlock {
    tokens: Vec<OraclePlSqlToken>,
}

impl HanaDoBlock {
    fn parse(sql: &str) -> Self {
        Self { tokens: oracle_plsql_tokens(sql) }
    }

    fn starts_block(&self) -> bool {
        self.tokens.first().is_some_and(|token| token.is_word("DO"))
    }

    fn is_complete(&self) -> bool {
        if !self.starts_block() {
            return false;
        }

        let mut stack: Vec<String> = Vec::new();
        let mut saw_begin = false;

        for (index, token) in self.tokens.iter().enumerate() {
            if token.is_word("BEGIN") {
                if previous_word_token(&self.tokens, index).is_some_and(|previous| previous == "END") {
                    continue;
                }
                stack.push("BLOCK".to_string());
                saw_begin = true;
                continue;
            }
            if token.is_any_word(&["IF", "FOR", "WHILE", "CASE"]) {
                if previous_word_token(&self.tokens, index).is_none_or(|previous| previous != "END") {
                    stack.push(token.as_word().unwrap_or("BLOCK").to_string());
                }
                continue;
            }
            if token.is_word("END") {
                let next = next_word_token(&self.tokens, index);
                let top = stack.last().map(|value| value.as_str());
                let target = match next {
                    Some(keyword @ ("IF" | "FOR" | "WHILE")) => keyword,
                    _ if top == Some("CASE") => "CASE",
                    _ => "BLOCK",
                };
                if top == Some(target) {
                    stack.pop();
                }
            }
        }

        saw_begin && stack.is_empty() && self.tokens.last().is_some_and(OraclePlSqlToken::is_semicolon)
    }
}

struct OraclePlSqlBlock {
    tokens: Vec<OraclePlSqlToken>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OraclePlSqlToken {
    Word(String),
    Semicolon,
}

impl OraclePlSqlBlock {
    fn parse(sql: &str) -> Self {
        Self { tokens: oracle_plsql_tokens(sql) }
    }

    fn starts_block(&self) -> bool {
        match self.tokens.as_slice() {
            [first, ..] if first.is_word("DECLARE") => true,
            [first, second, ..] if first.is_word("BEGIN") && !Self::is_transaction_begin_tail(second) => true,
            [first, rest @ ..] if first.is_word("CREATE") => Self::starts_create_plsql_object(rest),
            _ => false,
        }
    }

    fn is_complete(&self) -> bool {
        if !self.starts_block() {
            return false;
        }

        // Package/type specifications have declarations and an outer END with
        // no BEGIN. Bodies also own an outer END beyond nested routine END
        // pairs so an inner END cannot finish the object.
        let object_kind = self.create_object_kind();
        let mut scopes = match object_kind {
            Some(OraclePlSqlCreateObjectKind::Body | OraclePlSqlCreateObjectKind::Spec) => {
                vec![OraclePlSqlScope::Object]
            }
            None => Vec::new(),
        };
        let mut saw_begin = false;
        let mut complete = false;

        for (index, token) in self.tokens.iter().enumerate() {
            if token.is_semicolon() {
                continue;
            }

            if token.is_word("BEGIN") {
                scopes.push(OraclePlSqlScope::Block);
                saw_begin = true;
                complete = false;
            } else if token.is_word("CASE") {
                // Both CASE expressions and CASE statements own an END.
                // The CASE token that follows END CASE is a suffix, not a scope start.
                if previous_word_token(&self.tokens, index) != Some("END") {
                    scopes.push(OraclePlSqlScope::Case);
                }
            } else if token.is_word("END") {
                let next = self.tokens.get(index + 1).and_then(OraclePlSqlToken::as_word);
                if matches!(next, Some("IF" | "LOOP")) {
                    continue;
                }
                if matches!(next, Some("CASE")) && !matches!(scopes.last(), Some(OraclePlSqlScope::Case)) {
                    continue;
                }
                if scopes.pop().is_some() {
                    complete = scopes.is_empty();
                }
            }
        }

        match object_kind {
            // Specs complete on outer END [name]; without requiring BEGIN.
            Some(OraclePlSqlCreateObjectKind::Spec) => complete,
            _ => saw_begin && complete,
        }
    }

    fn starts_create_plsql_object(tokens: &[OraclePlSqlToken]) -> bool {
        let tokens = Self::skip_create_modifiers(tokens);
        match tokens {
            // PACKAGE BODY / TYPE BODY are programmable blocks with an outer END.
            [object, body, ..] if object.is_any_word(&["PACKAGE", "TYPE"]) && body.is_word("BODY") => true,
            // Plain CREATE TYPE ... AS OBJECT (...); ends with ");" — not a PL/SQL block.
            [object, ..] if object.is_word("TYPE") => false,
            [object, ..] if object.is_any_word(&["FUNCTION", "PROCEDURE", "TRIGGER", "PACKAGE"]) => true,
            _ => false,
        }
    }

    fn create_object_kind(&self) -> Option<OraclePlSqlCreateObjectKind> {
        if self.tokens.first().is_none_or(|token| !token.is_word("CREATE")) {
            return None;
        }
        let tokens = Self::skip_create_modifiers(&self.tokens[1..]);
        match tokens {
            [object, body, ..] if object.is_any_word(&["PACKAGE", "TYPE"]) && body.is_word("BODY") => {
                Some(OraclePlSqlCreateObjectKind::Body)
            }
            // Only PACKAGE specs lack BEGIN; plain TYPE objects are ordinary SQL.
            [object, ..] if object.is_word("PACKAGE") => Some(OraclePlSqlCreateObjectKind::Spec),
            _ => None,
        }
    }

    /// Skip OR REPLACE / FORCE / NOFORCE / EDITIONABLE modifiers after CREATE.
    fn skip_create_modifiers(tokens: &[OraclePlSqlToken]) -> &[OraclePlSqlToken] {
        let mut rest = tokens;
        loop {
            match rest {
                [or, replace, tail @ ..] if or.is_word("OR") && replace.is_word("REPLACE") => {
                    rest = tail;
                }
                [modifier, tail @ ..]
                    if modifier.is_any_word(&["FORCE", "NOFORCE", "EDITIONABLE", "NONEDITIONABLE"]) =>
                {
                    rest = tail;
                }
                _ => break,
            }
        }
        rest
    }

    fn is_transaction_begin_tail(token: &OraclePlSqlToken) -> bool {
        token.is_semicolon() || token.is_any_word(&["TRANSACTION", "WORK"])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OraclePlSqlCreateObjectKind {
    Spec,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OraclePlSqlScope {
    Object,
    Block,
    Case,
}

impl OraclePlSqlToken {
    fn word(value: String) -> Self {
        Self::Word(value)
    }

    fn from_sqlparser_token(token: Token) -> Option<Self> {
        match token {
            Token::Word(word) if word.quote_style.is_none() => Some(Self::Word(word.value.to_ascii_uppercase())),
            Token::SemiColon => Some(Self::Semicolon),
            _ => None,
        }
    }

    fn is_word(&self, expected: &str) -> bool {
        matches!(self, Self::Word(value) if value == expected)
    }

    fn as_word(&self) -> Option<&str> {
        match self {
            Self::Word(value) => Some(value),
            Self::Semicolon => None,
        }
    }

    fn is_any_word(&self, expected: &[&str]) -> bool {
        expected.iter().any(|word| self.is_word(word))
    }

    fn is_semicolon(&self) -> bool {
        matches!(self, Self::Semicolon)
    }
}

fn previous_word_token(tokens: &[OraclePlSqlToken], index: usize) -> Option<&str> {
    tokens[..index].iter().rev().find_map(OraclePlSqlToken::as_word)
}

fn next_word_token(tokens: &[OraclePlSqlToken], index: usize) -> Option<&str> {
    tokens[index + 1..].iter().find_map(OraclePlSqlToken::as_word)
}

fn oracle_plsql_tokens(sql: &str) -> Vec<OraclePlSqlToken> {
    let dialect = OracleDialect {};
    if let Ok(tokens) = Tokenizer::new(&dialect, sql).tokenize() {
        return tokens.into_iter().filter_map(OraclePlSqlToken::from_sqlparser_token).collect();
    }

    oracle_plsql_tokens_fallback(sql)
}

fn oracle_plsql_tokens_fallback(sql: &str) -> Vec<OraclePlSqlToken> {
    let mut tokens = Vec::new();
    let mut iter = sql.char_indices().peekable();

    while let Some((_, ch)) = iter.next() {
        if ch.is_whitespace() {
            continue;
        }

        if ch == '-' && iter.peek().is_some_and(|(_, next)| *next == '-') {
            iter.next();
            for (_, comment_ch) in iter.by_ref() {
                if comment_ch == '\n' {
                    break;
                }
            }
            continue;
        }

        if ch == '/' && iter.peek().is_some_and(|(_, next)| *next == '*') {
            iter.next();
            let mut previous = '\0';
            for (_, comment_ch) in iter.by_ref() {
                if previous == '*' && comment_ch == '/' {
                    break;
                }
                previous = comment_ch;
            }
            continue;
        }

        if ch == '\'' {
            while let Some((_, quote_ch)) = iter.next() {
                if quote_ch == '\'' {
                    if iter.peek().is_some_and(|(_, next)| *next == '\'') {
                        iter.next();
                    } else {
                        break;
                    }
                }
            }
            continue;
        }

        if ch == '"' {
            for (_, ident_ch) in iter.by_ref() {
                if ident_ch == '"' {
                    break;
                }
            }
            continue;
        }

        if ch == ';' {
            tokens.push(OraclePlSqlToken::Semicolon);
            continue;
        }

        if ch.is_ascii_alphabetic() || ch == '_' {
            let mut token = String::new();
            token.push(ch.to_ascii_uppercase());
            while let Some((_, next)) = iter.peek().copied() {
                if next.is_ascii_alphanumeric() || next == '_' || next == '$' || next == '#' {
                    token.push(next.to_ascii_uppercase());
                    iter.next();
                } else {
                    break;
                }
            }
            tokens.push(OraclePlSqlToken::word(token));
        }
    }

    tokens
}

fn starts_with_chars(chars: &[char], start: usize, needle: &[char]) -> bool {
    start + needle.len() <= chars.len() && chars[start..start + needle.len()] == *needle
}

fn dollar_quote_tag_at(chars: &[char], start: usize) -> Option<String> {
    if chars.get(start) != Some(&'$') {
        return None;
    }

    match chars.get(start + 1) {
        Some('$') => return Some("$$".to_string()),
        Some(ch) if ch.is_ascii_alphabetic() || *ch == '_' => {}
        _ => return None,
    }

    let mut end = start + 2;
    while let Some(ch) = chars.get(end) {
        if *ch == '$' {
            return Some(chars[start..=end].iter().collect());
        }
        if !ch.is_ascii_alphanumeric() && *ch != '_' {
            return None;
        }
        end += 1;
    }

    None
}

pub fn has_executable_sql(statement: &str) -> bool {
    has_executable_sql_with_options(statement, SqlParsingOptions::default())
}

pub fn has_executable_sql_for_database(statement: &str, db_type: DatabaseType) -> bool {
    has_executable_sql_with_options(statement, SqlParsingOptions::for_database_type(db_type))
}

fn executable_sql_bounds(statement: &str, options: SqlParsingOptions) -> Option<(usize, usize)> {
    let trimmed_end = statement.trim_end().len();
    let trimmed = &statement[..trimmed_end];
    let executable = leading_executable_sql_with_options(trimmed, options);
    if executable.is_empty() {
        return None;
    }
    let start = trimmed.len() - executable.len();
    Some((start, trimmed_end))
}

fn has_executable_sql_with_options(statement: &str, options: SqlParsingOptions) -> bool {
    let chars = statement.chars().collect::<Vec<_>>();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut previous = None;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();

        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }

        if in_block_comment {
            if previous == Some('*') && ch == '/' {
                in_block_comment = false;
            }
            previous = Some(ch);
            i += 1;
            continue;
        }

        if ch == '-' && next == Some('-') {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if options.profile.supports_hash_line_comments && ch == '#' {
            in_line_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if ch == '/' && next == Some('*') {
            if is_mysql_executable_comment_start(&chars, i) {
                return true;
            }
            in_block_comment = true;
            previous = Some(ch);
            i += 1;
            continue;
        }

        if !ch.is_whitespace() {
            return true;
        }

        previous = Some(ch);
        i += 1;
    }

    false
}

fn is_mysql_executable_comment_start(chars: &[char], start: usize) -> bool {
    chars.get(start) == Some(&'/')
        && chars.get(start + 1) == Some(&'*')
        && (chars.get(start + 2) == Some(&'!')
            || (chars.get(start + 2) == Some(&'M') && chars.get(start + 3) == Some(&'!')))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

    #[test]
    fn fuzzy_subsequence_match_matches_ordered_characters() {
        assert!(fuzzy_subsequence_match("system_user", "sysu"));
        assert!(contains_or_fuzzy_match("user_order", "uo"));
        assert!(!contains_or_fuzzy_match("alpha", "uo"));
    }

    #[test]
    fn contains_or_fuzzy_match_skips_fuzzy_for_single_character_filters() {
        assert!(fuzzy_filter_enabled("uo"));
        assert!(!fuzzy_filter_enabled("u"));
        assert!(contains_or_fuzzy_match("user_order", "u"));
        assert!(!contains_or_fuzzy_match("orders", "u"));
    }

    #[test]
    fn splits_semicolon_delimited_statements() {
        assert_eq!(
            split_sql_statements("CREATE TABLE a(id int); INSERT INTO a VALUES (1);"),
            vec!["CREATE TABLE a(id int)", "INSERT INTO a VALUES (1)"]
        );
    }

    #[test]
    fn keeps_opengauss_anonymous_plsql_block_intact() {
        let sql = "BEGIN \n  raise notice '%','1';\nend;";
        let statements = split_sql_statements_for_database(sql, DatabaseType::OpenGauss);
        assert_eq!(
            statements.len(),
            1,
            "anonymous block must not be split at its internal semicolon, got {statements:?}"
        );
        assert!(statements[0].to_ascii_lowercase().contains("begin"));
        assert!(statements[0].to_ascii_lowercase().contains("end"));
    }

    #[test]
    fn decodes_utf8_bom_sql_file_bytes() {
        let sql = decode_sql_file_bytes(b"\xEF\xBB\xBFCREATE TABLE t(id int);").unwrap();
        assert_eq!(sql, "CREATE TABLE t(id int);");
    }

    #[test]
    fn postgres_dollar_quoted_string_splitting() {
        let sql = "CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT 1; END; $$ LANGUAGE plpgsql; SELECT 2;";
        let statements = split_sql_statements_for_database(sql, DatabaseType::Postgres);
        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("$$ BEGIN SELECT 1; END; $$"));
    }

    #[test]
    fn opengauss_dollar_quoted_string_splitting() {
        let sql = "CREATE PROCEDURE p() AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql; SELECT 1;";
        let statements = split_sql_statements_for_database(sql, DatabaseType::Opengauss);
        assert_eq!(statements.len(), 2);
    }
}
