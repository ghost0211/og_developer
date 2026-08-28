use super::column_alter::{build_existing_column_sql, has_column_attribute_change};
use super::column_format::column_definition;
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::types::{SingleColumnAlterSqlOptions, TableStructureSqlOptions};
use super::util::{clean, original_column_name, quote_ident, quote_string};
use std::collections::HashSet;

pub(super) fn build_column_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let database_label = database_label(options.database_type);
    let table = super::util::qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();
    let mut dropped_column_names = HashSet::new();

    for column in &options.columns {
        if column.marked_for_drop {
            if !capabilities.drop_column {
                warnings.push(format!("Dropping columns is not supported for {database_label}."));
                continue;
            }
            let original_name = original_column_name(column);
            dropped_column_names.insert(original_name.to_string());
            let drop_clause = format!("DROP COLUMN {}", quote_ident(dialect, original_name));
            statements.push(format!("ALTER TABLE {table} {drop_clause};"));
            continue;
        }

        let has_rename = column.original.as_ref().is_some_and(|original| clean(&original.name) != clean(&column.name));
        let has_attribute_change = has_column_attribute_change(column);

        if has_rename && !capabilities.rename_column {
            warnings.push(format!("Renaming columns is not supported for {database_label}."));
        }
        if has_attribute_change && !capabilities.alter_existing_column {
            warnings.push(format!("Modifying existing column definitions is not supported for {database_label}."));
        }
        if (has_rename && !capabilities.rename_column) || (has_attribute_change && !capabilities.alter_existing_column)
        {
            continue;
        }

        if column.original.is_some() {
            let single_options = SingleColumnAlterSqlOptions {
                database_type: options.database_type,
                schema: options.schema.clone(),
                table_name: options.table_name.clone(),
                column: column.clone(),
            };
            statements.extend(build_existing_column_sql(&single_options, &table, warnings).statements);
        } else {
            if !capabilities.add_column {
                warnings.push(format!("Adding columns is not supported for {database_label}."));
                continue;
            }
            let definition = column_definition(dialect, column);
            statements.push(format!("ALTER TABLE {table} ADD COLUMN {definition};"));
            if capabilities.comment && !clean(&column.comment).is_empty() {
                statements.push(format!(
                    "COMMENT ON COLUMN {table}.{} IS {};",
                    quote_ident(dialect, &column.name),
                    quote_string(&clean(&column.comment))
                ));
            }
        }
    }

    statements.extend(build_primary_key_sql(options, dialect, &table, warnings));
    statements
}

fn build_primary_key_sql(
    options: &TableStructureSqlOptions,
    dialect: StructureDialect,
    table: &str,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let mut statements = Vec::new();

    let original_pk_columns: Vec<String> = options
        .columns
        .iter()
        .filter(|col| col.original.as_ref().is_some_and(|orig| orig.is_primary_key))
        .map(|col| original_column_name(col).to_string())
        .collect();

    let desired_pk_columns: Vec<String> = options
        .columns
        .iter()
        .filter(|col| !col.marked_for_drop && col.is_primary_key)
        .map(|col| col.name.clone())
        .collect();

    if original_pk_columns == desired_pk_columns {
        return statements;
    }

    if !capabilities.alter_primary_key {
        warnings.push("Modifying primary keys is not supported for this database.".to_string());
        return statements;
    }

    if !original_pk_columns.is_empty() {
        statements.push(format!("ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {}_pkey;", options.table_name));
    }

    if !desired_pk_columns.is_empty() {
        let pk_cols = desired_pk_columns.iter().map(|col| quote_ident(dialect, col)).collect::<Vec<_>>().join(", ");
        statements.push(format!("ALTER TABLE {table} ADD PRIMARY KEY ({pk_cols});"));
    }

    statements
}
