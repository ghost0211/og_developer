use super::types::TableStructureSqlOptions;

pub(super) fn validate_draft(options: &TableStructureSqlOptions) -> Vec<String> {
    let mut warnings = Vec::new();
    if options.table_name.trim().is_empty() {
        warnings.push("Table name must not be empty.".to_string());
    }
    warnings
}
