use dbx_core::database_capabilities::{is_metadata_connection_scoped, is_single_connection_pool, skips_tcp_probe};
use dbx_core::models::connection::DatabaseType;

#[test]
fn test_database_capabilities() {
    assert!(is_single_connection_pool(&DatabaseType::Jdbc));
    assert!(!is_single_connection_pool(&DatabaseType::Postgres));
    assert!(!is_single_connection_pool(&DatabaseType::Opengauss));

    assert!(!is_metadata_connection_scoped(&DatabaseType::Postgres));
    assert!(!is_metadata_connection_scoped(&DatabaseType::Opengauss));

    assert!(skips_tcp_probe(&DatabaseType::Jdbc));
    assert!(!skips_tcp_probe(&DatabaseType::Postgres));
    assert!(!skips_tcp_probe(&DatabaseType::Opengauss));
}
