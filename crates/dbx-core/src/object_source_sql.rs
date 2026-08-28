use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::types::ObjectSourceKind;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableObjectSourceSqlInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRenameObjectSourceInput {
    pub database_type: DatabaseType,
    pub object_type: ObjectSourceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub new_name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildViewDdlInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObjectSourceSaveExecutionMode {
    #[serde(rename = "single")]
    Single,
    #[serde(rename = "script")]
    Script,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RoutineDeclaration {
    kind: ObjectSourceKind,
    name: String,
    signature: String,
}

pub fn supports_source_backed_routine_rename(
    database_type: Option<DatabaseType>,
    object_type: ObjectSourceKind,
) -> bool {
    if !matches!(object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure) {
        return false;
    }
    let Some(database_type) = database_type else {
        return false;
    };
    is_postgres_like(database_type)
}

pub fn build_routine_rename_object_source_statements(
    input: RoutineRenameObjectSourceInput,
) -> Result<Vec<String>, String> {
    if !supports_source_backed_routine_rename(Some(input.database_type), input.object_type.clone()) {
        return Err(format!(
            "Renaming {:?} from source is not supported for {:?}.",
            input.object_type, input.database_type
        ));
    }

    let source = input.source.trim();
    let declaration = if is_mysql_like(input.database_type) {
        mysql_routine_declaration(source)
    } else {
        routine_declaration(source)
    };
    let Some(declaration) = declaration else {
        return Err(format!("Cannot find a CREATE {:?} declaration in the object source.", input.object_type));
    };
    if declaration.kind != input.object_type {
        return Err(format!("Cannot find a CREATE {:?} declaration in the object source.", input.object_type));
    }

    let renamed_source = if is_mysql_like(input.database_type) {
        replace_mysql_routine_declaration_name(source, &input.new_name)
    } else {
        replace_sql_routine_declaration_name(source, input.schema.as_deref(), &input.new_name)
    };
    let Some(renamed_source) = renamed_source else {
        return Err(format!("Cannot rewrite the {:?} name in the object source.", input.object_type));
    };

    if is_oracle_like(input.database_type) {
        return Ok(vec![
            ensure_semicolon(&renamed_source),
            format!(
                "DROP {} {};",
                object_type_keyword(&input.object_type),
                postgres_qualified_name(input.schema.as_deref(), &input.name)
            ),
        ]);
    }

    build_executable_object_source_statements(EditableObjectSourceSqlInput {
        database_type: input.database_type,
        object_type: input.object_type,
        schema: input.schema,
        name: input.name,
        source: renamed_source,
    })
}

pub fn build_executable_object_source_statements(input: EditableObjectSourceSqlInput) -> Result<Vec<String>, String> {
    let source = input.source.trim();
    let source = if is_opengauss_like(input.database_type) && input.object_type == ObjectSourceKind::Procedure {
        strip_standalone_trailing_slash(source)
    } else {
        source
    };

    if is_postgres_like(input.database_type) && input.object_type == ObjectSourceKind::View {
        if let Some(sql) = executable_postgres_view_ddl(source) {
            return Ok(vec![sql]);
        }
        if source_starts_with_alter(source) {
            // ALTER VIEW is already executable DDL, but it is not a view body.
            return Ok(vec![ensure_semicolon(source)]);
        }
        return Ok(vec![format!(
            "CREATE OR REPLACE VIEW {} AS\n{}",
            postgres_qualified_name(input.schema.as_deref(), &input.name),
            ensure_semicolon(source)
        )]);
    }

    let create_statement = ensure_semicolon(source);
    let cleanup = build_routine_rename_cleanup(&input, source);
    Ok(if let Some(cleanup) = cleanup { vec![create_statement, cleanup] } else { vec![create_statement] })
}

pub fn build_executable_object_source_sql(input: EditableObjectSourceSqlInput) -> Result<String, String> {
    Ok(build_executable_object_source_statements(input)?.join("\n"))
}

pub fn build_editable_object_source(input: EditableObjectSourceSqlInput) -> String {
    let source = input.source.clone();
    if is_postgres_like(input.database_type)
        && input.object_type == ObjectSourceKind::View
        && source_starts_with_create_or_alter(&source)
    {
        // Some providers return full view DDL instead of a bare SELECT body.
        return ensure_semicolon(source.trim());
    }
    match build_executable_object_source_statements(input) {
        Ok(statements) => statements.into_iter().next().unwrap_or_default(),
        Err(_) => ensure_semicolon(source.trim()),
    }
}

pub fn build_view_ddl_sql(input: BuildViewDdlInput) -> String {
    let source = input.source.trim();
    if Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(source) {
        return ensure_semicolon(source);
    }

    let qualified_name = postgres_qualified_name(input.schema.as_deref(), &input.name);

    if input.database_type.is_none() || input.database_type.is_some_and(is_postgres_like) {
        return format!("CREATE OR REPLACE VIEW {qualified_name} AS\n{}", ensure_semicolon(source));
    }

    format!("CREATE VIEW {qualified_name} AS\n{}", ensure_semicolon(source))
}

pub fn build_export_object_source_sql(
    database_type: DatabaseType,
    object_type: ObjectSourceKind,
    source: &str,
) -> String {
    let source = source.trim();
    let source = if is_opengauss_like(database_type) && object_type == ObjectSourceKind::Procedure {
        strip_standalone_trailing_slash(source)
    } else {
        source
    };
    if source.is_empty() {
        return String::new();
    }
    if is_mysql_like(database_type) && matches!(object_type, ObjectSourceKind::Procedure | ObjectSourceKind::Function) {
        return mysql_delimited_routine_source(source);
    }
    ensure_semicolon(source)
}

pub fn object_source_save_execution_mode(_database_type: DatabaseType) -> ObjectSourceSaveExecutionMode {
    ObjectSourceSaveExecutionMode::Single
}

fn build_routine_rename_cleanup(input: &EditableObjectSourceSqlInput, source: &str) -> Option<String> {
    if !matches!(input.object_type, ObjectSourceKind::Function | ObjectSourceKind::Procedure) {
        return None;
    }

    if is_mysql_like(input.database_type) {
        let declaration = mysql_routine_declaration(source)?;
        if declaration.kind != input.object_type || !routine_name_changed(&declaration.name, &input.name) {
            return None;
        }
        return Some(format!(
            "DROP {} IF EXISTS {};",
            object_type_keyword(&input.object_type),
            mysql_qualified_name(input.schema.as_deref(), &input.name)
        ));
    }

    if !is_postgres_like(input.database_type) {
        return None;
    }

    let declaration = routine_declaration(source)?;
    if declaration.kind != input.object_type || !routine_name_changed(&declaration.name, &input.name) {
        return None;
    }

    Some(format!(
        "DROP {} IF EXISTS {}{};",
        object_type_keyword(&input.object_type),
        postgres_qualified_name(input.schema.as_deref(), &input.name),
        declaration.signature
    ))
}

fn is_postgres_like(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::Opengauss)
}

fn is_opengauss_like(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Opengauss)
}

