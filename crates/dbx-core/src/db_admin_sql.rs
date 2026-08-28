use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{
    is_postgres_reserved_identifier, is_schema_aware, is_simple_lower_identifier, quote_table_identifier,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DatabaseObjectType {
    Table,
    View,
    MaterializedView,
    Procedure,
    Function,
    Sequence,
    Synonym,
    Package,
    PackageBody,
    Type,
    TypeBody,
    Job,
    Scheduler,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TableChildObjectType {
    Column,
    Index,
    ForeignKey,
    Trigger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: DatabaseObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDatabaseSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<DatabaseCreationTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseCreationTarget {
    Database,
    Schema,
    Catalog,
    Namespace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteAttachDatabaseSqlOptions {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: DatabaseObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableAdminSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropTableChildObjectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub object_type: TableChildObjectType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseNameSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNameSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePropertyEditSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_profile: Option<String>,
    pub target: DatabasePropertyTarget,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DatabasePropertyTarget {
    Database,
    Schema,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTableStructureSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub source_name: String,
    pub target_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub column_comments: Vec<DuplicateTableColumnComment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTableColumnComment {
    pub name: String,
    pub comment: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTableDataSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub source_name: String,
    pub target_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    #[serde(default)]
    pub postgres_overriding_system_value: bool,
    #[serde(default)]
    pub sqlserver_identity_insert: bool,
    #[serde(default)]
    pub normalize_new_target_name: bool,
}

pub fn supports_create_database_charset(_database_type: Option<DatabaseType>, _driver_profile: Option<&str>) -> bool {
    false
}

pub fn build_create_database_sql(options: CreateDatabaseSqlOptions) -> Result<String, String> {
    match options.target.unwrap_or(DatabaseCreationTarget::Database) {
        DatabaseCreationTarget::Database => build_create_database_statement(&options),
        // Schema creation is exposed through the same frontend dialog contract when the tree target is a database node.
        DatabaseCreationTarget::Schema => {
            build_create_schema_sql(SchemaNameSqlOptions { database_type: options.database_type, name: options.name })
        }
        DatabaseCreationTarget::Catalog => Err("Creating catalogs is not supported yet.".to_string()),
        DatabaseCreationTarget::Namespace => Err("Creating namespaces is not supported yet.".to_string()),
    }
}

fn build_create_database_statement(options: &CreateDatabaseSqlOptions) -> Result<String, String> {
    if !supports_create_database_target(options.database_type) {
        return Err(format!("Creating databases is not supported for {}.", database_label(options.database_type)));
    }
    let name = quote_admin_identifier(options.database_type, &options.name);
    let charset = clean_sql_option(options.charset.as_deref());
    let collation = clean_sql_option(options.collation.as_deref());
    if !supports_create_database_charset(options.database_type, options.driver_profile.as_deref()) || charset.is_empty()
    {
        return Ok(format!("CREATE DATABASE {name};"));
    }
    let collate_clause = if collation.is_empty() { String::new() } else { format!(" COLLATE {collation}") };
    Ok(format!("CREATE DATABASE {name} CHARACTER SET {charset}{collate_clause};"))
}

fn database_label(database_type: Option<DatabaseType>) -> String {
    match database_type {
        Some(DatabaseType::Postgres) => "PostgreSQL".to_string(),
        Some(DatabaseType::Opengauss) => "openGauss".to_string(),
        Some(DatabaseType::Jdbc) => "JDBC".to_string(),
        None => "Database".to_string(),
    }
}

fn comment_literal(comment: Option<&str>) -> String {
    match comment {
        Some(c) => format!("'{}'", c.replace('\'', "''")),
        None => "NULL".to_string(),
    }
}

fn quote_sql_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn supports_create_database_target(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::Opengauss))
}

pub fn supports_create_schema_target(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::Opengauss))
}

pub fn supports_database_property_charset(_database_type: Option<DatabaseType>, _driver_profile: Option<&str>) -> bool {
    false
}

pub fn supports_database_property_comment(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::Opengauss))
}

pub fn build_create_user_sql(username: &str, password: &str, _tablespace: &str) -> String {
    format!("CREATE USER \"{}\" WITH PASSWORD {};", username.replace('"', "\"\""), quote_sql_string(password),)
}

