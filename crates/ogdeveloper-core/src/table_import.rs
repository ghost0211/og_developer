use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read as IoRead, Seek, SeekFrom, Write as IoWrite};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use calamine::{
    open_workbook_auto, CellType, Data, DataRef, ExcelDateTime, Range, Reader as CalamineReader,
    ReaderRef as CalamineReaderRef,
};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connection::{task_client_session_id, AppState, PoolKind};
use crate::models::connection::DatabaseType;
use crate::transfer::{
    execute_on_pool, generate_insert_typed, generate_insert_typed_sql_batches, get_columns_for_transfer,
    normalize_integer_literal, qualified_table, quote_identifier, SqlBatchLimits,
};
pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;
pub const CREATE_TABLE_INFERENCE_ROWS: usize = 100;
pub const MAX_NON_STREAMING_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_LEGACY_XLS_IMPORT_BYTES: u64 = 50 * 1024 * 1024;
const IMPORT_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
// Keep preview parsing bounded even when an XLSX dimension declares a huge sparse range.
const MAX_FAST_PREVIEW_CELLS: usize = 100_000;
// Shared strings stay in memory for small workbooks and spill to an indexed temp file for large ones.
const MAX_IN_MEMORY_XLSX_SHARED_STRINGS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_XLSX_SHARED_STRINGS_BYTES: u64 = 1024 * 1024 * 1024;
const XLSX_SHARED_STRING_CACHE_ENTRIES: usize = 4096;
const XLSX_SHARED_STRING_CACHE_BYTES: usize = 8 * 1024 * 1024;
const XLSX_CANCELLABLE_READ_CHUNK_BYTES: usize = 64 * 1024;
const XLSX_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const POSTGRES_COPY_TARGET_BYTES: usize = 8 * 1024 * 1024;
const POSTGRES_COPY_MAX_ROWS: usize = 50_000;

pub fn table_import_client_session_id(import_id: &str) -> String {
    task_client_session_id("table-import", import_id)
}

#[derive(Debug, Clone)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    pub effective_encoding: Option<TableImportTextEncoding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompiledImportPlan {
    mapped_source_indexes: Vec<usize>,
    target_columns: Vec<String>,
    column_types: Vec<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportCreateTableColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportCreateTablePlan {
    pub sql: String,
    pub columns: Vec<ImportCreateTableColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
    #[serde(default)]
    pub target_data_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportMode {
    Append,
    Truncate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportSourceFormat {
    Csv,
    Tsv,
    Delimited,
    Json,
    Excel,
}

impl TableImportSourceFormat {
    pub fn label(self) -> &'static str {
        match self {
            TableImportSourceFormat::Csv => "csv",
            TableImportSourceFormat::Tsv => "tsv",
            TableImportSourceFormat::Delimited => "txt",
            TableImportSourceFormat::Json => "json",
            TableImportSourceFormat::Excel => "excel",
        }
    }

    pub fn is_delimited(self) -> bool {
        matches!(self, TableImportSourceFormat::Csv | TableImportSourceFormat::Tsv | TableImportSourceFormat::Delimited)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportJsonShape {
    Auto,
    Objects,
    Arrays,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportTextEncoding {
    Auto,
    Utf8,
    Gbk,
    Utf16Le,
    Utf16Be,
}

impl TableImportTextEncoding {
    fn encoding(self) -> Option<&'static encoding_rs::Encoding> {
        match self {
            TableImportTextEncoding::Auto => None,
            TableImportTextEncoding::Utf8 => Some(encoding_rs::UTF_8),
            TableImportTextEncoding::Gbk => Some(encoding_rs::GBK),
            TableImportTextEncoding::Utf16Le => Some(encoding_rs::UTF_16LE),
            TableImportTextEncoding::Utf16Be => Some(encoding_rs::UTF_16BE),
        }
    }

    fn label(self) -> &'static str {
        match self {
            TableImportTextEncoding::Auto => "auto",
            TableImportTextEncoding::Utf8 => "UTF-8",
            TableImportTextEncoding::Gbk => "GBK / GB18030",
            TableImportTextEncoding::Utf16Le => "UTF-16 LE",
            TableImportTextEncoding::Utf16Be => "UTF-16 BE",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportParseOptions {
    pub delimiter: Option<String>,
    pub encoding: Option<TableImportTextEncoding>,
    pub has_header: Option<bool>,
    pub title_row: Option<usize>,
    pub data_start_row: Option<usize>,
    pub last_data_row: Option<usize>,
    pub trim_values: Option<bool>,
    pub empty_string_as_null: Option<bool>,
    pub sheet_name: Option<String>,
    pub sheet_index: Option<usize>,
    pub json_shape: Option<TableImportJsonShape>,
}

impl Default for TableImportParseOptions {
    fn default() -> Self {
        Self {
            delimiter: None,
            encoding: Some(TableImportTextEncoding::Auto),
            has_header: None,
            title_row: None,
            data_start_row: None,
            last_data_row: None,
            trim_values: Some(false),
            empty_string_as_null: Some(true),
            sheet_name: None,
            sheet_index: None,
            json_shape: Some(TableImportJsonShape::Auto),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreviewRequest {
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub source_format: Option<TableImportSourceFormat>,
    #[serde(default)]
    pub parse_options: TableImportParseOptions,
    #[serde(default)]
    pub preview_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportRequest {
    pub import_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub file_path: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub source_format: Option<TableImportSourceFormat>,
    #[serde(default)]
    pub parse_options: TableImportParseOptions,
    pub mappings: Vec<TableImportColumnMapping>,
    pub mode: TableImportMode,
    #[serde(default)]
    pub create_table: bool,
    pub batch_size: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_source: Option<TableImportPreparedSource>,
    #[serde(default)]
    pub retain_source: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreparedSource {
    pub fingerprint: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    #[serde(default = "default_true")]
    pub total_rows_exact: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_encoding: Option<TableImportTextEncoding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreview {
    pub file_name: String,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    pub file_type: String,
    pub size_bytes: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
    pub total_rows_exact: bool,
    pub source_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_encoding: Option<TableImportTextEncoding>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sheets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportSummary {
    pub import_id: String,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportProgress {
    pub import_id: String,
    pub status: TableImportStatus,
    pub phase: TableImportPhase,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub total_rows_exact: bool,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportPhase {
    Preparing,
    DetectingEncoding,
    Reading,
    Writing,
    Finalizing,
    Done,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFileKind {
    Csv,
    Tsv,
    Txt,
    Json,
    Xlsx,
}

impl ImportFileKind {
    pub fn label(self) -> &'static str {
        match self {
            ImportFileKind::Csv => "csv",
            ImportFileKind::Tsv => "tsv",
            ImportFileKind::Txt => "txt",
            ImportFileKind::Json => "json",
            ImportFileKind::Xlsx => "xlsx",
        }
    }
}

pub fn import_file_kind(path: &str) -> Result<ImportFileKind, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        Ok(ImportFileKind::Csv)
    } else if lower.ends_with(".tsv") {
        Ok(ImportFileKind::Tsv)
    } else if lower.ends_with(".txt") {
        Ok(ImportFileKind::Txt)
    } else if lower.ends_with(".json") {
        Ok(ImportFileKind::Json)
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") {
        Ok(ImportFileKind::Xlsx)
    } else {
        Err("Unsupported import file type".to_string())
    }
}

pub fn source_format_for_path(path: &str) -> Result<TableImportSourceFormat, String> {
    Ok(match import_file_kind(path)? {
        ImportFileKind::Csv => TableImportSourceFormat::Csv,
        ImportFileKind::Tsv => TableImportSourceFormat::Tsv,
        ImportFileKind::Txt => TableImportSourceFormat::Delimited,
        ImportFileKind::Json => TableImportSourceFormat::Json,
        ImportFileKind::Xlsx => TableImportSourceFormat::Excel,
    })
}

pub fn effective_source_format(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
) -> Result<TableImportSourceFormat, String> {
    source_format
        .or_else(|| source_format_for_path(path).ok())
        .ok_or_else(|| "Unsupported import file type".to_string())
}

pub fn normalize_header(value: &str, index: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        format!("column_{}", index + 1)
    } else {
        trimmed.to_string()
    }
}

fn unique_import_headers(headers: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut next_suffix = HashMap::<String, usize>::new();
    headers
        .into_iter()
        .map(|header| {
            let suffix = next_suffix.entry(header.to_lowercase()).or_default();
            loop {
                let candidate = if *suffix == 0 { header.clone() } else { format!("{header}_{suffix}") };
                *suffix += 1;
                if seen.insert(candidate.to_lowercase()) {
                    break candidate;
                }
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct DelimitedParseConfig {
    pub delimiter: u8,
    pub trim_values: bool,
    pub empty_string_as_null: bool,
    pub row_range: ImportRowRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportRowRange {
    pub title_row: Option<usize>,
    pub data_start_row: usize,
    pub last_data_row: Option<usize>,
}

pub fn effective_import_row_range(options: &TableImportParseOptions) -> Result<ImportRowRange, String> {
    let title_row = match options.title_row {
        Some(0) => None,
        Some(row) => Some(row),
        None if options.has_header.unwrap_or(true) => Some(1),
        None => None,
    };
    let data_start_row = options.data_start_row.unwrap_or_else(|| title_row.map_or(1, |row| row + 1));
    let last_data_row = options.last_data_row.filter(|row| *row > 0);
    if data_start_row == 0 {
        return Err("Data start row must be at least 1".to_string());
    }
    if title_row.is_some_and(|row| row >= data_start_row) {
        return Err("Title row must be before the data start row".to_string());
    }
    if last_data_row.is_some_and(|last| last < data_start_row) {
        return Err("Last data row must be 0 or not less than the data start row".to_string());
    }
    Ok(ImportRowRange { title_row, data_start_row, last_data_row })
}

pub fn effective_delimited_config(
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
) -> Result<DelimitedParseConfig, String> {
    let default_delimiter = match source_format {
        TableImportSourceFormat::Tsv => b'\t',
        _ => b',',
    };
    let delimiter = match options.delimiter.as_deref() {
        None | Some("") => default_delimiter,
        Some("\\t") | Some("tab") | Some("TAB") => b'\t',
        Some(value) => {
            let bytes = value.as_bytes();
            if bytes.len() != 1 {
                return Err("Delimiter must be a single-byte character".to_string());
            }
            bytes[0]
        }
    };

    Ok(DelimitedParseConfig {
        delimiter,
        trim_values: options.trim_values.unwrap_or(false),
        empty_string_as_null: options.empty_string_as_null.unwrap_or(true),
        row_range: effective_import_row_range(options)?,
    })
}

pub fn csv_value_with_config(value: &str, config: DelimitedParseConfig) -> serde_json::Value {
    let value = if config.trim_values { value.trim() } else { value };
    if config.empty_string_as_null && value.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(value.to_string())
    }
}

pub fn csv_value(value: &str) -> serde_json::Value {
    csv_value_with_config(
        value,
        DelimitedParseConfig {
            delimiter: b',',
            trim_values: false,
            empty_string_as_null: true,
            row_range: ImportRowRange { title_row: Some(1), data_start_row: 2, last_data_row: None },
        },
    )
}

const IMPORT_ENCODING_READ_CHUNK_BYTES: usize = 16 * 1024;

// Decodes incrementally and rejects malformed input instead of silently inserting replacement characters.
struct StrictTranscodingReader<R> {
    reader: R,
    decoder: encoding_rs::Decoder,
    encoding: TableImportTextEncoding,
    pending_input: Vec<u8>,
    pending_output: Vec<u8>,
    output_offset: usize,
    reached_eof: bool,
    finished: bool,
    source_bytes_read: u64,
}

impl<R: IoRead> StrictTranscodingReader<R> {
    fn new(reader: R, encoding: TableImportTextEncoding) -> Result<Self, String> {
        let decoder = encoding
            .encoding()
            .ok_or_else(|| "Automatic text encoding must be resolved before decoding".to_string())?
            .new_decoder_without_bom_handling();
        Ok(Self {
            reader,
            decoder,
            encoding,
            pending_input: Vec::with_capacity(IMPORT_ENCODING_READ_CHUNK_BYTES),
            pending_output: Vec::new(),
            output_offset: 0,
            reached_eof: false,
            finished: false,
            source_bytes_read: 0,
        })
    }

    fn source_bytes_read(&self) -> u64 {
        self.source_bytes_read
    }

    fn invalid_data_error(&self) -> std::io::Error {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Invalid byte sequence for {} encoding", self.encoding.label()),
        )
    }
}

impl<R: IoRead> IoRead for StrictTranscodingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        loop {
            if self.output_offset < self.pending_output.len() {
                let available = &self.pending_output[self.output_offset..];
                let copied = available.len().min(buffer.len());
                buffer[..copied].copy_from_slice(&available[..copied]);
                self.output_offset += copied;
                if self.output_offset == self.pending_output.len() {
                    self.pending_output.clear();
                    self.output_offset = 0;
                }
                return Ok(copied);
            }
            if self.finished {
                return Ok(0);
            }

            if self.pending_input.is_empty() && !self.reached_eof {
                let mut input = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
                let read = self.reader.read(&mut input)?;
                self.source_bytes_read = self.source_bytes_read.saturating_add(read as u64);
                if read == 0 {
                    self.reached_eof = true;
                } else {
                    self.pending_input.extend_from_slice(&input[..read]);
                }
            }

            let output_capacity = self
                .decoder
                .max_utf8_buffer_length_without_replacement(self.pending_input.len())
                .unwrap_or(self.pending_input.len().saturating_mul(3).saturating_add(4))
                .max(4);
            self.pending_output.resize(output_capacity, 0);
            let (result, read, written) = self.decoder.decode_to_utf8_without_replacement(
                &self.pending_input,
                &mut self.pending_output,
                self.reached_eof,
            );
            self.pending_input.drain(..read);
            self.pending_output.truncate(written);

            match result {
                encoding_rs::DecoderResult::Malformed(_, _) => return Err(self.invalid_data_error()),
                encoding_rs::DecoderResult::InputEmpty if self.reached_eof => self.finished = true,
                encoding_rs::DecoderResult::InputEmpty | encoding_rs::DecoderResult::OutputFull => {}
            }
        }
    }
}

fn bom_text_encoding(bytes: &[u8]) -> Option<(TableImportTextEncoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some((TableImportTextEncoding::Utf8, 3))
    } else if bytes.starts_with(&[0xFF, 0xFE]) {
        Some((TableImportTextEncoding::Utf16Le, 2))
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        Some((TableImportTextEncoding::Utf16Be, 2))
    } else {
        None
    }
}

fn matching_bom_len(bytes: &[u8], encoding: TableImportTextEncoding) -> usize {
    bom_text_encoding(bytes).filter(|(bom_encoding, _)| *bom_encoding == encoding).map(|(_, len)| len).unwrap_or(0)
}

fn reader_is_valid_for_encoding<R: IoRead>(reader: R, encoding: TableImportTextEncoding) -> Result<bool, String> {
    let mut reader = StrictTranscodingReader::new(reader, encoding)?;
    match std::io::copy(&mut reader, &mut std::io::sink()) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidData => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_text_encoding_from_file_with_progress(
    path: &str,
    encoding: TableImportTextEncoding,
    bom_len: usize,
    mut on_progress: impl FnMut(u64),
) -> Result<(), String> {
    let total_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or_default();
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(bom_len as u64)).map_err(|error| error.to_string())?;
    let mut reader = StrictTranscodingReader::new(file, encoding)?;
    let mut buffer = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
    let mut last_reported = None;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| error.to_string())?;
        let bytes_read = (bom_len as u64).saturating_add(reader.source_bytes_read()).min(total_bytes);
        if last_reported != Some(bytes_read) {
            on_progress(bytes_read);
            last_reported = Some(bytes_read);
        }
        if read == 0 {
            break;
        }
    }
    if total_bytes > 0 && last_reported != Some(total_bytes) {
        on_progress(total_bytes);
    }
    Ok(())
}

fn auto_detect_text_encoding_from_bytes(bytes: &[u8]) -> Result<(TableImportTextEncoding, usize), String> {
    if let Some(detected) = bom_text_encoding(bytes) {
        return Ok(detected);
    }
    for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
        if reader_is_valid_for_encoding(std::io::Cursor::new(bytes), encoding)? {
            return Ok((encoding, 0));
        }
    }
    Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string())
}

fn resolve_text_encoding_from_bytes(
    bytes: &[u8],
    requested: Option<TableImportTextEncoding>,
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    if requested == TableImportTextEncoding::Auto {
        auto_detect_text_encoding_from_bytes(bytes)
    } else {
        Ok((requested, matching_bom_len(bytes, requested)))
    }
}

struct EncodingValidationState {
    decoder: encoding_rs::Decoder,
    pending: Vec<u8>,
    output: Vec<u8>,
    valid: bool,
}

impl EncodingValidationState {
    fn new(encoding: &'static encoding_rs::Encoding) -> Self {
        Self {
            decoder: encoding.new_decoder_without_bom_handling(),
            pending: Vec::new(),
            output: Vec::new(),
            valid: true,
        }
    }

    fn push(&mut self, input: &[u8], last: bool) {
        if !self.valid {
            return;
        }
        self.pending.extend_from_slice(input);
        loop {
            let output_capacity = self
                .decoder
                .max_utf8_buffer_length_without_replacement(self.pending.len())
                .unwrap_or(self.pending.len().saturating_mul(3).saturating_add(4))
                .max(4);
            self.output.resize(output_capacity, 0);
            let (result, read, _) =
                self.decoder.decode_to_utf8_without_replacement(&self.pending, &mut self.output, last);
            self.pending.drain(..read);
            match result {
                encoding_rs::DecoderResult::Malformed(_, _) => {
                    self.valid = false;
                    self.pending.clear();
                    return;
                }
                encoding_rs::DecoderResult::InputEmpty => return,
                encoding_rs::DecoderResult::OutputFull if read == 0 => {
                    self.valid = false;
                    self.pending.clear();
                    return;
                }
                encoding_rs::DecoderResult::OutputFull => {}
            }
        }
    }
}

fn auto_detect_text_encoding_from_file_with_progress(
    path: &str,
    mut on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    if let Some((detected, bom_len)) = bom_text_encoding(&prefix[..prefix_len]) {
        validate_text_encoding_from_file_with_progress(path, detected, bom_len, &mut on_progress)?;
        return Ok((detected, bom_len));
    }

    file.seek(SeekFrom::Start(0)).map_err(|error| error.to_string())?;
    // Validate both candidates incrementally so auto-detection does not load the file into memory.
    let mut utf8 = EncodingValidationState::new(encoding_rs::UTF_8);
    let mut gbk = EncodingValidationState::new(encoding_rs::GBK);
    let mut bytes_read = 0u64;
    let mut input = [0u8; IMPORT_ENCODING_READ_CHUNK_BYTES];
    loop {
        let read = file.read(&mut input).map_err(|error| error.to_string())?;
        if read == 0 {
            utf8.push(&[], true);
            gbk.push(&[], true);
            break;
        }
        utf8.push(&input[..read], false);
        gbk.push(&input[..read], false);
        bytes_read = bytes_read.saturating_add(read as u64);
        on_progress(bytes_read);
    }
    if utf8.valid {
        return Ok((TableImportTextEncoding::Utf8, 0));
    }
    if gbk.valid {
        return Ok((TableImportTextEncoding::Gbk, 0));
    }
    Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string())
}

fn resolve_text_encoding_from_file_with_progress(
    path: &str,
    requested: Option<TableImportTextEncoding>,
    on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    if requested == TableImportTextEncoding::Auto {
        return auto_detect_text_encoding_from_file_with_progress(path, on_progress);
    }

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 3];
    let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
    Ok((requested, matching_bom_len(&prefix[..prefix_len], requested)))
}

fn resolve_and_validate_text_encoding_from_file(
    path: &str,
    requested: Option<TableImportTextEncoding>,
    mut on_progress: impl FnMut(u64),
) -> Result<(TableImportTextEncoding, usize), String> {
    let requested = requested.unwrap_or(TableImportTextEncoding::Auto);
    let (encoding, bom_len) = if requested == TableImportTextEncoding::Auto {
        auto_detect_text_encoding_from_file_with_progress(path, &mut on_progress)?
    } else {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        let bom_len = matching_bom_len(&prefix[..prefix_len], requested);
        validate_text_encoding_from_file_with_progress(path, requested, bom_len, on_progress)?;
        (requested, bom_len)
    };
    Ok((encoding, bom_len))
}

fn open_delimited_csv_reader_with_progress(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    on_encoding_progress: impl FnMut(u64),
) -> Result<(csv::Reader<StrictTranscodingReader<File>>, DelimitedParseConfig, TableImportTextEncoding), String> {
    let config = effective_delimited_config(source_format, options)?;
    let (encoding, bom_len) =
        resolve_text_encoding_from_file_with_progress(path, options.encoding, on_encoding_progress)?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(bom_len as u64)).map_err(|error| error.to_string())?;
    let transcoded = StrictTranscodingReader::new(file, encoding)?;
    let reader =
        csv::ReaderBuilder::new().delimiter(config.delimiter).has_headers(false).flexible(true).from_reader(transcoded);
    Ok((reader, config, encoding))
}

pub fn parse_delimited_reader<R: std::io::Read>(
    reader: R,
    config: DelimitedParseConfig,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_decoded_delimited_reader(reader, config, preview_limit, TableImportTextEncoding::Utf8)
}

fn parse_decoded_delimited_reader<R: IoRead>(
    reader: R,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    let reader =
        csv::ReaderBuilder::new().delimiter(config.delimiter).has_headers(false).flexible(true).from_reader(reader);
    parse_csv_reader(reader, config, preview_limit, effective_encoding)
}

pub fn parse_delimited_bytes_with_options(
    bytes: &[u8],
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let (encoding, bom_len) = resolve_text_encoding_from_bytes(bytes, options.encoding)?;
    let reader = StrictTranscodingReader::new(std::io::Cursor::new(&bytes[bom_len..]), encoding)?;
    parse_decoded_delimited_reader(reader, effective_delimited_config(source_format, options)?, preview_limit, encoding)
}

pub fn parse_delimited_file_with_options(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    if options.encoding.unwrap_or(TableImportTextEncoding::Auto) == TableImportTextEncoding::Auto {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        if let Some((encoding, _)) = bom_text_encoding(&prefix[..prefix_len]) {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            return parse_csv_reader(reader, config, preview_limit, encoding);
        }

        for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            match parse_csv_reader(reader, config, preview_limit, encoding) {
                Ok(parsed) => return Ok(parsed),
                Err(error) if error.starts_with("Invalid byte sequence for ") => continue,
                Err(error) => return Err(error),
            }
        }
        return Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string());
    }

    let (reader, config, encoding) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    parse_csv_reader(reader, config, preview_limit, encoding)
}

fn parse_csv_reader<R: IoRead>(
    mut reader: csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    parse_csv_reader_inner(&mut reader, config, preview_limit, effective_encoding, true)
}

fn parse_csv_reader_bounded<R: IoRead>(
    mut reader: csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
) -> Result<ParsedImportFile, String> {
    parse_csv_reader_inner(&mut reader, config, preview_limit.max(1), effective_encoding, false)
}

fn parse_csv_reader_inner<R: IoRead>(
    reader: &mut csv::Reader<R>,
    config: DelimitedParseConfig,
    preview_limit: usize,
    effective_encoding: TableImportTextEncoding,
    count_all_rows: bool,
) -> Result<ParsedImportFile, String> {
    let mut rows = Vec::new();
    let mut total_rows = 0;
    let mut columns = Vec::new();
    let mut record = csv::StringRecord::new();
    let mut index = 0usize;
    while reader.read_record(&mut record).map_err(|e| e.to_string())? {
        index += 1;
        let row_number = index;
        if config.row_range.title_row == Some(row_number) {
            columns = unique_import_headers(
                record
                    .iter()
                    .enumerate()
                    .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index)),
            );
            continue;
        }
        if row_number < config.row_range.data_start_row {
            continue;
        }
        if config.row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..record.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        total_rows += 1;
        if rows.len() < preview_limit {
            rows.push(delimited_record_to_row(&record, columns.len(), config));
        }
        if !count_all_rows && rows.len() >= preview_limit {
            break;
        }
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }
    if total_rows == 0 {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok(ParsedImportFile { columns, rows, total_rows, effective_encoding: Some(effective_encoding) })
}

fn parse_delimited_preview_file_with_options(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    if options.encoding.unwrap_or(TableImportTextEncoding::Auto) == TableImportTextEncoding::Auto {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut prefix = [0u8; 3];
        let prefix_len = file.read(&mut prefix).map_err(|error| error.to_string())?;
        if let Some((encoding, _)) = bom_text_encoding(&prefix[..prefix_len]) {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            return parse_csv_reader_bounded(reader, config, preview_limit, encoding);
        }

        for encoding in [TableImportTextEncoding::Utf8, TableImportTextEncoding::Gbk] {
            let mut explicit_options = options.clone();
            explicit_options.encoding = Some(encoding);
            let (reader, config, encoding) =
                open_delimited_csv_reader_with_progress(path, source_format, &explicit_options, |_| {})?;
            match parse_csv_reader_bounded(reader, config, preview_limit, encoding) {
                Ok(parsed) => return Ok(parsed),
                Err(error) if error.starts_with("Invalid byte sequence for ") => continue,
                Err(error) => return Err(error),
            }
        }
        return Err("Could not detect text encoding; select UTF-8, GBK / GB18030, or UTF-16 manually".to_string());
    }

    let (reader, config, encoding) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    parse_csv_reader_bounded(reader, config, preview_limit, encoding)
}

pub fn parse_csv_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_delimited_bytes_with_options(
        bytes,
        TableImportSourceFormat::Csv,
        &TableImportParseOptions::default(),
        preview_limit,
    )
}

