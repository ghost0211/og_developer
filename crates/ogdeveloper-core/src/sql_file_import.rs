use std::path::Path;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::connection::AppState;
use crate::models::connection::DatabaseType;
use crate::query::{execute_sql_statement_with_options, QueryExecutionOptions};
use crate::sql::{
    optimize_sql_file_import_statements, prepare_sql_file_statement, statement_summary, SqlFileImportStatement,
    SqlFileImportStatementKind, SqlFileProgress, SqlFileRequest, SqlFileStatementAction, SqlFileStatus,
    SqlParsingOptions, SqlStatementSplitter,
};
use crate::types::QueryResult;

#[derive(Debug, Clone)]
struct SqlFileImportTarget {
    db_type: DatabaseType,
    driver_profile: Option<String>,
}

#[derive(Debug)]
struct StatementErrorDecision {
    progress: Vec<SqlFileProgress>,
    failure_count: usize,
    result: Result<bool, String>,
}

const SQL_FILE_READ_CHUNK_BYTES: usize = 256 * 1024;
const SQL_FILE_STATEMENT_BATCH_SIZE: usize = 256;
const SQL_FILE_PREVIEW_ENCODING_SAMPLE_BYTES: usize = 1024 * 1024;
const SQL_FILE_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

pub struct SqlFileProgressEmitter<F, C = fn() -> Instant> {
    emit: F,
    now: C,
    last_regular_emit_at: Option<Instant>,
    pending_regular: Option<SqlFileProgress>,
}

impl<F> SqlFileProgressEmitter<F>
where
    F: FnMut(SqlFileProgress),
{
    pub fn new(emit: F) -> Self {
        Self::with_clock(emit, Instant::now)
    }
}

impl<F, C> SqlFileProgressEmitter<F, C>
where
    F: FnMut(SqlFileProgress),
    C: FnMut() -> Instant,
{
    fn with_clock(emit: F, now: C) -> Self {
        Self { emit, now, last_regular_emit_at: None, pending_regular: None }
    }

    pub fn emit(&mut self, progress: SqlFileProgress) {
        if sql_file_progress_is_immediate(progress.status) || progress.file_index.is_some() {
            // Preserve ordering and final counters before terminal or failure
            // events.  File-boundary events (file_index is Some) are also
            // emitted immediately so rapid multi-file runs don't lose per-file
            // summaries through throttling.
            self.flush_pending();
            (self.emit)(progress);
            return;
        }

        self.pending_regular = Some(progress);
        let now = (self.now)();
        if self
            .last_regular_emit_at
            .is_none_or(|last_emit_at| now.duration_since(last_emit_at) >= SQL_FILE_PROGRESS_EMIT_INTERVAL)
        {
            self.flush_pending_at(now);
        }
    }

    fn flush_pending(&mut self) {
        if self.pending_regular.is_none() {
            return;
        }
        let now = (self.now)();
        self.flush_pending_at(now);
    }

    fn flush_pending_at(&mut self, now: Instant) {
        if let Some(progress) = self.pending_regular.take() {
            self.last_regular_emit_at = Some(now);
            (self.emit)(progress);
        }
    }
}

fn sql_file_progress_is_immediate(status: SqlFileStatus) -> bool {
    matches!(
        status,
        SqlFileStatus::Started
            | SqlFileStatus::StatementFailed
            | SqlFileStatus::Done
            | SqlFileStatus::Error
            | SqlFileStatus::Cancelled
    )
}

struct SqlFileExecutionProgress {
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
}

impl SqlFileExecutionProgress {
    fn new() -> Self {
        Self { statement_index: 0, success_count: 0, failure_count: 0, affected_rows: 0 }
    }
}

struct MySqlSqlFileExecutor;

impl MySqlSqlFileExecutor {
    async fn build(
        _state: &AppState,
        _request: &SqlFileRequest,
        _import_target: Option<&SqlFileImportTarget>,
    ) -> Result<Option<Self>, String> {
        Ok(None)
    }

    async fn execute_statement(
        &mut self,
        state: &AppState,
        request: &SqlFileRequest,
        sql: &str,
        token: &CancellationToken,
        statement_index: usize,
    ) -> Result<QueryResult, String> {
        execute_sql_file_statement(state, request, sql, token, statement_index).await
    }
}