pub fn build_drop_object_sql(options: DropObjectSqlOptions) -> String {
    // openGauss-style scheduled jobs have no `DROP JOB` statement; they are
    // removed with pkg_service.job_cancel(job_id). Resolve the job id by
    // name/schema on the current database so the statement cancels exactly the
    // job the tree row points at (kept as one plain SELECT so statement
    // splitting and preview stay trivial).
    if options.database_type.is_some_and(is_postgres_family_database) {
        if options.object_type == DatabaseObjectType::Job {
            let name = quote_sql_string(&options.name);
            let schema = options.schema.as_deref().map(quote_sql_string).unwrap_or_else(|| "NULL".to_string());
            return format!(
                "SELECT pkg_service.job_cancel(job_id) FROM pg_job \
                 WHERE (nspname = {schema} OR (nspname IS NULL AND {schema} = 'public')) \
                   AND dbname = current_database() \
                   AND job_id::text = {name};",
                name = name,
                schema = schema,
            );
        }
        if options.object_type == DatabaseObjectType::Scheduler {
            let name = quote_sql_string(&options.name);
            return format!("CALL dbms_scheduler.drop_job({name});", name = name);
        }
    }
    // PG-family servers resolve DROP FUNCTION/PROCEDURE by name alone only when
    // the routine name is unique in the schema. Overloaded routines require the
    // argument list (PostgreSQL: "function ... is not unique", openGauss: "function ...
    // asks parameters"). Emit the identity argument list whenever the caller knows it
    // so the drop never depends on name uniqueness or vendor-specific resolution.
    let is_pg_family = options.database_type.is_some_and(is_postgres_family_database);
    let signature = if is_pg_family
        && matches!(options.object_type, DatabaseObjectType::Function | DatabaseObjectType::Procedure)
    {
        options.signature.as_deref().map(|value| format!("({value})")).unwrap_or_default()
    } else {
        String::new()
    };
    let name = qualified_name(options.database_type, options.schema.as_deref(), &options.name);
    format!("DROP {} {name}{signature};", object_type_keyword(options.object_type),)
}

/// Quote a PG-family identifier only when it would not round-trip unquoted.
/// Unquoted PG identifiers fold to lowercase, so an all-lowercase, non-reserved,
/// bare identifier (`col_test`, `f_broken`) is emitted as-is; everything else
/// (mixed case, special characters, reserved words on PG or openGauss) is quoted
/// so the DDL always references exactly the object that was selected.
fn postgres_quote_when_needed(identifier: &str) -> String {
    if is_simple_lower_identifier(identifier) && !is_postgres_reserved_identifier(identifier) {
        identifier.to_string()
    } else {
        format!("\"{}\"", identifier.replace('"', "\"\""))
    }
}

/// Quote a database/schema/object identifier in admin DDL. PG-family servers May
/// omit quotes for safe lowercase identifiers; every other dialect keeps its
/// dialect-specific quoting rules unchanged.
fn quote_admin_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    if database_type.is_some_and(is_postgres_family_database) {
        postgres_quote_when_needed(name)
    } else {
        quote_rename_identifier(database_type, name)
    }
}

pub fn build_drop_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let cascade = if options.cascade.unwrap_or(false) && supports_drop_table_cascade(options.database_type) {
        " CASCADE"
    } else {
        ""
    };
    format!("DROP TABLE {table}{cascade};")
}

fn supports_drop_table_cascade(database_type: Option<DatabaseType>) -> bool {
    database_type.is_some_and(is_postgres_family_database)
}

pub(crate) fn is_postgres_family_database(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::Opengauss)
}

pub fn build_drop_table_child_object_sql(options: DropTableChildObjectSqlOptions) -> Result<String, String> {
    let database_type = options.database_type;
    let table = qualified_name(database_type, options.schema.as_deref(), &options.table_name);
    let name = quote_admin_identifier(database_type, &options.name);
    match options.object_type {
        TableChildObjectType::Column => Ok(format!("ALTER TABLE {table} DROP COLUMN {name};")),
        TableChildObjectType::Index => {
            if options.schema.as_deref().is_some_and(|schema| !schema.is_empty()) {
                let schema = quote_admin_identifier(database_type, options.schema.as_deref().unwrap());
                return Ok(format!("DROP INDEX {schema}.{name};"));
            }
            Ok(format!("DROP INDEX {name};"))
        }
        TableChildObjectType::ForeignKey => Ok(format!("ALTER TABLE {table} DROP CONSTRAINT {name};")),
        TableChildObjectType::Trigger => Ok(format!("DROP TRIGGER {name} ON {table};")),
    }
}

pub fn build_empty_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    format!("DELETE FROM {table};")
}

pub fn build_truncate_table_sql(options: TableAdminSqlOptions) -> String {
    let table = qualified_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let cascade = if options.cascade.unwrap_or(false) && supports_truncate_table_cascade(options.database_type) {
        " CASCADE"
    } else {
        ""
    };
    format!("TRUNCATE TABLE {table}{cascade};")
}

fn supports_truncate_table_cascade(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::Opengauss))
}

