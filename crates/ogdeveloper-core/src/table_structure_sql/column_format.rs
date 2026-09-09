use super::dialect::StructureDialect;
use super::types::EditableStructureColumn;
use super::util::{format_default_for_sql, normalize_default, quote_ident};

pub(super) fn column_definition(dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    let data_type = column_data_type(dialect, column);
    let mut parts = vec![quote_ident(dialect, &column.name), data_type];
    if !column.is_nullable {
        parts.push("NOT NULL".to_string());
    }
    if let Some(extra_clause) = column_extra_clause(dialect, column) {
        parts.push(extra_clause);
    }
    let default_value = normalize_default(Some(&column.default_value));
    if !default_value.is_empty() {
        parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
    }
    parts.join(" ")
}

pub(super) fn column_extra_clause(dialect: StructureDialect, column: &EditableStructureColumn) -> Option<String> {
    let extra = column.extra.as_ref()?;
    match dialect {
        StructureDialect::Postgres => {
            if let Some(identity) = &extra.identity {
                let generation = identity.generation.as_deref().unwrap_or("BY DEFAULT");
                let mut clause = format!("GENERATED {generation} AS IDENTITY");
                if identity.seed.is_some() || identity.increment.is_some() {
                    let start = identity.seed.unwrap_or(1);
                    let inc = identity.increment.unwrap_or(1);
                    clause.push_str(&format!(" (START WITH {start} INCREMENT BY {inc})"));
                }
                Some(clause)
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn column_data_type(_dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    column.data_type.trim().to_string()
}
