use crate::sql_dialect::descriptor::{DialectCapabilityDescriptor, DialectInfo, DialectKind};
use insta::assert_json_snapshot;

#[test]
fn snapshot_postgres_descriptor() {
    let desc = DialectCapabilityDescriptor::for_dialect(DialectKind::Postgres);
    assert_json_snapshot!("postgres_descriptor", desc);
}

#[test]
fn snapshot_postgres_info() {
    let info = DialectInfo::for_kind(DialectKind::Postgres);
    assert_json_snapshot!("postgres_info", info);
}

#[test]
fn snapshot_all_dialects_info() {
    let all = DialectInfo::all();
    assert_json_snapshot!("all_dialects_info", all);
}
