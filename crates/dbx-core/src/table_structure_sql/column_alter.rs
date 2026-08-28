use super::column_format::column_data_type;
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::types::{EditableStructureColumn, SingleColumnAlterSqlOptions, TableStructureSqlResult};
use super::util::{
    clean, format_default_for_sql, normalize_default, original_column_name, qualified_table, quote_ident, quote_string,
};

pub fn build_single_column_alter_sql(options: SingleColumnAlterSqlOptions) -> TableStructureSqlResult {
    let mut warnings = Vec::new();
    let capabilities = capabilities_for(options.database_type);
    let table = qualified_table(capabilities.dialect, options.schema.as_deref(), &options.table_name);
    build_existing_column_sql(&options, &table, &mut warnings)
}

pub(super) fn build_existing_column_sql(
    options: &SingleColumnAlterSqlOptions,
    table: &str,
    warnings: &mut Vec<String>,
) -> TableStructureSqlResult {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let database_label = database_label(options.database_type);
    let mut statements = Vec::new();

    if options.column.marked_for_drop {
        if !capabilities.drop_column {
            warnings.push(format!("Dropping columns is not supported for {database_label}."));
            return TableStructureSqlResult { statements, warnings: warnings.clone() };
        }
        let original_name = original_column_name(&options.column);
        let drop_clause = format!("DROP COLUMN {}", quote_ident(dialect, original_name));
        statements.push(format!("ALTER TABLE {table} {drop_clause};"));
        return TableStructureSqlResult { statements, warnings: warnings.clone() };
    }

    let has_rename =
        options.column.original.as_ref().is_some_and(|original| clean(&original.name) != clean(&options.column.name));
    let has_attribute_change = has_column_attribute_change(&options.column);

    if has_rename && !capabilities.rename_column {
        warnings.push(format!("Renaming columns is not supported for {database_label}."));
    }
    if has_attribute_change && !capabilities.alter_existing_column {
        warnings.push(format!("Modifying existing column definitions is not supported for {database_label}."));
    }
    if (has_rename && !capabilities.rename_column) || (has_attribute_change && !capabilities.alter_existing_column) {
        return TableStructureSqlResult { statements, warnings: warnings.clone() };
    }
    if !has_rename && !has_attribute_change && !has_column_extra_change(&options.column) {
        return TableStructureSqlResult { statements, warnings: warnings.clone() };
    }

    match dialect {
        StructureDialect::Postgres => statements.extend(build_postgres_existing_column_sql(table, &options.column)),
        _ => warnings.push(format!("Editing existing columns is not supported for {database_label} yet.")),
    }

    TableStructureSqlResult { statements, warnings: warnings.clone() }
}

fn is_column_extra_empty(extra: &super::types::ColumnExtra) -> bool {
    !extra.auto_increment.unwrap_or(false)
        && !extra.on_update_current_timestamp.unwrap_or(false)
        && extra.identity.is_none()
}

fn has_column_extra_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = column.original.as_ref() else {
        return false;
    };
    let current_extra = column.extra.as_ref();
    let original_extra_empty = original.extra.as_deref().unwrap_or("").trim().is_empty();

    match current_extra {
        None => !original_extra_empty,
        Some(current) => is_column_extra_empty(current) != original_extra_empty,
    }
}

pub(super) fn has_column_attribute_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = column.original.as_ref() else {
        return true;
    };
    clean(&original.data_type) != clean(&column.data_type)
        || original.is_nullable != column.is_nullable
        || clean(original.column_default.as_deref().unwrap_or("")) != clean(&column.default_value)
        || clean(original.comment.as_deref().unwrap_or("")) != clean(&column.comment)
        || has_column_extra_change(column)
}

pub(super) fn build_postgres_existing_column_sql(table: &str, column: &EditableStructureColumn) -> Vec<String> {
    let mut statements = Vec::new();
    let original = column.original.as_ref();
    let current_name = column.name.as_str();

    if let Some(original) = original {
        if clean(&original.name) != clean(current_name) {
            statements.push(format!(
                "ALTER TABLE {table} RENAME COLUMN {} TO {};",
                quote_ident(StructureDialect::Postgres, &original.name),
                quote_ident(StructureDialect::Postgres, current_name)
            ));
        }
    }

    if let Some(original) = original {
        if clean(&original.data_type) != clean(&column.data_type) {
            let data_type = column_data_type(StructureDialect::Postgres, column);
            statements.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {} TYPE {data_type};",
                quote_ident(StructureDialect::Postgres, current_name)
            ));
        }

        if original.is_nullable != column.is_nullable {
            let action = if column.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
            statements.push(format!(
                "ALTER TABLE {table} ALTER COLUMN {} {action};",
                quote_ident(StructureDialect::Postgres, current_name)
            ));
        }

        let original_default = normalize_default(original.column_default.as_deref());
        let current_default = normalize_default(Some(&column.default_value));
        if original_default != current_default {
            if current_default.is_empty() {
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} DROP DEFAULT;",
                    quote_ident(StructureDialect::Postgres, current_name)
                ));
            } else {
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN {} SET DEFAULT {};",
                    quote_ident(StructureDialect::Postgres, current_name),
                    format_default_for_sql(StructureDialect::Postgres, &column.data_type, &current_default)
                ));
            }
        }

        let orig_comment = clean(original.comment.as_deref().unwrap_or(""));
        let cur_comment = clean(&column.comment);
        if orig_comment != cur_comment {
            statements.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {};",
                quote_ident(StructureDialect::Postgres, current_name),
                quote_string(&cur_comment)
            ));
        }
    }

    statements
}