pub fn parse_delimited_bytes(bytes: &[u8], delimiter: u8, preview_limit: usize) -> Result<ParsedImportFile, String> {
    let options = TableImportParseOptions {
        delimiter: Some(if delimiter == b'\t' { "\\t".to_string() } else { (delimiter as char).to_string() }),
        ..TableImportParseOptions::default()
    };
    parse_delimited_bytes_with_options(bytes, TableImportSourceFormat::Delimited, &options, preview_limit)
}

pub fn parse_json_bytes_with_options(
    bytes: &[u8],
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => return Err("JSON import must be an object or an array".to_string()),
    };
    if items.is_empty() {
        return Err("Import file has no rows".to_string());
    }

    let shape = options.json_shape.unwrap_or(TableImportJsonShape::Auto);
    let all_objects = items.iter().all(|item| item.is_object());
    let all_arrays = items.iter().all(|item| item.is_array());

    if shape == TableImportJsonShape::Objects && !all_objects {
        return Err("JSON import is configured for object rows, but at least one row is not an object".to_string());
    }
    if shape == TableImportJsonShape::Arrays && !all_arrays {
        return Err("JSON import is configured for array rows, but at least one row is not an array".to_string());
    }

    if all_objects {
        let mut columns = Vec::new();
        for item in &items {
            if let Some(obj) = item.as_object() {
                for key in obj.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let obj = item.as_object().expect("checked object JSON row");
                columns
                    .iter()
                    .map(|column| obj.get(column).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len(), effective_encoding: None });
    }

    if all_arrays {
        let max_cols = items.iter().filter_map(|item| item.as_array().map(|row| row.len())).max().unwrap_or(0);
        if max_cols == 0 {
            return Err("Import file has no columns".to_string());
        }
        let columns = (0..max_cols).map(|index| format!("column_{}", index + 1)).collect::<Vec<_>>();
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let arr = item.as_array().expect("checked array JSON row");
                (0..max_cols)
                    .map(|index| arr.get(index).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile { columns, rows, total_rows: items.len(), effective_encoding: None });
    }

    Err("JSON rows must all be objects or all be arrays; mixed row shapes are not supported".to_string())
}

pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_json_bytes_with_options(bytes, &TableImportParseOptions::default(), preview_limit)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum XlsxTemporalKind {
    Date,
    Time,
    DateTime,
    Duration,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct XlsxCellStyle {
    temporal_kind: Option<XlsxTemporalKind>,
    number_format: Option<Arc<str>>,
}

fn format_chrono_duration_hms(duration: chrono::Duration, wrap_to_day: bool) -> String {
    let mut millis = duration.num_milliseconds();
    let negative = millis < 0;
    if negative {
        millis = -millis;
    }

    const DAY_MILLIS: i64 = 24 * 60 * 60 * 1000;
    if wrap_to_day {
        millis %= DAY_MILLIS;
    }

    let hours = millis / (60 * 60 * 1000);
    let minutes = (millis / (60 * 1000)) % 60;
    let seconds = (millis / 1000) % 60;
    let sub_millis = millis % 1000;
    let sign = if negative { "-" } else { "" };
    if sub_millis == 0 {
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        let fraction = format!("{sub_millis:03}").trim_end_matches('0').to_string();
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}.{fraction}")
    }
}

fn xlsx_datetime_label(value: &ExcelDateTime, temporal_kind: Option<XlsxTemporalKind>) -> String {
    if matches!(temporal_kind, Some(XlsxTemporalKind::Duration)) || value.is_duration() {
        return value
            .as_duration()
            .map(|duration| format_chrono_duration_hms(duration, false))
            .unwrap_or_else(|| value.to_string());
    }

    if matches!(temporal_kind, Some(XlsxTemporalKind::Time)) {
        return value
            .as_duration()
            .map(|duration| format_chrono_duration_hms(duration, true))
            .unwrap_or_else(|| value.to_string());
    }

    let Some(datetime) = value.as_datetime() else {
        return value.to_string();
    };

    match temporal_kind {
        Some(XlsxTemporalKind::Date) => datetime.format("%Y-%m-%d").to_string(),
        Some(XlsxTemporalKind::DateTime) => datetime.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        None => {
            if (0.0..1.0).contains(&value.as_f64()) {
                value.to_string()
            } else {
                datetime.format("%Y-%m-%d %H:%M:%S%.f").to_string()
            }
        }
        Some(XlsxTemporalKind::Time) | Some(XlsxTemporalKind::Duration) => unreachable!("handled above"),
    }
}

fn xlsx_string_value(value: &str, empty_string_as_null: bool) -> serde_json::Value {
    if empty_string_as_null && value.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(value.to_string())
    }
}

fn xlsx_number_value(value: f64) -> serde_json::Value {
    if value.is_finite() && value.fract() == 0.0 && value >= i64::MIN as f64 && value < -(i64::MIN as f64) {
        let integer = value as i64;
        if integer as f64 == value {
            return serde_json::Value::Number(integer.into());
        }
    }
    serde_json::Number::from_f64(value).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
}

fn xlsx_cell_value_with_temporal_kind(
    cell: &Data,
    temporal_kind: Option<XlsxTemporalKind>,
    empty_string_as_null: bool,
) -> serde_json::Value {
    match cell {
        Data::Empty => serde_json::Value::Null,
        Data::String(s) => xlsx_string_value(s, empty_string_as_null),
        Data::Float(n) => xlsx_number_value(*n),
        Data::Int(n) => serde_json::Value::Number((*n).into()),
        Data::Bool(v) => serde_json::Value::Bool(*v),
        Data::DateTime(v) => serde_json::Value::String(xlsx_datetime_label(v, temporal_kind)),
        Data::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        Data::DurationIso(v) => serde_json::Value::String(v.clone()),
        Data::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

fn xlsx_numeric_display_text(value: f64, style: Option<&XlsxCellStyle>) -> String {
    style
        .and_then(|style| style.number_format.as_deref())
        .and_then(|format_code| {
            let format = ssfmt::NumberFormat::parse(format_code).ok()?;
            let mut options = ssfmt::FormatOptions::default();
            let lcid = format.sections().iter().flat_map(|section| &section.parts).find_map(|part| match part {
                ssfmt::ast::FormatPart::Locale(locale) => locale.lcid,
                _ => None,
            });
            // ssfmt 0.1 only provides en-US locale data; preserve the German separators explicitly.
            if lcid == Some(0x0407) {
                options.locale.decimal_separator = ',';
                options.locale.thousands_separator = '.';
            }
            Some(format.format(value, &options))
        })
        .unwrap_or_else(|| value.to_string())
}

fn xlsx_cell_text_value(cell: &Data, style: Option<&XlsxCellStyle>) -> Option<String> {
    if style.and_then(|style| style.temporal_kind).is_some() {
        return None;
    }
    match cell {
        Data::Float(value) if value.is_finite() => Some(xlsx_numeric_display_text(*value, style)),
        Data::Int(value) => Some(xlsx_numeric_display_text(*value as f64, style)),
        _ => None,
    }
}

pub fn xlsx_cell_value(cell: &Data) -> serde_json::Value {
    xlsx_cell_value_with_temporal_kind(cell, None, true)
}

fn xlsx_cell_label_with_temporal_kind(cell: &Data, temporal_kind: Option<XlsxTemporalKind>) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => n.to_string(),
        Data::Int(n) => n.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => xlsx_datetime_label(v, temporal_kind),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => v.to_string(),
    }
}

pub fn xlsx_cell_label(cell: &Data) -> String {
    xlsx_cell_label_with_temporal_kind(cell, None)
}

fn xlsx_cell_ref_value_with_temporal_kind(
    cell: &DataRef<'_>,
    temporal_kind: Option<XlsxTemporalKind>,
    empty_string_as_null: bool,
) -> serde_json::Value {
    match cell {
        DataRef::Empty => serde_json::Value::Null,
        DataRef::String(s) => xlsx_string_value(s, empty_string_as_null),
        DataRef::SharedString(s) => xlsx_string_value(s, empty_string_as_null),
        DataRef::Float(n) => xlsx_number_value(*n),
        DataRef::Int(n) => serde_json::Value::Number((*n).into()),
        DataRef::Bool(v) => serde_json::Value::Bool(*v),
        DataRef::DateTime(v) => serde_json::Value::String(xlsx_datetime_label(v, temporal_kind)),
        DataRef::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        DataRef::DurationIso(v) => serde_json::Value::String(v.clone()),
        DataRef::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

fn xlsx_cell_ref_label_with_temporal_kind(cell: &DataRef<'_>, temporal_kind: Option<XlsxTemporalKind>) -> String {
    match cell {
        DataRef::Empty => String::new(),
        DataRef::String(s) => s.clone(),
        DataRef::SharedString(s) => (*s).to_string(),
        DataRef::Float(n) => n.to_string(),
        DataRef::Int(n) => n.to_string(),
        DataRef::Bool(v) => v.to_string(),
        DataRef::DateTime(v) => xlsx_datetime_label(v, temporal_kind),
        DataRef::DateTimeIso(v) => v.clone(),
        DataRef::DurationIso(v) => v.clone(),
        DataRef::Error(v) => v.to_string(),
    }
}

pub fn xlsx_sheet_names(path: &str) -> Result<Vec<String>, String> {
    if is_legacy_xls_path(path) {
        let workbook = open_workbook_auto(path).map_err(|error| error.to_string())?;
        return Ok(workbook.sheet_names().to_vec());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    Ok(xlsx_workbook_sheet_refs(&workbook_xml).into_iter().map(|(name, _)| name).collect())
}

fn xml_local_name_eq(name: &[u8], expected: &[u8]) -> bool {
    name.rsplit(|byte| *byte == b':').next().is_some_and(|local| local.eq_ignore_ascii_case(expected))
}

fn xml_attr_value<R>(reader: &XmlReader<R>, element: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    element.attributes().flatten().find_map(|attr| {
        if xml_local_name_eq(attr.key.as_ref(), key) {
            attr.decode_and_unescape_value(reader.decoder()).ok().map(|value| value.into_owned())
        } else {
            None
        }
    })
}

fn xlsx_builtin_temporal_kind(num_fmt_id: u16) -> Option<XlsxTemporalKind> {
    match num_fmt_id {
        14..=17 => Some(XlsxTemporalKind::Date),
        18..=21 | 45 | 47 => Some(XlsxTemporalKind::Time),
        22 => Some(XlsxTemporalKind::DateTime),
        46 => Some(XlsxTemporalKind::Duration),
        _ => None,
    }
}

fn xlsx_temporal_kind_from_format_code(format_code: &str) -> Option<XlsxTemporalKind> {
    let mut normalized = String::new();
    let mut chars = format_code.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                for quoted in chars.by_ref() {
                    if quoted == '"' {
                        break;
                    }
                }
            }
            '\\' | '_' | '*' => {
                let _ = chars.next();
            }
            ';' => break,
            '[' => {
                let mut bracket = String::new();
                for bracket_ch in chars.by_ref() {
                    if bracket_ch == ']' {
                        break;
                    }
                    bracket.push(bracket_ch);
                }
                let bracket = bracket.trim().to_ascii_lowercase();
                if matches!(bracket.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss") {
                    return Some(XlsxTemporalKind::Duration);
                }
            }
            _ => normalized.push(ch.to_ascii_lowercase()),
        }
    }

    let has_time = normalized.contains('h')
        || normalized.contains('s')
        || normalized.contains("am/pm")
        || normalized.contains("a/p");
    let has_month = normalized.contains('m');
    let has_date = normalized.contains('y') || normalized.contains('d') || (has_month && !has_time);
    match (has_date, has_time) {
        (true, true) => Some(XlsxTemporalKind::DateTime),
        (true, false) => Some(XlsxTemporalKind::Date),
        (false, true) => Some(XlsxTemporalKind::Time),
        (false, false) => None,
    }
}

