use super::dialect::{capabilities_for, StructureDialect};
use super::types::{EditableStructureIndex, TableStructureSqlOptions};
use super::util::{clean, quote_ident, quote_string};
use crate::models::connection::DatabaseType;

pub(super) fn build_index_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = super::util::qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();

    for index in &options.indexes {
        if index.is_primary {
            continue;
        }

        if index.marked_for_drop {
            if !capabilities.drop_index {
                warnings.push("Dropping indexes is not supported for this database.".to_string());
                continue;
            }
            let name = index.original.as_ref().map(|o| o.name.as_str()).unwrap_or(&index.name);
            statements.push(build_drop_index_sql(
                options.database_type,
                dialect,
                &table,
                options.schema.as_deref(),
                name,
            ));
            continue;
        }

        if index.original.is_none() {
            if !capabilities.create_index {
                warnings.push("Creating indexes is not supported for this database.".to_string());
                continue;
            }
            statements.push(build_create_index_sql(dialect, &table, index));
            if capabilities.index_comment && !clean(&index.comment).is_empty() {
                statements.push(format!(
                    "COMMENT ON INDEX {} IS {};",
                    quote_ident(dialect, &index.name),
                    quote_string(&clean(&index.comment))
                ));
            }
        }
    }

    statements
}

pub(super) fn build_create_index_sql(dialect: StructureDialect, table: &str, index: &EditableStructureIndex) -> String {
    let unique = if index.is_unique { "UNIQUE " } else { "" };
    let method = if !index.index_type.trim().is_empty() {
        format!(" USING {}", index.index_type.trim().to_ascii_uppercase())
    } else {
        String::new()
    };
    let columns = index.columns.iter().map(|col| quote_ident(dialect, col)).collect::<Vec<_>>().join(", ");
    let mut sql =
        format!("CREATE {unique}INDEX {}{} ON {table}{method} ({columns})", quote_ident(dialect, &index.name), "");

    if !index.included_columns.is_empty() {
        let includes =
            index.included_columns.iter().map(|col| quote_ident(dialect, col)).collect::<Vec<_>>().join(", ");
        sql.push_str(&format!(" INCLUDE ({includes})"));
    }

    if !index.filter.trim().is_empty() {
        sql.push_str(&format!(" WHERE {}", index.filter.trim()));
    }

    sql.push(';');
    sql
}

pub(super) fn build_drop_index_sql(
    _database_type: Option<DatabaseType>,
    dialect: StructureDialect,
    _table: &str,
    schema: Option<&str>,
    index_name: &str,
) -> String {
    if matches!(dialect, StructureDialect::Postgres) && schema.is_some_and(|schema| !schema.trim().is_empty()) {
        return format!("DROP INDEX {}.{};", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, index_name));
    }
    format!("DROP INDEX {};", quote_ident(dialect, index_name))
}
