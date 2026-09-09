use super::dialect::capabilities_for;
use super::types::TableStructureSqlOptions;
use super::util::{clean, quote_ident};

pub(super) fn build_foreign_key_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = super::util::qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();

    if !capabilities.foreign_key && !options.foreign_keys.is_empty() {
        warnings.push("Foreign keys are not supported for this database.".to_string());
        return statements;
    }

    for fk in &options.foreign_keys {
        if fk.marked_for_drop {
            if let Some(orig) = &fk.original {
                statements.push(format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(dialect, &orig.name)));
            }
            continue;
        }

        if fk.original.is_none() {
            let name = clean(&fk.name);
            let col = quote_ident(dialect, &fk.column);
            let ref_table = if fk.ref_schema.trim().is_empty() {
                quote_ident(dialect, &fk.ref_table)
            } else {
                format!("{}.{}", quote_ident(dialect, &fk.ref_schema), quote_ident(dialect, &fk.ref_table))
            };
            let ref_col = quote_ident(dialect, &fk.ref_column);

            let mut sql = format!(
                "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({col}) REFERENCES {ref_table} ({ref_col})",
                quote_ident(dialect, &name)
            );
            if !fk.on_delete.trim().is_empty() {
                sql.push_str(&format!(" ON DELETE {}", fk.on_delete));
            }
            if !fk.on_update.trim().is_empty() {
                sql.push_str(&format!(" ON UPDATE {}", fk.on_update));
            }
            sql.push(';');
            statements.push(sql);
        }
    }

    statements
}
