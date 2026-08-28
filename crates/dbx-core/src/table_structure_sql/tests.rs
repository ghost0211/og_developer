use super::*;
use crate::models::connection::DatabaseType;

fn column(name: &str) -> EditableStructureColumn {
    EditableStructureColumn {
        id: name.to_string(),
        name: name.to_string(),
        data_type: "varchar(255)".to_string(),
        is_nullable: true,
        default_value: String::new(),
        comment: String::new(),
        is_primary_key: false,
        extra: None,
        original: None,
        original_position: None,
        marked_for_drop: false,
        character_set: String::new(),
        collation: String::new(),
    }
}

fn existing_pk_column(
    name: &str,
    data_type: &str,
    was_primary_key: bool,
    is_primary_key: bool,
) -> EditableStructureColumn {
    let mut col = column(name);
    col.data_type = data_type.to_string();
    col.is_nullable = false;
    col.is_primary_key = is_primary_key;
    col.original = Some(ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable: false,
        column_default: None,
        is_primary_key: was_primary_key,
        extra: None,
        comment: None,
        ..Default::default()
    });
    col
}

#[test]
fn generates_postgres_create_table_sql() {
    let options = TableStructureSqlOptions {
        database_type: Some(DatabaseType::Postgres),
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        columns: vec![existing_pk_column("id", "bigint", true, true), column("name")],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: Some("user table".to_string()),
        original_table_comment: None,
    };

    let result = build_create_table_sql(options);
    assert!(result.warnings.is_empty());
    assert_eq!(result.statements.len(), 2);
    assert!(result.statements[0].starts_with("CREATE TABLE public.users"));
    assert!(result.statements[1].contains("COMMENT ON TABLE public.users IS 'user table'"));
}

#[test]
fn generates_opengauss_alter_table_add_column_sql() {
    let options = TableStructureSqlOptions {
        database_type: Some(DatabaseType::OpenGauss),
        schema: Some("public".to_string()),
        table_name: "users".to_string(),
        columns: vec![existing_pk_column("id", "bigint", true, true), column("email")],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    };

    let result = build_table_structure_change_sql(options);
    assert!(result.warnings.is_empty());
    assert_eq!(result.statements, vec!["ALTER TABLE public.users ADD COLUMN email varchar(255);"]);
}
