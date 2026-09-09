fn uses_oracle_row_id(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::OpenGauss))
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{quote_table_identifier, table_pagination_strategy, TablePaginationStrategy};
use crate::transfer::{format_ch_array_sql_literal, format_pg_array_sql_literal};

const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
const DATA_GRID_COLUMN_DISTINCT_VALUES_DEFAULT_LIMIT: usize = 1000;
const DATA_GRID_COLUMN_DISTINCT_VALUES_MAX_LIMIT: usize = 1000;
const MYSQL_DATA_GRID_BATCH_MAX_ROWS: usize = 500;
const MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct DataGridTableMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    /// Doris / StarRocks multi-catalog: the database under the external
    /// catalog, used as the middle segment of the 3-part qualified name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<DataGridColumnInfo>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct DataGridColumnInfo {
    pub name: String,
    #[serde(default)]
    pub data_type: String,
    #[serde(default)]
    pub is_nullable: bool,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub column_default: Option<String>,
    #[serde(default)]
    pub extra: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataGridSaveStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    pub table_meta: DataGridTableMeta,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub dirty_rows: Vec<(usize, Vec<(usize, Value)>)>,
    #[serde(default)]
    pub deleted_rows: Vec<usize>,
    #[serde(default)]
    pub new_rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCopyUpdateStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub table_meta: DataGridTableMeta,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCopyInsertStatementOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_meta: Option<DataGridTableMeta>,
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_types: Option<Vec<Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_columns: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub exclude_primary_keys: bool,
    #[serde(default)]
    pub include_computed_columns: bool,
    #[serde(default)]
    pub insert_mode: DataGridCopyInsertMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridCopyInsertMode {
    #[default]
    Merged,
    RowByRow,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataGridContextFilterMode {
    Equals,
    NotEquals,
    IsNull,
    IsNotNull,
    Like,
    NotLike,
    LessThan,
    GreaterThan,
    In,
    NotIn,
    Between,
    NotBetween,
}

fn supports_data_grid_context_filter_mode(
    database_type: Option<DatabaseType>,
    mode: DataGridContextFilterMode,
) -> bool {
    !matches!(
        (database_type, mode),
        (
            Some(DatabaseType::Jdbc),
            DataGridContextFilterMode::In
                | DataGridContextFilterMode::NotIn
                | DataGridContextFilterMode::Between
                | DataGridContextFilterMode::NotBetween
        )
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridContextFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    pub column_name: String,
    pub mode: DataGridContextFilterMode,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnValueFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    pub raw_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnValuesFilterConditionOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    #[serde(default)]
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridColumnDistinctValuesSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub column_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_info: Option<DataGridColumnInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_counts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridCountSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    /// Doris / StarRocks multi-catalog: the database under the external
    /// catalog, used as the middle segment of the 3-part qualified name when
    /// `schema` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HiveTablePropertiesSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    pub property_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataGridSavePreparation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_error: Option<String>,
    pub statements: Vec<String>,
    pub rollback_statements: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_schema: Option<String>,
}

pub fn prepare_data_grid_save(options: DataGridSaveStatementOptions) -> DataGridSavePreparation {
    let validation_error = validate_data_grid_save(&options);
    if validation_error.is_some() {
        return DataGridSavePreparation {
            validation_error,
            statements: Vec::new(),
            rollback_statements: Vec::new(),
            execution_schema: data_grid_save_execution_schema(options.database_type, &options.table_meta),
        };
    }

    DataGridSavePreparation {
        validation_error: None,
        statements: build_data_grid_save_statements(&options),
        rollback_statements: build_data_grid_rollback_statements(&options),
        execution_schema: data_grid_save_execution_schema(options.database_type, &options.table_meta),
    }
}

/// Relational SQL UPDATE/WHERE predicates are not meaningful for graph,
/// document, or time-series stores that don't speak relational SQL.
pub(crate) fn supports_relational_copy_predicates(_database_type: Option<DatabaseType>) -> bool {
    true
}

pub fn build_data_grid_copy_update_statements(options: DataGridCopyUpdateStatementOptions) -> Vec<String> {
    if !supports_relational_copy_predicates(options.database_type) {
        return Vec::new();
    }
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() {
        return Vec::new();
    }

    let save_columns = effective_copy_columns(options.source_columns.as_deref(), &options.columns);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
    if primary_key_indexes.iter().any(Option::is_none) {
        return Vec::new();
    }
    let primary_key_indexes: Vec<usize> = primary_key_indexes.into_iter().flatten().collect();
    let primary_key_set: Vec<String> =
        primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();
    let writable_indexes: Vec<(&str, usize, Option<&DataGridColumnInfo>)> = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, index)))
        .filter(|(column, _)| !primary_key_set.contains(&normalize_column_name(column)))
        .filter(|(column, _)| !is_oracle_row_id(options.database_type, Some(column)))
        .map(|(column, index)| (column, index, column_info_for(column_info, column)))
        .collect();
    let primary_key_info =
        primary_keys.iter().map(|primary_key| column_info_for(column_info, primary_key)).collect::<Vec<_>>();

    if writable_indexes.is_empty() {
        return Vec::new();
    }

    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        None,
    );
    let mut statements = Vec::new();
    for row in &options.rows {
        if primary_key_indexes.iter().any(|index| row.get(*index).unwrap_or(&Value::Null).is_null()) {
            continue;
        }
        let sets = writable_indexes
            .iter()
            .map(|(column, index, info)| {
                format!(
                    "{} = {}",
                    data_grid_identifier(options.database_type, column, None),
                    format_grid_sql_literal(row.get(*index).unwrap_or(&Value::Null), options.database_type, *info)
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let where_clause = primary_keys
            .iter()
            .enumerate()
            .map(|(index, primary_key)| {
                build_column_predicate(
                    options.database_type,
                    primary_key,
                    row.get(primary_key_indexes[index]).unwrap_or(&Value::Null),
                    primary_key_info[index],
                    false,
                    None,
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        statements.push(data_grid_statement(
            options.database_type,
            data_grid_update_sql(options.database_type, &table, &sets, &where_clause),
        ));
    }
    statements
}

pub fn build_data_grid_copy_insert_statement(options: DataGridCopyInsertStatementOptions) -> Option<String> {
    let save_columns = effective_copy_columns(options.source_columns.as_deref(), &options.columns);
    let column_info = options.table_meta.as_ref().and_then(|meta| meta.columns.as_deref()).unwrap_or(&[]);
    let primary_key_set: Vec<String> = options
        .table_meta
        .as_ref()
        .map(|meta| meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect())
        .unwrap_or_default();
    let insertable_columns: Vec<(&str, usize, Option<DataGridColumnInfo>)> = save_columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| Some((column.as_deref()?, index)))
        .map(|(column, index)| {
            let fallback_type =
                options.column_types.as_deref().and_then(|types| types.get(index)).and_then(|value| value.as_deref());
            (column, index, copy_column_info(column_info, column, fallback_type))
        })
        .filter(|(column, _, info)| {
            !is_grid_insert_omitted_column(
                options.database_type,
                info.as_ref(),
                Some(column),
                options.include_computed_columns,
            )
        })
        .collect();
    let insert_columns: Vec<(&str, usize, Option<DataGridColumnInfo>)> = insertable_columns
        .iter()
        .filter(|(column, _, _)| {
            !options.exclude_primary_keys || !primary_key_set.contains(&normalize_column_name(column))
        })
        .cloned()
        .collect();

    if insert_columns.is_empty() || options.rows.is_empty() {
        return None;
    }

    let table = options.table_meta.as_ref().map_or_else(
        || "table_name".to_string(),
        |meta| {
            crate::sql_dialect::qualified_table_name_with_catalog(
                options.database_type,
                meta.catalog.as_deref(),
                meta.schema.as_deref(),
                meta.database.as_deref(),
                &meta.table_name,
            )
        },
    );
    let columns = insert_columns
        .iter()
        .map(|(column, _, _)| quote_ident(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let value_rows = options
        .rows
        .iter()
        .map(|row| {
            format!(
                "({})",
                insert_columns
                    .iter()
                    .map(|(_, index, info)| {
                        format_grid_copy_insert_sql_literal(
                            row.get(*index).unwrap_or(&Value::Null),
                            options.database_type,
                            info.as_ref(),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>();
    if options.insert_mode == DataGridCopyInsertMode::RowByRow {
        return Some(
            value_rows
                .iter()
                .map(|values| format!("INSERT INTO {table} ({columns}) VALUES {values};"))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    Some(format!(
        "INSERT INTO {table} ({columns}) VALUES{}{};",
        if value_rows.len() == 1 { " " } else { "\n" },
        value_rows.join(",\n")
    ))
}

pub fn build_data_grid_context_filter_condition(options: DataGridContextFilterConditionOptions) -> Option<String> {
    if !supports_data_grid_context_filter_mode(options.database_type, options.mode) {
        return None;
    }

    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    let like_column = column_like_filter_ref(
        options.database_type,
        &options.column_name,
        options.column_info.as_ref(),
        options.identifier_quote.as_deref(),
    );
    let value = &options.value;
    match options.mode {
        DataGridContextFilterMode::IsNull => Some(format!("{column} IS NULL")),
        DataGridContextFilterMode::IsNotNull => Some(format!("{column} IS NOT NULL")),
        DataGridContextFilterMode::Equals if value.is_null() => Some(format!("{column} IS NULL")),
        DataGridContextFilterMode::NotEquals if value.is_null() => Some(format!("{column} IS NOT NULL")),
        DataGridContextFilterMode::Like => Some(format!(
            "{like_column} LIKE {}",
            format_grid_sql_literal(
                &Value::String(format!("%{}%", value_to_filter_text(value))),
                options.database_type,
                None
            )
        )),
        DataGridContextFilterMode::NotLike => Some(format!(
            "{like_column} NOT LIKE {}",
            format_grid_sql_literal(
                &Value::String(format!("%{}%", value_to_filter_text(value))),
                options.database_type,
                None
            )
        )),
        DataGridContextFilterMode::LessThan => Some(format!(
            "{column} < {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::GreaterThan => Some(format!(
            "{column} > {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::In => build_data_grid_context_membership_filter_condition(
            &column,
            &options.values,
            options.database_type,
            options.column_info.as_ref(),
            false,
        ),
        DataGridContextFilterMode::NotIn => build_data_grid_context_membership_filter_condition(
            &column,
            &options.values,
            options.database_type,
            options.column_info.as_ref(),
            true,
        ),
        DataGridContextFilterMode::Between => build_data_grid_context_range_filter_condition(
            &column,
            value,
            options.end_value.as_ref(),
            options.database_type,
            options.column_info.as_ref(),
            false,
        ),
        DataGridContextFilterMode::NotBetween => build_data_grid_context_range_filter_condition(
            &column,
            value,
            options.end_value.as_ref(),
            options.database_type,
            options.column_info.as_ref(),
            true,
        ),
        DataGridContextFilterMode::Equals => Some(format!(
            "{column} = {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
        DataGridContextFilterMode::NotEquals => Some(format!(
            "{column} <> {}",
            format_grid_sql_literal(value, options.database_type, options.column_info.as_ref())
        )),
    }
}

fn build_data_grid_context_membership_filter_condition(
    column: &str,
    values: &[Value],
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    negated: bool,
) -> Option<String> {
    if values.is_empty() {
        return None;
    }

    let mut has_null = false;
    let mut literals = Vec::new();
    let mut seen_literals = HashSet::new();
    for value in values {
        if value.is_null() {
            has_null = true;
            continue;
        }
        let literal = format_grid_sql_literal(value, database_type, column_info);
        if seen_literals.insert(literal.clone()) {
            literals.push(literal);
        }
    }

    let membership = build_membership_predicate(column, &literals, database_type, negated);

    if negated {
        return match membership {
            Some(membership) => Some(format!("({column} IS NOT NULL AND {membership})")),
            None if has_null => Some(format!("{column} IS NOT NULL")),
            None => None,
        };
    }

    match membership {
        Some(membership) if has_null => Some(format!("({column} IS NULL OR {membership})")),
        Some(membership) => Some(membership),
        None if has_null => Some(format!("{column} IS NULL")),
        None => None,
    }
}

fn build_membership_predicate(
    column: &str,
    literals: &[String],
    _database_type: Option<DatabaseType>,
    negated: bool,
) -> Option<String> {
    if literals.is_empty() {
        return None;
    }

    let operator = if negated { "NOT IN" } else { "IN" };
    Some(format!("{column} {operator} ({})", literals.join(", ")))
}

fn build_data_grid_context_range_filter_condition(
    column: &str,
    start_value: &Value,
    end_value: Option<&Value>,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    negated: bool,
) -> Option<String> {
    let end_value = end_value?;
    if start_value.is_null() || end_value.is_null() {
        return None;
    }
    let start = format_grid_sql_literal(start_value, database_type, column_info);
    let end = format_grid_sql_literal(end_value, database_type, column_info);

    let operator = if negated { "NOT BETWEEN" } else { "BETWEEN" };
    Some(format!("{column} {operator} {start} AND {end}"))
}

pub fn build_data_grid_column_value_filter_condition(
    options: DataGridColumnValueFilterConditionOptions,
) -> Option<String> {
    let text = options.raw_value.trim();
    if text.is_empty() {
        return None;
    }
    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    if text.eq_ignore_ascii_case("null") {
        return Some(format!("{column} IS NULL"));
    }
    let value = parse_typed_filter_value(text, options.database_type, options.column_info.as_ref());
    Some(format!("{column} = {}", format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())))
}

pub fn build_data_grid_column_values_filter_condition(
    options: DataGridColumnValuesFilterConditionOptions,
) -> Option<String> {
    if options.values.is_empty() {
        return None;
    }

    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    let mut has_null = false;
    let mut literals = Vec::new();
    let mut seen_literals = HashSet::new();
    for value in &options.values {
        if value.is_null() {
            has_null = true;
            continue;
        }
        let literal = format_grid_sql_literal(value, options.database_type, options.column_info.as_ref());
        if seen_literals.insert(literal.clone()) {
            literals.push(literal);
        }
    }

    let mut predicates = Vec::new();
    if has_null {
        predicates.push(format!("{column} IS NULL"));
    }
    if literals.len() == 1 {
        predicates.push(format!("{column} = {}", literals[0]));
    } else if let Some(membership) = build_membership_predicate(&column, &literals, options.database_type, false) {
        predicates.push(membership);
    }

    match predicates.len() {
        0 => None,
        1 => predicates.into_iter().next(),
        _ => Some(format!("({})", predicates.join(" OR "))),
    }
}

pub fn build_data_grid_column_distinct_values_sql(options: DataGridColumnDistinctValuesSqlOptions) -> String {
    let limit = data_grid_column_distinct_values_limit(options.limit);
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.catalog.as_deref(),
        options.schema.as_deref(),
        options.database.as_deref(),
        &options.table_name,
        options.identifier_quote.as_deref(),
    );
    let column = column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
    let mut predicates = Vec::new();
    let predicate = crate::sql_dialect::normalize_where_input(options.where_input.as_deref());
    if !predicate.is_empty() {
        predicates.push(format!("({predicate})"));
    }
    if let Some(search_predicate) = data_grid_column_distinct_values_search_predicate(&options) {
        predicates.push(search_predicate);
    }
    let where_clause =
        if predicates.is_empty() { String::new() } else { format!(" WHERE {}", predicates.join(" AND ")) };
    let select_list = if options.include_counts {
        format!("{column} AS dbx_value, COUNT(*) AS dbx_count")
    } else {
        format!("{column} AS dbx_value")
    };
    let group_by = format!(" GROUP BY {column}");
    let order_by = if options.include_counts { " ORDER BY dbx_count DESC, dbx_value" } else { " ORDER BY dbx_value" };
    let from_clause = format!(" FROM {table}{where_clause}{group_by}{order_by}");

    match table_pagination_strategy(options.database_type) {
        TablePaginationStrategy::LimitOffset => {
            format!("SELECT {select_list}{from_clause} LIMIT {limit}")
        }
        _ => {
            format!("SELECT {select_list}{from_clause}")
        }
    }
}

pub fn build_data_grid_count_sql(options: DataGridCountSqlOptions) -> String {
    let table = if crate::sql_dialect::uses_connection_identifier_quote(
        options.database_type,
        options.identifier_quote.as_deref(),
    ) {
        crate::sql_dialect::table_data_qualified_table_name(
            options.database_type,
            options.schema.as_deref(),
            &options.table_name,
            options.identifier_quote.as_deref(),
        )
    } else {
        crate::sql_dialect::qualified_table_name_with_catalog(
            options.database_type,
            options.catalog.as_deref(),
            options.schema.as_deref(),
            options.database.as_deref(),
            &options.table_name,
        )
    };
    let predicate = crate::sql_dialect::normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    format!("SELECT COUNT(*) AS cnt FROM {table}{where_clause}")
}

pub fn build_hive_table_properties_sql(_options: HiveTablePropertiesSqlOptions) -> String {
    String::new()
}

fn data_grid_column_distinct_values_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DATA_GRID_COLUMN_DISTINCT_VALUES_DEFAULT_LIMIT).clamp(1, DATA_GRID_COLUMN_DISTINCT_VALUES_MAX_LIMIT)
}

fn data_grid_column_distinct_values_search_predicate(
    options: &DataGridColumnDistinctValuesSqlOptions,
) -> Option<String> {
    let search = options.search_value.as_deref()?.trim();
    if search.is_empty() {
        return None;
    }
    if !options.column_info.as_ref().map(|column| is_textual_column_type(&column.data_type)).unwrap_or(true)
        && !is_postgres_like_pattern_database(options.database_type)
    {
        let column =
            column_filter_ref(options.database_type, &options.column_name, options.identifier_quote.as_deref());
        let value = parse_typed_filter_value(search, options.database_type, options.column_info.as_ref());
        return Some(format!(
            "{column} = {}",
            format_grid_sql_literal(&value, options.database_type, options.column_info.as_ref())
        ));
    }
    let column = column_like_filter_ref(
        options.database_type,
        &options.column_name,
        options.column_info.as_ref(),
        options.identifier_quote.as_deref(),
    );
    let pattern = Value::String(format!("%{search}%"));
    Some(format!("{column} LIKE {}", format_grid_sql_literal(&pattern, options.database_type, None)))
}

fn validate_data_grid_save(options: &DataGridSaveStatementOptions) -> Option<String> {
    if let Some(error) = validate_inserted_primary_keys(options) {
        return Some(error);
    }

    if let Some(error) = validate_existing_row_primary_keys(options) {
        return Some(error);
    }

    let save_columns = effective_columns(options);
    let not_null_columns: Vec<String> = options
        .table_meta
        .columns
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|column| {
            !column.is_nullable
                && column.column_default.is_none()
                && !is_auto_generated_column(column)
                && !is_non_identity_generated_column(Some(column))
                && !is_oracle_row_id(options.database_type, Some(&column.name))
        })
        .map(|column| normalize_column_name(&column.name))
        .collect();

    if not_null_columns.is_empty() {
        return None;
    }

    for (_, changes) in &options.dirty_rows {
        for (column_index, value) in changes {
            let source_column = save_columns.get(*column_index).and_then(|column| column.as_deref());
            if is_null_write_to_not_null_column(options.database_type, &not_null_columns, source_column, value) {
                return Some(null_write_error(source_column.unwrap_or_default()));
            }
        }
    }

    // MySQL BEFORE INSERT triggers can populate omitted NOT NULL columns. New-row NULL values are
    // omitted from the generated INSERT, so let MySQL apply triggers or report missing required fields.
    if true {
        for row in &options.new_rows {
            for column_index in 0..options.columns.len() {
                let source_column = save_columns.get(column_index).and_then(|column| column.as_deref());
                if is_null_write_to_not_null_column(
                    options.database_type,
                    &not_null_columns,
                    source_column,
                    row.get(column_index).unwrap_or(&Value::Null),
                ) {
                    return Some(null_write_error(source_column.unwrap_or_default()));
                }
            }
        }
    }

    None
}

fn validate_existing_row_primary_keys(options: &DataGridSaveStatementOptions) -> Option<String> {
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() || (options.dirty_rows.is_empty() && options.deleted_rows.is_empty()) {
        return None;
    }

    let save_columns = effective_columns(options);
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
    let missing_primary_keys = primary_keys
        .iter()
        .zip(&primary_key_indexes)
        .filter_map(|(primary_key, index)| index.is_none().then_some(primary_key.as_str()))
        .collect::<Vec<_>>();
    if !missing_primary_keys.is_empty() {
        return Some(format!(
            "Cannot safely update or delete rows because the query result does not include every primary key column (missing: {}). Refresh or rerun the query before saving.",
            missing_primary_keys.join(", ")
        ));
    }

    let primary_key_indexes = primary_key_indexes.into_iter().flatten().collect::<Vec<_>>();
    for row_index in
        options.dirty_rows.iter().map(|(row_index, _)| *row_index).chain(options.deleted_rows.iter().copied())
    {
        let Some(row) = options.rows.get(row_index) else {
            continue;
        };
        if let Some((primary_key, _)) =
            primary_keys.iter().zip(&primary_key_indexes).find(|(_, index)| row.get(**index).is_none_or(Value::is_null))
        {
            return Some(format!(
                "Cannot safely update or delete rows because primary key column \"{primary_key}\" has no value in the query result. Refresh or rerun the query before saving."
            ));
        }
    }

    None
}

fn validate_inserted_primary_keys(options: &DataGridSaveStatementOptions) -> Option<String> {
    let primary_keys = &options.table_meta.primary_keys;
    if primary_keys.is_empty() || options.new_rows.is_empty() {
        return None;
    }

    let save_columns = effective_columns(options);
    let primary_key_indexes: Vec<Option<usize>> = primary_keys
        .iter()
        .map(|primary_key| find_column_index(options.database_type, &save_columns, primary_key))
        .collect();
    if primary_key_indexes.iter().any(Option::is_none) {
        return None;
    }
    let primary_key_indexes: Vec<usize> = primary_key_indexes.into_iter().flatten().collect();

    let mut existing_keys: Vec<String> = Vec::new();
    for row in &options.rows {
        if let Some(key) = primary_key_value_key(&primary_key_indexes, row) {
            existing_keys.push(key);
        }
    }

    let mut new_keys: Vec<String> = Vec::new();
    for row in &options.new_rows {
        let Some(key) = primary_key_value_key(&primary_key_indexes, row) else {
            continue;
        };
        if existing_keys.contains(&key) || new_keys.contains(&key) {
            return Some(duplicate_primary_key_error(
                primary_keys,
                &primary_key_indexes,
                row,
                existing_keys.contains(&key),
            ));
        }
        new_keys.push(key);
    }

    None
}

fn build_data_grid_save_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        options.identifier_quote.as_deref(),
    );
    let mut statements = Vec::new();
    let primary_key_set: Vec<String> =
        options.table_meta.primary_keys.iter().map(|primary_key| normalize_column_name(primary_key)).collect();

    let batch_mysql_writes = supports_mysql_data_grid_batch(options);
    let mut update_sets: Option<String> = None;
    let mut update_predicates = Vec::new();
    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let sets = changes
            .iter()
            .filter_map(|(column_index, value)| {
                let column = save_columns.get(*column_index)?.as_deref()?;
                if is_grid_update_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    &primary_key_set,
                ) {
                    return None;
                }
                Some(format!(
                    "{} = {}",
                    data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()),
                    format_grid_save_sql_literal(value, options.database_type, column_info_for(column_info, column))
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let where_clause = build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            row,
            column_info,
            options.identifier_quote.as_deref(),
        );
        if batch_mysql_writes {
            if update_sets.as_deref().is_some_and(|current| current != sets) {
                let current_sets = update_sets.take().unwrap_or_default();
                push_mysql_predicate_batches(
                    &mut statements,
                    &format!("UPDATE {table} SET {current_sets} WHERE "),
                    std::mem::take(&mut update_predicates),
                );
            }
            update_sets = Some(sets);
            update_predicates.push(where_clause);
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                data_grid_update_sql(options.database_type, &table, &sets, &where_clause),
            ));
        }
    }
    if let Some(sets) = update_sets {
        push_mysql_predicate_batches(&mut statements, &format!("UPDATE {table} SET {sets} WHERE "), update_predicates);
    }

    let mut delete_predicates = Vec::new();
    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let where_clause = build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            row,
            column_info,
            options.identifier_quote.as_deref(),
        );
        if batch_mysql_writes {
            delete_predicates.push(where_clause);
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                data_grid_delete_sql(options.database_type, &table, &where_clause),
            ));
        }
    }
    if !delete_predicates.is_empty() {
        push_mysql_predicate_batches(&mut statements, &format!("DELETE FROM {table} WHERE "), delete_predicates);
    }

    for row in &options.new_rows {
        if false {
            if let Some(statement) = build_hive_values_insert(options, &table, &save_columns, row, true, true) {
                statements.push(data_grid_statement(options.database_type, statement));
            }
            continue;
        }
        let insert_pairs: Vec<(&str, &Value)> = save_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
            .filter(|(column, value)| {
                let column_info = column_info_for(column_info, column);
                // Empty generated values must be omitted so the database can apply AUTO_INCREMENT/IDENTITY semantics.
                !column_info.is_some_and(is_auto_generated_column) || !grid_value_is_empty(value)
            })
            .filter(|(column, _)| {
                !is_grid_insert_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    false,
                )
            })
            .filter(|(_, value)| !value.is_null())
            .collect();
        if insert_pairs.is_empty() {
            if false {
                statements
                    .push(data_grid_statement(options.database_type, format!("INSERT INTO {table} () VALUES ()")));
            }
            continue;
        }
        let columns = insert_pairs
            .iter()
            .map(|(column, _)| data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()))
            .collect::<Vec<_>>()
            .join(", ");
        let values = insert_pairs
            .iter()
            .map(|(column, value)| {
                format_grid_save_sql_literal(value, options.database_type, column_info_for(column_info, column))
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(data_grid_statement(
            options.database_type,
            format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
        ));
    }

    statements
}

fn build_data_grid_rollback_statements(options: &DataGridSaveStatementOptions) -> Vec<String> {
    let save_columns = effective_columns(options);
    let column_info = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let table = data_grid_qualified_table_name(
        options.database_type,
        options.table_meta.catalog.as_deref(),
        options.table_meta.schema.as_deref(),
        options.table_meta.database.as_deref(),
        &options.table_meta.table_name,
        options.identifier_quote.as_deref(),
    );
    let mut statements = Vec::new();

    for row in &options.new_rows {
        let where_clause = if false {
            build_mysql_insert_rollback_where(options, &save_columns, row, column_info)
        } else {
            let where_clause = build_save_row_where(
                options.database_type,
                &save_columns,
                row,
                column_info,
                options.identifier_quote.as_deref(),
            );
            (!where_clause.is_empty()).then_some(where_clause)
        };
        if let Some(where_clause) = where_clause {
            statements
                .push(data_grid_statement(options.database_type, format!("DELETE FROM {table} WHERE {where_clause}")));
        }
    }

    let batch_mysql_writes = supports_mysql_data_grid_batch(options);
    let mut deleted_insert_columns: Option<String> = None;
    let mut deleted_insert_values = Vec::new();
    for row_index in &options.deleted_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        if false {
            if let Some(statement) = build_hive_values_insert(options, &table, &save_columns, row, false, false) {
                statements.push(data_grid_statement(options.database_type, statement));
            }
            continue;
        }
        let insert_pairs: Vec<(&str, &Value)> = save_columns
            .iter()
            .enumerate()
            .filter_map(|(index, column)| Some((column.as_deref()?, row.get(index).unwrap_or(&Value::Null))))
            .filter(|(column, _)| {
                !is_grid_insert_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    false,
                )
            })
            .collect();
        let columns = insert_pairs
            .iter()
            .map(|(column, _)| data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()))
            .collect::<Vec<_>>()
            .join(", ");
        let values = insert_pairs
            .iter()
            .map(|(column, value)| {
                format_grid_sql_literal(value, options.database_type, column_info_for(column_info, column))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if batch_mysql_writes {
            if deleted_insert_columns.as_deref().is_some_and(|current| current != columns) {
                let current_columns = deleted_insert_columns.take().unwrap_or_default();
                push_mysql_values_insert_batches(
                    &mut statements,
                    &table,
                    &current_columns,
                    std::mem::take(&mut deleted_insert_values),
                );
            }
            deleted_insert_columns = Some(columns);
            deleted_insert_values.push(format!("({values})"));
        } else {
            statements.push(data_grid_statement(
                options.database_type,
                format!("INSERT INTO {table} ({columns}) VALUES ({values})"),
            ));
        }
    }
    if let Some(columns) = deleted_insert_columns {
        push_mysql_values_insert_batches(&mut statements, &table, &columns, deleted_insert_values);
    }

    for (row_index, changes) in &options.dirty_rows {
        let Some(row) = options.rows.get(*row_index) else {
            continue;
        };
        let mut after_row = row.clone();
        for (column_index, value) in changes {
            if *column_index < after_row.len() {
                after_row[*column_index] = value.clone();
            }
        }
        let writable_changes: Vec<(&(usize, Value), &str)> = changes
            .iter()
            .filter_map(|change @ (column_index, _)| {
                let column = save_columns.get(*column_index)?.as_deref()?;
                if is_grid_update_omitted_column(
                    options.database_type,
                    column_info_for(column_info, column),
                    Some(column),
                    &[],
                ) {
                    return None;
                }
                Some((change, column))
            })
            .collect();
        let sets = writable_changes
            .iter()
            .map(|((column_index, _), column)| {
                format!(
                    "{} = {}",
                    data_grid_identifier(options.database_type, column, options.identifier_quote.as_deref()),
                    format_grid_sql_literal(
                        row.get(*column_index).unwrap_or(&Value::Null),
                        options.database_type,
                        column_info_for(column_info, column)
                    )
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if sets.is_empty() {
            continue;
        }
        let mut predicates = vec![build_primary_key_where(
            options.database_type,
            &options.table_meta.primary_keys,
            &save_columns,
            &after_row,
            column_info,
            options.identifier_quote.as_deref(),
        )];
        predicates.extend(writable_changes.iter().map(|((_, value), column)| {
            build_save_column_predicate(
                options.database_type,
                column,
                value,
                column_info_for(column_info, column),
                true,
                options.identifier_quote.as_deref(),
            )
        }));
        statements.push(data_grid_statement(
            options.database_type,
            format!(
                "UPDATE {table} SET {sets} WHERE {}",
                predicates.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" AND ")
            ),
        ));
    }

    statements
}

fn supports_mysql_data_grid_batch(_options: &DataGridSaveStatementOptions) -> bool {
    // Keyless rows use full-row predicates, which are too wide and ambiguous to combine safely.
    false
}

fn push_mysql_predicate_batches(statements: &mut Vec<String>, prefix: &str, predicates: Vec<String>) {
    push_mysql_joined_batches(statements, prefix, predicates, " OR ", true);
}

fn push_mysql_values_insert_batches(
    statements: &mut Vec<String>,
    table: &str,
    columns: &str,
    value_tuples: Vec<String>,
) {
    push_mysql_joined_batches(
        statements,
        &format!("INSERT INTO {table} ({columns}) VALUES "),
        value_tuples,
        ", ",
        false,
    );
}

fn push_mysql_joined_batches(
    statements: &mut Vec<String>,
    prefix: &str,
    parts: Vec<String>,
    separator: &str,
    wrap_multiple_parts: bool,
) {
    let mut batch = Vec::new();
    for part in parts {
        let next_len = joined_batch_sql_len(prefix, &batch, &part, separator, wrap_multiple_parts);
        if !batch.is_empty()
            && (batch.len() >= MYSQL_DATA_GRID_BATCH_MAX_ROWS || next_len > MYSQL_DATA_GRID_BATCH_TARGET_SQL_BYTES)
        {
            push_mysql_joined_batch_statement(
                statements,
                prefix,
                std::mem::take(&mut batch),
                separator,
                wrap_multiple_parts,
            );
        }
        batch.push(part);
    }
    if !batch.is_empty() {
        push_mysql_joined_batch_statement(statements, prefix, batch, separator, wrap_multiple_parts);
    }
}

fn joined_batch_sql_len(
    prefix: &str,
    current: &[String],
    next: &str,
    separator: &str,
    wrap_multiple_parts: bool,
) -> usize {
    let part_bytes = |part: &str| part.len() + usize::from(wrap_multiple_parts) * 2;
    if current.is_empty() {
        return prefix.len() + next.len() + 1;
    }
    let current_bytes = if current.len() == 1 && wrap_multiple_parts {
        current[0].len()
    } else {
        current.iter().map(|part| part_bytes(part)).sum::<usize>() + separator.len() * current.len().saturating_sub(1)
    };
    let existing_adjustment = if current.len() == 1 && wrap_multiple_parts { 2 } else { 0 };
    prefix.len() + current_bytes + existing_adjustment + separator.len() + part_bytes(next) + 1
}

fn push_mysql_joined_batch_statement(
    statements: &mut Vec<String>,
    prefix: &str,
    parts: Vec<String>,
    separator: &str,
    wrap_multiple_parts: bool,
) {
    let body = if parts.len() == 1 || !wrap_multiple_parts {
        parts.join(separator)
    } else {
        parts.into_iter().map(|part| format!("({part})")).collect::<Vec<_>>().join(separator)
    };
    statements.push(format!("{prefix}{body};"));
}

fn build_mysql_insert_rollback_where(
    options: &DataGridSaveStatementOptions,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
) -> Option<String> {
    if options.table_meta.primary_keys.is_empty() {
        return None;
    }

    for primary_key in &options.table_meta.primary_keys {
        let index = columns.iter().position(|column| column.as_deref() == Some(primary_key.as_str()))?;
        let value = row.get(index).unwrap_or(&Value::Null);
        let info = column_info_for(column_info, primary_key);
        if value.is_null()
            || empty_string_saves_as_null(value, info)
            || info.is_some_and(is_auto_generated_column)
            || info.is_some_and(|column| is_non_identity_generated_column(Some(column)))
        {
            // Generated or trigger-populated keys are unknown until after INSERT.
            // Do not emit a rollback predicate that cannot match the inserted row.
            return None;
        }
    }

    Some(build_primary_key_where(
        options.database_type,
        &options.table_meta.primary_keys,
        columns,
        row,
        column_info,
        options.identifier_quote.as_deref(),
    ))
}

pub(crate) fn effective_columns(options: &DataGridSaveStatementOptions) -> Vec<Option<String>> {
    let columns = match &options.source_columns {
        Some(source_columns) if source_columns.len() == options.columns.len() => source_columns.clone(),
        _ => options.columns.iter().map(|column| Some(column.clone())).collect(),
    };
    if true {
        return columns;
    }
    columns
        .into_iter()
        .map(|column| column.map(|column| resolve_hive_target_column(&options.table_meta, &column)))
        .collect()
}

fn resolve_hive_target_column(table_meta: &DataGridTableMeta, result_column: &str) -> String {
    let Some(columns) = table_meta.columns.as_deref() else {
        return result_column.to_string();
    };
    if let Some(column) = unique_column_info_match(columns, result_column) {
        return column.name.clone();
    }
    let Some(unqualified) = last_qualified_identifier_component(result_column) else {
        return result_column.to_string();
    };
    // Hive JDBC may expose SELECT * labels as `table.column`. Resolve them through
    // target metadata, while exact matching above preserves real dotted column names.
    unique_column_info_match(columns, &unqualified)
        .map_or_else(|| result_column.to_string(), |column| column.name.clone())
}

fn unique_column_info_match<'a>(columns: &'a [DataGridColumnInfo], name: &str) -> Option<&'a DataGridColumnInfo> {
    if let Some(column) = columns.iter().find(|column| column.name == name) {
        return Some(column);
    }
    let normalized = normalize_column_name(name);
    let mut matches = columns.iter().filter(|column| normalize_column_name(&column.name) == normalized);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn last_qualified_identifier_component(name: &str) -> Option<String> {
    let mut quote = None;
    let mut component_start = 0;
    let mut last_component = None;
    let chars = name.char_indices().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if let Some(end_quote) = quote {
            if ch == end_quote {
                if chars.get(index + 1).is_some_and(|(_, next)| *next == end_quote) {
                    index += 2;
                    continue;
                }
                quote = None;
            }
        } else {
            match ch {
                '`' | '"' => quote = Some(ch),
                '[' => quote = Some(']'),
                '.' => {
                    let component = name[component_start..byte_index].trim();
                    if component.is_empty() {
                        return None;
                    }
                    last_component = Some(component);
                    component_start = byte_index + ch.len_utf8();
                }
                _ => {}
            }
        }
        index += 1;
    }
    if quote.is_some() || last_component.is_none() {
        return None;
    }
    unquote_identifier_component(name[component_start..].trim())
}

fn unquote_identifier_component(component: &str) -> Option<String> {
    if component.is_empty() {
        return None;
    }
    for (open, close) in [('`', '`'), ('"', '"'), ('[', ']')] {
        if component.starts_with(open) || component.ends_with(close) {
            let inner = component.strip_prefix(open)?.strip_suffix(close)?;
            let escaped = format!("{close}{close}");
            return Some(inner.replace(&escaped, &close.to_string()));
        }
    }
    Some(component.to_string())
}

fn build_hive_values_insert(
    options: &DataGridSaveStatementOptions,
    table: &str,
    save_columns: &[Option<String>],
    row: &[Value],
    save_literals: bool,
    skip_all_null: bool,
) -> Option<String> {
    let metadata_columns = options.table_meta.columns.as_deref().unwrap_or(&[]);
    let target_columns = if metadata_columns.is_empty() {
        save_columns.iter().filter_map(|column| column.as_deref()).collect::<Vec<_>>()
    } else {
        metadata_columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>()
    };
    if target_columns.is_empty() {
        return None;
    }
    let values = target_columns
        .iter()
        .map(|column| {
            let value = find_column_index(options.database_type, save_columns, column)
                .and_then(|index| row.get(index))
                .unwrap_or(&Value::Null);
            (column, value)
        })
        .collect::<Vec<_>>();
    if skip_all_null && values.iter().all(|(_, value)| value.is_null()) {
        return None;
    }
    let values = values
        .into_iter()
        .map(|(column, value)| {
            let info = column_info_for(metadata_columns, column);
            if save_literals {
                format_grid_save_sql_literal(value, options.database_type, info)
            } else {
                format_grid_sql_literal(value, options.database_type, info)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("INSERT INTO TABLE {table} VALUES ({values})"))
}

fn effective_copy_columns(source_columns: Option<&[Option<String>]>, columns: &[String]) -> Vec<Option<String>> {
    match source_columns {
        Some(source_columns) if source_columns.len() == columns.len() => source_columns.to_vec(),
        _ => columns.iter().map(|column| Some(column.clone())).collect(),
    }
}

fn copy_column_info(
    column_info: &[DataGridColumnInfo],
    column: &str,
    fallback_type: Option<&str>,
) -> Option<DataGridColumnInfo> {
    if let Some(info) = column_info_for(column_info, column) {
        return Some(info.clone());
    }
    fallback_type.map(|data_type| DataGridColumnInfo {
        name: column.to_string(),
        data_type: data_type.to_string(),
        is_nullable: true,
        is_primary_key: false,
        column_default: None,
        extra: None,
    })
}

fn data_grid_save_execution_schema(
    _database_type: Option<DatabaseType>,
    table_meta: &DataGridTableMeta,
) -> Option<String> {
    if false {
        return None;
    }
    table_meta.schema.clone()
}

pub fn normalize_data_grid_save_error(_database_type: Option<DatabaseType>, error: &str) -> String {
    if false && (error.contains("Attempt to do update or delete") || error.contains("Error 10294")) {
        return "Hive UPDATE/DELETE are not enabled for this table or server. Add rows with INSERT, or enable ACID transactional tables in Hive before editing/deleting existing rows.".to_string();
    }
    error.to_string()
}

fn format_grid_copy_insert_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    // JSON columns may expose a JSON array/object value (e.g. `[1,2,3]` or `{}`)
    // instead of its string form. Keep it as a single JSON literal rather than
    // letting format_grid_sql_literal serialize it as a PostgreSQL-style array
    // (`{...}`). Serialize the value back to compact JSON text, format that as a
    // string literal, then cast it for MySQL so it inserts as JSON.
    if column_info.is_some_and(|column| {
        let dt = column.data_type.trim();
        dt.eq_ignore_ascii_case("json") || dt.eq_ignore_ascii_case("jsonb")
    }) && (value.is_array() || value.is_object())
    {
        let json_text = value.to_string();
        let string_literal = format_grid_sql_literal(&Value::String(json_text), database_type, column_info);
        return mysql_json_predicate_literal(string_literal, database_type, column_info);
    }
    format_grid_sql_literal(value, database_type, column_info)
}

pub fn format_grid_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    // Boolean values on BIT columns always use numeric 0/1.
    // This covers MySQL, SQL Server, and any other database where BIT
    // is a numeric/boolean type rather than a bit-string type like
    // PostgreSQL's bit(n).
    if let Some(value) = value.as_bool() {
        // SQL Server has no TRUE/FALSE literals (its boolean type is BIT, which
        // is_bit_literal_column already covers); any other column there still
        // needs numeric 1/0 instead of a literal.
        if is_bit_literal_column(database_type, column_info) {
            return if value { "1" } else { "0" }.to_string();
        }
        return if value { "TRUE" } else { "FALSE" }.to_string();
    }
    if is_mysql_bit_literal_column(database_type, column_info) {
        if let Some(number) = value.as_number() {
            return number.to_string();
        }
        if let Some(text) = value.as_str().and_then(format_mysql_bit_literal_text) {
            return text;
        }
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(arr) = value.as_array() {
        if let Some(element_type) = postgres_json_array_element_type(database_type, column_info) {
            return format_postgres_json_array_sql_literal(arr, element_type);
        }
        if false {
            return format_ch_array_sql_literal(arr);
        }
        return format_pg_array_sql_literal(arr);
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    if is_mysql_binary_literal_column(database_type, column_info) {
        if let Some(literal) = format_mysql_binary_literal_text(&text) {
            // DBX result values expose binary columns as prefixed hex; keep them
            // as MySQL hex literals so copied INSERT/UPDATE SQL round-trips bytes.
            return literal;
        }
    }
    if column_info.map(|column| is_numeric_type(&column.data_type)).unwrap_or(false) && is_numeric_literal(&text) {
        // BigDecimal/BigInteger cells cross JSON-RPC as strings so browsers cannot round them.
        return text;
    }
    if false {
        if let Some(typed_value) = manticore_typed_attribute_value(&text, column_info) {
            return format_grid_sql_literal(&typed_value, database_type, column_info);
        }
    }
    if text.is_empty() {
        return "''".to_string();
    }
    // MySQL geometry columns: wrap WKT text with ST_GeomFromText()
    if is_mysql_geometry_literal_database(database_type)
        && column_info.map(|column| is_geometry_column_type(&column.data_type)).unwrap_or(false)
    {
        let escaped = text.replace('\\', "\\\\").replace('\'', "''");
        return format!("ST_GeomFromText('{}')", escaped);
    }
    let literal_text = text;
    if database_type == Some(DatabaseType::Postgres) && literal_text.contains('\\') {
        // Escape strings have stable backslash semantics regardless of the
        // session's standard_conforming_strings setting.
        let escaped_text = literal_text.replace('\\', "\\\\").replace('\'', "''");
        return format!("E'{escaped_text}'");
    }
    if false {
        return format_sqlserver_unicode_literal(&literal_text);
    }
    let escaped_text = if false {
        literal_text.replace('\\', "\\\\").replace('\'', "\\'")
    } else if is_sqlite_literal_database(database_type) {
        // SQLite-family engines do not treat backslash as a string-literal
        // escape character, so only the quote delimiter needs escaping.
        literal_text.replace('\'', "''")
    } else {
        literal_text.replace('\\', "\\\\").replace('\'', "''")
    };
    let escaped = format!("'{escaped_text}'");
    escaped
}

fn postgres_json_array_element_type(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> Option<&'static str> {
    if database_type != Some(DatabaseType::Postgres) {
        return None;
    }
    match column_info?.data_type.trim().to_ascii_lowercase().as_str() {
        "json[]" | "_json" => Some("json"),
        "jsonb[]" | "_jsonb" => Some("jsonb"),
        _ => None,
    }
}

fn format_postgres_json_array_sql_literal(arr: &[Value], element_type: &str) -> String {
    if arr.is_empty() {
        return format!("ARRAY[]::{element_type}[]");
    }
    let elements = arr
        .iter()
        .map(|value| {
            if value.is_null() {
                return "NULL".to_string();
            }
            let json = match value {
                Value::String(text) => serde_json::from_str::<Value>(text)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|_| Value::String(text.clone()).to_string()),
                _ => value.to_string(),
            };
            let escaped = json.replace('\\', "\\\\").replace('\'', "''");
            format!("E'{escaped}'::{element_type}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("ARRAY[{elements}]")
}

fn format_sqlserver_unicode_literal(text: &str) -> String {
    let mut parts = Vec::new();
    let mut segment = String::new();

    for ch in text.chars() {
        let line_break = match ch {
            '\r' => Some(13),
            '\n' => Some(10),
            _ => None,
        };
        if let Some(codepoint) = line_break {
            if !segment.is_empty() {
                parts.push(format!("N'{}'", segment.replace('\'', "''")));
                segment.clear();
            }
            // Keep physical newlines out of generated SQL so a preceding
            // backslash cannot be consumed as a line-continuation marker.
            parts.push(format!("NCHAR({codepoint})"));
        } else {
            segment.push(ch);
        }
    }

    if !segment.is_empty() {
        parts.push(format!("N'{}'", segment.replace('\'', "''")));
    }
    if parts.is_empty() {
        "N''".to_string()
    } else {
        parts.join(" + ")
    }
}

fn is_sqlite_literal_database(_database_type: Option<DatabaseType>) -> bool {
    false
}

fn format_grid_save_sql_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if empty_string_saves_as_null(value, column_info) {
        "NULL".to_string()
    } else {
        format_grid_sql_literal(value, database_type, column_info)
    }
}

fn empty_string_saves_as_null(value: &Value, column_info: Option<&DataGridColumnInfo>) -> bool {
    value.as_str() == Some("")
        && column_info.is_some_and(|column| column.is_nullable && !is_textual_column_type(&column.data_type))
}

fn is_mysql_bit_literal_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    is_mysql_datetime_literal_database(database_type)
        && column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_literal_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    database_type != Some(DatabaseType::Postgres)
        && column_info.map(|column| is_bit_column_type(&column.data_type)).unwrap_or(false)
}

fn is_bit_column_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| {
        // SQL Server/tiberius reports nullable BIT result columns as `bitn`.
        // They still need numeric 0/1 literals in generated UPDATE SQL.
        matches!(token, "bit" | "bitn")
    })
}

fn is_mysql_geometry_literal_database(_database_type: Option<DatabaseType>) -> bool {
    false
}

fn is_mysql_binary_literal_column(
    _database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    false && column_info.map(|column| is_mysql_binary_column_type(&column.data_type)).unwrap_or(false)
}

fn is_mysql_binary_column_type(data_type: &str) -> bool {
    let lower = data_type.trim().to_ascii_lowercase();
    let base = lower.split(['(', ':', ' ']).next().unwrap_or("").trim();
    matches!(base, "binary" | "varbinary" | "blob" | "tinyblob" | "mediumblob" | "longblob")
}

fn format_mysql_binary_literal_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let hex = trimmed.strip_prefix("0x")?;
    if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        Some(if hex.is_empty() { "X''".to_string() } else { trimmed.to_string() })
    } else {
        None
    }
}

fn is_geometry_column_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    let base = lower.split('(').next().unwrap_or(&lower).trim();
    matches!(
        base,
        "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

fn manticore_typed_attribute_value(text: &str, column_info: Option<&DataGridColumnInfo>) -> Option<Value> {
    let data_type = column_info?.data_type.to_ascii_lowercase();
    if is_boolean_type(&data_type, None) && text.eq_ignore_ascii_case("true") {
        return Some(Value::Bool(true));
    }
    if is_boolean_type(&data_type, None) && text.eq_ignore_ascii_case("false") {
        return Some(Value::Bool(false));
    }
    if is_numeric_type(&data_type) && is_numeric_literal(text) {
        return text.parse::<serde_json::Number>().ok().map(Value::Number);
    }
    None
}

fn format_mysql_bit_literal_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.eq_ignore_ascii_case("true") {
        return Some("1".to_string());
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Some("0".to_string());
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) && !trimmed.is_empty() {
        return Some(if trimmed.len() == 1 {
            trimmed.to_string()
        } else if trimmed.chars().all(|ch| matches!(ch, '0' | '1')) {
            format!("b'{trimmed}'")
        } else {
            trimmed.to_string()
        });
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("b'") && trimmed.ends_with('\'') {
        let bits = &trimmed[2..trimmed.len() - 1];
        if !bits.is_empty() && bits.chars().all(|ch| matches!(ch, '0' | '1')) {
            return Some(format!("b'{bits}'"));
        }
    }
    None
}

fn is_mysql_datetime_literal_database(_database_type: Option<DatabaseType>) -> bool {
    false
}

fn build_primary_key_where(
    database_type: Option<DatabaseType>,
    primary_keys: &[String],
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
    identifier_quote: Option<&str>,
) -> String {
    if primary_keys.is_empty() && uses_keyless_row_predicate(database_type) {
        return build_row_where(database_type, columns, row, column_info, identifier_quote);
    }
    primary_keys
        .iter()
        .map(|primary_key| {
            let value = row
                .get(find_column_index(database_type, columns, primary_key).unwrap_or(usize::MAX))
                .unwrap_or(&Value::Null);
            build_column_predicate(
                database_type,
                primary_key,
                value,
                column_info_for(column_info, primary_key),
                false,
                identifier_quote,
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_row_where(
    database_type: Option<DatabaseType>,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
    identifier_quote: Option<&str>,
) -> String {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column = column.as_deref()?;
            if is_oracle_row_id(database_type, Some(column)) {
                return None;
            }
            Some(build_column_predicate(
                database_type,
                column,
                row.get(index).unwrap_or(&Value::Null),
                column_info_for(column_info, column),
                true,
                identifier_quote,
            ))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn build_save_row_where(
    database_type: Option<DatabaseType>,
    columns: &[Option<String>],
    row: &[Value],
    column_info: &[DataGridColumnInfo],
    identifier_quote: Option<&str>,
) -> String {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| {
            let column = column.as_deref()?;
            if is_oracle_row_id(database_type, Some(column)) {
                return None;
            }
            Some(build_save_column_predicate(
                database_type,
                column,
                row.get(index).unwrap_or(&Value::Null),
                column_info_for(column_info, column),
                true,
                identifier_quote,
            ))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub(crate) fn build_column_predicate(
    database_type: Option<DatabaseType>,
    column: &str,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
    use_binary_text_comparison: bool,
    identifier_quote: Option<&str>,
) -> String {
    let ident = predicate_ident(database_type, column, identifier_quote);
    if value.is_null() {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_sql_literal(value, database_type, column_info))
    } else {
        let literal = format_grid_sql_literal(value, database_type, column_info);
        if use_binary_text_comparison {
            if let Some(predicate) = postgres_keyless_json_predicate(database_type, &ident, &literal, column_info) {
                return predicate;
            }
        }
        format!("{ident} = {}", mysql_json_predicate_literal(literal, database_type, column_info))
    }
}

fn build_save_column_predicate(
    database_type: Option<DatabaseType>,
    column: &str,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
    use_binary_text_comparison: bool,
    identifier_quote: Option<&str>,
) -> String {
    let ident = predicate_ident(database_type, column, identifier_quote);
    if value.is_null() || empty_string_saves_as_null(value, column_info) {
        format!("{ident} IS NULL")
    } else if use_binary_text_comparison && uses_mysql_binary_text_predicate(database_type, value, column_info) {
        format!("BINARY {ident} = {}", format_grid_save_sql_literal(value, database_type, column_info))
    } else {
        let literal = format_grid_save_sql_literal(value, database_type, column_info);
        if use_binary_text_comparison {
            if let Some(predicate) = postgres_keyless_json_predicate(database_type, &ident, &literal, column_info) {
                return predicate;
            }
        }
        format!("{ident} = {}", mysql_json_predicate_literal(literal, database_type, column_info))
    }
}

fn postgres_keyless_json_predicate(
    database_type: Option<DatabaseType>,
    ident: &str,
    literal: &str,
    column_info: Option<&DataGridColumnInfo>,
) -> Option<String> {
    if !is_postgres_like_pattern_database(database_type) {
        return None;
    }
    let normalized = column_info?.data_type.trim().to_ascii_lowercase();
    let data_type = normalized.rsplit('.').next().unwrap_or(&normalized).trim_matches('"');
    match data_type {
        "json" => Some(format!("{ident}::text = {literal}::text")),
        "jsonb" => Some(format!("{ident} = {literal}::jsonb")),
        _ => None,
    }
}

fn mysql_json_predicate_literal(
    literal: String,
    _database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> String {
    if false && column_info.is_some_and(|column| column.data_type.trim().eq_ignore_ascii_case("json")) {
        format!("CAST({literal} AS JSON)")
    } else {
        literal
    }
}

fn data_grid_statement(_database_type: Option<DatabaseType>, sql: String) -> String {
    if false {
        sql
    } else {
        format!("{sql};")
    }
}

fn data_grid_update_sql(_database_type: Option<DatabaseType>, table: &str, sets: &str, where_clause: &str) -> String {
    if false {
        format!("ALTER TABLE {table} UPDATE {sets} WHERE {where_clause}")
    } else {
        format!("UPDATE {table} SET {sets} WHERE {where_clause}")
    }
}

fn data_grid_delete_sql(_database_type: Option<DatabaseType>, table: &str, where_clause: &str) -> String {
    if false {
        format!("ALTER TABLE {table} DELETE WHERE {where_clause}")
    } else {
        format!("DELETE FROM {table} WHERE {where_clause}")
    }
}

fn uses_mysql_binary_text_predicate(
    _database_type: Option<DatabaseType>,
    value: &Value,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    false && value.is_string() && column_info.map(|column| is_textual_column_type(&column.data_type)).unwrap_or(false)
}

fn is_textual_column_type(data_type: &str) -> bool {
    let lower = data_type.trim().to_ascii_lowercase();
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
        || lower.starts_with("national character varying")
}

fn is_oracle_row_id(database_type: Option<DatabaseType>, name: Option<&str>) -> bool {
    uses_oracle_row_id(database_type) && name.is_some_and(|name| name.eq_ignore_ascii_case(DBX_ROWID_COLUMN))
}

pub(crate) fn is_neo4j_element_id(_database_type: Option<DatabaseType>, _name: Option<&str>) -> bool {
    false
}

pub(crate) fn is_auto_generated_column(column: &DataGridColumnInfo) -> bool {
    column
        .extra
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|part| matches!(part, "auto_increment" | "autoincrement" | "identity"))
}

fn grid_value_is_empty(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(str::is_empty)
}

pub(crate) fn is_grid_insert_omitted_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
    include_computed_columns: bool,
) -> bool {
    is_oracle_row_id(database_type, name)
        || is_postgres_tsvector_column(database_type, column_info)
        || (!include_computed_columns && is_non_identity_generated_column(column_info))
}

fn is_grid_update_omitted_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
    primary_key_set: &[String],
) -> bool {
    is_oracle_row_id(database_type, name)
        || is_clickhouse_key_column(database_type, column_info, name, primary_key_set)
        || is_non_identity_generated_column(column_info)
}

fn is_clickhouse_key_column(
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
    name: Option<&str>,
    primary_key_set: &[String],
) -> bool {
    if true {
        return false;
    }
    column_info.is_some_and(|column| column.is_primary_key)
        || is_clickhouse_partition_key_column(database_type, column_info)
        || name.is_some_and(|name| primary_key_set.contains(&normalize_column_name(name)))
}

fn is_clickhouse_partition_key_column(
    _database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> bool {
    false
        && column_info.and_then(|column| column.extra.as_deref()).is_some_and(|extra| {
            extra.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').any(|part| part == "partition_key")
        })
}

fn is_postgres_tsvector_column(database_type: Option<DatabaseType>, column_info: Option<&DataGridColumnInfo>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_info.map(|column| is_postgres_tsvector_type(&column.data_type)).unwrap_or(false)
}

fn is_postgres_tsvector_type(data_type: &str) -> bool {
    let normalized = data_type.trim().trim_matches('"').to_ascii_lowercase();
    normalized == "tsvector" || normalized.ends_with(".tsvector")
}

pub(crate) fn is_non_identity_generated_column(column_info: Option<&DataGridColumnInfo>) -> bool {
    let extra = column_info.and_then(|column| column.extra.as_deref()).unwrap_or("").to_ascii_lowercase();
    extra.contains("generated always as") && !extra.contains("identity")
}

fn is_null_write_to_not_null_column(
    database_type: Option<DatabaseType>,
    not_null_columns: &[String],
    column: Option<&str>,
    value: &Value,
) -> bool {
    let Some(column) = column else {
        return false;
    };
    if is_oracle_row_id(database_type, Some(column)) || is_neo4j_element_id(database_type, Some(column)) {
        return false;
    }
    value.is_null() && not_null_columns.iter().any(|not_null| not_null == &normalize_column_name(column))
}

fn find_column_index(database_type: Option<DatabaseType>, columns: &[Option<String>], target: &str) -> Option<usize> {
    if let Some(index) = columns.iter().position(|column| column.as_deref() == Some(target)) {
        return Some(index);
    }
    // PostgreSQL can have distinct `id` and quoted `"ID"` columns. Only
    // dialects whose result metadata is known to drift in case may fall back,
    // and even then a case-only match must be unique.
    if !matches!(database_type, Some(DatabaseType::OpenGauss)) {
        return None;
    }
    let normalized_target = normalize_column_name(target);
    let mut matches = columns.iter().enumerate().filter_map(|(index, column)| {
        (column.as_deref().map(normalize_column_name).unwrap_or_default() == normalized_target).then_some(index)
    });
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

fn primary_key_value_key(primary_key_indexes: &[usize], row: &[Value]) -> Option<String> {
    let values: Vec<Value> =
        primary_key_indexes.iter().map(|index| row.get(*index).cloned().unwrap_or(Value::Null)).collect();
    if values.iter().any(Value::is_null) {
        return None;
    }
    serde_json::to_string(&values).ok()
}

fn duplicate_primary_key_error(
    primary_keys: &[String],
    primary_key_indexes: &[usize],
    row: &[Value],
    matches_existing_row: bool,
) -> String {
    let key_summary = primary_keys
        .iter()
        .enumerate()
        .map(|(index, primary_key)| {
            format!(
                "{} = {}",
                primary_key,
                format_key_value_for_message(row.get(primary_key_indexes[index]).unwrap_or(&Value::Null))
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let source = if matches_existing_row { "the existing primary key" } else { "another new row's primary key" };
    format!("New row duplicates {source} ({key_summary}). Change the key before saving.")
}

fn format_key_value_for_message(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(value) = value.as_str() {
        return format!("\"{}\"", value.replace('"', "\\\""));
    }
    value.to_string()
}

fn normalize_column_name(name: &str) -> String {
    name.to_ascii_uppercase()
}

fn null_write_error(column: &str) -> String {
    format!("Column \"{column}\" does not allow NULL.")
}

fn predicate_ident(database_type: Option<DatabaseType>, name: &str, identifier_quote: Option<&str>) -> String {
    if is_oracle_row_id(database_type, Some(name)) {
        "ROWIDTOCHAR(ROWID)".to_string()
    } else {
        data_grid_identifier(database_type, name, identifier_quote)
    }
}

pub(crate) fn quote_ident(database_type: Option<DatabaseType>, name: &str) -> String {
    quote_table_identifier(database_type, name)
}

fn data_grid_identifier(database_type: Option<DatabaseType>, name: &str, identifier_quote: Option<&str>) -> String {
    crate::sql_dialect::quote_table_data_identifier(database_type, name, identifier_quote)
}

fn data_grid_qualified_table_name(
    database_type: Option<DatabaseType>,
    catalog: Option<&str>,
    schema: Option<&str>,
    database: Option<&str>,
    table_name: &str,
    identifier_quote: Option<&str>,
) -> String {
    if crate::sql_dialect::uses_connection_identifier_quote(database_type, identifier_quote) {
        crate::sql_dialect::table_data_qualified_table_name(database_type, schema, table_name, identifier_quote)
    } else {
        crate::sql_dialect::qualified_table_name_with_catalog(database_type, catalog, schema, database, table_name)
    }
}

fn column_filter_ref(database_type: Option<DatabaseType>, column_name: &str, identifier_quote: Option<&str>) -> String {
    let quoted = data_grid_identifier(database_type, column_name, identifier_quote);
    if false {
        format!("n.{quoted}")
    } else {
        quoted
    }
}

fn column_like_filter_ref(
    database_type: Option<DatabaseType>,
    column_name: &str,
    column_info: Option<&DataGridColumnInfo>,
    identifier_quote: Option<&str>,
) -> String {
    let column = column_filter_ref(database_type, column_name, identifier_quote);
    if is_postgres_like_pattern_database(database_type)
        && column_info.map(|column_info| !is_textual_column_type(&column_info.data_type)).unwrap_or(true)
    {
        format!("{column}::text")
    } else {
        column
    }
}

fn is_postgres_like_pattern_database(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::OpenGauss))
}

fn value_to_filter_text(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        value.to_string()
    } else if value.is_null() {
        String::new()
    } else {
        value.to_string()
    }
}

fn parse_typed_filter_value(
    text: &str,
    database_type: Option<DatabaseType>,
    column_info: Option<&DataGridColumnInfo>,
) -> Value {
    let unquoted = unwrap_matching_quotes(text);
    let data_type = column_info.map(|column| column.data_type.to_ascii_lowercase()).unwrap_or_default();
    if is_boolean_type(&data_type, database_type) && unquoted.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if is_boolean_type(&data_type, database_type) && unquoted.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if (is_numeric_type(&data_type) || data_type.is_empty()) && is_numeric_literal(&unquoted) {
        if let Ok(number) = unquoted.parse::<serde_json::Number>() {
            return Value::Number(number);
        }
    }
    Value::String(unquoted)
}

fn unwrap_matching_quotes(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let Some(last) = text.chars().last() else {
        return String::new();
    };
    if text.len() >= 2 && ((first == '\'' && last == '\'') || (first == '"' && last == '"')) {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

fn is_numeric_type(data_type: &str) -> bool {
    let lower = data_type.to_ascii_lowercase();
    [
        "int",
        "integer",
        "bigint",
        "smallint",
        "tinyint",
        "mediumint",
        "serial",
        "number",
        "numeric",
        "decimal",
        "float",
        "double",
        "real",
        "money",
    ]
    .iter()
    .any(|part| lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| token == *part))
}

fn is_boolean_type(data_type: &str, database_type: Option<DatabaseType>) -> bool {
    let lower = data_type.to_ascii_lowercase();
    lower.split(|ch: char| !ch.is_ascii_alphanumeric()).any(|token| {
        matches!(token, "bool" | "boolean")
            || (matches!(token, "bit" | "bitn") && database_type != Some(DatabaseType::Postgres))
    })
}

fn is_numeric_literal(text: &str) -> bool {
    if text.trim() != text || text.is_empty() {
        return false;
    }
    text.parse::<f64>().is_ok_and(f64::is_finite)
        && text.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '+' | '-' | '.' | 'e' | 'E'))
        && text.chars().any(|ch| ch.is_ascii_digit())
}

fn uses_keyless_row_predicate(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Postgres | DatabaseType::OpenGauss))
}

pub(crate) fn column_info_for<'a>(columns: &'a [DataGridColumnInfo], name: &str) -> Option<&'a DataGridColumnInfo> {
    let normalized = normalize_column_name(name);
    columns.iter().find(|column| normalize_column_name(&column.name) == normalized)
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_postgres_insert_statement() {
        let options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                ..Default::default()
            },
            columns: vec!["id".to_string(), "name".to_string()],
            new_rows: vec![vec![json!(1), json!("Alice")]],
            ..Default::default()
        };

        let result = build_data_grid_save_statements(&options);
        assert_eq!(result.len(), 1);
        assert!(result[0].contains("INSERT INTO \"public\".\"users\""));
    }

    #[test]
    fn builds_opengauss_update_statement() {
        let options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Opengauss),
            table_meta: DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                ..Default::default()
            },
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![vec![json!(1), json!("Alice")]],
            dirty_rows: vec![(0, vec![(1, json!("Bob"))])],
            ..Default::default()
        };

        let result = build_data_grid_save_statements(&options);
        assert_eq!(result.len(), 1);
        assert!(result[0].contains("UPDATE \"public\".\"users\" SET"));
    }

    #[test]
    fn builds_postgres_delete_statement() {
        let options = DataGridSaveStatementOptions {
            database_type: Some(DatabaseType::Postgres),
            table_meta: DataGridTableMeta {
                schema: Some("public".to_string()),
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                ..Default::default()
            },
            columns: vec!["id".to_string(), "name".to_string()],
            rows: vec![vec![json!(1), json!("Alice")]],
            deleted_rows: vec![0],
            ..Default::default()
        };

        let result = build_data_grid_save_statements(&options);
        assert_eq!(result.len(), 1);
        assert!(result[0].contains("DELETE FROM \"public\".\"users\" WHERE"));
    }
}
