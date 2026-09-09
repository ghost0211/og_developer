//! Environment compatibility for installations predating the product rename.
use std::ffi::OsString;

pub fn var_os(name: &str) -> Option<OsString> {
    resolve_var_os(name, |key| std::env::var_os(key))
}

fn resolve_var_os(name: &str, mut lookup: impl FnMut(&str) -> Option<OsString>) -> Option<OsString> {
    lookup(name).or_else(|| name.strip_prefix("OGDEVELOPER_").and_then(|suffix| lookup(&format!("DBX_{suffix}"))))
}

pub fn var(name: &str) -> Result<String, std::env::VarError> {
    var_os(name).ok_or(std::env::VarError::NotPresent)?.into_string().map_err(std::env::VarError::NotUnicode)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_values_including_empty_override_legacy() {
        for current in ["new", ""] {
            assert_eq!(
                resolve_var_os("OGDEVELOPER_PASSWORD", |key| Some(OsString::from(
                    if key.starts_with("OGDEVELOPER_") { current } else { "old" }
                ))),
                Some(OsString::from(current))
            );
        }
        assert_eq!(
            resolve_var_os("OGDEVELOPER_PASSWORD", |key| (key == "DBX_PASSWORD").then(|| OsString::from("old"))),
            Some(OsString::from("old"))
        );
        assert_eq!(resolve_var_os("PATH", |_| None), None);
    }
}