fn parse_xlsx_styles(styles_xml: &str) -> Vec<XlsxCellStyle> {
    let mut reader = XmlReader::from_str(styles_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut custom_formats = HashMap::<u16, String>::new();
    let mut styles = Vec::new();
    let mut in_cell_xfs = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"numFmt") =>
            {
                let id = xml_attr_value(&reader, &element, b"numFmtId").and_then(|value| value.parse::<u16>().ok());
                let format_code = xml_attr_value(&reader, &element, b"formatCode");
                if let (Some(id), Some(format_code)) = (id, format_code) {
                    custom_formats.insert(id, format_code);
                }
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"cellXfs") => {
                in_cell_xfs = true;
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"cellXfs") => {
                in_cell_xfs = false;
            }
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if in_cell_xfs && xml_local_name_eq(element.name().as_ref(), b"xf") =>
            {
                let num_fmt_id =
                    xml_attr_value(&reader, &element, b"numFmtId").and_then(|value| value.parse::<u16>().ok());
                let custom_format_code = num_fmt_id.and_then(|id| custom_formats.get(&id).map(String::as_str));
                let temporal_kind = num_fmt_id.and_then(|id| {
                    custom_formats
                        .get(&id)
                        .and_then(|code| xlsx_temporal_kind_from_format_code(code))
                        .or_else(|| xlsx_builtin_temporal_kind(id))
                });
                styles.push(XlsxCellStyle {
                    temporal_kind,
                    number_format: if temporal_kind.is_none() {
                        custom_format_code
                            .or_else(|| num_fmt_id.and_then(|id| ssfmt::format_code_from_id(id as u32)))
                            .map(Arc::<str>::from)
                    } else {
                        None
                    },
                });
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    styles
}

fn xlsx_workbook_sheet_refs(workbook_xml: &str) -> Vec<(String, Option<String>)> {
    let mut reader = XmlReader::from_str(workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut sheets = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"sheet") =>
            {
                if let Some(name) = xml_attr_value(&reader, &element, b"name") {
                    sheets.push((name, xml_attr_value(&reader, &element, b"id")));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    sheets
}

fn xlsx_workbook_relationship_targets(rels_xml: &str) -> HashMap<String, String> {
    let mut reader = XmlReader::from_str(rels_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut targets = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"Relationship") =>
            {
                if let (Some(id), Some(target)) =
                    (xml_attr_value(&reader, &element, b"Id"), xml_attr_value(&reader, &element, b"Target"))
                {
                    targets.insert(id, target);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    targets
}

fn xlsx_relationship_target_path(base_dir: &str, target: &str) -> String {
    if target.starts_with('/') {
        return target.trim_start_matches('/').to_string();
    }

    let mut parts = base_dir.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

fn xlsx_sheet_path_for_name(workbook_xml: &str, rels_xml: &str, sheet_name: &str) -> Option<String> {
    let sheets = xlsx_workbook_sheet_refs(workbook_xml);
    let (index, (_, rel_id)) = sheets.iter().enumerate().find(|(_, (name, _))| name == sheet_name)?;
    let rel_targets = xlsx_workbook_relationship_targets(rels_xml);
    rel_id
        .as_ref()
        .and_then(|id| rel_targets.get(id))
        .map(|target| xlsx_relationship_target_path("xl", target))
        .or_else(|| Some(format!("xl/worksheets/sheet{}.xml", index + 1)))
}

fn xlsx_workbook_uses_1904_date_system(workbook_xml: &str) -> bool {
    let mut reader = XmlReader::from_str(workbook_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"workbookPr") =>
            {
                return xml_attr_value(&reader, &element, b"date1904")
                    .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"));
            }
            Ok(Event::Eof) | Err(_) => return false,
            _ => {}
        }
        buf.clear();
    }
}

fn xlsx_cell_ref_position(reference: &str) -> Option<(usize, usize)> {
    let mut column = 0usize;
    let mut row = 0usize;
    let mut saw_column = false;
    let mut saw_row = false;
    for ch in reference.chars() {
        if ch == '$' {
            continue;
        }
        if ch.is_ascii_alphabetic() && !saw_row {
            saw_column = true;
            column = column * 26 + (ch.to_ascii_uppercase() as u8 - b'A' + 1) as usize;
        } else if ch.is_ascii_digit() {
            saw_row = true;
            row = row * 10 + ch.to_digit(10)? as usize;
        } else {
            return None;
        }
    }
    (saw_column && saw_row).then_some((row, column))
}

fn parse_xlsx_sheet_cell_styles<R: BufRead>(
    source: R,
    styles: &[XlsxCellStyle],
    text_columns: &HashSet<usize>,
) -> Result<HashMap<(usize, usize), XlsxCellStyle>, String> {
    let mut reader = XmlReader::from_reader(source);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut cell_styles = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"c") =>
            {
                let Some(style_id) =
                    xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok())
                else {
                    buf.clear();
                    continue;
                };
                let Some(style) = styles.get(style_id) else {
                    buf.clear();
                    continue;
                };
                if let Some(position) =
                    xml_attr_value(&reader, &element, b"r").and_then(|reference| xlsx_cell_ref_position(&reference))
                {
                    if style.temporal_kind.is_some() || text_columns.contains(&position.1) {
                        cell_styles.insert(position, style.clone());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Ok(cell_styles)
}

fn read_xlsx_zip_text(zip: &mut zip::ZipArchive<File>, path: &str) -> Result<String, String> {
    let mut file = zip.by_name(path).map_err(|err| err.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|err| err.to_string())?;
    Ok(content)
}

#[derive(Debug, Default)]
struct XlsxPreviewRawCell {
    cell_type: Option<String>,
    style_id: Option<usize>,
    value: String,
    inline_value: String,
    has_value: bool,
    has_inline_value: bool,
}

fn xlsx_dimension_bounds(reference: &str) -> Option<((usize, usize), (usize, usize))> {
    let mut parts = reference.split(':');
    let start = xlsx_cell_ref_position(parts.next()?)?;
    let end = parts.next().and_then(xlsx_cell_ref_position).unwrap_or(start);
    Some((start, end))
}

fn read_xlsx_shared_strings(
    zip: &mut zip::ZipArchive<File>,
    needed: &HashSet<usize>,
) -> Result<HashMap<usize, String>, String> {
    if needed.is_empty() {
        return Ok(HashMap::new());
    }
    let max_needed = needed.iter().copied().max().unwrap_or_default();
    let file = zip.by_name("xl/sharedStrings.xml").map_err(|error| error.to_string())?;
    let mut reader = XmlReader::from_reader(BufReader::new(file));
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut index = 0usize;
    let mut in_item = false;
    let mut in_text = false;
    let mut phonetic_depth = 0usize;
    let mut current = String::new();
    let mut strings = HashMap::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                in_item = true;
                current.clear();
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = phonetic_depth == 0;
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = false;
            }
            Ok(Event::End(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                if needed.contains(&index) {
                    strings.insert(index, current.clone());
                }
                if index >= max_needed && strings.len() == needed.len() {
                    break;
                }
                index += 1;
                in_item = false;
                phonetic_depth = 0;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Ok(strings)
}

struct XlsxDiskSharedStrings {
    file: File,
    index: File,
    count: usize,
    cache: HashMap<usize, String>,
    cache_bytes: usize,
}

enum XlsxSharedStrings {
    Memory(Vec<String>),
    Disk(XlsxDiskSharedStrings),
}

impl XlsxSharedStrings {
    fn push(&mut self, value: &str) -> Result<(), String> {
        match self {
            Self::Memory(strings) => strings.push(value.to_string()),
            Self::Disk(store) => {
                let offset = store.file.stream_position().map_err(|error| error.to_string())?;
                let len = u32::try_from(value.len()).map_err(|_| "Excel shared string is too large".to_string())?;
                store.file.write_all(value.as_bytes()).map_err(|error| error.to_string())?;
                store.index.write_all(&offset.to_le_bytes()).map_err(|error| error.to_string())?;
                store.index.write_all(&len.to_le_bytes()).map_err(|error| error.to_string())?;
                store.count = store.count.saturating_add(1);
            }
        }
        Ok(())
    }

    fn get(&mut self, index: usize) -> Result<Option<String>, String> {
        match self {
            Self::Memory(strings) => Ok(strings.get(index).cloned()),
            Self::Disk(store) => {
                if let Some(value) = store.cache.get(&index) {
                    return Ok(Some(value.clone()));
                }
                if index >= store.count {
                    return Ok(None);
                }
                let index_offset = (index as u64).saturating_mul(12);
                store.index.seek(SeekFrom::Start(index_offset)).map_err(|error| error.to_string())?;
                let mut offset_bytes = [0u8; 8];
                let mut len_bytes = [0u8; 4];
                store.index.read_exact(&mut offset_bytes).map_err(|error| error.to_string())?;
                store.index.read_exact(&mut len_bytes).map_err(|error| error.to_string())?;
                let offset = u64::from_le_bytes(offset_bytes);
                let len = u32::from_le_bytes(len_bytes);
                store.file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
                let mut bytes = vec![0; len as usize];
                store.file.read_exact(&mut bytes).map_err(|error| error.to_string())?;
                let value = String::from_utf8(bytes).map_err(|error| error.to_string())?;
                // This cache is opportunistic; clearing it wholesale keeps lookup simple while
                // enforcing both the entry-count and byte-size bounds.
                if store.cache.len() >= XLSX_SHARED_STRING_CACHE_ENTRIES
                    || store.cache_bytes.saturating_add(value.len()) > XLSX_SHARED_STRING_CACHE_BYTES
                {
                    store.cache.clear();
                    store.cache_bytes = 0;
                }
                if value.len() <= XLSX_SHARED_STRING_CACHE_BYTES {
                    store.cache_bytes = store.cache_bytes.saturating_add(value.len());
                    store.cache.insert(index, value.clone());
                }
                Ok(Some(value))
            }
        }
    }
}

fn create_xlsx_spill_file() -> std::io::Result<File> {
    let file = tempfile::tempfile()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

struct XlsxCancellableReader<'a, R> {
    inner: R,
    is_cancelled: &'a dyn Fn() -> bool,
    on_progress: &'a mut dyn FnMut(u64) -> std::io::Result<()>,
    bytes_read: u64,
}

impl<R: IoRead> IoRead for XlsxCancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if (self.is_cancelled)() {
            return Err(std::io::Error::other("Import cancelled"));
        }
        let read_len = buffer.len().min(XLSX_CANCELLABLE_READ_CHUNK_BYTES);
        let bytes_read = self.inner.read(&mut buffer[..read_len])?;
        self.bytes_read = self.bytes_read.saturating_add(bytes_read as u64);
        (self.on_progress)(self.bytes_read)?;
        Ok(bytes_read)
    }
}

fn open_xlsx_shared_strings_with_control(
    zip: &mut zip::ZipArchive<File>,
    memory_limit: u64,
    is_cancelled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(u64) -> std::io::Result<()>,
) -> Result<XlsxSharedStrings, String> {
    let uncompressed_size = match zip.by_name("xl/sharedStrings.xml") {
        Ok(file) => file.size(),
        Err(zip::result::ZipError::FileNotFound) => return Ok(XlsxSharedStrings::Memory(Vec::new())),
        Err(error) => return Err(error.to_string()),
    };
    if uncompressed_size > MAX_XLSX_SHARED_STRINGS_BYTES {
        return Err(format!(
            "Excel shared strings are too large: {uncompressed_size} bytes (max {MAX_XLSX_SHARED_STRINGS_BYTES} bytes)"
        ));
    }
    // A fixed-width offset/length index lets cell parsing seek individual strings without
    // retaining the entire sharedStrings.xml payload in RAM.
    let mut strings = if uncompressed_size <= memory_limit {
        XlsxSharedStrings::Memory(Vec::new())
    } else {
        // Anonymous temporary files are owner-only on Unix and are removed by the OS when
        // their last handles close, including after abnormal process termination.
        let file = create_xlsx_spill_file().map_err(|error| error.to_string())?;
        let index = create_xlsx_spill_file().map_err(|error| error.to_string())?;
        XlsxSharedStrings::Disk(XlsxDiskSharedStrings { file, index, count: 0, cache: HashMap::new(), cache_bytes: 0 })
    };

    let file = zip.by_name("xl/sharedStrings.xml").map_err(|error| error.to_string())?;
    let controlled = XlsxCancellableReader { inner: file, is_cancelled, on_progress, bytes_read: 0 };
    let mut reader = XmlReader::from_reader(BufReader::new(controlled));
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut in_item = false;
    let mut in_text = false;
    let mut phonetic_depth = 0usize;
    let mut current = String::new();
    loop {
        if is_cancelled() {
            return Err("Import cancelled".to_string());
        }
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                in_item = true;
                current.clear();
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = phonetic_depth == 0;
            }
            Ok(Event::Start(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_item && in_text => {
                current.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                in_text = false;
            }
            Ok(Event::End(element)) if in_item && xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                phonetic_depth = phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"si") => {
                strings.push(&current)?;
                in_item = false;
                phonetic_depth = 0;
            }
            Ok(Event::Eof) => break,
            Err(error) => {
                return Err(if is_cancelled() { "Import cancelled".to_string() } else { error.to_string() });
            }
            _ => {}
        }
        buffer.clear();
    }
    if let XlsxSharedStrings::Disk(store) = &mut strings {
        store.file.flush().map_err(|error| error.to_string())?;
        store.index.flush().map_err(|error| error.to_string())?;
    }
    Ok(strings)
}

fn xlsx_preview_cell_value(
    cell: &XlsxPreviewRawCell,
    shared_strings: &HashMap<usize, String>,
    styles: &[XlsxCellStyle],
    date_1904: bool,
    empty_string_as_null: bool,
) -> serde_json::Value {
    let cell_type = cell.cell_type.as_deref().unwrap_or_default();
    match cell_type {
        "s" => cell
            .value
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(&index))
            .map_or(serde_json::Value::Null, |value| xlsx_string_value(value, empty_string_as_null)),
        "inlineStr" if cell.has_inline_value => xlsx_string_value(&cell.inline_value, empty_string_as_null),
        "inlineStr" => serde_json::Value::Null,
        "str" if cell.has_value => xlsx_string_value(&cell.value, empty_string_as_null),
        "str" => serde_json::Value::Null,
        "d" | "e" => csv_value(&cell.value),
        "b" => serde_json::Value::Bool(matches!(cell.value.trim(), "1" | "true" | "TRUE")),
        _ => {
            let Some(number) = cell.value.trim().parse::<f64>().ok() else {
                return if cell.value.is_empty() { serde_json::Value::Null } else { csv_value(&cell.value) };
            };
            let temporal_kind = cell.style_id.and_then(|style| styles.get(style)?.temporal_kind);
            if let Some(kind) = temporal_kind {
                let date_type = if kind == XlsxTemporalKind::Duration {
                    calamine::ExcelDateTimeType::TimeDelta
                } else {
                    calamine::ExcelDateTimeType::DateTime
                };
                let value = ExcelDateTime::new(number, date_type, date_1904);
                return serde_json::Value::String(xlsx_datetime_label(&value, Some(kind)));
            }
            xlsx_number_value(number)
        }
    }
}

fn xlsx_preview_cell_label(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        value => value.to_string(),
    }
}

fn parse_xlsx_preview_file_with_options(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<(ParsedImportFile, Vec<String>), String> {
    // Read worksheet XML directly so preview can stop after the requested rows instead of
    // materializing the workbook's complete cell range.
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let sheet_refs = xlsx_workbook_sheet_refs(&workbook_xml);
    let sheets = sheet_refs.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
    let sheet_name = if let Some(name) = options.sheet_name.as_ref().filter(|name| !name.trim().is_empty()) {
        if !sheets.iter().any(|sheet| sheet == name) {
            return Err(format!("Workbook sheet not found: {name}"));
        }
        name.clone()
    } else if let Some(index) = options.sheet_index {
        sheets.get(index).cloned().ok_or_else(|| format!("Workbook sheet index out of range: {index}"))?
    } else {
        sheets.first().cloned().ok_or_else(|| "Workbook has no sheets".to_string())?
    };
    let sheet_path = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, &sheet_name)
        .ok_or_else(|| format!("Workbook sheet not found: {sheet_name}"))?;
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    let date_1904 = xlsx_workbook_uses_1904_date_system(&workbook_xml);
    let empty_string_as_null = options.empty_string_as_null.unwrap_or(true);
    let row_range = effective_import_row_range(options)?;
    let preview_limit = preview_limit.max(1);
    let preview_last_row = row_range.data_start_row.saturating_add(preview_limit.saturating_sub(1));
    let requested_last_row = row_range.last_data_row.map_or(preview_last_row, |last| last.min(preview_last_row));
    let max_relative_row = requested_last_row.max(row_range.title_row.unwrap_or_default());

    let mut dimension = None;
    let mut raw_cells = HashMap::<(usize, usize), XlsxPreviewRawCell>::new();
    let mut observed_min_row = usize::MAX;
    let mut observed_min_column = usize::MAX;
    let mut observed_max_column = 0usize;
    let mut observed_max_row = 0usize;
    {
        let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
        let mut reader = XmlReader::from_reader(BufReader::new(sheet));
        reader.config_mut().trim_text(false);
        let mut buf = Vec::new();
        let mut current_position = None;
        let mut current_cell = XlsxPreviewRawCell::default();
        let mut current_row = 0usize;
        let mut current_column = 0usize;
        let mut in_value = false;
        let mut in_inline_text = false;
        let mut inline_phonetic_depth = 0usize;
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(element)) | Ok(Event::Empty(element))
                    if xml_local_name_eq(element.name().as_ref(), b"dimension") =>
                {
                    dimension = xml_attr_value(&reader, &element, b"ref").as_deref().and_then(xlsx_dimension_bounds);
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"row") => {
                    current_row = xml_attr_value(&reader, &element, b"r")
                        .and_then(|value| value.parse::<usize>().ok())
                        .filter(|row| *row > 0)
                        .unwrap_or_else(|| current_row.saturating_add(1).max(1));
                    current_column = 0;
                    if observed_min_row != usize::MAX {
                        let max_absolute_row = observed_min_row.saturating_add(max_relative_row.saturating_sub(1));
                        if current_row > max_absolute_row {
                            break;
                        }
                    }
                    observed_max_row = observed_max_row.max(current_row);
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    let position = xml_attr_value(&reader, &element, b"r")
                        .as_deref()
                        .and_then(xlsx_cell_ref_position)
                        .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                    current_row = position.0;
                    current_column = position.1;
                    observed_min_row = observed_min_row.min(position.0);
                    observed_min_column = observed_min_column.min(position.1);
                    observed_max_row = observed_max_row.max(position.0);
                    observed_max_column = observed_max_column.max(position.1);
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => continue,
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    let position = xml_attr_value(&reader, &element, b"r")
                        .as_deref()
                        .and_then(xlsx_cell_ref_position)
                        .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                    current_row = position.0;
                    current_column = position.1;
                    current_position = Some(position);
                    current_cell = XlsxPreviewRawCell {
                        cell_type: xml_attr_value(&reader, &element, b"t"),
                        style_id: xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok()),
                        ..XlsxPreviewRawCell::default()
                    };
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                    current_cell.has_value = true;
                    in_value = true;
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                    current_cell.has_value = true;
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                    current_cell.has_inline_value = true;
                    in_inline_text = inline_phonetic_depth == 0;
                }
                Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                    current_cell.has_inline_value = true;
                }
                Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                    inline_phonetic_depth = inline_phonetic_depth.saturating_add(1);
                }
                Ok(Event::Text(text)) if in_value => {
                    current_cell.value.push_str(&text.unescape().map_err(|error| error.to_string())?);
                }
                Ok(Event::Text(text)) if in_inline_text => {
                    current_cell.inline_value.push_str(&text.unescape().map_err(|error| error.to_string())?);
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                    in_value = false;
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                    in_inline_text = false;
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                    inline_phonetic_depth = inline_phonetic_depth.saturating_sub(1);
                }
                Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                    if let Some((row, column)) = current_position.take() {
                        observed_min_row = observed_min_row.min(row);
                        observed_min_column = observed_min_column.min(column);
                        observed_max_column = observed_max_column.max(column);
                        observed_max_row = observed_max_row.max(row);
                        let relative_row = row.saturating_sub(observed_min_row).saturating_add(1);
                        if relative_row == row_range.title_row.unwrap_or_default()
                            || (relative_row >= row_range.data_start_row && relative_row <= requested_last_row)
                        {
                            raw_cells.insert((row, column), std::mem::take(&mut current_cell));
                        }
                    }
                    inline_phonetic_depth = 0;
                    in_inline_text = false;
                }
                Ok(Event::Eof) => break,
                Err(error) => return Err(error.to_string()),
                _ => {}
            }
            buf.clear();
        }
    }

    let needed_shared_strings = raw_cells
        .values()
        .filter(|cell| cell.cell_type.as_deref() == Some("s"))
        .filter_map(|cell| cell.value.parse::<usize>().ok())
        .collect::<HashSet<_>>();
    let shared_strings = read_xlsx_shared_strings(&mut zip, &needed_shared_strings)?;
    if observed_min_row == usize::MAX || observed_min_column == usize::MAX {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    let start_row = observed_min_row;
    let start_column = observed_min_column;
    let observed_end_column = observed_max_column.max(start_column);
    let observed_column_count = observed_end_column.saturating_sub(start_column).saturating_add(1);
    let preview_row_count = requested_last_row
        .saturating_sub(row_range.data_start_row)
        .saturating_add(1)
        .saturating_add(usize::from(row_range.title_row.is_some()));
    if observed_column_count.saturating_mul(preview_row_count) > MAX_FAST_PREVIEW_CELLS {
        return Err(format!(
            "Excel preview grid is too large: {} columns across {} preview rows exceed the {} cell limit",
            observed_column_count, preview_row_count, MAX_FAST_PREVIEW_CELLS
        ));
    }
    let dimension_end_column = dimension
        .filter(|((dimension_start_row, dimension_start_column), _)| {
            *dimension_start_row == start_row && *dimension_start_column == start_column
        })
        .map(|(_, (_, end_column))| end_column)
        .filter(|end_column| {
            end_column.saturating_sub(start_column).saturating_add(1).saturating_mul(preview_row_count)
                <= MAX_FAST_PREVIEW_CELLS
        });
    let end_column = dimension_end_column.unwrap_or(observed_end_column).max(observed_end_column);
    let column_count = end_column.saturating_sub(start_column).saturating_add(1);
    let mut columns = if let Some(title_row) = row_range.title_row {
        let absolute_title_row = start_row.saturating_add(title_row.saturating_sub(1));
        unique_import_headers((0..column_count).map(|index| {
            let column = start_column + index;
            let value = raw_cells
                .get(&(absolute_title_row, column))
                .map(|cell| xlsx_preview_cell_value(cell, &shared_strings, &styles, date_1904, empty_string_as_null))
                .unwrap_or(serde_json::Value::Null);
            normalize_header(&xlsx_preview_cell_label(&value), index)
        }))
    } else {
        Vec::new()
    };
    if columns.is_empty() {
        columns = (0..column_count).map(|index| format!("column_{}", index + 1)).collect();
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }

    let observed_end_relative = observed_max_row.saturating_sub(start_row).saturating_add(1);
    let last_preview_row = requested_last_row.min(observed_end_relative);
    if last_preview_row < row_range.data_start_row {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    let rows = (row_range.data_start_row..=last_preview_row)
        .map(|relative_row| {
            let absolute_row = start_row + relative_row - 1;
            (0..columns.len())
                .map(|index| {
                    raw_cells
                        .get(&(absolute_row, start_column + index))
                        .map(|cell| {
                            xlsx_preview_cell_value(cell, &shared_strings, &styles, date_1904, empty_string_as_null)
                        })
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok((ParsedImportFile { columns, total_rows: rows.len(), rows, effective_encoding: None }, sheets))
}

fn xlsx_cell_styles(
    path: &str,
    sheet_name: &str,
    text_columns: &HashSet<usize>,
) -> Result<HashMap<(usize, usize), XlsxCellStyle>, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|err| err.to_string())?;
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    if styles.is_empty() {
        return Ok(HashMap::new());
    }

    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let Some(sheet_path) = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, sheet_name) else {
        return Ok(HashMap::new());
    };
    let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
    parse_xlsx_sheet_cell_styles(BufReader::new(sheet), &styles, text_columns)
}

fn is_legacy_xls_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xls"))
}

fn xlsx_style_selection_columns<T, Label>(range: &Range<T>, row_range: ImportRowRange, cell_label: Label) -> Vec<String>
where
    T: CellType,
    Label: Fn(&T, Option<XlsxTemporalKind>) -> String,
{
    for (index, source_row) in range.rows().enumerate() {
        let row_number = index + 1;
        if row_range.title_row == Some(row_number) {
            return unique_import_headers(
                source_row.iter().enumerate().map(|(index, cell)| normalize_header(&cell_label(cell, None), index)),
            );
        }
        let row_is_within_range = match row_range.last_data_row {
            Some(last) => row_number <= last,
            None => true,
        };
        if row_number >= row_range.data_start_row && row_is_within_range {
            return (0..source_row.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
    }
    Vec::new()
}

pub fn parse_xlsx_file_with_options(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_xlsx_file_with_options_and_text_columns(path, options, preview_limit, &HashSet::new())
}

fn parse_xlsx_file_with_options_and_text_columns(
    path: &str,
    options: &TableImportParseOptions,
    preview_limit: usize,
    text_source_columns: &HashSet<String>,
) -> Result<ParsedImportFile, String> {
    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheet_names = workbook.sheet_names().to_vec();
    let sheet_name = if let Some(name) = options.sheet_name.as_ref().filter(|name| !name.trim().is_empty()) {
        if !sheet_names.iter().any(|sheet| sheet == name) {
            return Err(format!("Workbook sheet not found: {name}"));
        }
        name.clone()
    } else if let Some(index) = options.sheet_index {
        sheet_names.get(index).cloned().ok_or_else(|| format!("Workbook sheet index out of range: {index}"))?
    } else {
        sheet_names.first().cloned().ok_or_else(|| "Workbook has no sheets".to_string())?
    };
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    let legacy_xls = is_legacy_xls_path(path);
    if extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm") {
        let range = workbook.worksheet_range_ref(&sheet_name).map_err(|e| e.to_string())?;
        let row_range = effective_import_row_range(options)?;
        let style_selection_columns =
            xlsx_style_selection_columns(&range, row_range, xlsx_cell_ref_label_with_temporal_kind);
        let text_worksheet_columns = style_selection_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| {
                text_source_columns
                    .contains(column)
                    .then_some(range.start().map_or(index + 1, |(_, start)| start as usize + index + 1))
            })
            .collect::<HashSet<_>>();
        let cell_styles =
            if legacy_xls { HashMap::new() } else { xlsx_cell_styles(path, &sheet_name, &text_worksheet_columns)? };
        return parse_xlsx_range(
            &range,
            options,
            preview_limit,
            &cell_styles,
            text_source_columns,
            legacy_xls,
            xlsx_cell_ref_label_with_temporal_kind,
            xlsx_cell_ref_value_with_temporal_kind,
            xlsx_cell_ref_text_value,
            xlsx_cell_ref_is_numeric,
        );
    }

    let range = workbook.worksheet_range(&sheet_name).map_err(|e| e.to_string())?;
    let row_range = effective_import_row_range(options)?;
    let style_selection_columns = xlsx_style_selection_columns(&range, row_range, xlsx_cell_label_with_temporal_kind);
    let text_worksheet_columns = style_selection_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            text_source_columns
                .contains(column)
                .then_some(range.start().map_or(index + 1, |(_, start)| start as usize + index + 1))
        })
        .collect::<HashSet<_>>();
    let cell_styles =
        if legacy_xls { HashMap::new() } else { xlsx_cell_styles(path, &sheet_name, &text_worksheet_columns)? };
    parse_xlsx_range(
        &range,
        options,
        preview_limit,
        &cell_styles,
        text_source_columns,
        legacy_xls,
        xlsx_cell_label_with_temporal_kind,
        xlsx_cell_value_with_temporal_kind,
        xlsx_cell_text_value,
        xlsx_cell_is_numeric,
    )
}