fn is_mysql_like(_database_type: DatabaseType) -> bool {
    false
}

fn is_oracle_like(_database_type: DatabaseType) -> bool {
    false
}

fn object_type_keyword(object_type: &ObjectSourceKind) -> &'static str {
    match object_type {
        ObjectSourceKind::View => "VIEW",
        ObjectSourceKind::MaterializedView => "MATERIALIZED_VIEW",
        ObjectSourceKind::Procedure => "PROCEDURE",
        ObjectSourceKind::Function => "FUNCTION",
        ObjectSourceKind::Trigger => "TRIGGER",
        ObjectSourceKind::Sequence => "SEQUENCE",
        ObjectSourceKind::Synonym => "SYNONYM",
        ObjectSourceKind::Package => "PACKAGE",
        ObjectSourceKind::PackageBody => "PACKAGE BODY",
        ObjectSourceKind::Type => "TYPE",
        ObjectSourceKind::TypeBody => "TYPE BODY",
        ObjectSourceKind::Job => "JOB",
        ObjectSourceKind::Scheduler => "SCHEDULER",
    }
}

fn quote_postgres_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn ensure_semicolon(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn strip_standalone_trailing_slash(sql: &str) -> &str {
    let trimmed = sql.trim();
    let Some(without_slash) = trimmed.strip_suffix('/') else {
        return trimmed;
    };
    if without_slash.ends_with('\n') || without_slash.ends_with('\r') {
        without_slash.trim_end()
    } else {
        trimmed
    }
}

fn mysql_delimited_routine_source(source: &str) -> String {
    let trimmed = source.trim();
    if Regex::new(r"(?i)^\s*DELIMITER\b").unwrap().is_match(trimmed) {
        return trimmed.to_string();
    }
    let body = trimmed.trim_end_matches(';').trim_end();
    let delimiter = mysql_routine_script_delimiter(body);
    format!("DELIMITER {delimiter}\n{body}{delimiter}\nDELIMITER ;")
}

fn mysql_routine_script_delimiter(source: &str) -> &'static str {
    ["//", "$$", ";;", "__DBX_DELIMITER__"]
        .into_iter()
        .find(|delimiter| !source.contains(delimiter))
        .unwrap_or("__DBX_DELIMITER__")
}