pub async fn execute_sql_file_content(
    state: &AppState,
    request: &SqlFileRequest,
    file_content: &str,
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    let import_target = sql_file_import_target(state, &request.connection_id).await;
    let statements =
        split_sql_file_import_statements(file_content, import_target.as_ref().map(|target| target.db_type));

    let planned_statements = optimize_sql_file_import_statements(
        &statements,
        import_target.as_ref().map(|target| target.db_type),
        import_target.as_ref().and_then(|target| target.driver_profile.as_deref()),
    );
    // MySQL-family imports need one pinned connection so `USE` and session
    // state survive across the whole file.
    let mut mysql_executor = MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await?;
    let mut progress = SqlFileExecutionProgress::new();
    execute_planned_statements_with_progress(
        state,
        request,
        &token,
        started_at,
        &planned_statements,
        mysql_executor.as_mut(),
        &mut progress,
        &mut emit,
    )
    .await?;
    emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
    Ok(())
}

pub async fn execute_sql_file_path(
    state: &AppState,
    request: &SqlFileRequest,
    file_path: &Path,
    token: CancellationToken,
    started_at: Instant,
    emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    execute_sql_file_paths(state, request, &[file_path], token, started_at, emit).await
}

/// Executes multiple SQL files as one import operation. MySQL-family imports
/// deliberately reuse one pinned connection across every file, so session
/// state such as `USE`, temporary tables, variables, and transactions remains
/// available to the next file in the batch.
pub async fn execute_sql_file_paths(
    state: &AppState,
    request: &SqlFileRequest,
    file_paths: &[&Path],
    token: CancellationToken,
    started_at: Instant,
    mut emit: impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    if file_paths.is_empty() {
        let error = "No SQL files selected".to_string();
        emit(sql_file_error_progress(&request.execution_id, started_at, error.clone()));
        return Err(error);
    }

    let import_target = sql_file_import_target(state, &request.connection_id).await;
    let options =
        import_target.as_ref().map(|target| SqlParsingOptions::for_database_type(target.db_type)).unwrap_or_default();
    let database_type = import_target.as_ref().map(|target| target.db_type);
    let mut progress = SqlFileExecutionProgress::new();
    let mut mysql_executor = match MySqlSqlFileExecutor::build(state, request, import_target.as_ref()).await {
        Ok(executor) => executor,
        Err(error) => {
            emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
            return Err(error);
        }
    };
    let file_count = file_paths.len();
    let mut prev_statement_index = 0usize;
    let mut prev_success_count = 0usize;
    let mut prev_failure_count = 0usize;
    let mut prev_affected_rows = 0u64;
    for (file_index, file_path) in file_paths.iter().enumerate() {
        let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();

        // Emit a file-boundary progress event so the frontend knows which file is
        // currently executing and can display a "File N/M" indicator.
        if file_count > 1 {
            emit(SqlFileProgress {
                execution_id: request.execution_id.clone(),
                status: SqlFileStatus::Running,
                statement_index: progress.statement_index,
                success_count: progress.success_count,
                failure_count: progress.failure_count,
                affected_rows: progress.affected_rows,
                elapsed_ms: started_at.elapsed().as_millis(),
                statement_summary: String::new(),
                error: None,
                file_index: Some(file_index),
                file_name: Some(file_name.clone()),
            });
        }

        let mut splitter = StreamingSqlFileSplitter::new(database_type, options);
        let mut pending_statements = Vec::with_capacity(SQL_FILE_STATEMENT_BATCH_SIZE);
        let mut decoder = match SqlFileStreamDecoder::open(file_path).await {
            Ok(decoder) => decoder,
            Err(error) => {
                emit(sql_file_execution_error_progress(&request.execution_id, started_at, &progress, error.clone()));
                return Err(error);
            }
        };

        loop {
            let chunk = match decoder.next_chunk().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    emit(sql_file_progress(
                        &request.execution_id,
                        SqlFileStatus::Error,
                        progress.statement_index,
                        progress.success_count,
                        progress.failure_count,
                        progress.affected_rows,
                        started_at,
                        "",
                        Some(error.clone()),
                    ));
                    return Err(error);
                }
            };
            let Some(chunk) = chunk else {
                break;
            };
            if token.is_cancelled() {
                emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
                return Ok(());
            }
            pending_statements.extend(splitter.push_chunk(&chunk));
            if pending_statements.len() < SQL_FILE_STATEMENT_BATCH_SIZE {
                continue;
            }
            execute_sql_file_statement_batch(
                state,
                request,
                &token,
                started_at,
                &mut pending_statements,
                import_target.as_ref(),
                mysql_executor.as_mut(),
                &mut progress,
                &mut emit,
            )
            .await?;
        }

        pending_statements.extend(splitter.finish());
        execute_sql_file_statement_batch(
            state,
            request,
            &token,
            started_at,
            &mut pending_statements,
            import_target.as_ref(),
            mysql_executor.as_mut(),
            &mut progress,
            &mut emit,
        )
        .await?;

        // After each file, emit a per-file summary with diff-based counters so
        // the frontend can build a per-file breakdown table.
        if file_count > 1 {
            emit(SqlFileProgress {
                execution_id: request.execution_id.clone(),
                status: SqlFileStatus::StatementDone,
                statement_index: progress.statement_index - prev_statement_index,
                success_count: progress.success_count - prev_success_count,
                failure_count: progress.failure_count - prev_failure_count,
                affected_rows: progress.affected_rows - prev_affected_rows,
                elapsed_ms: started_at.elapsed().as_millis(),
                statement_summary: String::new(),
                error: None,
                file_index: Some(file_index),
                file_name: Some(file_name),
            });
            prev_statement_index = progress.statement_index;
            prev_success_count = progress.success_count;
            prev_failure_count = progress.failure_count;
            prev_affected_rows = progress.affected_rows;
        }
    }
    emit_sql_file_terminal_progress(request, &token, started_at, &progress, &mut emit);
    Ok(())
}

