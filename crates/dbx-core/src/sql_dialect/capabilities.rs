use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TablePaginationStrategy {
    LimitOffset,
    AgentMaxRows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaginationContext {
    TablePreview,
    BoundedRead,
    UserQuery,
}

pub fn is_schema_aware(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Postgres | DatabaseType::OpenGauss | DatabaseType::Jdbc)
}

pub fn pagination_strategy(database_type: Option<DatabaseType>, context: PaginationContext) -> TablePaginationStrategy {
    let _ = context;
    match database_type {
        Some(DatabaseType::Jdbc) => TablePaginationStrategy::AgentMaxRows,
        _ => TablePaginationStrategy::LimitOffset,
    }
}

pub fn table_pagination_strategy(database_type: Option<DatabaseType>) -> TablePaginationStrategy {
    pagination_strategy(database_type, PaginationContext::TablePreview)
}