fn source_starts_with_create_or_alter(source: &str) -> bool {
    let executable = &source[leading_sql_statement_start(source)..];
    Regex::new(r"(?i)^(?:CREATE|ALTER)\s+").unwrap().is_match(executable)
}

fn source_starts_with_alter(source: &str) -> bool {
    let executable = &source[leading_sql_statement_start(source)..];
    Regex::new(r"(?i)^ALTER\s+").unwrap().is_match(executable)
}

fn executable_postgres_view_ddl(source: &str) -> Option<String> {
    let trimmed = source.trim();
    let statement_start = leading_sql_statement_start(trimmed);
    let executable = &trimmed[statement_start..];
    if Regex::new(r"(?i)^CREATE\s+OR\s+REPLACE\s+").unwrap().is_match(executable) {
        return Some(ensure_semicolon(trimmed));
    }

    // Kingbase extends PostgreSQL's prefix with FORCE after the optional RECURSIVE modifier.
    let create_view =
        Regex::new(r"(?i)^CREATE\s+((?:(?:TEMP|TEMPORARY)\s+)?(?:RECURSIVE\s+)?(?:FORCE\s+)?VIEW\s+)").unwrap();
    if create_view.is_match(executable) {
        let replaced = create_view.replace(executable, "CREATE OR REPLACE $1");
        return Some(ensure_semicolon(&format!("{}{}", &trimmed[..statement_start], replaced)));
    }

    None
}

fn leading_sql_statement_start(source: &str) -> usize {
    let mut index = 0;
    loop {
        index = skip_sql_whitespace(source, index);
        if let Some(end) = sql_line_comment_end(source, index) {
            index = end;
            continue;
        }
        if let Some(end) = sql_block_comment_end(source, index) {
            index = end;
            continue;
        }
        return index;
    }
}

fn postgres_qualified_name(schema: Option<&str>, name: &str) -> String {
    schema
        .into_iter()
        .chain(std::iter::once(name))
        .filter(|part| !part.is_empty())
        .map(quote_postgres_identifier)
        .collect::<Vec<_>>()
        .join(".")
}

fn sql_line_comment_end(source: &str, start: usize) -> Option<usize> {
    if !source[start..].starts_with("--") {
        return None;
    }
    let rest = &source[start..];
    Some(start + rest.find('\n').map(|index| index + 1).unwrap_or(rest.len()))
}

fn sql_block_comment_end(source: &str, start: usize) -> Option<usize> {
    if !source[start..].starts_with("/*") {
        return None;
    }

    // PostgreSQL and Kingbase default to nested SQL block comments, so match the outer terminator.
    let mut depth = 1;
    let mut index = start + 2;
    while index < source.len() {
        if source[index..].starts_with("/*") {
            depth += 1;
            index += 2;
        } else if source[index..].starts_with("*/") {
            depth -= 1;
            index += 2;
            if depth == 0 {
                return Some(index);
            }
        } else {
            index += source[index..].chars().next().unwrap().len_utf8();
        }
    }

    // Preserve the existing safe behavior: an unclosed leading comment consumes the remaining source.
    Some(source.len())
}

