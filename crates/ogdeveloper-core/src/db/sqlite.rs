use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::file_validator::validate_file_path;

const SQLITE_DATABASE_HEADER: &[u8; 16] = b"SQLite format 3\0";

#[derive(Clone)]
pub struct SqliteHandle {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteHandle {
    pub fn new(conn: Connection) -> Self {
        Self { conn: Arc::new(Mutex::new(conn)) }
    }

    pub fn with_connection<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut Connection) -> Result<T, String>,
    {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        f(&mut conn)
    }
}

pub async fn connect_path(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, false).await
}

pub async fn connect_path_create_if_missing(path: &str) -> Result<SqliteHandle, String> {
    connect_path_with_options(path, true).await
}

async fn connect_path_with_options(path: &str, create_if_missing: bool) -> Result<SqliteHandle, String> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || open_sqlite_handle(&path, create_if_missing))
        .await
        .map_err(|e| e.to_string())?
}

fn open_sqlite_handle(path: &str, create_if_missing: bool) -> Result<SqliteHandle, String> {
    let is_memory = is_memory_database_path(path);
    if !is_memory && !create_if_missing {
        validate_file_path(path, is_network_path)?;
    }

    if !is_memory && create_if_missing {
        ensure_parent_dir(path)?;
    }
    if !is_memory && !is_network_path(path) {
        validate_existing_sqlite_file(path)?;
    }

    let conn = open_sqlite_connection(path, create_if_missing)?;
    conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?;
    register_sqlite_compat_functions(&conn)?;

    Ok(SqliteHandle { conn: Arc::new(Mutex::new(conn)) })
}

fn open_sqlite_connection(path: &str, create_if_missing: bool) -> Result<Connection, String> {
    if is_memory_database_path(path) {
        return Connection::open_in_memory().map_err(|e| format!("SQLite connection failed: {e}"));
    }

    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
    if create_if_missing {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    if is_network_path(path) {
        flags |= OpenFlags::SQLITE_OPEN_URI;
        Connection::open_with_flags(sqlite_network_path_uri(path), flags)
            .map_err(|e| format!("SQLite connection failed: {e}"))
    } else {
        Connection::open_with_flags(path, flags).map_err(|e| format!("SQLite connection failed: {e}"))
    }
}

pub fn path_has_sqlite_header(path: &Path) -> Result<bool, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("failed to open file: {e}"))?;
    let mut header = [0_u8; 16];
    match file.read_exact(&mut header) {
        Ok(()) => Ok(&header == SQLITE_DATABASE_HEADER),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(format!("failed to read file header: {e}")),
    }
}

fn validate_existing_sqlite_file(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if !path.exists() {
        return Ok(());
    }
    let metadata = path.metadata().map_err(|e| format!("failed to inspect SQLite database file: {e}"))?;
    if metadata.len() == 0 {
        return Ok(());
    }
    if path_has_sqlite_header(path)? {
        return Ok(());
    }
    Err("Selected file is not a valid SQLite database file.".to_string())
}

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//") || path.contains("wsl.localhost") || path.contains("wsl$")
}

fn sqlite_network_path_uri(path: &str) -> String {
    let (path_and_query, fragment) =
        path.split_once('#').map_or((path, None), |(prefix, suffix)| (prefix, Some(suffix)));
    let (file_path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
    let mut query = query.to_string();
    if !sqlite_uri_query_has_param(&query, "nolock") {
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str("nolock=1");
    }

    let mut uri = format!("file:{file_path}");
    if !query.is_empty() {
        uri.push('?');
        uri.push_str(&query);
    }
    if let Some(fragment) = fragment {
        uri.push('#');
        uri.push_str(fragment);
    }
    uri
}

fn sqlite_uri_query_has_param(query: &str, name: &str) -> bool {
    query.split('&').any(|part| {
        let key = part.split_once('=').map_or(part, |(key, _)| key);
        key.eq_ignore_ascii_case(name)
    })
}

pub fn is_memory_database_path(path: &str) -> bool {
    path.trim().eq_ignore_ascii_case(":memory:")
}

fn register_sqlite_compat_functions(conn: &Connection) -> Result<(), String> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS;

    if !sqlite_function_available(conn, "SELECT if(1, 2, 3)") {
        conn.create_scalar_function("if", -1, flags, sqlite_if)
            .map_err(|e| format!("SQLite compatibility function registration failed (if): {e}"))?;
    }
    if !sqlite_function_available(conn, "SELECT unistr('')") {
        conn.create_scalar_function("unistr", 1, flags, sqlite_unistr)
            .map_err(|e| format!("SQLite compatibility function registration failed (unistr): {e}"))?;
    }

    Ok(())
}