#[derive(Debug)]
enum XlsxStreamMessage {
    Header(Vec<String>),
    Rows(Vec<Vec<serde_json::Value>>),
    Progress(u64),
    Done,
}

fn xlsx_stream_cell_value(
    cell: &XlsxPreviewRawCell,
    shared_strings: &mut XlsxSharedStrings,
    styles: &[XlsxCellStyle],
    date_1904: bool,
    format_as_text: bool,
    empty_string_as_null: bool,
) -> Result<serde_json::Value, String> {
    if format_as_text && cell.cell_type.as_deref().unwrap_or_default().is_empty() {
        if let Ok(number) = cell.value.trim().parse::<f64>() {
            let style = cell.style_id.and_then(|style| styles.get(style));
            if style.and_then(|style| style.temporal_kind).is_none() {
                return Ok(serde_json::Value::String(xlsx_numeric_display_text(number, style)));
            }
        }
    }
    if cell.cell_type.as_deref() != Some("s") {
        return Ok(xlsx_preview_cell_value(cell, &HashMap::new(), styles, date_1904, empty_string_as_null));
    }
    let Some(index) = cell.value.parse::<usize>().ok() else {
        return Ok(serde_json::Value::Null);
    };
    Ok(shared_strings
        .get(index)?
        .map_or(serde_json::Value::Null, |value| xlsx_string_value(&value, empty_string_as_null)))
}

fn xlsx_cell_ref_text_value(cell: &DataRef<'_>, style: Option<&XlsxCellStyle>) -> Option<String> {
    if style.and_then(|style| style.temporal_kind).is_some() {
        return None;
    }
    match cell {
        DataRef::Float(value) if value.is_finite() => Some(xlsx_numeric_display_text(*value, style)),
        DataRef::Int(value) => Some(xlsx_numeric_display_text(*value as f64, style)),
        _ => None,
    }
}

fn xlsx_cell_ref_is_numeric(cell: &DataRef<'_>) -> bool {
    matches!(cell, DataRef::Float(_) | DataRef::Int(_))
}

fn xlsx_cell_is_numeric(cell: &Data) -> bool {
    matches!(cell, Data::Float(_) | Data::Int(_))
}

struct XlsxStreamRowsState {
    sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
    row_range: ImportRowRange,
    dimension: Option<((usize, usize), (usize, usize))>,
    start_row: Option<usize>,
    start_column: usize,
    declared_column_count: Option<usize>,
    columns: Vec<String>,
    header_sent: bool,
    pending_rows: Vec<Vec<serde_json::Value>>,
    rows_seen: usize,
    current_row: Option<usize>,
    current_values: Vec<serde_json::Value>,
    batch_size: usize,
}

impl XlsxStreamRowsState {
    fn new(
        sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
        row_range: ImportRowRange,
        dimension: Option<((usize, usize), (usize, usize))>,
        expected_columns: Option<Vec<String>>,
        batch_size: usize,
    ) -> Self {
        let batch_size = batch_size.max(1);
        Self {
            sender,
            row_range,
            dimension,
            start_row: None,
            start_column: 0,
            declared_column_count: None,
            columns: expected_columns.unwrap_or_default(),
            header_sent: false,
            pending_rows: Vec::with_capacity(batch_size),
            rows_seen: 0,
            current_row: None,
            current_values: Vec::new(),
            batch_size,
        }
    }

    fn initialize_range(&mut self, first_row: usize, first_column: usize) {
        if self.start_row.is_some() {
            return;
        }
        let expected_column_count = (!self.columns.is_empty()).then_some(self.columns.len());
        let dimension = self.dimension.filter(|((start_row, start_column), (end_row, end_column))| {
            let column_count = end_column.saturating_sub(*start_column).saturating_add(1);
            let row_count = end_row.saturating_sub(*start_row).saturating_add(1);
            *start_row == first_row
                && *start_column == first_column
                && column_count <= MAX_FAST_PREVIEW_CELLS
                && expected_column_count
                    .map_or(column_count.saturating_mul(row_count) <= MAX_FAST_PREVIEW_CELLS, |expected| {
                        expected == column_count
                    })
        });
        self.start_row = Some(first_row);
        self.start_column = first_column;
        self.declared_column_count = dimension
            .map(|((_, start_column), (_, end_column))| end_column.saturating_sub(start_column).saturating_add(1));
    }

    fn selected_range_finished(&self, absolute_row: usize) -> bool {
        let Some(start_row) = self.start_row else {
            return false;
        };
        self.row_range.last_data_row.is_some_and(|last| absolute_row > start_row.saturating_add(last.saturating_sub(1)))
    }

    fn is_text_source_column(
        &mut self,
        absolute_row: usize,
        absolute_column: usize,
        text_source_columns: &HashSet<String>,
    ) -> bool {
        self.initialize_range(absolute_row, absolute_column);
        absolute_column
            .checked_sub(self.start_column)
            .and_then(|offset| self.columns.get(offset))
            .is_some_and(|column| text_source_columns.contains(column))
    }

    fn push_cell(
        &mut self,
        absolute_row: usize,
        absolute_column: usize,
        value: serde_json::Value,
        progress: u64,
    ) -> Result<(), String> {
        self.initialize_range(absolute_row, absolute_column);
        if self.current_row != Some(absolute_row) {
            self.flush_current_row(progress)?;
            self.current_row = Some(absolute_row);
        }
        let column_offset = absolute_column.checked_sub(self.start_column).ok_or_else(|| {
            format!("Excel row {absolute_row} contains a cell before the detected import range start column")
        })?;
        if column_offset >= MAX_FAST_PREVIEW_CELLS {
            return Err(format!("Excel import column {} exceeds the safety limit", column_offset + 1));
        }
        if column_offset >= self.current_values.len() {
            self.current_values.resize(column_offset + 1, serde_json::Value::Null);
        }
        self.current_values[column_offset] = value;
        Ok(())
    }

    fn flush_current_row(&mut self, progress: u64) -> Result<(), String> {
        let Some(absolute_row) = self.current_row.take() else {
            return Ok(());
        };
        let values = std::mem::take(&mut self.current_values);
        self.flush_row(absolute_row, values, progress)
    }