pub fn build_drop_database_sql(options: DatabaseNameSqlOptions) -> String {
    format!("DROP DATABASE {};", quote_admin_identifier(options.database_type, &options.name))
}

pub fn build_update_database_properties_sql(options: DatabasePropertyEditSqlOptions) -> Result<String, String> {
    match options.target {
        DatabasePropertyTarget::Database => {
            if options.comment.is_some() {
                return build_database_comment_sql(options.database_type, &options.name, options.comment.as_deref());
            }
            build_database_charset_sql(&options)
        }
        DatabasePropertyTarget::Schema => {
            build_schema_comment_sql(options.database_type, &options.name, options.comment.as_deref())
        }
    }
}

fn clean_sql_option(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_string()
}

fn build_database_charset_sql(options: &DatabasePropertyEditSqlOptions) -> Result<String, String> {
    if !supports_database_property_charset(options.database_type, options.driver_profile.as_deref()) {
        return Err(format!(
            "Editing database charset/collation is not supported for {}.",
            database_label(options.database_type)
        ));
    }
    let charset = clean_sql_option(options.charset.as_deref());
    let collation = clean_sql_option(options.collation.as_deref());
    if charset.is_empty() && collation.is_empty() {
        return Err("At least one charset or collation value is required.".to_string());
    }
    let mut sql = format!("ALTER DATABASE {}", quote_admin_identifier(options.database_type, &options.name));
    if !charset.is_empty() {
        sql.push_str(&format!(" DEFAULT CHARACTER SET {charset}"));
    }
    if !collation.is_empty() {
        sql.push_str(&format!(" DEFAULT COLLATE {collation}"));
    }
    sql.push(';');
    Ok(sql)
}

fn build_database_comment_sql(
    database_type: Option<DatabaseType>,
    name: &str,
    comment: Option<&str>,
) -> Result<String, String> {
    if !supports_database_property_comment(database_type) {
        return Err(format!("Editing database comments is not supported for {}.", database_label(database_type)));
    }
    Ok(format!("COMMENT ON DATABASE {} IS {};", quote_admin_identifier(database_type, name), comment_literal(comment)))
}

fn build_schema_comment_sql(
    database_type: Option<DatabaseType>,
    name: &str,
    comment: Option<&str>,
) -> Result<String, String> {
    if !supports_database_property_comment(database_type) {
        return Err(format!("Editing schema comments is not supported for {}.", database_label(database_type)));
    }
    Ok(format!("COMMENT ON SCHEMA {} IS {};", quote_admin_identifier(database_type, name), comment_literal(comment)))
}

pub fn build_create_schema_sql(options: SchemaNameSqlOptions) -> Result<String, String> {
    if !supports_create_schema_target(options.database_type) {
        return Err(format!("Creating schemas is not supported for {}.", database_label(options.database_type)));
    }
    Ok(format!("CREATE SCHEMA {};", quote_admin_identifier(options.database_type, &options.name)))
}

pub fn build_drop_schema_sql(options: SchemaNameSqlOptions) -> String {
    let schema = quote_admin_identifier(options.database_type, &options.name);
    format!("DROP SCHEMA {schema} CASCADE;")
}

fn quote_duplicate_table_comment(_database_type: DatabaseType, comment: &str) -> String {
    format!("'{}'", comment.replace('\'', "''"))
}

pub fn build_duplicate_table_structure_sql(options: DuplicateTableStructureSqlOptions) -> String {
    let source = qualified_name(options.database_type, options.schema.as_deref(), &options.source_name);
    let target =
        qualified_duplicate_target_name(options.database_type, options.schema.as_deref(), &options.target_name);
    let structure_sql = format!("CREATE TABLE {target} (LIKE {source} INCLUDING ALL);");

    let mut comment_sql = Vec::new();
    if let Some(database_type) =
        options.database_type.filter(|database_type| supports_duplicate_table_comment(*database_type))
    {
        if let Some(comment) = options.table_comment.as_deref().filter(|comment| !comment.trim().is_empty()) {
            comment_sql.push(format!(
                "COMMENT ON TABLE {target} IS {}",
                quote_duplicate_table_comment(database_type, comment)
            ));
        }
    }
    if comment_sql.is_empty() {
        return structure_sql;
    }
    format!("{};\n{};", structure_sql.trim_end_matches(';'), comment_sql.join(";\n"))
}

