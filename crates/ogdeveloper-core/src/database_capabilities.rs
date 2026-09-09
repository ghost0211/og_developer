use crate::models::connection::DatabaseType;

pub fn is_single_connection_pool(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Jdbc)
}

pub fn is_metadata_connection_scoped(_db_type: &DatabaseType) -> bool {
    false
}

pub fn skips_tcp_probe(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Jdbc)
}

pub fn is_local_file_db_type(_db_type: &DatabaseType) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_connection_pool_and_tcp_probe() {
        assert!(is_single_connection_pool(&DatabaseType::Jdbc));
        assert!(!is_single_connection_pool(&DatabaseType::OpenGauss));
        assert!(!is_single_connection_pool(&DatabaseType::Postgres));

        assert!(skips_tcp_probe(&DatabaseType::Jdbc));
        assert!(!skips_tcp_probe(&DatabaseType::OpenGauss));
        assert!(!skips_tcp_probe(&DatabaseType::Postgres));
    }
}
