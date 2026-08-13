use crate::{FromSql, IsNull, ToSql, Type};
use bytes::{BufMut, BytesMut};
use serde_1::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json_1::Value;
use std::error::Error;
use std::fmt::Debug;

/// A wrapper type to allow arbitrary `Serialize`/`Deserialize` types to convert to Postgres JSON values.
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Json<T>(pub T);

impl<T: Serialize> Serialize for Json<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Json<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self)
    }
}

impl<'a, T> FromSql<'a> for Json<T>
where
    T: Deserialize<'a>,
{
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Json<T>, Box<dyn Error + Sync + Send>> {
        let raw = if is_jsonb_type(ty) {
            match raw.split_first() {
                // PostgreSQL binary jsonb prefixes the JSON document with a
                // version byte. Some compatible servers return text JSON for
                // jsonb columns, so fall through to parsing the full payload
                // when the prefix is not the supported binary version.
                Some((1, rest)) => rest,
                _ => raw,
            }
        } else {
            raw
        };
        serde_json_1::de::from_slice(raw)
            .map(Json)
            .map_err(Into::into)
    }

    fn accepts(ty: &Type) -> bool {
        is_json_type(ty)
    }
}

impl<T> ToSql for Json<T>
where
    T: Serialize + Debug,
{
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        if is_jsonb_type(ty) {
            out.put_u8(1);
        }
        serde_json_1::ser::to_writer(out.writer(), &self.0)?;
        Ok(IsNull::No)
    }

    fn accepts(ty: &Type) -> bool {
        is_json_type(ty)
    }
    to_sql_checked!();
}

impl<'a> FromSql<'a> for Value {
    fn from_sql(ty: &Type, raw: &[u8]) -> Result<Value, Box<dyn Error + Sync + Send>> {
        Json::<Value>::from_sql(ty, raw).map(|json| json.0)
    }

    fn accepts(ty: &Type) -> bool {
        is_json_type(ty)
    }
}

impl ToSql for Value {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        Json(self).to_sql(ty, out)
    }

    fn accepts(ty: &Type) -> bool {
        is_json_type(ty)
    }
    to_sql_checked!();
}

fn is_json_type(ty: &Type) -> bool {
    matches!(*ty, Type::JSON | Type::JSONB) || matches!(ty.name(), "json" | "jsonb")
}

fn is_jsonb_type(ty: &Type) -> bool {
    *ty == Type::JSONB || ty.name() == "jsonb"
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::Kind;

    fn other_jsonb_type() -> Type {
        Type::new(
            "jsonb".to_string(),
            9_999_999,
            Kind::Simple,
            "pg_catalog".to_string(),
        )
    }

    #[test]
    fn jsonb_accepts_text_payload_for_compatible_servers() {
        let value = <Value as FromSql>::from_sql(&Type::JSONB, br#"{"a":1}"#).unwrap();

        assert_eq!(value, serde_json_1::json!({ "a": 1 }));
    }

    #[test]
    fn jsonb_accepts_postgres_binary_payload() {
        let value = <Value as FromSql>::from_sql(&Type::JSONB, b"\x01{\"a\":1}").unwrap();

        assert_eq!(value, serde_json_1::json!({ "a": 1 }));
    }

    #[test]
    fn other_jsonb_type_accepts_and_encodes_jsonb() {
        let ty = other_jsonb_type();
        let value = serde_json_1::json!({ "a": 1 });
        let mut out = BytesMut::new();

        assert!(<Value as FromSql>::accepts(&ty));
        assert!(<Value as ToSql>::accepts(&ty));
        <Value as ToSql>::to_sql(&value, &ty, &mut out).unwrap();

        assert_eq!(&out[..], b"\x01{\"a\":1}");
    }
}