pub async fn read_sql_file_preview(file_path: &Path, max_chars: usize) -> Result<String, String> {
    let mut decoder =
        SqlFileStreamDecoder::open_with_detection_limit(file_path, Some(SQL_FILE_PREVIEW_ENCODING_SAMPLE_BYTES))
            .await?;
    let mut preview = String::new();
    while preview.chars().count() < max_chars {
        let Some(chunk) = decoder.next_chunk().await? else {
            break;
        };
        preview.push_str(&chunk);
    }
    Ok(preview.chars().take(max_chars).collect())
}

struct SqlFileStreamDecoder {
    reader: BufReader<tokio::fs::File>,
    decoder: encoding_rs::Decoder,
    pending_bytes: Vec<u8>,
    reached_eof: bool,
}

impl SqlFileStreamDecoder {
    async fn open(file_path: &Path) -> Result<Self, String> {
        Self::open_with_detection_limit(file_path, None).await
    }

    async fn open_with_detection_limit(file_path: &Path, detection_limit: Option<usize>) -> Result<Self, String> {
        let (encoding, bom_len) = detect_sql_file_encoding(file_path, detection_limit).await?;
        let mut file = tokio::fs::File::open(file_path).await.map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).await.map_err(|error| error.to_string())?;
        let prefix = &prefix[..prefix_len];
        let mut pending_bytes = prefix[bom_len..].to_vec();
        pending_bytes.reserve(SQL_FILE_READ_CHUNK_BYTES);
        Ok(Self {
            reader: BufReader::with_capacity(SQL_FILE_READ_CHUNK_BYTES, file),
            decoder: encoding.new_decoder_without_bom_handling(),
            pending_bytes,
            reached_eof: false,
        })
    }

    async fn next_chunk(&mut self) -> Result<Option<String>, String> {
        if self.reached_eof && self.pending_bytes.is_empty() {
            return Ok(None);
        }
        while !self.reached_eof && self.pending_bytes.len() < SQL_FILE_READ_CHUNK_BYTES {
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES - self.pending_bytes.len()];
            let read = self.reader.read(&mut buffer).await.map_err(|error| error.to_string())?;
            if read == 0 {
                self.reached_eof = true;
                break;
            }
            self.pending_bytes.extend_from_slice(&buffer[..read]);
        }

        let mut output = String::with_capacity(
            self.decoder
                .max_utf8_buffer_length_without_replacement(self.pending_bytes.len())
                .unwrap_or(self.pending_bytes.len()),
        );
        let (result, read) =
            self.decoder.decode_to_string_without_replacement(&self.pending_bytes, &mut output, self.reached_eof);
        self.pending_bytes.drain(..read);
        match result {
            encoding_rs::DecoderResult::InputEmpty => Ok((!output.is_empty()).then_some(output)),
            encoding_rs::DecoderResult::OutputFull => Ok(Some(output)),
            encoding_rs::DecoderResult::Malformed(_, _) => Err("Unsupported or invalid SQL file encoding".to_string()),
        }
    }
}