fn sqlite_function_available(conn: &Connection, sql: &str) -> bool {
    conn.query_row(sql, [], |_| Ok(())).is_ok()
}

fn sqlite_if(ctx: &Context<'_>) -> rusqlite::Result<Value> {
    if ctx.len() < 2 {
        return Err(rusqlite::Error::UserFunctionError(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "if() requires at least two arguments",
        ))));
    }

    let mut i = 0;
    while i + 1 < ctx.len() {
        if sqlite_truthy(ctx.get_raw(i)) {
            return Ok(sqlite_value_ref_to_owned(ctx.get_raw(i + 1)));
        }
        i += 2;
    }

    if ctx.len() % 2 == 1 {
        Ok(sqlite_value_ref_to_owned(ctx.get_raw(ctx.len() - 1)))
    } else {
        Ok(Value::Null)
    }
}

fn sqlite_truthy(value: ValueRef<'_>) -> bool {
    match value {
        ValueRef::Null => false,
        ValueRef::Integer(value) => value != 0,
        ValueRef::Real(value) => value != 0.0,
        ValueRef::Text(value) | ValueRef::Blob(value) => {
            let text = String::from_utf8_lossy(value);
            let trimmed = text.trim_start();
            for end in (1..=trimmed.len()).rev() {
                if trimmed.is_char_boundary(end) {
                    if let Ok(value) = trimmed[..end].parse::<f64>() {
                        return value != 0.0;
                    }
                }
            }
            false
        }
    }
}

fn sqlite_value_ref_to_owned(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Integer(value),
        ValueRef::Real(value) => Value::Real(value),
        ValueRef::Text(value) => Value::Text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Blob(value.to_vec()),
    }
}

fn sqlite_unistr(ctx: &Context<'_>) -> rusqlite::Result<Value> {
    let input = match ctx.get_raw(0) {
        ValueRef::Null => return Ok(Value::Null),
        ValueRef::Integer(value) => value.to_string(),
        ValueRef::Real(value) => value.to_string(),
        ValueRef::Text(value) | ValueRef::Blob(value) => String::from_utf8_lossy(value).into_owned(),
    };

    sqlite_unistr_text(&input).map(Value::Text)
}

fn sqlite_unistr_text(input: &str) -> rusqlite::Result<String> {
    let chars: Vec<char> = input.chars().collect();
    let mut result = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] != '\\' {
            result.push(chars[i]);
            i += 1;
            continue;
        }

        if i + 1 >= chars.len() {
            result.push('\\');
            i += 1;
            continue;
        }

        match chars[i + 1] {
            '\\' => {
                result.push('\\');
                i += 2;
            }
            'u' | 'U' => {
                let digits = if chars[i + 1] == 'U' { 8 } else { 4 };
                if let Some(ch) = sqlite_unistr_codepoint(&chars, i + 2, digits)? {
                    result.push(ch);
                    i += 2 + digits;
                } else {
                    result.push('\\');
                    i += 1;
                }
            }
            _ => {
                result.push(chars[i]);
                i += 1;
            }
        }
    }

    Ok(result)
}

fn sqlite_unistr_codepoint(chars: &[char], start: usize, digits: usize) -> rusqlite::Result<Option<char>> {
    if start + digits > chars.len() {
        return Ok(None);
    }

    let mut value = 0_u32;
    for ch in &chars[start..start + digits] {
        let Some(digit) = ch.to_digit(16) else {
            return Ok(None);
        };
        value = (value << 4) | digit;
    }

    std::char::from_u32(value).map(Some).ok_or_else(|| {
        rusqlite::Error::UserFunctionError(Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid Unicode codepoint: {value:#X}"),
        )))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_path_supports_memory_database_across_statements() {
        let handle = connect_path(":memory:").await.unwrap();
        handle
            .with_connection(|conn| {
                conn.execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);").map_err(|e| e.to_string())
            })
            .unwrap();

        handle
            .with_connection(|conn| {
                conn.execute("INSERT INTO items (name) VALUES (?1)", ["alpha"]).map_err(|e| e.to_string())
            })
            .unwrap();

        let count: i64 = handle
            .with_connection(|conn| {
                conn.query_row("SELECT count(*) FROM items", [], |row| row.get(0)).map_err(|e| e.to_string())
            })
            .unwrap();

        assert_eq!(count, 1);
    }
}