    fn flush_row(
        &mut self,
        absolute_row: usize,
        mut values: Vec<serde_json::Value>,
        progress: u64,
    ) -> Result<(), String> {
        let relative_row = absolute_row.saturating_sub(self.start_row.unwrap_or(absolute_row)).saturating_add(1);
        if self.row_range.title_row == Some(relative_row) {
            if self.columns.is_empty() {
                let column_count = self.declared_column_count.unwrap_or(values.len()).max(values.len());
                values.resize(column_count, serde_json::Value::Null);
                self.columns = unique_import_headers(
                    values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| normalize_header(&xlsx_preview_cell_label(value), index)),
                );
            }
            return Ok(());
        }
        if relative_row < self.row_range.data_start_row
            || self.row_range.last_data_row.is_some_and(|last| relative_row > last)
        {
            return Ok(());
        }
        if self.columns.is_empty() {
            let column_count = self.declared_column_count.unwrap_or(values.len()).max(values.len());
            self.columns = (0..column_count).map(|index| format!("column_{}", index + 1)).collect();
        }
        if !self.header_sent {
            self.sender
                .blocking_send(Ok(XlsxStreamMessage::Header(self.columns.clone())))
                .map_err(|_| "Excel import consumer closed before the stream started".to_string())?;
            self.header_sent = true;
        }
        if values.len() > self.columns.len() && values[self.columns.len()..].iter().any(|value| !value.is_null()) {
            return Err(format!(
                "Excel row {absolute_row} contains data beyond the {} columns confirmed by the preview",
                self.columns.len()
            ));
        }
        values.resize(self.columns.len(), serde_json::Value::Null);
        values.truncate(self.columns.len());
        self.pending_rows.push(values);
        self.rows_seen = self.rows_seen.saturating_add(1);
        if self.pending_rows.len() >= self.batch_size {
            self.emit_rows(progress)?;
        }
        Ok(())
    }

    fn emit_rows(&mut self, progress: u64) -> Result<(), String> {
        if self.pending_rows.is_empty() {
            return Ok(());
        }
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Rows(std::mem::take(&mut self.pending_rows))))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())?;
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Progress(progress)))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())?;
        self.pending_rows = Vec::with_capacity(self.batch_size);
        Ok(())
    }

    fn finish(mut self, progress: u64) -> Result<(), String> {
        self.flush_current_row(progress)?;
        self.emit_rows(progress)?;
        if !self.header_sent || self.rows_seen == 0 {
            return Err("Import file has no data rows in the selected row range".to_string());
        }
        self.sender
            .blocking_send(Ok(XlsxStreamMessage::Done))
            .map_err(|_| "Excel import consumer closed before the stream finished".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn stream_xlsx_rows_to_channel_with_control(
    path: &str,
    options: &TableImportParseOptions,
    batch_size: usize,
    expected_columns: Option<Vec<String>>,
    text_source_columns: HashSet<String>,
    scan_full_worksheet: bool,
    sender: tokio::sync::mpsc::Sender<Result<XlsxStreamMessage, String>>,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    // This producer runs on a blocking thread and communicates in bounded batches. The small
    // channel capacity applies backpressure when database writes are slower than XML parsing.
    let total_bytes = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or_default();
    let empty_string_as_null = options.empty_string_as_null.unwrap_or(true);
    let mut zip = zip::ZipArchive::new(File::open(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let workbook_xml = read_xlsx_zip_text(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_xlsx_zip_text(&mut zip, "xl/_rels/workbook.xml.rels").unwrap_or_default();
    let sheet_refs = xlsx_workbook_sheet_refs(&workbook_xml);
    let sheet_names = sheet_refs.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
    let sheet_name = if let Some(name) = options.sheet_name.as_ref().filter(|name| !name.trim().is_empty()) {
        if !sheet_names.iter().any(|sheet| sheet == name) {
            return Err(format!("Workbook sheet not found: {name}"));
        }
        name.clone()
    } else if let Some(index) = options.sheet_index {
        sheet_names.get(index).cloned().ok_or_else(|| format!("Workbook sheet index out of range: {index}"))?
    } else {
        sheet_names.first().cloned().ok_or_else(|| "Workbook has no sheets".to_string())?
    };
    let styles_xml = read_xlsx_zip_text(&mut zip, "xl/styles.xml").unwrap_or_default();
    let styles = parse_xlsx_styles(&styles_xml);
    let date_1904 = xlsx_workbook_uses_1904_date_system(&workbook_xml);
    let sheet_path = xlsx_sheet_path_for_name(&workbook_xml, &rels_xml, &sheet_name)
        .ok_or_else(|| format!("Workbook sheet not found: {sheet_name}"))?;
    let shared_strings_bytes = match zip.by_name("xl/sharedStrings.xml") {
        Ok(file) => file.size(),
        Err(zip::result::ZipError::FileNotFound) => 0,
        Err(error) => return Err(error.to_string()),
    };
    let shared_progress_end = if shared_strings_bytes > 0 { total_bytes / 2 } else { 0 };
    let progress_sender = sender.clone();
    let mut last_shared_progress = Instant::now() - IMPORT_PROGRESS_INTERVAL;
    let mut on_shared_progress = |bytes_read: u64| {
        let progress = bytes_read
            .saturating_mul(shared_progress_end)
            .checked_div(shared_strings_bytes.max(1))
            .unwrap_or_default()
            .min(shared_progress_end);
        if last_shared_progress.elapsed() >= IMPORT_PROGRESS_INTERVAL || bytes_read >= shared_strings_bytes {
            progress_sender
                .blocking_send(Ok(XlsxStreamMessage::Progress(progress)))
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Excel import consumer closed"))?;
            last_shared_progress = Instant::now();
        }
        Ok(())
    };
    let is_cancelled = || cancelled.load(Ordering::Acquire);
    let mut shared_strings = open_xlsx_shared_strings_with_control(
        &mut zip,
        MAX_IN_MEMORY_XLSX_SHARED_STRINGS_BYTES,
        &is_cancelled,
        &mut on_shared_progress,
    )?;
    let row_range = effective_import_row_range(options)?;
    let sheet = zip.by_name(&sheet_path).map_err(|error| error.to_string())?;
    let uncompressed_sheet_bytes = sheet.size().max(1);
    let mut reader = XmlReader::from_reader(BufReader::new(sheet));
    reader.config_mut().trim_text(false);
    let mut rows = XlsxStreamRowsState::new(sender, row_range, None, expected_columns, batch_size);
    let mut buffer = Vec::new();
    let mut current_row = 0usize;
    let mut current_column = 0usize;
    let mut current_position = None;
    let mut current_cell = XlsxPreviewRawCell::default();
    let mut in_value = false;
    let mut in_inline_text = false;
    let mut inline_phonetic_depth = 0usize;
    loop {
        // Convert the uncompressed worksheet offset into an approximate archive-byte offset so
        // progress remains monotonic without scanning the ZIP twice.
        if cancelled.load(Ordering::Acquire) {
            return Err("Import cancelled".to_string());
        }
        let progress = shared_progress_end.saturating_add(
            reader
                .buffer_position()
                .saturating_mul(total_bytes.saturating_sub(shared_progress_end))
                .checked_div(uncompressed_sheet_bytes)
                .unwrap_or_default()
                .min(total_bytes.saturating_sub(shared_progress_end)),
        );
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(element)) | Ok(Event::Empty(element))
                if xml_local_name_eq(element.name().as_ref(), b"dimension") =>
            {
                rows.dimension = xml_attr_value(&reader, &element, b"ref").as_deref().and_then(xlsx_dimension_bounds);
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"row") => {
                current_row = xml_attr_value(&reader, &element, b"r")
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|row| *row > 0)
                    .unwrap_or_else(|| current_row.saturating_add(1).max(1));
                current_column = 0;
                if !scan_full_worksheet && rows.selected_range_finished(current_row) {
                    break;
                }
            }
            Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                let position = xml_attr_value(&reader, &element, b"r")
                    .as_deref()
                    .and_then(xlsx_cell_ref_position)
                    .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                current_row = position.0;
                current_column = position.1;
                rows.push_cell(position.0, position.1, serde_json::Value::Null, progress)?;
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                let position = xml_attr_value(&reader, &element, b"r")
                    .as_deref()
                    .and_then(xlsx_cell_ref_position)
                    .unwrap_or_else(|| (current_row.max(1), current_column.saturating_add(1).max(1)));
                current_row = position.0;
                current_column = position.1;
                current_position = Some(position);
                current_cell = XlsxPreviewRawCell {
                    cell_type: xml_attr_value(&reader, &element, b"t"),
                    style_id: xml_attr_value(&reader, &element, b"s").and_then(|value| value.parse::<usize>().ok()),
                    ..XlsxPreviewRawCell::default()
                };
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                current_cell.has_value = true;
                in_value = true;
            }
            Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => {
                current_cell.has_value = true;
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                current_cell.has_inline_value = true;
                in_inline_text = inline_phonetic_depth == 0;
            }
            Ok(Event::Empty(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => {
                current_cell.has_inline_value = true;
            }
            Ok(Event::Start(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                inline_phonetic_depth = inline_phonetic_depth.saturating_add(1);
            }
            Ok(Event::Text(text)) if in_value => {
                current_cell.value.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::Text(text)) if in_inline_text => {
                current_cell.inline_value.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"v") => in_value = false,
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"t") => in_inline_text = false,
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"rPh") => {
                inline_phonetic_depth = inline_phonetic_depth.saturating_sub(1);
            }
            Ok(Event::End(element)) if xml_local_name_eq(element.name().as_ref(), b"c") => {
                if let Some((row, column)) = current_position.take() {
                    let format_as_text = rows.is_text_source_column(row, column, &text_source_columns);
                    let value = xlsx_stream_cell_value(
                        &current_cell,
                        &mut shared_strings,
                        &styles,
                        date_1904,
                        format_as_text,
                        empty_string_as_null,
                    )?;
                    rows.push_cell(row, column, value, progress)?;
                    current_cell = XlsxPreviewRawCell::default();
                }
                inline_phonetic_depth = 0;
                in_inline_text = false;
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buffer.clear();
    }
    rows.finish(total_bytes)
}

async fn receive_xlsx_stream_message(
    receiver: &mut tokio::sync::mpsc::Receiver<Result<XlsxStreamMessage, String>>,
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    producer_cancelled: &AtomicBool,
) -> Result<Option<Result<XlsxStreamMessage, String>>, ()> {
    loop {
        if is_cancelled(import_id).await {
            producer_cancelled.store(true, Ordering::Release);
            return Err(());
        }
        if let Ok(message) = tokio::time::timeout(XLSX_CANCEL_POLL_INTERVAL, receiver.recv()).await {
            return Ok(message);
        }
    }
}

fn xlsx_import_pass_progress(bytes_read: u64, total_bytes: u64, second_pass: bool) -> u64 {
    let bytes_read = bytes_read.min(total_bytes);
    let first_pass_bytes = total_bytes / 2;
    if !second_pass {
        return bytes_read.saturating_mul(first_pass_bytes).checked_div(total_bytes.max(1)).unwrap_or_default();
    }
    first_pass_bytes.saturating_add(
        bytes_read
            .saturating_mul(total_bytes.saturating_sub(first_pass_bytes))
            .checked_div(total_bytes.max(1))
            .unwrap_or_default(),
    )
}

async fn validate_xlsx_worksheet_for_import(
    path: String,
    options: TableImportParseOptions,
    expected_columns: Option<Vec<String>>,
    text_source_columns: HashSet<String>,
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    mut on_progress: impl FnMut(u64),
) -> Result<Vec<String>, String> {
    // Drain bounded row batches without writing. Full-sheet mode keeps parsing through the
    // worksheet EOF even when the selected import range ends earlier.
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<XlsxStreamMessage, String>>(2);
    let producer_cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_for_producer = producer_cancelled.clone();
    let validation = tokio::task::spawn_blocking(move || {
        stream_xlsx_rows_to_channel_with_control(
            &path,
            &options,
            DEFAULT_BATCH_SIZE,
            expected_columns,
            text_source_columns,
            true,
            sender,
            cancelled_for_producer,
        )
    });

    let mut columns = None;
    loop {
        let message =
            match receive_xlsx_stream_message(&mut receiver, import_id, is_cancelled, &producer_cancelled).await {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(()) => {
                    drop(receiver);
                    let _ = validation.await;
                    return Err("Import cancelled".to_string());
                }
            };
        match message {
            Ok(XlsxStreamMessage::Header(header)) => columns = Some(header),
            Ok(XlsxStreamMessage::Progress(bytes_read)) => on_progress(bytes_read),
            Ok(XlsxStreamMessage::Rows(_) | XlsxStreamMessage::Done) => {}
            Err(error) => {
                producer_cancelled.store(true, Ordering::Release);
                drop(receiver);
                let _ = validation.await;
                return Err(error);
            }
        }
    }

    validation.await.map_err(|error| error.to_string())??;
    columns.ok_or_else(|| "Excel stream ended before providing a header".to_string())
}

fn parse_xlsx_range<T, Label, Value, TextValue, IsNumeric>(
    range: &Range<T>,
    options: &TableImportParseOptions,
    preview_limit: usize,
    cell_styles: &HashMap<(usize, usize), XlsxCellStyle>,
    text_source_columns: &HashSet<String>,
    legacy_xls: bool,
    cell_label: Label,
    cell_value: Value,
    cell_text_value: TextValue,
    is_numeric: IsNumeric,
) -> Result<ParsedImportFile, String>
where
    T: CellType,
    Label: Fn(&T, Option<XlsxTemporalKind>) -> String,
    Value: Fn(&T, Option<XlsxTemporalKind>, bool) -> serde_json::Value,
    TextValue: Fn(&T, Option<&XlsxCellStyle>) -> Option<String>,
    IsNumeric: Fn(&T) -> bool,
{
    let (range_start_row, range_start_column) =
        range.start().map(|(row, column)| (row as usize, column as usize)).unwrap_or_default();
    let row_range = effective_import_row_range(options)?;
    let empty_string_as_null = options.empty_string_as_null.unwrap_or(true);
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut total_rows = 0;
    for (index, source_row) in range.rows().enumerate() {
        let row_number = index + 1;
        if row_range.title_row == Some(row_number) {
            columns = unique_import_headers(source_row.iter().enumerate().map(|(index, cell)| {
                // Calamine rows are relative to the used range, while XLSX style coordinates are worksheet-absolute.
                let cell_position = (range_start_row + row_number, range_start_column + index + 1);
                normalize_header(
                    &cell_label(cell, cell_styles.get(&cell_position).and_then(|style| style.temporal_kind)),
                    index,
                )
            }));
            continue;
        }
        if row_number < row_range.data_start_row {
            continue;
        }
        if row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..source_row.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            let cell_position = (range_start_row + row_number, range_start_column + index + 1);
            let style = cell_styles.get(&cell_position);
            let value = source_row
                .get(index)
                .map(|cell| {
                    if text_source_columns.contains(column) {
                        if legacy_xls && is_numeric(cell) {
                            return Err(format!(
                                "Legacy .xls files cannot preserve numeric display formatting for text target column '{column}'. Save the workbook as .xlsx or map this source column to a numeric target."
                            ));
                        }
                        if let Some(text) = cell_text_value(cell, style) {
                            return Ok(serde_json::Value::String(text));
                        }
                    }
                    Ok(cell_value(cell, style.and_then(|style| style.temporal_kind), empty_string_as_null))
                })
                .transpose()?
                .unwrap_or(serde_json::Value::Null);
            row.push(value);
        }
        rows.push(row);
    }
    if columns.is_empty() {
        return Err("Import file has no columns in the selected row range".to_string());
    }
    if total_rows == 0 {
        return Err("Import file has no data rows in the selected row range".to_string());
    }
    Ok(ParsedImportFile { columns, rows, total_rows, effective_encoding: None })
}

pub fn parse_xlsx_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_xlsx_file_with_options(path, &TableImportParseOptions::default(), preview_limit)
}

fn ensure_non_streaming_file_size(path: &str, format: TableImportSourceFormat) -> Result<(), String> {
    if format.is_delimited() {
        return Ok(());
    }
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    let max_bytes = if format == TableImportSourceFormat::Excel && extension.eq_ignore_ascii_case("xls") {
        MAX_LEGACY_XLS_IMPORT_BYTES
    } else {
        MAX_NON_STREAMING_IMPORT_BYTES
    };
    if metadata.len() > max_bytes {
        return Err(format!(
            "File too large for {} import: {} bytes (max {} bytes)",
            format.label(),
            metadata.len(),
            max_bytes
        ));
    }
    Ok(())
}

pub async fn parse_import_file_with_options(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    parse_import_file_with_options_and_text_columns(path, source_format, options, preview_limit, HashSet::new()).await
}

async fn parse_import_file_with_options_and_text_columns(
    path: &str,
    source_format: Option<TableImportSourceFormat>,
    options: &TableImportParseOptions,
    preview_limit: usize,
    text_source_columns: HashSet<String>,
) -> Result<ParsedImportFile, String> {
    let format = effective_source_format(path, source_format)?;
    ensure_non_streaming_file_size(path, format)?;
    match format {
        TableImportSourceFormat::Csv | TableImportSourceFormat::Tsv | TableImportSourceFormat::Delimited => {
            let path = path.to_string();
            let options = options.clone();
            tokio::task::spawn_blocking(move || {
                parse_delimited_file_with_options(&path, format, &options, preview_limit)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        TableImportSourceFormat::Json => {
            let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
            parse_json_bytes_with_options(&bytes, options, preview_limit)
        }
        TableImportSourceFormat::Excel => {
            let path = path.to_string();
            let options = options.clone();
            tokio::task::spawn_blocking(move || {
                parse_xlsx_file_with_options_and_text_columns(&path, &options, preview_limit, &text_source_columns)
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

async fn parse_import_preview_file_with_options(
    path: &str,
    format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    preview_limit: usize,
) -> Result<(ParsedImportFile, bool, Vec<String>), String> {
    if format.is_delimited() {
        let path = path.to_string();
        let options = options.clone();
        let parsed = tokio::task::spawn_blocking(move || {
            parse_delimited_preview_file_with_options(&path, format, &options, preview_limit)
        })
        .await
        .map_err(|e| e.to_string())??;
        return Ok((parsed, false, Vec::new()));
    }

    ensure_non_streaming_file_size(path, format)?;
    let extension = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    if format == TableImportSourceFormat::Excel
        && (extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm"))
    {
        let path = path.to_string();
        let options = options.clone();
        let (parsed, sheets) =
            tokio::task::spawn_blocking(move || parse_xlsx_preview_file_with_options(&path, &options, preview_limit))
                .await
                .map_err(|e| e.to_string())??;
        return Ok((parsed, false, sheets));
    }

    let parsed = parse_import_file_with_options(path, Some(format), options, preview_limit).await?;
    let sheets = if format == TableImportSourceFormat::Excel {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || xlsx_sheet_names(&path)).await.map_err(|e| e.to_string())??
    } else {
        Vec::new()
    };
    Ok((parsed, true, sheets))
}

pub async fn parse_import_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_import_file_with_options(path, None, &TableImportParseOptions::default(), preview_limit).await
}

pub fn mapping_indexes(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    mapping_indexes_for_columns(&data.columns, mappings)
}

pub fn mapping_indexes_for_columns(
    columns: &[String],
    mappings: &[TableImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    mapping_indexes_with_mappings(columns, mappings).map(|mapped| {
        mapped.into_iter().map(|(source_index, mapping)| (source_index, mapping.target_column.clone())).collect()
    })
}

fn mapping_indexes_with_mappings<'a>(
    columns: &[String],
    mappings: &'a [TableImportColumnMapping],
) -> Result<Vec<(usize, &'a TableImportColumnMapping)>, String> {
    if mappings.is_empty() {
        return Err("No columns mapped for import".to_string());
    }
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        let source_index = columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("Source column not found: {}", mapping.source_column))?;
        if mapping.target_column.trim().is_empty() {
            return Err("Target column cannot be empty".to_string());
        }
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!("Target column mapped more than once: {}", mapping.target_column));
        }
        mapped.push((source_index, mapping));
    }
    Ok(mapped)
}

fn compile_import_plan(
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
) -> Result<CompiledImportPlan, String> {
    let mapped = mapping_indexes_for_columns(columns, mappings)?;
    let mapped_source_indexes = mapped.iter().map(|(source_index, _)| *source_index).collect::<Vec<_>>();
    let target_columns = mapped.into_iter().map(|(_, target)| target).collect::<Vec<_>>();
    let column_types = target_columns
        .iter()
        .map(|column| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(column))
                .map(|(_, data_type)| data_type.clone())
        })
        .collect::<Vec<_>>();
    Ok(CompiledImportPlan { mapped_source_indexes, target_columns, column_types })
}

pub fn build_import_insert_batch_from_rows(
    rows: &[Vec<serde_json::Value>],
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> Result<Option<ImportSqlBatch>, String> {
    build_import_insert_batch_from_rows_with_format(
        rows,
        columns,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_import_insert_batch_from_rows_with_format(
    rows: &[Vec<serde_json::Value>],
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    date_time_format: Option<&str>,
) -> Result<Option<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(None);
    }

    let plan = compile_import_plan(columns, mappings, target_column_types)?;
    build_import_insert_batch_with_plan(rows, &plan, table, schema, db_type, false, date_time_format)
}

fn build_import_insert_batch_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
) -> Result<Option<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(None);
    }
    let mapped_rows = map_import_rows_with_plan(rows, plan, db_type, kingbase_oracle_mode, date_time_format);
    let sql =
        generate_insert_typed(&plan.target_columns, &plan.column_types, &mapped_rows, table, schema, db_type, None);
    Ok((!sql.trim().is_empty()).then_some(ImportSqlBatch { sql, row_count: rows.len() }))
}

fn build_import_insert_batches_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
    hard_sql_bytes: Option<usize>,
) -> Result<Vec<ImportSqlBatch>, String> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mapped_rows = map_import_rows_with_plan(rows, plan, db_type, kingbase_oracle_mode, date_time_format);
    let batches = generate_insert_typed_sql_batches(
        &plan.target_columns,
        &plan.column_types,
        &mapped_rows,
        table,
        schema,
        db_type,
        None,
        SqlBatchLimits::for_database(db_type, rows.len()).with_hard_sql_bytes(hard_sql_bytes),
    )?;
    Ok(batches.into_iter().map(|(sql, row_count)| ImportSqlBatch { sql, row_count }).collect())
}

fn map_import_rows_with_plan(
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
) -> Vec<Vec<serde_json::Value>> {
    rows.iter()
        .map(|row| map_import_row_with_plan(row, plan, db_type, kingbase_oracle_mode, date_time_format))
        .collect()
}

fn map_import_row_with_plan(
    row: &[serde_json::Value],
    plan: &CompiledImportPlan,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
) -> Vec<serde_json::Value> {
    plan.mapped_source_indexes
        .iter()
        .enumerate()
        .map(|(target_index, source_index)| {
            let value = row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null);
            normalize_import_value(
                &value,
                plan.column_types.get(target_index).and_then(|data_type| data_type.as_deref()),
                db_type,
                kingbase_oracle_mode,
                date_time_format,
            )
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_import_execution_batches(
    rows: &[Vec<serde_json::Value>],
    plan: Option<&CompiledImportPlan>,
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
    hard_sql_bytes: Option<usize>,
) -> Result<Vec<ImportSqlBatch>, String> {
    if let Some(plan) = plan {
        return build_import_insert_batches_with_plan(
            rows,
            plan,
            table,
            schema,
            db_type,
            kingbase_oracle_mode,
            date_time_format,
            hard_sql_bytes,
        );
    }

    let plan = compile_import_plan(columns, mappings, target_column_types)?;
    build_import_insert_batches_with_plan(
        rows,
        &plan,
        table,
        schema,
        db_type,
        kingbase_oracle_mode,
        date_time_format,
        hard_sql_bytes,
    )
}

fn effective_import_batch_size(_db_type: &DatabaseType, requested: usize) -> usize {
    // Some backends impose stricter limits than the UI batch setting; clamp here so every
    // import path, including streaming producers, uses the same safe value.
    let max_rows = usize::MAX;
    requested.max(1).min(max_rows)
}

fn normalize_import_temporal_value(
    value: &serde_json::Value,
    data_type: Option<&str>,
    _db_type: &DatabaseType,
    _kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
) -> serde_json::Value {
    crate::temporal_format::normalize_temporal_import_value(value, data_type, date_time_format)
}

fn is_textual_import_target_type(data_type: &str) -> bool {
    let mut lower = data_type.trim().trim_matches('"').to_ascii_lowercase();
    loop {
        let unwrapped = ["nullable", "lowcardinality"].iter().find_map(|wrapper| {
            lower
                .strip_prefix(&format!("{wrapper}("))
                .and_then(|inner| inner.strip_suffix(')'))
                .map(|inner| inner.trim().to_string())
        });
        match unwrapped {
            Some(inner) => lower = inner,
            None => break,
        }
    }
    if lower == "long raw" || lower.starts_with("long raw(") {
        return false;
    }
    let base = lower.split(['(', ':', ' ']).next().unwrap_or("").trim();
    matches!(
        base,
        "char"
            | "character"
            | "varchar"
            | "varchar2"
            | "nvarchar"
            | "nvarchar2"
            | "nchar"
            | "string"
            | "fixedstring"
            | "sysname"
            | "long"
            | "text"
            | "tinytext"
            | "mediumtext"
            | "longtext"
            | "ntext"
            | "clob"
            | "nclob"
            | "enum"
            | "set"
    ) || lower.starts_with("character varying")
}

fn textual_source_columns_for_import(
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
) -> HashSet<String> {
    mappings
        .iter()
        .filter(|mapping| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(&mapping.target_column))
                .map(|(_, data_type)| data_type.as_str())
                .or(mapping.target_data_type.as_deref())
                .is_some_and(is_textual_import_target_type)
        })
        .map(|mapping| mapping.source_column.clone())
        .collect()
}

fn normalize_import_value(
    value: &serde_json::Value,
    data_type: Option<&str>,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
) -> serde_json::Value {
    let normalized = normalize_import_temporal_value(value, data_type, db_type, kingbase_oracle_mode, date_time_format);
    let integer_text =
        normalized.as_str().map(str::to_owned).or_else(|| normalized.as_number().map(ToString::to_string));
    if let Some(integer_text) = integer_text
        .as_deref()
        .and_then(|value| normalize_integer_literal(value, db_type, data_type))
        .and_then(|value| value.parse::<i64>().ok())
    {
        // Normalize before both INSERT and COPY paths; COPY does not pass through SQL literal escaping.
        return serde_json::Value::Number(integer_text.into());
    }
    normalized
}

pub fn build_import_insert_batches(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    batch_size: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    build_import_insert_batches_with_format(
        data,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        false,
        batch_size,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_import_insert_batches_with_format(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    kingbase_oracle_mode: bool,
    batch_size: usize,
    date_time_format: Option<&str>,
) -> Result<Vec<ImportSqlBatch>, String> {
    let plan = compile_import_plan(&data.columns, mappings, target_column_types)?;
    let batch_size = effective_import_batch_size(db_type, batch_size);
    let mut batches = Vec::new();
    for rows in data.rows.chunks(batch_size) {
        batches.extend(build_import_insert_batches_with_plan(
            rows,
            &plan,
            table,
            schema,
            db_type,
            kingbase_oracle_mode,
            date_time_format,
            None,
        )?);
    }
    Ok(batches)
}

pub fn truncate_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let full_table = qualified_table(table, schema, db_type, None);
    format!("TRUNCATE TABLE {full_table}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportInferredType {
    Boolean,
    Integer,
    Decimal,
    Date,
    Timestamp,
    Json,
    Text,
}

fn merge_inferred_type(current: Option<ImportInferredType>, next: ImportInferredType) -> ImportInferredType {
    let Some(current) = current else {
        return next;
    };
    if current == next {
        return current;
    }
    match (current, next) {
        (ImportInferredType::Text, _) | (_, ImportInferredType::Text) => ImportInferredType::Text,
        (ImportInferredType::Integer, ImportInferredType::Decimal)
        | (ImportInferredType::Decimal, ImportInferredType::Integer) => ImportInferredType::Decimal,
        (ImportInferredType::Date, ImportInferredType::Timestamp)
        | (ImportInferredType::Timestamp, ImportInferredType::Date) => ImportInferredType::Timestamp,
        _ => ImportInferredType::Text,
    }
}

fn has_numeric_leading_zero(value: &str) -> bool {
    let unsigned = value.trim_start_matches(['+', '-']);
    let bytes = unsigned.as_bytes();
    bytes.len() > 1 && bytes[0] == b'0' && bytes[1].is_ascii_digit()
}

fn is_likely_date(value: &str) -> bool {
    ["%Y-%m-%d", "%Y/%m/%d"].iter().any(|format| NaiveDate::parse_from_str(value, format).is_ok())
}

fn is_likely_timestamp(value: &str) -> bool {
    if DateTime::parse_from_rfc3339(value).is_ok() {
        return true;
    }
    ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y/%m/%d %H:%M:%S%.f", "%Y/%m/%dT%H:%M:%S%.f"]
        .iter()
        .any(|format| NaiveDateTime::parse_from_str(value, format).is_ok())
}

fn infer_string_type(value: &str) -> ImportInferredType {
    let value = value.trim();
    if value.is_empty() {
        return ImportInferredType::Text;
    }
    if is_likely_timestamp(value) {
        return ImportInferredType::Timestamp;
    }
    if is_likely_date(value) {
        return ImportInferredType::Date;
    }
    if !has_numeric_leading_zero(value) {
        if value.parse::<i64>().is_ok() || value.parse::<u64>().is_ok() {
            return ImportInferredType::Integer;
        }
        if (value.contains('.') || value.contains('e') || value.contains('E'))
            && value.parse::<f64>().is_ok_and(|number| number.is_finite())
        {
            return ImportInferredType::Decimal;
        }
    }
    ImportInferredType::Text
}

fn infer_value_type(value: &serde_json::Value) -> Option<ImportInferredType> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(_) => Some(ImportInferredType::Boolean),
        serde_json::Value::Number(number) => {
            if number.is_i64() || number.is_u64() {
                Some(ImportInferredType::Integer)
            } else {
                Some(ImportInferredType::Decimal)
            }
        }
        serde_json::Value::String(value) => Some(infer_string_type(value)),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => Some(ImportInferredType::Json),
    }
}

