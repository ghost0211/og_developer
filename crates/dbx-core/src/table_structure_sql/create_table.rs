use super::column_format::column_definition;
use super::dialect::capabilities_for;
use super::indexes::build_create_index_sql;
use super::types::{TableStructureSqlOptions, TableStructureSqlResult};
use super::util::{clean, qualified_table, quote_ident, quote_string};
use super::validation::validate_draft;

pub fn build_create_table_sql(options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let warnings = validate_draft(&options);

    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let active_columns: Vec<_> = options.columns.iter().filter(|c| !c.marked_for_drop).collect();

    if active_columns.is_empty() {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["Table must have at least one column.".to_string()],
        };
    }

    let mut statements = Vec::new();
    let mut column_definitions = Vec::new();

    for column in &active_columns {
        let definition = column_definition(dialect, column);
        column_definitions.push(definition);
    }

    let primary_keys: Vec<_> =
        active_columns.iter().filter(|c| c.is_primary_key).map(|c| quote_ident(dialect, &c.name)).collect();

    if !primary_keys.is_empty() {
        column_definitions.push(format!("PRIMARY KEY ({})", primary_keys.join(", ")));
    }

    let create_sql = format!("CREATE TABLE {table} (\n  {}\n);", column_definitions.join(",\n  "));
    statements.push(create_sql);

    if capabilities.comment {
        if let Some(comment) = &options.table_comment {
            let clean_comment = clean(comment);
            if !clean_comment.is_empty() {
                statements.push(format!("COMMENT ON TABLE {table} IS {};", quote_string(&clean_comment)));
            }
        }
        for column in &active_columns {
            let clean_comment = clean(&column.comment);
            if !clean_comment.is_empty() {
                statements.push(format!(
                    "COMMENT ON COLUMN {table}.{} IS {};",
                    quote_ident(dialect, &column.name),
                    quote_string(&clean_comment)
                ));
            }
        }
    }

    for index in &options.indexes {
        if !index.marked_for_drop && !index.is_primary {
            statements.push(build_create_index_sql(dialect, &table, index));
        }
    }

    TableStructureSqlResult { statements, warnings }
}