fn skip_sql_whitespace(source: &str, mut index: usize) -> usize {
    while index < source.len() {
        let ch = source[index..].chars().next().unwrap();
        if !ch.is_whitespace() {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

fn mysql_qualified_name(schema: Option<&str>, name: &str) -> String {
    schema
        .into_iter()
        .chain(std::iter::once(name))
        .filter(|part| !part.is_empty())
        .map(quote_mysql_identifier)
        .collect::<Vec<_>>()
        .join(".")
}

fn unquote_postgres_identifier(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].replace("\"\"", "\"")
    } else {
        trimmed.to_string()
    }
}

fn split_qualified_routine_name(value: &str) -> Vec<String> {
    Regex::new(r#""(?:""|[^"])+"|[A-Za-z_][\w$]*"#)
        .unwrap()
        .find_iter(value)
        .map(|part| unquote_postgres_identifier(part.as_str()))
        .collect()
}

fn unquote_mysql_identifier(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('`') && trimmed.ends_with('`') && trimmed.len() >= 2 {
        trimmed[1..trimmed.len() - 1].replace("``", "`")
    } else {
        trimmed.to_string()
    }
}

fn split_mysql_qualified_routine_name(value: &str) -> Vec<String> {
    Regex::new(r"`(?:``|[^`])+`|[A-Za-z_][\w$]*")
        .unwrap()
        .find_iter(value)
        .map(|part| unquote_mysql_identifier(part.as_str()))
        .collect()
}

fn routine_declaration(source: &str) -> Option<RoutineDeclaration> {
    let re = Regex::new(
        r#"(?is)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(FUNCTION|PROCEDURE)\s+((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)\s*(\(.*?\))?"#,
    )
    .unwrap();
    let captures = re.captures(source)?;
    let kind = parse_object_source_kind(captures.get(1)?.as_str())?;
    let name_parts = split_qualified_routine_name(captures.get(2)?.as_str());
    let name = name_parts.last()?.clone();
    let signature = captures.get(3).map(|value| value.as_str().trim().to_string()).unwrap_or_default();
    Some(RoutineDeclaration { kind, name, signature })
}

fn replace_sql_routine_declaration_name(source: &str, schema: Option<&str>, new_name: &str) -> Option<String> {
    let re = Regex::new(
        r#"(?is)^(\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:FUNCTION|PROCEDURE)\s+)((?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*))?)"#,
    )
    .unwrap();
    let captures = re.captures(source)?;
    let full = captures.get(0)?;
    let prefix = captures.get(1)?.as_str();
    let existing_name = captures.get(2)?.as_str();
    let existing_parts = split_qualified_routine_name(existing_name);
    let schema_name =
        schema.or_else(|| existing_parts.first().filter(|_| existing_parts.len() > 1).map(String::as_str));
    let replacement = if let Some(schema_name) = schema_name {
        format!("{}.{}", quote_postgres_identifier(schema_name), quote_postgres_identifier(new_name))
    } else {
        quote_postgres_identifier(new_name)
    };
    Some(format!("{}{}{}{}", &source[..full.start()], prefix, replacement, &source[full.end()..]))
}

fn mysql_routine_declaration(source: &str) -> Option<RoutineDeclaration> {
    let re = Regex::new(
        r"(?is)^\s*CREATE\s+(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
    )
    .unwrap();
    let captures = re.captures(source)?;
    let kind = parse_object_source_kind(captures.get(1)?.as_str())?;
    let name_parts = split_mysql_qualified_routine_name(captures.get(2)?.as_str());
    let name = name_parts.last()?.clone();
    Some(RoutineDeclaration { kind, name, signature: String::new() })
}

fn replace_mysql_routine_declaration_name(source: &str, new_name: &str) -> Option<String> {
    let re = Regex::new(
        r"(?is)^(\s*CREATE\s+(?:DEFINER\s*=\s*(?:(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)\s*@\s*(?:`(?:``|[^`])+`|'(?:''|[^'])+'|[^\s]+)|CURRENT_USER(?:\(\))?)\s+)?(?:FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?)((?:`(?:``|[^`])+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][\w$]*))?)",
    )
    .unwrap();
    let captures = re.captures(source)?;
    let full = captures.get(0)?;
    let prefix = captures.get(1)?.as_str();
    Some(format!("{}{}{}{}", &source[..full.start()], prefix, quote_mysql_identifier(new_name), &source[full.end()..]))
}

fn routine_name_changed(source_name: &str, saved_name: &str) -> bool {
    !source_name.eq_ignore_ascii_case(saved_name)
}

fn parse_object_source_kind(value: &str) -> Option<ObjectSourceKind> {
    if value.eq_ignore_ascii_case("VIEW") {
        Some(ObjectSourceKind::View)
    } else if value.eq_ignore_ascii_case("MATERIALIZED VIEW") || value.eq_ignore_ascii_case("MATERIALIZED_VIEW") {
        Some(ObjectSourceKind::MaterializedView)
    } else if value.eq_ignore_ascii_case("PROCEDURE") {
        Some(ObjectSourceKind::Procedure)
    } else if value.eq_ignore_ascii_case("FUNCTION") {
        Some(ObjectSourceKind::Function)
    } else if value.eq_ignore_ascii_case("TRIGGER") {
        Some(ObjectSourceKind::Trigger)
    } else if value.eq_ignore_ascii_case("SEQUENCE") {
        Some(ObjectSourceKind::Sequence)
    } else if value.eq_ignore_ascii_case("SYNONYM") {
        Some(ObjectSourceKind::Synonym)
    } else if value.eq_ignore_ascii_case("PACKAGE") {
        Some(ObjectSourceKind::Package)
    } else if value.eq_ignore_ascii_case("PACKAGE BODY") || value.eq_ignore_ascii_case("PACKAGE_BODY") {
        Some(ObjectSourceKind::PackageBody)
    } else if value.eq_ignore_ascii_case("TYPE") {
        Some(ObjectSourceKind::Type)
    } else if value.eq_ignore_ascii_case("TYPE BODY") || value.eq_ignore_ascii_case("TYPE_BODY") {
        Some(ObjectSourceKind::TypeBody)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(database_type: DatabaseType, object_type: ObjectSourceKind, source: &str) -> EditableObjectSourceSqlInput {
        EditableObjectSourceSqlInput {
            database_type,
            object_type,
            schema: Some("public".to_string()),
            name: "refresh_cache".to_string(),
            source: source.to_string(),
        }
    }

    #[test]
    fn postgres_view_body_opens_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
        );
    }

    #[test]
    fn postgres_view_create_source_opens_without_rewrapping_or_reformatting() {
        let source = "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true";
        let sql = build_editable_object_source(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: source.to_string(),
        });

        assert_eq!(sql, format!("{source};"));
    }

    #[test]
    fn postgres_view_create_source_saves_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: "CREATE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true".to_string(),
        })
        .unwrap();

        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true;"
        );
    }

    #[test]
    fn postgres_view_create_or_replace_source_saves_without_rewrapping() {
        let source = "CREATE OR REPLACE VIEW public.active_users AS SELECT id, name FROM users WHERE active = true";
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Postgres,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active_users".to_string(),
            source: source.to_string(),
        })
        .unwrap();

        assert_eq!(sql, format!("{source};"));
    }

    #[test]
    fn opengauss_view_body_opens_as_create_or_replace_view() {
        let sql = build_executable_object_source_sql(EditableObjectSourceSqlInput {
            database_type: DatabaseType::Opengauss,
            object_type: ObjectSourceKind::View,
            schema: Some("public".to_string()),
            name: "active users".to_string(),
            source: " SELECT id, name FROM users WHERE active ".to_string(),
        })
        .unwrap();
        assert_eq!(
            sql,
            "CREATE OR REPLACE VIEW \"public\".\"active users\" AS\nSELECT id, name FROM users WHERE active;"
        );
    }

    #[test]
    fn parses_programmable_metadata_object_kinds() {
        assert_eq!(parse_object_source_kind("TRIGGER"), Some(ObjectSourceKind::Trigger));
        assert_eq!(parse_object_source_kind("SYNONYM"), Some(ObjectSourceKind::Synonym));
        assert_eq!(parse_object_source_kind("TYPE"), Some(ObjectSourceKind::Type));
        assert_eq!(parse_object_source_kind("TYPE_BODY"), Some(ObjectSourceKind::TypeBody));
        assert_eq!(parse_object_source_kind("PACKAGE BODY"), Some(ObjectSourceKind::PackageBody));
    }

    #[test]
    fn postgres_procedure_rename_adds_drop_cleanup() {
        let statements = build_executable_object_source_statements(input(
            DatabaseType::Postgres,
            ObjectSourceKind::Procedure,
            "CREATE OR REPLACE PROCEDURE \"public\".\"refresh_cache_v2\"(mode text)\nLANGUAGE SQL\nAS $$ SELECT 1 $$;",
        ))
        .unwrap();
        assert_eq!(
            statements,
            vec![
                "CREATE OR REPLACE PROCEDURE \"public\".\"refresh_cache_v2\"(mode text)\nLANGUAGE SQL\nAS $$ SELECT 1 $$;",
                "DROP PROCEDURE IF EXISTS \"public\".\"refresh_cache\"(mode text);",
            ]
        );
    }

    #[test]
    fn opengauss_procedure_source_omits_gsql_trailing_slash() {
        let source = "CREATE OR REPLACE PROCEDURE public.refresh_cache()\nAS DECLARE BEGIN\n  NULL;\nEND;\n/";
        let expected = "CREATE OR REPLACE PROCEDURE public.refresh_cache()\nAS DECLARE BEGIN\n  NULL;\nEND;";

        let editable =
            build_editable_object_source(input(DatabaseType::Opengauss, ObjectSourceKind::Procedure, source));
        assert_eq!(editable, expected);

        let exported = build_export_object_source_sql(DatabaseType::Opengauss, ObjectSourceKind::Procedure, source);
        assert_eq!(exported, expected);
    }
}
