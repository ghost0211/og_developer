use super::dialect::{capabilities_for, StructureDialect};
use super::types::TableStructureSqlOptions;
use super::util::{clean, qualified_table, quote_string};

pub(super) fn build_table_comment_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();

    let original_comment = clean(options.original_table_comment.as_deref().unwrap_or(""));
    let current_comment = clean(options.table_comment.as_deref().unwrap_or(""));

    if original_comment == current_comment {
        return statements;
    }

    if !capabilities.comment {
        warnings.push("Modifying table comments is not supported for this database.".to_string());
        return statements;
    }

    if matches!(dialect, StructureDialect::Postgres) {
        statements.push(format!("COMMENT ON TABLE {table} IS {};", quote_string(&current_comment)));
    }

    statements
}