async fn detect_sql_file_encoding(
    file_path: &Path,
    detection_limit: Option<usize>,
) -> Result<(&'static encoding_rs::Encoding, usize), String> {
    let mut file = tokio::fs::File::open(file_path).await.map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).await.map_err(|error| error.to_string())?;
    let prefix = &prefix[..prefix_len];
    if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok((encoding_rs::UTF_8, 3));
    }
    if prefix.starts_with(&[0xFF, 0xFE]) {
        return Ok((encoding_rs::UTF_16LE, 2));
    }
    if prefix.starts_with(&[0xFE, 0xFF]) {
        return Ok((encoding_rs::UTF_16BE, 2));
    }

    // SQL dumps often begin with ASCII comments even when the remaining file
    // is GBK. Validate the entire stream as UTF-8 with bounded buffers before
    // falling back to the legacy GBK behavior.
    let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
    let mut input = prefix.to_vec();
    let mut inspected_bytes = prefix.len();
    let mut reached_eof = false;
    loop {
        let reached_detection_limit = detection_limit.is_some_and(|limit| inspected_bytes >= limit);
        if !reached_eof && !reached_detection_limit {
            let remaining =
                detection_limit.map(|limit| limit.saturating_sub(inspected_bytes)).unwrap_or(SQL_FILE_READ_CHUNK_BYTES);
            let mut buffer = vec![0u8; SQL_FILE_READ_CHUNK_BYTES.min(remaining.max(1))];
            let read = file.read(&mut buffer).await.map_err(|error| error.to_string())?;
            if read == 0 {
                reached_eof = true;
            } else {
                inspected_bytes += read;
                input.extend_from_slice(&buffer[..read]);
            }
        }
        let mut output = String::with_capacity(
            decoder.max_utf8_buffer_length_without_replacement(input.len()).unwrap_or(input.len()),
        );
        let (result, read) = decoder.decode_to_string_without_replacement(&input, &mut output, reached_eof);
        input.drain(..read);
        match result {
            encoding_rs::DecoderResult::Malformed(_, _) => return Ok((encoding_rs::GBK, 0)),
            encoding_rs::DecoderResult::InputEmpty if reached_eof || reached_detection_limit => {
                return Ok((encoding_rs::UTF_8, 0));
            }
            encoding_rs::DecoderResult::InputEmpty | encoding_rs::DecoderResult::OutputFull => {}
        }
    }
}

struct StreamingSqlFileSplitter {
    splitter: SqlStatementSplitter,
}

impl StreamingSqlFileSplitter {
    fn new(_db_type: Option<DatabaseType>, options: SqlParsingOptions) -> Self {
        Self { splitter: SqlStatementSplitter::with_options(options) }
    }

    fn push_chunk(&mut self, chunk: &str) -> Vec<String> {
        self.splitter.push_chunk(chunk)
    }