pub fn build_copy_table_data_sql(options: CopyTableDataSqlOptions) -> String {
    let source = qualified_name(options.database_type, options.schema.as_deref(), &options.source_name);
    let target = if options.normalize_new_target_name {
        qualified_duplicate_target_name(options.database_type, options.schema.as_deref(), &options.target_name)
    } else {
        qualified_name(options.database_type, options.schema.as_deref(), &options.target_name)
    };
    let Some(columns) = options.columns.filter(|columns| !columns.is_empty()) else {
        return format!("INSERT INTO {target} SELECT * FROM {source};");
    };
    let column_list = columns
        .iter()
        .map(|column| quote_admin_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let postgres_override = if options.postgres_overriding_system_value
        && matches!(options.database_type, Some(DatabaseType::Postgres | DatabaseType::Opengauss))
    {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };
    format!("INSERT INTO {target} ({column_list}){postgres_override} SELECT {column_list} FROM {source};")
}

pub fn supports_object_rename(database_type: Option<DatabaseType>, object_type: DatabaseObjectType) -> bool {
    let Some(database_type) = database_type else {
        return false;
    };
    if matches!(object_type, DatabaseObjectType::Procedure | DatabaseObjectType::Function) {
        return false;
    }
    if is_postgres_like_rename(database_type) || is_oracle_like_rename(database_type) {
        return matches!(
            object_type,
            DatabaseObjectType::Table | DatabaseObjectType::View | DatabaseObjectType::MaterializedView
        );
    }
    false
}

pub fn build_rename_object_sql(options: RenameObjectSqlOptions) -> Result<String, String> {
    let database_type = options.database_type;
    if !supports_object_rename(database_type, options.object_type) {
        return Err(format!(
            "Renaming {} is not supported for {}.",
            object_type_keyword(options.object_type),
            database_label(database_type)
        ));
    }

    if database_type
        .is_some_and(|database_type| is_postgres_like_rename(database_type) || is_oracle_like_rename(database_type))
    {
        return Ok(format!(
            "ALTER {} {} RENAME TO {};",
            object_type_keyword(options.object_type),
            qualified_name(database_type, options.schema.as_deref(), &options.old_name),
            quote_admin_identifier(database_type, &options.new_name)
        ));
    }

    Err(format!(
        "Renaming {} is not supported for {}.",
        object_type_keyword(options.object_type),
        database_label(database_type)
    ))
}

fn is_postgres_like_rename(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::Opengauss)
}

fn is_oracle_like_rename(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Opengauss)
}

fn supports_duplicate_table_comment(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::Opengauss)
}

fn quote_rename_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    quote_table_identifier(database_type, name)
}

fn qualified_name(database_type: Option<DatabaseType>, schema: Option<&str>, name: &str) -> String {
    if database_type.is_some_and(is_schema_aware) && schema.is_some_and(|schema| !schema.is_empty()) {
        format!(
            "{}.{}",
            quote_admin_identifier(database_type, schema.unwrap()),
            quote_admin_identifier(database_type, name)
        )
    } else {
        quote_admin_identifier(database_type, name)
    }
}

fn qualified_duplicate_target_name(database_type: Option<DatabaseType>, schema: Option<&str>, name: &str) -> String {
    qualified_name(database_type, schema, name)
}

fn object_type_keyword(object_type: DatabaseObjectType) -> &'static str {
    match object_type {
        DatabaseObjectType::Table => "TABLE",
        DatabaseObjectType::View => "VIEW",
        DatabaseObjectType::MaterializedView => "MATERIALIZED VIEW",
        DatabaseObjectType::Procedure => "PROCEDURE",
        DatabaseObjectType::Function => "FUNCTION",
        DatabaseObjectType::Sequence => "SEQUENCE",
        DatabaseObjectType::Synonym => "SYNONYM",
        DatabaseObjectType::Package => "PACKAGE",
        DatabaseObjectType::PackageBody => "PACKAGE BODY",
        DatabaseObjectType::Type => "TYPE",
        DatabaseObjectType::TypeBody => "TYPE BODY",
        DatabaseObjectType::Job => "JOB",
        DatabaseObjectType::Scheduler => "SCHEDULER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_postgres_create_database_sql() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE analytics;"
        );
    }

    #[test]
    fn builds_opengauss_create_database_sql() {
        assert_eq!(
            build_create_database_sql(CreateDatabaseSqlOptions {
                database_type: Some(DatabaseType::Opengauss),
                driver_profile: None,
                target: None,
                parent: None,
                name: "analytics".to_string(),
                charset: None,
                collation: None,
            })
            .unwrap(),
            "CREATE DATABASE analytics;"
        );
    }

    #[test]
    fn builds_drop_table_sql_for_postgres() {
        assert_eq!(
            build_drop_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                cascade: Some(true),
            }),
            "DROP TABLE public.users CASCADE;"
        );
    }

    #[test]
    fn builds_truncate_table_sql_for_postgres() {
        assert_eq!(
            build_truncate_table_sql(TableAdminSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                ..Default::default()
            }),
            "TRUNCATE TABLE public.users;"
        );
    }
}