fn infer_column_type(rows: &[Vec<serde_json::Value>], source_index: usize) -> ImportInferredType {
    let mut inferred = None;
    for row in rows {
        let Some(value_type) = row.get(source_index).and_then(infer_value_type) else {
            continue;
        };
        inferred = Some(merge_inferred_type(inferred, value_type));
        if inferred == Some(ImportInferredType::Text) {
            break;
        }
    }
    inferred.unwrap_or(ImportInferredType::Text)
}

fn text_data_type(_db_type: &DatabaseType) -> &'static str {
    "TEXT"
}

fn integer_data_type(_db_type: &DatabaseType) -> &'static str {
    "BIGINT"
}

fn decimal_data_type(_db_type: &DatabaseType) -> &'static str {
    "DOUBLE PRECISION"
}

fn boolean_data_type(_db_type: &DatabaseType) -> &'static str {
    "BOOLEAN"
}

fn date_data_type(_db_type: &DatabaseType) -> &'static str {
    "DATE"
}

fn timestamp_data_type(_db_type: &DatabaseType) -> &'static str {
    "TIMESTAMP"
}

fn json_data_type(_db_type: &DatabaseType) -> &'static str {
    "JSONB"
}

fn import_data_type(inferred_type: ImportInferredType, db_type: &DatabaseType) -> String {
    match inferred_type {
        ImportInferredType::Boolean => boolean_data_type(db_type),
        ImportInferredType::Integer => integer_data_type(db_type),
        ImportInferredType::Decimal => decimal_data_type(db_type),
        ImportInferredType::Date => date_data_type(db_type),
        ImportInferredType::Timestamp => timestamp_data_type(db_type),
        ImportInferredType::Json => json_data_type(db_type),
        ImportInferredType::Text => text_data_type(db_type),
    }
    .to_string()
}

fn normalize_import_target_data_type(mapping: &TableImportColumnMapping) -> Result<Option<String>, String> {
    let Some(raw_data_type) = mapping.target_data_type.as_deref() else {
        return Ok(None);
    };
    let data_type = raw_data_type.trim();
    if data_type.is_empty() {
        return Err(format!("Target data type cannot be empty: {}", mapping.target_column));
    }
    validate_import_target_data_type(data_type)?;
    Ok(Some(data_type.to_string()))
}

fn validate_import_target_data_type(data_type: &str) -> Result<(), String> {
    let lowered = data_type.to_ascii_lowercase();
    if data_type.contains(';')
        || lowered.contains("--")
        || lowered.contains("/*")
        || lowered.contains("*/")
        || data_type.chars().any(char::is_control)
    {
        return Err(format!("Unsupported target data type syntax: {data_type}"));
    }

    // A user-entered type is a DDL fragment, so keep it constrained to one type
    // expression and reject separators that could add another column or clause.
    let mut paren_depth = 0usize;
    for ch in data_type.chars() {
        match ch {
            '(' => paren_depth += 1,
            ')' => {
                paren_depth = paren_depth
                    .checked_sub(1)
                    .ok_or_else(|| format!("Unsupported target data type syntax: {data_type}"))?;
            }
            ',' if paren_depth == 0 => {
                return Err(format!("Unsupported target data type syntax: {data_type}"));
            }
            _ => {}
        }
    }
    if paren_depth != 0 {
        return Err(format!("Unsupported target data type syntax: {data_type}"));
    }
    Ok(())
}

pub fn build_import_create_table_plan(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
) -> Result<ImportCreateTablePlan, String> {
    if table.trim().is_empty() {
        return Err("Target table name is required".to_string());
    }
    let mapped = mapping_indexes_with_mappings(&data.columns, mappings)?;
    let mut columns = Vec::with_capacity(mapped.len());
    for (source_index, mapping) in mapped {
        let data_type = match normalize_import_target_data_type(mapping)? {
            Some(data_type) => data_type,
            None => {
                let inferred_type = infer_column_type(&data.rows, source_index);
                import_data_type(inferred_type, db_type)
            }
        };
        columns.push(ImportCreateTableColumn { name: mapping.target_column.clone(), data_type });
    }
    if columns.is_empty() {
        return Err("No columns mapped for import".to_string());
    }

    let full_table = qualified_table(table.trim(), schema, db_type, None);
    let column_sql = columns
        .iter()
        .map(|column| format!("{} {}", quote_identifier(&column.name, db_type), column.data_type))
        .collect::<Vec<_>>()
        .join(",\n  ");
    let engine_clause = if false { " ENGINE = MergeTree() ORDER BY tuple()" } else { "" };
    Ok(ImportCreateTablePlan { sql: format!("CREATE TABLE {full_table} (\n  {column_sql}\n){engine_clause}"), columns })
}

fn import_error_message(request: &TableImportRequest, rows_imported: usize, error: impl AsRef<str>) -> String {
    format!("Import into table '{}' failed after {} imported rows: {}", request.table, rows_imported, error.as_ref())
}

fn import_progress(
    import_id: &str,
    status: TableImportStatus,
    rows_imported: usize,
    total_rows: usize,
    started_at: Instant,
    error: Option<String>,
) -> TableImportProgress {
    let phase = match status {
        TableImportStatus::Running => TableImportPhase::Writing,
        TableImportStatus::Done | TableImportStatus::Error | TableImportStatus::Cancelled => TableImportPhase::Done,
    };
    import_progress_with_details(import_id, status, phase, rows_imported, total_rows, true, 0, 0, started_at, error)
}

#[allow(clippy::too_many_arguments)]
fn import_progress_with_details(
    import_id: &str,
    status: TableImportStatus,
    phase: TableImportPhase,
    rows_imported: usize,
    total_rows: usize,
    total_rows_exact: bool,
    bytes_read: u64,
    total_bytes: u64,
    started_at: Instant,
    error: Option<String>,
) -> TableImportProgress {
    TableImportProgress {
        import_id: import_id.to_string(),
        status,
        phase,
        rows_imported,
        total_rows,
        total_rows_exact,
        bytes_read,
        total_bytes,
        elapsed_ms: started_at.elapsed().as_millis(),
        error,
    }
}

fn import_summary(import_id: &str, rows_imported: usize, total_rows: usize, started_at: Instant) -> TableImportSummary {
    TableImportSummary {
        import_id: import_id.to_string(),
        rows_imported,
        total_rows,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

async fn execute_import_statement(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<crate::db::QueryResult, String> {
    let started_at = Instant::now();
    let result = execute_on_pool(state, pool_key, sql).await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += 1;
    result
}

fn postgres_copy_text_value(value: &serde_json::Value) -> Result<String, String> {
    let raw = match value {
        serde_json::Value::Null => return Ok("\\N".to_string()),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            return Err("PostgreSQL COPY fast path does not support structured values".to_string())
        }
    };
    if raw.contains('\0') {
        return Err("PostgreSQL COPY text format does not support NUL bytes".to_string());
    }
    let mut escaped = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '\t' => escaped.push_str("\\t"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\u{0008}' => escaped.push_str("\\b"),
            '\u{000C}' => escaped.push_str("\\f"),
            '\u{000B}' => escaped.push_str("\\v"),
            _ => escaped.push(ch),
        }
    }
    Ok(escaped)
}

fn postgres_copy_compatible_column_type(data_type: Option<&str>) -> bool {
    let Some(data_type) = data_type else {
        return true;
    };
    let base = data_type.trim().to_ascii_lowercase();
    !base.starts_with("bytea") && !base.starts_with("bit") && !base.starts_with("varbit")
}

#[derive(Debug)]
struct PostgresCopyBatch {
    sql: String,
    data: Vec<u8>,
    row_count: usize,
}

#[derive(Debug)]
struct PostgresCopyAccumulator {
    sql: String,
    data: Vec<u8>,
    row_count: usize,
    target_bytes: usize,
    max_rows: usize,
}

impl PostgresCopyAccumulator {
    fn new(sql: String) -> Self {
        Self::with_limits(sql, POSTGRES_COPY_TARGET_BYTES, POSTGRES_COPY_MAX_ROWS)
    }

    fn with_limits(sql: String, target_bytes: usize, max_rows: usize) -> Self {
        Self {
            sql,
            data: Vec::with_capacity(target_bytes.min(1024 * 1024)),
            row_count: 0,
            target_bytes: target_bytes.max(1),
            max_rows: max_rows.max(1),
        }
    }

    fn should_flush_before(&self, next_row_bytes: usize) -> bool {
        !self.is_empty()
            && (self.data.len().saturating_add(next_row_bytes) > self.target_bytes
                || self.row_count.saturating_add(1) > self.max_rows)
    }

    fn append_row(&mut self, row: &[u8]) {
        self.data.extend_from_slice(row);
        self.row_count += 1;
    }

    fn should_flush_after_append(&self) -> bool {
        !self.is_empty() && (self.data.len() >= self.target_bytes || self.row_count >= self.max_rows)
    }

    fn take_batch(&mut self) -> Option<PostgresCopyBatch> {
        if self.is_empty() {
            return None;
        }
        Some(PostgresCopyBatch {
            sql: self.sql.clone(),
            data: std::mem::take(&mut self.data),
            row_count: std::mem::take(&mut self.row_count),
        })
    }

    fn recycle_batch_buffer(&mut self, mut data: Vec<u8>) {
        data.clear();
        let max_reusable_capacity = self.target_bytes.saturating_mul(2);
        self.data = if data.capacity() <= max_reusable_capacity {
            data
        } else {
            Vec::with_capacity(self.target_bytes.min(1024 * 1024))
        };
    }

    fn is_empty(&self) -> bool {
        self.row_count == 0
    }
}

fn build_postgres_copy_text_row(
    row: &[serde_json::Value],
    plan: &CompiledImportPlan,
    date_time_format: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mapped_row = map_import_row_with_plan(row, plan, &DatabaseType::Postgres, false, date_time_format);
    let mut data = Vec::new();
    for (index, value) in mapped_row.iter().enumerate() {
        if index > 0 {
            data.push(b'\t');
        }
        data.extend_from_slice(postgres_copy_text_value(value)?.as_bytes());
    }
    data.push(b'\n');
    Ok(data)
}

fn postgres_copy_sql(plan: &CompiledImportPlan, table: &str, schema: &str) -> String {
    let table = qualified_table(table, schema, &DatabaseType::Postgres, None);
    let columns = plan
        .target_columns
        .iter()
        .map(|column| quote_identifier(column, &DatabaseType::Postgres))
        .collect::<Vec<_>>()
        .join(", ");
    format!("COPY {table} ({columns}) FROM STDIN WITH (FORMAT text)")
}

async fn execute_postgres_copy_batch(
    state: &AppState,
    pool_key: &str,
    sql: &str,
    data: &[u8],
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<(), String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Err("PostgreSQL pool not found for COPY import".to_string()),
        }
    };
    let started_at = Instant::now();
    let result = crate::db::postgres::copy_in(&pool, sql, data).await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += 1;
    result
}

fn postgres_copy_accumulator_for_plan(
    allowed: bool,
    plan: Option<&CompiledImportPlan>,
    table: &str,
    schema: &str,
) -> Option<PostgresCopyAccumulator> {
    let plan = plan.filter(|plan| {
        allowed && plan.column_types.iter().all(|data_type| postgres_copy_compatible_column_type(data_type.as_deref()))
    })?;
    Some(PostgresCopyAccumulator::new(postgres_copy_sql(plan, table, schema)))
}