    fn finish(self) -> Vec<String> {
        self.splitter.finish()
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_sql_file_statement_batch(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    statements: &mut Vec<String>,
    import_target: Option<&SqlFileImportTarget>,
    mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    let statements = std::mem::take(statements);
    let planned_statements = optimize_sql_file_import_statements(
        &statements,
        import_target.map(|target| target.db_type),
        import_target.and_then(|target| target.driver_profile.as_deref()),
    );
    execute_planned_statements_with_progress(
        state,
        request,
        token,
        started_at,
        &planned_statements,
        mysql_executor,
        progress,
        emit,
    )
    .await
}

fn emit_sql_file_terminal_progress(
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    progress: &SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) {
    emit(sql_file_progress(
        &request.execution_id,
        if token.is_cancelled() { SqlFileStatus::Cancelled } else { SqlFileStatus::Done },
        progress.statement_index,
        progress.success_count,
        progress.failure_count,
        progress.affected_rows,
        started_at,
        "",
        None,
    ));
}

pub fn split_sql_file_import_statements(file_content: &str, db_type: Option<DatabaseType>) -> Vec<String> {
    let options = db_type.map(SqlParsingOptions::for_database_type).unwrap_or_default();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(file_content);
    statements.extend(splitter.finish());
    statements
}

#[allow(clippy::too_many_arguments)]
pub fn sql_file_progress(
    execution_id: &str,
    status: SqlFileStatus,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    started_at: Instant,
    statement_summary: &str,
    error: Option<String>,
) -> SqlFileProgress {
    SqlFileProgress {
        execution_id: execution_id.to_string(),
        status,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        elapsed_ms: started_at.elapsed().as_millis(),
        statement_summary: statement_summary.to_string(),
        error,
        file_index: None,
        file_name: None,
    }
}

pub fn sql_file_error_progress(execution_id: &str, started_at: Instant, error: String) -> SqlFileProgress {
    sql_file_progress(execution_id, SqlFileStatus::Error, 0, 0, 0, 0, started_at, "", Some(error))
}

fn sql_file_execution_error_progress(
    execution_id: &str,
    started_at: Instant,
    progress: &SqlFileExecutionProgress,
    error: String,
) -> SqlFileProgress {
    sql_file_progress(
        execution_id,
        SqlFileStatus::Error,
        progress.statement_index,
        progress.success_count,
        progress.failure_count,
        progress.affected_rows,
        started_at,
        "",
        Some(error),
    )
}

async fn sql_file_import_target(state: &AppState, connection_id: &str) -> Option<SqlFileImportTarget> {
    let configs = state.configs.read().await;
    configs
        .get(connection_id)
        .map(|config| SqlFileImportTarget { db_type: config.db_type, driver_profile: config.driver_profile.clone() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MysqlLikeSqlFileBootstrapAnalysis {
    pub can_execute_without_selected_database: bool,
    pub establishes_database_context: bool,
}

pub fn mysql_like_sql_file_bootstrap_analysis(file_content: &str) -> MysqlLikeSqlFileBootstrapAnalysis {
    let options = SqlParsingOptions::mysql_compatible();
    let mut splitter = SqlStatementSplitter::with_options(options);
    let mut statements = splitter.push_chunk(file_content);
    statements.extend(splitter.finish());

    let mut saw_statement = false;
    let mut has_database_context = false;

    for statement in statements {
        let prepared = match prepare_sql_file_statement(&statement, &DatabaseType::Postgres, None) {
            SqlFileStatementAction::Skip => continue,
            SqlFileStatementAction::Execute(sql) => sql,
        };
        let statement = strip_leading_sql_comments(&prepared, true).trim_start();
        if statement.is_empty() {
            continue;
        }

        // Keep preview gating aligned with the executor: setup statements may
        // run before the script establishes its own database context.
        saw_statement = true;
        let Some((keyword, remainder)) = leading_sql_keyword(statement) else {
            return MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: false,
                establishes_database_context: has_database_context,
            };
        };

        if keyword.eq_ignore_ascii_case("SET") {
            continue;
        }

        // Connection-scoped SHOW (DATABASES, VARIABLES, PROCESSLIST, …) does not
        // need a selected schema. Object-scoped SHOW still fails at the server.
        if keyword.eq_ignore_ascii_case("SHOW") {
            continue;
        }

        if mysql_use_database_target(statement).is_some() {
            has_database_context = true;
            continue;
        }

        if (keyword.eq_ignore_ascii_case("DROP") || keyword.eq_ignore_ascii_case("CREATE"))
            && leading_sql_keyword(remainder)
                .is_some_and(|(next, _)| next.eq_ignore_ascii_case("DATABASE") || next.eq_ignore_ascii_case("SCHEMA"))
        {
            continue;
        }

        if !has_database_context {
            return MysqlLikeSqlFileBootstrapAnalysis {
                can_execute_without_selected_database: false,
                establishes_database_context: false,
            };
        }
    }

    MysqlLikeSqlFileBootstrapAnalysis {
        can_execute_without_selected_database: saw_statement,
        establishes_database_context: has_database_context,
    }
}

pub fn mysql_like_sql_file_can_execute_without_selected_database(file_content: &str) -> bool {
    mysql_like_sql_file_bootstrap_analysis(file_content).can_execute_without_selected_database
}

fn mysql_use_database_target(sql: &str) -> Option<String> {
    let sql = strip_leading_sql_comments(sql, true).trim_start();
    let rest = sql.get(..3).filter(|prefix| prefix.eq_ignore_ascii_case("USE")).and_then(|_| sql.get(3..))?;
    if rest.is_empty() || !rest.as_bytes()[0].is_ascii_whitespace() {
        return None;
    }

    let (database, remainder) = parse_mysql_identifier(rest.trim_start())?;
    sql_remainder_is_comment_only(remainder).then_some(database)
}

fn strip_leading_sql_comments(mut sql: &str, supports_hash_line_comments: bool) -> &str {
    loop {
        sql = sql.trim_start();
        if sql.is_empty() {
            return sql;
        }

        if let Some(rest) = sql.strip_prefix("--") {
            if let Some(idx) = rest.find('\n') {
                sql = &rest[idx + 1..];
                continue;
            }
            return "";
        }

        if supports_hash_line_comments {
            if let Some(rest) = sql.strip_prefix('#') {
                if let Some(idx) = rest.find('\n') {
                    sql = &rest[idx + 1..];
                    continue;
                }
                return "";
            }
        }

        if let Some(rest) = sql.strip_prefix("/*") {
            let Some(close) = rest.find("*/") else {
                return "";
            };
            sql = &rest[close + 2..];
            continue;
        }

        return sql;
    }
}

fn leading_sql_keyword(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    let end = input.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(input.len());
    (end > 0).then_some((&input[..end], &input[end..]))
}

fn parse_mysql_identifier(input: &str) -> Option<(String, &str)> {
    let first = *input.as_bytes().first()?;
    match first {
        b'`' | b'"' => parse_mysql_doubled_delimited_identifier(input, first),
        b'[' => parse_mysql_bracket_identifier(input),
        _ => {
            let end = input.find(|c: char| c.is_whitespace() || c == ';').unwrap_or(input.len());
            let identifier = input[..end].trim();
            (!identifier.is_empty()).then_some((identifier.to_string(), &input[end..]))
        }
    }
}

fn parse_mysql_doubled_delimited_identifier(input: &str, quote: u8) -> Option<(String, &str)> {
    let bytes = input.as_bytes();
    let mut index = 1;
    let mut segment_start = 1;
    let mut identifier = String::new();

    while index < bytes.len() {
        if bytes[index] == quote {
            identifier.push_str(&input[segment_start..index]);
            if bytes.get(index + 1) == Some(&quote) {
                identifier.push(quote as char);
                index += 2;
                segment_start = index;
                continue;
            }
            return Some((identifier, &input[index + 1..]));
        }
        index += 1;
    }

    None
}

fn parse_mysql_bracket_identifier(input: &str) -> Option<(String, &str)> {
    let bytes = input.as_bytes();
    let mut index = 1;
    let mut segment_start = 1;
    let mut identifier = String::new();

    while index < bytes.len() {
        if bytes[index] == b']' {
            identifier.push_str(&input[segment_start..index]);
            if bytes.get(index + 1) == Some(&b']') {
                identifier.push(']');
                index += 2;
                segment_start = index;
                continue;
            }
            return Some((identifier, &input[index + 1..]));
        }
        index += 1;
    }

    None
}

fn sql_remainder_is_comment_only(mut remainder: &str) -> bool {
    loop {
        remainder = remainder.trim_start();
        if remainder.is_empty() {
            return true;
        }
        if let Some(rest) = remainder.strip_prefix(';') {
            remainder = rest;
            continue;
        }
        if remainder.starts_with("--") || remainder.starts_with('#') {
            return true;
        }
        if let Some(rest) = remainder.strip_prefix("/*") {
            let Some(close) = rest.find("*/") else {
                return false;
            };
            remainder = &rest[close + 2..];
            continue;
        }
        return false;
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_planned_statements_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    planned_statements: &[SqlFileImportStatement],
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    progress: &mut SqlFileExecutionProgress,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<(), String> {
    for planned_statement in planned_statements {
        if token.is_cancelled() {
            return Ok(());
        }

        let next_statement_index = progress.statement_index + planned_statement.source_statement_count;
        if execute_statement_with_progress(
            state,
            request,
            token,
            started_at,
            next_statement_index,
            planned_statement,
            &mut progress.success_count,
            &mut progress.failure_count,
            &mut progress.affected_rows,
            mysql_executor.as_deref_mut(),
            emit,
        )
        .await?
        {
            return Ok(());
        }
        progress.statement_index = next_statement_index;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_statement_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    statement_index: usize,
    statement: &SqlFileImportStatement,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<bool, String> {
    if token.is_cancelled() {
        let summary = statement_summary(&statement.sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Cancelled,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        return Ok(true);
    }

    if statement.kind == SqlFileImportStatementKind::Skip {
        let summary = statement_summary(&statement.sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Running,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        *success_count += statement.source_statement_count;
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::StatementDone,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));
        return Ok(false);
    }

    let summary = statement_summary(&statement.sql);
    emit(sql_file_progress(
        &request.execution_id,
        SqlFileStatus::Running,
        statement_index,
        *success_count,
        *failure_count,
        *affected_rows,
        started_at,
        &summary,
        None,
    ));

    let result = {
        let mysql_executor = mysql_executor.as_deref_mut();
        execute_sql_file_statement_with_executor(state, request, &statement.sql, token, statement_index, mysql_executor)
            .await
    };

    match result {
        Ok(result) => {
            *success_count += statement.source_statement_count;
            *affected_rows += result.affected_rows;
            emit(sql_file_progress(
                &request.execution_id,
                SqlFileStatus::StatementDone,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &summary,
                None,
            ));
            Ok(false)
        }
        Err(error) => {
            if statement.source_statement_count > 1 && !token.is_cancelled() {
                return execute_merged_statement_fallback_with_progress(
                    state,
                    request,
                    token,
                    started_at,
                    statement_index + 1 - statement.source_statement_count,
                    statement,
                    success_count,
                    failure_count,
                    affected_rows,
                    mysql_executor,
                    emit,
                )
                .await;
            }

            let decision = statement_error_decision(
                &request.execution_id,
                token,
                request.continue_on_error,
                started_at,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                &summary,
                error,
            );

            *failure_count = decision.failure_count;
            for progress in decision.progress {
                emit(progress);
            }
            decision.result
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_merged_statement_fallback_with_progress(
    state: &AppState,
    request: &SqlFileRequest,
    token: &CancellationToken,
    started_at: Instant,
    first_statement_index: usize,
    statement: &SqlFileImportStatement,
    success_count: &mut usize,
    failure_count: &mut usize,
    affected_rows: &mut u64,
    mut mysql_executor: Option<&mut MySqlSqlFileExecutor>,
    emit: &mut impl FnMut(SqlFileProgress),
) -> Result<bool, String> {
    for (offset, source_sql) in statement.source_sqls.iter().enumerate() {
        let statement_index = first_statement_index + offset;
        if token.is_cancelled() {
            emit(sql_file_progress(
                &request.execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                *success_count,
                *failure_count,
                *affected_rows,
                started_at,
                &statement_summary(source_sql),
                None,
            ));
            return Ok(true);
        }

        let summary = statement_summary(source_sql);
        emit(sql_file_progress(
            &request.execution_id,
            SqlFileStatus::Running,
            statement_index,
            *success_count,
            *failure_count,
            *affected_rows,
            started_at,
            &summary,
            None,
        ));

        match execute_sql_file_statement_with_executor(
            state,
            request,
            source_sql,
            token,
            statement_index,
            mysql_executor.as_deref_mut(),
        )
        .await
        {
            Ok(result) => {
                *success_count += 1;
                *affected_rows += result.affected_rows;
                emit(sql_file_progress(
                    &request.execution_id,
                    SqlFileStatus::StatementDone,
                    statement_index,
                    *success_count,
                    *failure_count,
                    *affected_rows,
                    started_at,
                    &summary,
                    None,
                ));
            }
            Err(error) => {
                let decision = statement_error_decision(
                    &request.execution_id,
                    token,
                    request.continue_on_error,
                    started_at,
                    statement_index,
                    *success_count,
                    *failure_count,
                    *affected_rows,
                    &summary,
                    error,
                );

                *failure_count = decision.failure_count;
                for progress in decision.progress {
                    emit(progress);
                }
                if decision.result? {
                    return Ok(true);
                }
            }
        }
    }

    Ok(false)
}

async fn execute_sql_file_statement_with_executor(
    state: &AppState,
    request: &SqlFileRequest,
    sql: &str,
    token: &CancellationToken,
    statement_index: usize,
    mysql_executor: Option<&mut MySqlSqlFileExecutor>,
) -> Result<QueryResult, String> {
    if let Some(mysql_executor) = mysql_executor {
        mysql_executor.execute_statement(state, request, sql, token, statement_index).await
    } else {
        execute_sql_file_statement(state, request, sql, token, statement_index).await
    }
}

async fn execute_sql_file_statement(
    state: &AppState,
    request: &SqlFileRequest,
    sql: &str,
    token: &CancellationToken,
    statement_index: usize,
) -> Result<QueryResult, String> {
    let execution_id = sql_file_statement_execution_id(&request.execution_id, statement_index);
    let registered = state.running_queries.register(execution_id.clone());
    let child_token = registered.token();
    let cancel_task = {
        let parent_token = token.clone();
        let running_queries = state.running_queries.clone();
        let execution_id = execution_id.clone();
        tokio::spawn(async move {
            parent_token.cancelled().await;
            running_queries.cancel(&execution_id);
        })
    };

    let result = execute_sql_statement_with_options(
        state,
        &request.connection_id,
        &request.database,
        sql,
        None,
        Some(child_token),
        QueryExecutionOptions { execution_id: Some(execution_id), ..Default::default() },
    )
    .await;

    cancel_task.abort();
    result
}

fn sql_file_statement_execution_id(parent_execution_id: &str, statement_index: usize) -> String {
    format!("{parent_execution_id}:statement:{statement_index}")
}

#[allow(clippy::too_many_arguments)]
fn statement_error_decision(
    execution_id: &str,
    token: &CancellationToken,
    continue_on_error: bool,
    started_at: Instant,
    statement_index: usize,
    success_count: usize,
    failure_count: usize,
    affected_rows: u64,
    summary: &str,
    error: String,
) -> StatementErrorDecision {
    if token.is_cancelled() {
        return StatementErrorDecision {
            progress: vec![sql_file_progress(
                execution_id,
                SqlFileStatus::Cancelled,
                statement_index,
                success_count,
                failure_count,
                affected_rows,
                started_at,
                summary,
                None,
            )],
            failure_count,
            result: Ok(true),
        };
    }

    let failure_count = failure_count + 1;
    let statement_failed = sql_file_progress(
        execution_id,
        SqlFileStatus::StatementFailed,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        summary,
        Some(error.clone()),
    );

    if continue_on_error {
        return StatementErrorDecision { progress: vec![statement_failed], failure_count, result: Ok(false) };
    }

    let terminal_error = sql_file_progress(
        execution_id,
        SqlFileStatus::Error,
        statement_index,
        success_count,
        failure_count,
        affected_rows,
        started_at,
        summary,
        Some(error.clone()),
    );

    StatementErrorDecision { progress: vec![statement_failed, terminal_error], failure_count, result: Err(error) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_sql_file_splits_statements() {
        assert_eq!(
            split_sql_file_import_statements("SELECT 1; SELECT 2;", Some(DatabaseType::Postgres)),
            vec!["SELECT 1", "SELECT 2"]
        );
    }
}