async fn flush_postgres_copy_accumulator(
    state: &AppState,
    pool_key: &str,
    accumulator: &mut PostgresCopyAccumulator,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<usize, String> {
    let Some(batch) = accumulator.take_batch() else {
        return Ok(0);
    };
    match execute_postgres_copy_batch(state, pool_key, &batch.sql, &batch.data, db_write_ms, statement_count).await {
        Ok(()) => {
            let row_count = batch.row_count;
            accumulator.recycle_batch_buffer(batch.data);
            Ok(row_count)
        }
        Err(error) => Err(error),
    }
}

async fn flush_pending_postgres_copy(
    state: &AppState,
    pool_key: &str,
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    accumulator: &mut Option<PostgresCopyAccumulator>,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<usize, ImportRowsBatchError> {
    match accumulator.as_mut() {
        Some(accumulator) if !accumulator.is_empty() => {
            ensure_import_write_allowed(import_id, is_cancelled, 0).await?;
            flush_postgres_copy_accumulator(state, pool_key, accumulator, db_write_ms, statement_count)
                .await
                .map_err(ImportRowsBatchError::before_write)
        }
        Some(_) | None => Ok(0),
    }
}

#[allow(clippy::too_many_arguments)]
async fn append_postgres_copy_rows(
    state: &AppState,
    pool_key: &str,
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    rows: &[Vec<serde_json::Value>],
    plan: &CompiledImportPlan,
    date_time_format: Option<&str>,
    accumulator: &mut PostgresCopyAccumulator,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<usize, ImportRowsBatchError> {
    let mut rows_imported = 0usize;
    for row in rows {
        let encoded = build_postgres_copy_text_row(row, plan, date_time_format)
            .map_err(|message| ImportRowsBatchError::with_rows_imported(rows_imported, message))?;
        if accumulator.should_flush_before(encoded.len()) {
            ensure_import_write_allowed(import_id, is_cancelled, rows_imported).await?;
            rows_imported = rows_imported.saturating_add(
                flush_postgres_copy_accumulator(state, pool_key, accumulator, db_write_ms, statement_count)
                    .await
                    .map_err(|message| ImportRowsBatchError::with_rows_imported(rows_imported, message))?,
            );
        }
        accumulator.append_row(&encoded);
        if accumulator.should_flush_after_append() {
            ensure_import_write_allowed(import_id, is_cancelled, rows_imported).await?;
            rows_imported = rows_imported.saturating_add(
                flush_postgres_copy_accumulator(state, pool_key, accumulator, db_write_ms, statement_count)
                    .await
                    .map_err(|message| ImportRowsBatchError::with_rows_imported(rows_imported, message))?,
            );
        }
    }
    Ok(rows_imported)
}

fn postgres_copy_eligibility_sql(table: &str, schema: &str) -> String {
    let table = table.replace('\'', "''");
    let schema_filter = if schema.trim().is_empty() {
        "n.nspname = current_schema()".to_string()
    } else {
        format!("n.nspname = '{}'", schema.replace('\'', "''"))
    };
    format!(
        "SELECT NOT c.relrowsecurity AND NOT c.relhasrules AS copy_eligible \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE {schema_filter} AND c.relname = '{table}' AND c.relkind IN ('r', 'p') \
         LIMIT 1"
    )
}

async fn postgres_copy_fast_path_eligible(state: &AppState, pool_key: &str, table: &str, schema: &str) -> bool {
    let sql = postgres_copy_eligibility_sql(table, schema);
    match execute_on_pool(state, pool_key, &sql).await {
        Ok(result) => result.rows.first().and_then(|row| row.first()).is_some_and(|value| match value {
            serde_json::Value::Bool(value) => *value,
            serde_json::Value::String(value) => {
                matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "t" | "true")
            }
            serde_json::Value::Number(value) => value.as_u64() == Some(1),
            _ => false,
        }),
        Err(error) => {
            log::debug!("PostgreSQL COPY eligibility check failed; using INSERT fallback: {error}");
            false
        }
    }
}

#[derive(Debug)]
struct ImportRowsBatchError {
    rows_imported: usize,
    message: String,
    cancelled: bool,
}

impl ImportRowsBatchError {
    fn before_write(message: impl Into<String>) -> Self {
        Self::with_rows_imported(0, message)
    }

    fn with_rows_imported(rows_imported: usize, message: impl Into<String>) -> Self {
        Self { rows_imported, message: message.into(), cancelled: false }
    }

    fn cancelled(rows_imported: usize) -> Self {
        Self { rows_imported, message: "Import cancelled".to_string(), cancelled: true }
    }
}

async fn ensure_import_write_allowed(
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    rows_imported: usize,
) -> Result<(), ImportRowsBatchError> {
    if is_cancelled(import_id).await {
        Err(ImportRowsBatchError::cancelled(rows_imported))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ImportBatchExecutionPolicy {
    transactional: bool,
    include_truncate: bool,
    allow_postgres_copy: bool,
}

fn supports_transactional_import_truncate(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Postgres)
}

fn supports_import_batch_transactions(_db_type: &DatabaseType) -> bool {
    // These native drivers do not expose a transaction spanning separate requests.
    // Agent-backed JDBC drivers perform their own supportsTransactions check.
    !false
}

fn import_batch_execution_policy(
    mode: &TableImportMode,
    pending_truncate: bool,
    db_type: &DatabaseType,
) -> ImportBatchExecutionPolicy {
    let transactional = matches!(mode, TableImportMode::Truncate) && supports_import_batch_transactions(db_type);
    let include_truncate = transactional && pending_truncate;
    ImportBatchExecutionPolicy {
        transactional,
        include_truncate,
        allow_postgres_copy: *db_type == DatabaseType::Postgres && !include_truncate,
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_import_transaction(
    state: &AppState,
    pool_key: &str,
    connection_id: &str,
    database: &str,
    schema: &str,
    statements: &[String],
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<crate::db::QueryResult, String> {
    let started_at = Instant::now();
    let result = crate::query::execute_statements_in_transaction_on_pool(
        state,
        pool_key,
        connection_id,
        database,
        statements,
        (!schema.trim().is_empty()).then_some(schema),
        None,
    )
    .await;
    *db_write_ms += started_at.elapsed().as_millis();
    *statement_count += statements.len();
    result
}

#[allow(clippy::too_many_arguments)]
async fn execute_import_rows_batch(
    state: &AppState,
    pool_key: &str,
    import_id: &str,
    is_cancelled: &impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    connection_id: &str,
    database: &str,
    rows: &[Vec<serde_json::Value>],
    plan: Option<&CompiledImportPlan>,
    sqlserver_bulk_plan: Option<&SqlServerBulkImportPlan>,
    columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    mode: &TableImportMode,
    pending_truncate: bool,
    postgres_copy_accumulator: &mut Option<PostgresCopyAccumulator>,
    kingbase_oracle_mode: bool,
    date_time_format: Option<&str>,
    hard_sql_bytes: Option<usize>,
    db_write_ms: &mut u128,
    statement_count: &mut usize,
) -> Result<usize, ImportRowsBatchError> {
    let execution_policy = import_batch_execution_policy(mode, pending_truncate, db_type);
    if let Some((_import_plan, _bulk_plan)) = sqlserver_bulk_plans_for_rows(db_type, plan, sqlserver_bulk_plan, rows) {
        return Err(ImportRowsBatchError::before_write("SqlServer bulk import not supported".to_string()));
    }
    // COPY is used only for plain scalar PostgreSQL rows and ordinary tables. Any unsupported
    // value or table feature falls through to the portable INSERT generator below.
    if execution_policy.allow_postgres_copy
        && *db_type == DatabaseType::Postgres
        && !rows
            .iter()
            .flatten()
            .any(|value| matches!(value, serde_json::Value::Array(_) | serde_json::Value::Object(_)))
    {
        if let (Some(plan), Some(accumulator)) = (plan, postgres_copy_accumulator.as_mut()) {
            return append_postgres_copy_rows(
                state,
                pool_key,
                import_id,
                is_cancelled,
                rows,
                plan,
                date_time_format,
                accumulator,
                db_write_ms,
                statement_count,
            )
            .await;
        }
    }
    let mut rows_imported = flush_pending_postgres_copy(
        state,
        pool_key,
        import_id,
        is_cancelled,
        postgres_copy_accumulator,
        db_write_ms,
        statement_count,
    )
    .await?;
    let batches = build_import_execution_batches(
        rows,
        plan,
        columns,
        mappings,
        target_column_types,
        table,
        schema,
        db_type,
        kingbase_oracle_mode,
        date_time_format,
        hard_sql_bytes,
    )
    .map_err(|message| ImportRowsBatchError::with_rows_imported(rows_imported, message))?;
    if execution_policy.transactional {
        ensure_import_write_allowed(import_id, is_cancelled, rows_imported).await?;
        let mut statements = Vec::with_capacity(batches.len() + usize::from(execution_policy.include_truncate));
        if execution_policy.include_truncate {
            statements.push(truncate_sql(table, schema, db_type));
        }
        statements.extend(batches.into_iter().map(|batch| batch.sql));
        execute_import_transaction(
            state,
            pool_key,
            connection_id,
            database,
            schema,
            &statements,
            db_write_ms,
            statement_count,
        )
        .await
        .map_err(|message| ImportRowsBatchError::with_rows_imported(rows_imported, message))?;
        return Ok(rows_imported.saturating_add(rows.len()));
    }
    for batch in batches {
        ensure_import_write_allowed(import_id, is_cancelled, rows_imported).await?;
        if let Err(error) = execute_import_statement(state, pool_key, &batch.sql, db_write_ms, statement_count).await {
            return Err(ImportRowsBatchError::with_rows_imported(rows_imported, error));
        }
        rows_imported = rows_imported.saturating_add(batch.row_count);
    }
    Ok(rows_imported)
}

fn log_import_metrics(
    request: &TableImportRequest,
    source_format: TableImportSourceFormat,
    rows_imported: usize,
    started_at: Instant,
    db_write_ms: u128,
    statement_count: usize,
) {
    let elapsed_ms = started_at.elapsed().as_millis();
    let non_db_ms = elapsed_ms.saturating_sub(db_write_ms);
    let rows_per_second =
        if elapsed_ms == 0 { rows_imported as f64 } else { rows_imported as f64 * 1000.0 / elapsed_ms as f64 };
    log::info!(
        "[table-import:done] import_id={} format={} rows={} elapsed_ms={} db_write_ms={} non_db_ms={} statements={} rows_per_second={:.1}",
        request.import_id,
        source_format.label(),
        rows_imported,
        elapsed_ms,
        db_write_ms,
        non_db_ms,
        statement_count,
        rows_per_second,
    );
}

fn emit_import_error<F>(
    progress_callback: &mut F,
    request: &TableImportRequest,
    rows_imported: usize,
    total_rows: usize,
    started_at: Instant,
    error: impl AsRef<str>,
) -> String
where
    F: FnMut(TableImportProgress),
{
    let message = import_error_message(request, rows_imported, error);
    progress_callback(import_progress(
        &request.import_id,
        TableImportStatus::Error,
        rows_imported,
        total_rows,
        started_at,
        Some(message.clone()),
    ));
    message
}

fn delimited_record_to_row(
    record: &csv::StringRecord,
    columns_len: usize,
    config: DelimitedParseConfig,
) -> Vec<serde_json::Value> {
    (0..columns_len)
        .map(|index| {
            record.get(index).map(|value| csv_value_with_config(value, config)).unwrap_or(serde_json::Value::Null)
        })
        .collect()
}

fn delimited_columns_and_first_record<R: std::io::Read>(
    reader: &mut csv::Reader<R>,
    config: DelimitedParseConfig,
) -> Result<(Vec<String>, Option<csv::StringRecord>), String> {
    let mut columns = Vec::new();
    for (index, record) in reader.records().enumerate() {
        let record = record.map_err(|e| e.to_string())?;
        let row_number = index + 1;
        if config.row_range.title_row == Some(row_number) {
            columns = unique_import_headers(
                record
                    .iter()
                    .enumerate()
                    .map(|(index, header)| normalize_header(header.trim_start_matches('\u{feff}'), index)),
            );
            continue;
        }
        if row_number < config.row_range.data_start_row {
            continue;
        }
        if config.row_range.last_data_row.is_some_and(|last| row_number > last) {
            break;
        }
        if columns.is_empty() {
            columns = (0..record.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        return Ok((columns, Some(record)));
    }
    Err("Import file has no data rows in the selected row range".to_string())
}

#[derive(Debug)]
enum DelimitedStreamMessage {
    Header(Vec<String>),
    Rows { rows: Vec<Vec<serde_json::Value>>, bytes_read: u64 },
    Done,
}

fn stream_delimited_rows_to_channel(
    path: &str,
    source_format: TableImportSourceFormat,
    options: &TableImportParseOptions,
    batch_size: usize,
    sender: tokio::sync::mpsc::Sender<Result<DelimitedStreamMessage, String>>,
) -> Result<(), String> {
    // Keep CSV parsing off the async executor while the bounded channel prevents unbounded
    // accumulation when the database consumer is under load.
    let (mut reader, config, _) = open_delimited_csv_reader_with_progress(path, source_format, options, |_| {})?;
    let (columns, first_record) = delimited_columns_and_first_record(&mut reader, config)?;
    sender
        .blocking_send(Ok(DelimitedStreamMessage::Header(columns.clone())))
        .map_err(|_| "Delimited import consumer closed before the stream started".to_string())?;

    let batch_size = batch_size.max(1);
    let mut pending_rows = Vec::with_capacity(batch_size);
    let mut next_record = first_record;
    let mut source_row_number = config.row_range.data_start_row.saturating_sub(1);
    loop {
        let record = if let Some(record) = next_record.take() {
            record
        } else {
            let mut record = csv::StringRecord::new();
            if !reader.read_record(&mut record).map_err(|error| error.to_string())? {
                break;
            }
            record
        };
        source_row_number = source_row_number.saturating_add(1);
        if config.row_range.last_data_row.is_some_and(|last| source_row_number > last) {
            break;
        }
        pending_rows.push(delimited_record_to_row(&record, columns.len(), config));
        if pending_rows.len() >= batch_size {
            sender
                .blocking_send(Ok(DelimitedStreamMessage::Rows {
                    rows: std::mem::take(&mut pending_rows),
                    bytes_read: reader.get_ref().source_bytes_read(),
                }))
                .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
            pending_rows = Vec::with_capacity(batch_size);
        }
    }
    if !pending_rows.is_empty() {
        sender
            .blocking_send(Ok(DelimitedStreamMessage::Rows {
                rows: pending_rows,
                bytes_read: reader.get_ref().source_bytes_read(),
            }))
            .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
    }
    sender
        .blocking_send(Ok(DelimitedStreamMessage::Done))
        .map_err(|_| "Delimited import consumer closed before the stream finished".to_string())?;
    Ok(())
}

fn import_source_fingerprint(
    path: &str,
    format: TableImportSourceFormat,
    options: &TableImportParseOptions,
) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical_path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_nanos.to_le_bytes());
    hasher.update(format.label().as_bytes());
    hasher.update(serde_json::to_vec(options).map_err(|error| error.to_string())?);
    Ok(format!("{:x}", hasher.finalize()))
}

fn validated_prepared_import_source(
    request: &TableImportRequest,
    format: TableImportSourceFormat,
) -> Option<ParsedImportFile> {
    let prepared = request.prepared_source.as_ref()?;
    if prepared.columns.is_empty() || prepared.total_rows == 0 {
        return None;
    }
    // Preview rows are reusable only while the source metadata and all parse options still match.
    let fingerprint = import_source_fingerprint(&request.file_path, format, &request.parse_options).ok()?;
    if fingerprint != prepared.fingerprint {
        return None;
    }
    Some(ParsedImportFile {
        columns: prepared.columns.clone(),
        rows: prepared.rows.clone(),
        total_rows: prepared.total_rows,
        effective_encoding: prepared.effective_encoding,
    })
}

pub async fn preview_table_import_file_with_request(
    request: TableImportPreviewRequest,
) -> Result<TableImportPreview, String> {
    let format = effective_source_format(&request.file_path, request.source_format)?;
    let (parsed, total_rows_exact, sheets) = parse_import_preview_file_with_options(
        &request.file_path,
        format,
        &request.parse_options,
        request.preview_limit.unwrap_or(DEFAULT_PREVIEW_LIMIT),
    )
    .await?;
    let metadata = tokio::fs::metadata(&request.file_path).await.map_err(|e| e.to_string())?;
    let source_fingerprint = import_source_fingerprint(&request.file_path, format, &request.parse_options)?;
    let file_name = Path::new(&request.file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&request.file_path)
        .to_string();
    Ok(TableImportPreview {
        file_name,
        file_path: request.file_path,
        source_ref: request.source_ref,
        file_type: format.label().to_string(),
        size_bytes: metadata.len(),
        columns: parsed.columns,
        rows: parsed.rows,
        total_rows: parsed.total_rows,
        total_rows_exact,
        source_fingerprint,
        effective_encoding: parsed.effective_encoding,
        sheets,
    })
}

pub async fn preview_table_import_file_core(file_path: &str) -> Result<TableImportPreview, String> {
    preview_table_import_file_with_request(TableImportPreviewRequest {
        file_path: file_path.to_string(),
        source_ref: None,
        source_format: None,
        parse_options: TableImportParseOptions::default(),
        preview_limit: Some(DEFAULT_PREVIEW_LIMIT),
    })
    .await
}

async fn kingbase_oracle_compatibility_mode(_state: &AppState, _pool_key: &str, _db_type: &DatabaseType) -> bool {
    false
}

async fn mysql_import_sql_hard_limit(_state: &AppState, _pool_key: &str) -> Option<usize> {
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerBulkImportPlan;

async fn sqlserver_bulk_import_plan_for_pool(
    _state: &AppState,
    _pool_key: &str,
    _db_type: &DatabaseType,
    _import_plan: Option<&CompiledImportPlan>,
    _table: &str,
    _schema: &str,
) -> Option<SqlServerBulkImportPlan> {
    None
}

fn sqlserver_bulk_plans_for_rows<'a>(
    _db_type: &DatabaseType,
    _import_plan: Option<&'a CompiledImportPlan>,
    _bulk_plan: Option<&'a SqlServerBulkImportPlan>,
    _rows: &[Vec<serde_json::Value>],
) -> Option<(&'a CompiledImportPlan, &'a SqlServerBulkImportPlan)> {
    None
}

pub async fn import_table_file_core<F>(
    state: &AppState,
    request: &TableImportRequest,
    db_type: &DatabaseType,
    pool_key: &str,
    is_cancelled: impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    mut progress_callback: F,
) -> Result<TableImportSummary, String>
where
    F: FnMut(TableImportProgress),
{
    let started_at = Instant::now();
    let mut db_write_ms = 0u128;
    let mut statement_count = 0usize;
    let batch_size = if request.batch_size == 0 { DEFAULT_BATCH_SIZE } else { request.batch_size };
    let kingbase_oracle_mode = kingbase_oracle_compatibility_mode(state, pool_key, db_type).await;
    let source_format = match effective_source_format(&request.file_path, request.source_format) {
        Ok(format) => format,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
    };

    if let Err(error) = tokio::fs::metadata(&request.file_path).await {
        return Err(emit_import_error(
            &mut progress_callback,
            request,
            0,
            0,
            started_at,
            format!("Import source is no longer available: {error}"),
        ));
    }
    let import_sql_hard_limit = mysql_import_sql_hard_limit(state, pool_key).await;
    let prepared_source = validated_prepared_import_source(request, source_format);
    let prepared_source_total_exact =
        prepared_source.is_some() && request.prepared_source.as_ref().is_some_and(|prepared| prepared.total_rows_exact);

    // Validate the entire text source before writing so a malformed tail cannot leave partial batches behind.
    let validated_text_encoding = if source_format.is_delimited() {
        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::DetectingEncoding,
            0,
            0,
            false,
            0,
            total_bytes,
            started_at,
            None,
        ));
        let mut last_encoding_progress_emit = Instant::now() - IMPORT_PROGRESS_INTERVAL;
        let path = request.file_path.clone();
        let requested_encoding = request.parse_options.encoding;
        let (encoding_progress_sender, mut encoding_progress_receiver) = tokio::sync::mpsc::channel(16);
        let validation = tokio::task::spawn_blocking(move || {
            let mut last_progress_send = Instant::now() - IMPORT_PROGRESS_INTERVAL;
            resolve_and_validate_text_encoding_from_file(&path, requested_encoding, |bytes_read| {
                if last_progress_send.elapsed() >= IMPORT_PROGRESS_INTERVAL
                    || (total_bytes > 0 && bytes_read >= total_bytes)
                {
                    let _ = encoding_progress_sender.blocking_send(bytes_read);
                    last_progress_send = Instant::now();
                }
            })
        });
        while let Some(bytes_read) = encoding_progress_receiver.recv().await {
            if last_encoding_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL
                || (total_bytes > 0 && bytes_read >= total_bytes)
            {
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Running,
                    TableImportPhase::DetectingEncoding,
                    0,
                    0,
                    false,
                    bytes_read.min(total_bytes),
                    total_bytes,
                    started_at,
                    None,
                ));
                last_encoding_progress_emit = Instant::now();
            }
        }
        let validation = match validation.await {
            Ok(validation) => validation,
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error.to_string()));
            }
        };
        match validation {
            Ok(resolved) => Some(resolved),
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        }
    } else {
        None
    };
    let mut import_parse_options = request.parse_options.clone();
    if let Some((encoding, _)) = validated_text_encoding {
        import_parse_options.encoding = Some(encoding);
    }

    let mut create_table_sample: Option<ParsedImportFile> = None;
    let mut created_column_types: Option<Vec<(String, String)>> = None;
    if request.create_table {
        if matches!(request.mode, TableImportMode::Truncate) {
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                0,
                started_at,
                "Cannot truncate a table that is being created by the import",
            ));
        }
        let required_sample_rows = if prepared_source_total_exact {
            prepared_source
                .as_ref()
                .map(|prepared| prepared.total_rows.min(CREATE_TABLE_INFERENCE_ROWS))
                .unwrap_or(CREATE_TABLE_INFERENCE_ROWS)
        } else {
            CREATE_TABLE_INFERENCE_ROWS
        };
        let parsed = if let Some(prepared) =
            prepared_source.as_ref().filter(|prepared| prepared.rows.len() >= required_sample_rows).cloned()
        {
            prepared
        } else {
            match parse_import_preview_file_with_options(
                &request.file_path,
                source_format,
                &import_parse_options,
                CREATE_TABLE_INFERENCE_ROWS,
            )
            .await
            {
                Ok((parsed, _, _)) => parsed,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        let total_rows = parsed.total_rows;
        let plan = match build_import_create_table_plan(
            &parsed,
            &request.mappings,
            &request.table,
            &request.schema,
            db_type,
        ) {
            Ok(plan) => plan,
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        };
        // The table must be created before streaming rows so existing import batching
        // can reuse the same INSERT path and database-specific value escaping.
        if let Err(error) =
            execute_import_statement(state, pool_key, &plan.sql, &mut db_write_ms, &mut statement_count).await
        {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
        created_column_types =
            Some(plan.columns.iter().map(|column| (column.name.clone(), column.data_type.clone())).collect());
        create_table_sample = Some(parsed);
    }

    if source_format.is_delimited() {
        let parsed = if let Some(parsed) = create_table_sample.clone().or_else(|| prepared_source.clone()) {
            parsed
        } else {
            match parse_import_preview_file_with_options(&request.file_path, source_format, &import_parse_options, 1)
                .await
            {
                Ok((parsed, _, _)) => parsed,
                Err(error) => {
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        let known_total_rows = prepared_source_total_exact.then_some(parsed.total_rows);
        let progress_total_rows = known_total_rows.unwrap_or_default();
        let total_rows = progress_total_rows;
        let total_rows_exact = known_total_rows.is_some();
        if let Err(error) = mapping_indexes_for_columns(&parsed.columns, &request.mappings) {
            return Err(emit_import_error(&mut progress_callback, request, 0, progress_total_rows, started_at, error));
        }

        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);

        let mut target_column_types = get_columns_for_transfer(
            state,
            pool_key,
            &request.connection_id,
            &request.database,
            &request.schema,
            &request.table,
            None,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|column| (column.name, column.data_type))
        .collect::<Vec<_>>();
        if target_column_types.is_empty() {
            target_column_types = created_column_types.clone().unwrap_or_default();
        }
        let (resolved_encoding, _) =
            validated_text_encoding.ok_or_else(|| "Delimited import encoding was not validated".to_string())?;
        let mut streaming_options = import_parse_options.clone();
        streaming_options.encoding = Some(resolved_encoding);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::Reading,
            0,
            progress_total_rows,
            known_total_rows.is_some(),
            0,
            total_bytes,
            started_at,
            None,
        ));
        let effective_batch_size = effective_import_batch_size(db_type, batch_size);
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<DelimitedStreamMessage, String>>(2);
        let path = request.file_path.clone();
        let producer_options = streaming_options.clone();
        let producer = tokio::task::spawn_blocking(move || {
            stream_delimited_rows_to_channel(&path, source_format, &producer_options, effective_batch_size, sender)
        });
        let columns = match receiver.recv().await {
            Some(Ok(DelimitedStreamMessage::Header(columns))) => columns,
            Some(Ok(_)) => {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    0,
                    total_rows,
                    started_at,
                    "Delimited stream did not provide a header before data rows",
                ));
            }
            Some(Err(error)) => {
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
            None => {
                let error = producer
                    .await
                    .map_err(|error| error.to_string())?
                    .err()
                    .unwrap_or_else(|| "Delimited stream ended before providing a header".to_string());
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        };
        if columns.is_empty() {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                total_rows,
                started_at,
                "Import file has no columns in the selected row range",
            ));
        }
        if let Err(error) = mapping_indexes_for_columns(&columns, &request.mappings) {
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
        let compiled_plan = if false {
            None
        } else {
            match compile_import_plan(&columns, &request.mappings, &target_column_types) {
                Ok(plan) => Some(plan),
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
                }
            }
        };
        let sqlserver_bulk_plan = sqlserver_bulk_import_plan_for_pool(
            state,
            pool_key,
            db_type,
            compiled_plan.as_ref(),
            &request.table,
            &request.schema,
        )
        .await;
        let allow_postgres_copy = *db_type == DatabaseType::Postgres
            && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;
        let mut postgres_copy_accumulator = postgres_copy_accumulator_for_plan(
            allow_postgres_copy,
            compiled_plan.as_ref(),
            &request.table,
            &request.schema,
        );
        let mut pending_truncate =
            matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
        if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
            let sql = truncate_sql(&request.table, &request.schema, db_type);
            if let Err(error) =
                execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
            {
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        }
        let mut rows_imported = 0usize;
        let mut last_bytes_read = 0u64;
        let mut last_progress_emit = Instant::now();
        loop {
            let message = match receiver.recv().await {
                Some(message) => message,
                None => break,
            };
            match message {
                Ok(DelimitedStreamMessage::Header(_)) => {}
                Ok(DelimitedStreamMessage::Rows { rows, bytes_read }) => {
                    last_bytes_read = last_bytes_read.max(bytes_read);
                    if is_cancelled(&request.import_id).await {
                        drop(receiver);
                        let _ = producer.await;
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Cancelled,
                            TableImportPhase::Done,
                            rows_imported,
                            total_rows,
                            total_rows_exact,
                            last_bytes_read.min(total_bytes),
                            total_bytes,
                            started_at,
                            None,
                        ));
                        return Err("Import cancelled".to_string());
                    }
                    let row_count = match execute_import_rows_batch(
                        state,
                        pool_key,
                        &request.import_id,
                        &is_cancelled,
                        &request.connection_id,
                        &request.database,
                        &rows,
                        compiled_plan.as_ref(),
                        sqlserver_bulk_plan.as_ref(),
                        &columns,
                        &request.mappings,
                        &target_column_types,
                        &request.table,
                        &request.schema,
                        db_type,
                        &request.mode,
                        pending_truncate,
                        &mut postgres_copy_accumulator,
                        kingbase_oracle_mode,
                        request.date_time_format.as_deref(),
                        import_sql_hard_limit,
                        &mut db_write_ms,
                        &mut statement_count,
                    )
                    .await
                    {
                        Ok(row_count) => row_count,
                        Err(error) => {
                            drop(receiver);
                            let _ = producer.await;
                            rows_imported = rows_imported.saturating_add(error.rows_imported);
                            if error.cancelled {
                                progress_callback(import_progress_with_details(
                                    &request.import_id,
                                    TableImportStatus::Cancelled,
                                    TableImportPhase::Done,
                                    rows_imported,
                                    total_rows,
                                    total_rows_exact,
                                    last_bytes_read.min(total_bytes),
                                    total_bytes,
                                    started_at,
                                    None,
                                ));
                                return Err(error.message);
                            }
                            return Err(emit_import_error(
                                &mut progress_callback,
                                request,
                                rows_imported,
                                total_rows,
                                started_at,
                                error.message,
                            ));
                        }
                    };
                    rows_imported = rows_imported.saturating_add(row_count);
                    pending_truncate = false;
                    if let Some(known_total_rows) = known_total_rows {
                        rows_imported = rows_imported.min(known_total_rows);
                    }
                    if last_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL {
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Running,
                            TableImportPhase::Writing,
                            rows_imported,
                            total_rows,
                            total_rows_exact,
                            last_bytes_read.min(total_bytes),
                            total_bytes,
                            started_at,
                            None,
                        ));
                        last_progress_emit = Instant::now();
                    }
                }
                Ok(DelimitedStreamMessage::Done) => break,
                Err(error) => {
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        rows_imported,
                        total_rows,
                        started_at,
                        error,
                    ));
                }
            }
        }
        match producer.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error,
                ));
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error.to_string(),
                ));
            }
        }
        let flushed_rows = match flush_pending_postgres_copy(
            state,
            pool_key,
            &request.import_id,
            &is_cancelled,
            &mut postgres_copy_accumulator,
            &mut db_write_ms,
            &mut statement_count,
        )
        .await
        {
            Ok(rows) => rows,
            Err(error) if error.cancelled => {
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Cancelled,
                    TableImportPhase::Done,
                    rows_imported,
                    total_rows,
                    total_rows_exact,
                    last_bytes_read.min(total_bytes),
                    total_bytes,
                    started_at,
                    None,
                ));
                return Err(error.message);
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error.message,
                ));
            }
        };
        rows_imported = rows_imported.saturating_add(flushed_rows);
        if let Some(known_total_rows) = known_total_rows {
            rows_imported = rows_imported.min(known_total_rows);
        }

        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Done,
            TableImportPhase::Done,
            rows_imported,
            rows_imported,
            true,
            total_bytes,
            total_bytes,
            started_at,
            None,
        ));
        log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);

        return Ok(import_summary(&request.import_id, rows_imported, rows_imported, started_at));
    }

    let extension =
        Path::new(&request.file_path).extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    if source_format == TableImportSourceFormat::Excel
        && (extension.eq_ignore_ascii_case("xlsx") || extension.eq_ignore_ascii_case("xlsm"))
    {
        let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Running,
            TableImportPhase::Reading,
            0,
            0,
            false,
            0,
            total_bytes,
            started_at,
            None,
        ));
        let effective_batch_size = effective_import_batch_size(db_type, batch_size);
        let expected_columns =
            create_table_sample.as_ref().or(prepared_source.as_ref()).map(|source| source.columns.clone());
        let mut target_column_types = get_columns_for_transfer(
            state,
            pool_key,
            &request.connection_id,
            &request.database,
            &request.schema,
            &request.table,
            None,
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|column| (column.name, column.data_type))
        .collect::<Vec<_>>();
        if target_column_types.is_empty() {
            target_column_types = created_column_types.clone().unwrap_or_default();
        }
        let text_source_columns = textual_source_columns_for_import(&request.mappings, &target_column_types);
        // No truncate, INSERT, or COPY may run until the selected worksheet parses to EOF.
        let mut last_xlsx_read_bytes = 0u64;
        let validated_columns = match validate_xlsx_worksheet_for_import(
            request.file_path.clone(),
            request.parse_options.clone(),
            expected_columns.clone(),
            text_source_columns.clone(),
            &request.import_id,
            &is_cancelled,
            |bytes_read| {
                last_xlsx_read_bytes =
                    last_xlsx_read_bytes.max(xlsx_import_pass_progress(bytes_read, total_bytes, false));
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Running,
                    TableImportPhase::Reading,
                    0,
                    0,
                    false,
                    last_xlsx_read_bytes,
                    total_bytes,
                    started_at,
                    None,
                ));
            },
        )
        .await
        {
            Ok(columns) => columns,
            Err(error) if error == "Import cancelled" => {
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Cancelled,
                    TableImportPhase::Done,
                    0,
                    0,
                    false,
                    last_xlsx_read_bytes,
                    total_bytes,
                    started_at,
                    None,
                ));
                return Err(error);
            }
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        };
        let expected_columns = Some(validated_columns);
        // Full-sheet validation can take long enough for the user to cancel. Recheck before
        // starting the producer or executing a non-transactional truncate.
        if is_cancelled(&request.import_id).await {
            progress_callback(import_progress_with_details(
                &request.import_id,
                TableImportStatus::Cancelled,
                TableImportPhase::Done,
                0,
                0,
                false,
                last_xlsx_read_bytes,
                total_bytes,
                started_at,
                None,
            ));
            return Err("Import cancelled".to_string());
        }
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Result<XlsxStreamMessage, String>>(2);
        let producer_cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_producer = producer_cancelled.clone();
        let path = request.file_path.clone();
        let options = request.parse_options.clone();
        let producer = tokio::task::spawn_blocking(move || {
            stream_xlsx_rows_to_channel_with_control(
                &path,
                &options,
                effective_batch_size,
                expected_columns,
                text_source_columns,
                false,
                sender,
                cancelled_for_producer,
            )
        });
        let columns = loop {
            let message = match receive_xlsx_stream_message(
                &mut receiver,
                &request.import_id,
                &is_cancelled,
                &producer_cancelled,
            )
            .await
            {
                Ok(Some(message)) => message,
                Ok(None) => {
                    let error = producer
                        .await
                        .map_err(|error| error.to_string())?
                        .err()
                        .unwrap_or_else(|| "Excel stream ended before providing a header".to_string());
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
                Err(()) => {
                    drop(receiver);
                    let _ = producer.await;
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Cancelled,
                        TableImportPhase::Done,
                        0,
                        0,
                        false,
                        last_xlsx_read_bytes,
                        total_bytes,
                        started_at,
                        None,
                    ));
                    return Err("Import cancelled".to_string());
                }
            };
            match message {
                Ok(XlsxStreamMessage::Header(columns)) => break columns,
                Ok(XlsxStreamMessage::Progress(bytes_read)) => {
                    last_xlsx_read_bytes =
                        last_xlsx_read_bytes.max(xlsx_import_pass_progress(bytes_read, total_bytes, true));
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Running,
                        TableImportPhase::Reading,
                        0,
                        0,
                        false,
                        last_xlsx_read_bytes,
                        total_bytes,
                        started_at,
                        None,
                    ));
                }
                Ok(_) => {
                    producer_cancelled.store(true, Ordering::Release);
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        0,
                        0,
                        started_at,
                        "Excel stream did not provide a header before data rows",
                    ));
                }
                Err(error) => {
                    producer_cancelled.store(true, Ordering::Release);
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        if columns.is_empty() {
            producer_cancelled.store(true, Ordering::Release);
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                0,
                0,
                started_at,
                "Import file has no columns in the selected row range",
            ));
        }
        if let Err(error) = mapping_indexes_for_columns(&columns, &request.mappings) {
            producer_cancelled.store(true, Ordering::Release);
            drop(receiver);
            let _ = producer.await;
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
        let compiled_plan = if false {
            None
        } else {
            match compile_import_plan(&columns, &request.mappings, &target_column_types) {
                Ok(plan) => Some(plan),
                Err(error) => {
                    producer_cancelled.store(true, Ordering::Release);
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
                }
            }
        };
        let sqlserver_bulk_plan = sqlserver_bulk_import_plan_for_pool(
            state,
            pool_key,
            db_type,
            compiled_plan.as_ref(),
            &request.table,
            &request.schema,
        )
        .await;
        let allow_postgres_copy = *db_type == DatabaseType::Postgres
            && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;
        let mut postgres_copy_accumulator = postgres_copy_accumulator_for_plan(
            allow_postgres_copy,
            compiled_plan.as_ref(),
            &request.table,
            &request.schema,
        );
        let mut pending_truncate =
            matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
        if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
            let sql = truncate_sql(&request.table, &request.schema, db_type);
            if let Err(error) =
                execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
            {
                producer_cancelled.store(true, Ordering::Release);
                drop(receiver);
                let _ = producer.await;
                return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
            }
        }
        let mut rows_imported = 0usize;
        loop {
            let message = match receive_xlsx_stream_message(
                &mut receiver,
                &request.import_id,
                &is_cancelled,
                &producer_cancelled,
            )
            .await
            {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(()) => {
                    drop(receiver);
                    let _ = producer.await;
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Cancelled,
                        TableImportPhase::Done,
                        rows_imported,
                        0,
                        false,
                        last_xlsx_read_bytes,
                        total_bytes,
                        started_at,
                        None,
                    ));
                    return Err("Import cancelled".to_string());
                }
            };
            match message {
                Ok(XlsxStreamMessage::Header(_)) => {}
                Ok(XlsxStreamMessage::Rows(rows)) => {
                    if is_cancelled(&request.import_id).await {
                        producer_cancelled.store(true, Ordering::Release);
                        drop(receiver);
                        let _ = producer.await;
                        progress_callback(import_progress_with_details(
                            &request.import_id,
                            TableImportStatus::Cancelled,
                            TableImportPhase::Done,
                            rows_imported,
                            0,
                            false,
                            last_xlsx_read_bytes,
                            total_bytes,
                            started_at,
                            None,
                        ));
                        return Err("Import cancelled".to_string());
                    }
                    let row_count = match execute_import_rows_batch(
                        state,
                        pool_key,
                        &request.import_id,
                        &is_cancelled,
                        &request.connection_id,
                        &request.database,
                        &rows,
                        compiled_plan.as_ref(),
                        sqlserver_bulk_plan.as_ref(),
                        &columns,
                        &request.mappings,
                        &target_column_types,
                        &request.table,
                        &request.schema,
                        db_type,
                        &request.mode,
                        pending_truncate,
                        &mut postgres_copy_accumulator,
                        kingbase_oracle_mode,
                        request.date_time_format.as_deref(),
                        import_sql_hard_limit,
                        &mut db_write_ms,
                        &mut statement_count,
                    )
                    .await
                    {
                        Ok(row_count) => row_count,
                        Err(error) => {
                            producer_cancelled.store(true, Ordering::Release);
                            drop(receiver);
                            let _ = producer.await;
                            rows_imported = rows_imported.saturating_add(error.rows_imported);
                            if error.cancelled {
                                progress_callback(import_progress_with_details(
                                    &request.import_id,
                                    TableImportStatus::Cancelled,
                                    TableImportPhase::Done,
                                    rows_imported,
                                    0,
                                    false,
                                    0,
                                    total_bytes,
                                    started_at,
                                    None,
                                ));
                                return Err(error.message);
                            }
                            return Err(emit_import_error(
                                &mut progress_callback,
                                request,
                                rows_imported,
                                0,
                                started_at,
                                error.message,
                            ));
                        }
                    };
                    rows_imported = rows_imported.saturating_add(row_count);
                    pending_truncate = false;
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Running,
                        TableImportPhase::Writing,
                        rows_imported,
                        0,
                        false,
                        0,
                        total_bytes,
                        started_at,
                        None,
                    ));
                }
                Ok(XlsxStreamMessage::Progress(bytes_read)) => {
                    last_xlsx_read_bytes =
                        last_xlsx_read_bytes.max(xlsx_import_pass_progress(bytes_read, total_bytes, true));
                    progress_callback(import_progress_with_details(
                        &request.import_id,
                        TableImportStatus::Running,
                        TableImportPhase::Writing,
                        rows_imported,
                        0,
                        false,
                        last_xlsx_read_bytes,
                        total_bytes,
                        started_at,
                        None,
                    ));
                }
                Ok(XlsxStreamMessage::Done) => break,
                Err(error) => {
                    producer_cancelled.store(true, Ordering::Release);
                    drop(receiver);
                    let _ = producer.await;
                    return Err(emit_import_error(
                        &mut progress_callback,
                        request,
                        rows_imported,
                        0,
                        started_at,
                        error,
                    ));
                }
            }
        }
        match producer.await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                return Err(emit_import_error(&mut progress_callback, request, rows_imported, 0, started_at, error));
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    0,
                    started_at,
                    error.to_string(),
                ));
            }
        }
        let flushed_rows = match flush_pending_postgres_copy(
            state,
            pool_key,
            &request.import_id,
            &is_cancelled,
            &mut postgres_copy_accumulator,
            &mut db_write_ms,
            &mut statement_count,
        )
        .await
        {
            Ok(rows) => rows,
            Err(error) if error.cancelled => {
                progress_callback(import_progress_with_details(
                    &request.import_id,
                    TableImportStatus::Cancelled,
                    TableImportPhase::Done,
                    rows_imported,
                    0,
                    false,
                    total_bytes,
                    total_bytes,
                    started_at,
                    None,
                ));
                return Err(error.message);
            }
            Err(error) => {
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    0,
                    started_at,
                    error.message,
                ));
            }
        };
        rows_imported = rows_imported.saturating_add(flushed_rows);
        progress_callback(import_progress_with_details(
            &request.import_id,
            TableImportStatus::Done,
            TableImportPhase::Done,
            rows_imported,
            rows_imported,
            true,
            total_bytes,
            total_bytes,
            started_at,
            None,
        ));
        log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);
        return Ok(import_summary(&request.import_id, rows_imported, rows_imported, started_at));
    }

    let total_bytes = tokio::fs::metadata(&request.file_path).await.map(|metadata| metadata.len()).unwrap_or(0);
    progress_callback(import_progress_with_details(
        &request.import_id,
        TableImportStatus::Running,
        TableImportPhase::Reading,
        0,
        0,
        false,
        0,
        total_bytes,
        started_at,
        None,
    ));
    let mut target_column_types = get_columns_for_transfer(
        state,
        pool_key,
        &request.connection_id,
        &request.database,
        &request.schema,
        &request.table,
        None,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|column| (column.name, column.data_type))
    .collect::<Vec<_>>();
    if target_column_types.is_empty() {
        target_column_types = created_column_types.clone().unwrap_or_default();
    }
    let text_source_columns = textual_source_columns_for_import(&request.mappings, &target_column_types);
    let parsed = match parse_import_file_with_options_and_text_columns(
        &request.file_path,
        Some(source_format),
        &import_parse_options,
        usize::MAX,
        text_source_columns,
    )
    .await
    {
        Ok(parsed) => parsed,
        Err(error) => {
            return Err(emit_import_error(&mut progress_callback, request, 0, 0, started_at, error));
        }
    };

    let total_rows = parsed.total_rows;
    if let Err(error) = mapping_indexes(&parsed, &request.mappings) {
        return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
    }
    progress_callback(import_progress_with_details(
        &request.import_id,
        TableImportStatus::Running,
        TableImportPhase::Writing,
        0,
        total_rows,
        true,
        total_bytes,
        total_bytes,
        started_at,
        None,
    ));
    let mut last_progress_emit = Instant::now();

    let effective_batch_size = effective_import_batch_size(db_type, batch_size);
    let compiled_plan = if false {
        None
    } else {
        match compile_import_plan(&parsed.columns, &request.mappings, &target_column_types) {
            Ok(plan) => Some(plan),
            Err(error) => {
                return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
            }
        }
    };
    let sqlserver_bulk_plan = sqlserver_bulk_import_plan_for_pool(
        state,
        pool_key,
        db_type,
        compiled_plan.as_ref(),
        &request.table,
        &request.schema,
    )
    .await;
    let allow_postgres_copy = *db_type == DatabaseType::Postgres
        && postgres_copy_fast_path_eligible(state, pool_key, &request.table, &request.schema).await;
    let mut postgres_copy_accumulator = postgres_copy_accumulator_for_plan(
        allow_postgres_copy,
        compiled_plan.as_ref(),
        &request.table,
        &request.schema,
    );

    let mut pending_truncate =
        matches!(request.mode, TableImportMode::Truncate) && supports_transactional_import_truncate(db_type);
    if matches!(request.mode, TableImportMode::Truncate) && !pending_truncate {
        let sql = truncate_sql(&request.table, &request.schema, db_type);
        if let Err(error) =
            execute_import_statement(state, pool_key, &sql, &mut db_write_ms, &mut statement_count).await
        {
            return Err(emit_import_error(&mut progress_callback, request, 0, total_rows, started_at, error));
        }
    }

    let mut rows_imported = 0;
    for rows in parsed.rows.chunks(effective_batch_size) {
        if is_cancelled(&request.import_id).await {
            progress_callback(import_progress(
                &request.import_id,
                TableImportStatus::Cancelled,
                rows_imported,
                total_rows,
                started_at,
                None,
            ));
            return Err("Import cancelled".to_string());
        }

        let row_count = match execute_import_rows_batch(
            state,
            pool_key,
            &request.import_id,
            &is_cancelled,
            &request.connection_id,
            &request.database,
            rows,
            compiled_plan.as_ref(),
            sqlserver_bulk_plan.as_ref(),
            &parsed.columns,
            &request.mappings,
            &target_column_types,
            &request.table,
            &request.schema,
            db_type,
            &request.mode,
            pending_truncate,
            &mut postgres_copy_accumulator,
            kingbase_oracle_mode,
            request.date_time_format.as_deref(),
            import_sql_hard_limit,
            &mut db_write_ms,
            &mut statement_count,
        )
        .await
        {
            Ok(row_count) => row_count,
            Err(error) => {
                rows_imported = (rows_imported + error.rows_imported).min(total_rows);
                if error.cancelled {
                    progress_callback(import_progress(
                        &request.import_id,
                        TableImportStatus::Cancelled,
                        rows_imported,
                        total_rows,
                        started_at,
                        None,
                    ));
                    return Err(error.message);
                }
                return Err(emit_import_error(
                    &mut progress_callback,
                    request,
                    rows_imported,
                    total_rows,
                    started_at,
                    error.message,
                ));
            }
        };
        rows_imported = (rows_imported + row_count).min(total_rows);
        pending_truncate = false;
        if last_progress_emit.elapsed() >= IMPORT_PROGRESS_INTERVAL {
            progress_callback(import_progress(
                &request.import_id,
                TableImportStatus::Running,
                rows_imported,
                total_rows,
                started_at,
                None,
            ));
            last_progress_emit = Instant::now();
        }
    }

    let flushed_rows = flush_pending_postgres_copy(
        state,
        pool_key,
        &request.import_id,
        &is_cancelled,
        &mut postgres_copy_accumulator,
        &mut db_write_ms,
        &mut statement_count,
    )
    .await;
    let flushed_rows = match flushed_rows {
        Ok(rows) => rows,
        Err(error) if error.cancelled => {
            progress_callback(import_progress(
                &request.import_id,
                TableImportStatus::Cancelled,
                rows_imported,
                total_rows,
                started_at,
                None,
            ));
            return Err(error.message);
        }
        Err(error) => {
            return Err(emit_import_error(
                &mut progress_callback,
                request,
                rows_imported,
                total_rows,
                started_at,
                error.message,
            ));
        }
    };
    rows_imported = rows_imported.saturating_add(flushed_rows).min(total_rows);

    progress_callback(import_progress(
        &request.import_id,
        TableImportStatus::Done,
        rows_imported,
        total_rows,
        started_at,
        None,
    ));
    log_import_metrics(request, source_format, rows_imported, started_at, db_write_ms, statement_count);

    Ok(import_summary(&request.import_id, rows_imported, total_rows, started_at))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_effective_import_batch_size() {
        assert_eq!(effective_import_batch_size(&DatabaseType::Postgres, 1000), 1000);
        assert_eq!(effective_import_batch_size(&DatabaseType::OpenGauss, 500), 500);
    }

    #[test]
    fn test_decimal_data_type() {
        assert_eq!(decimal_data_type(&DatabaseType::Postgres), "DOUBLE PRECISION");
        assert_eq!(decimal_data_type(&DatabaseType::OpenGauss), "DOUBLE PRECISION");
    }

    #[test]
    fn test_json_data_type() {
        assert_eq!(json_data_type(&DatabaseType::Postgres), "JSONB");
        assert_eq!(json_data_type(&DatabaseType::OpenGauss), "JSONB");
    }
}
