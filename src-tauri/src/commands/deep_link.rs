use std::collections::HashSet;
use std::sync::Mutex;

const CONNECTION_DEEP_LINK_PREFIXES: [&str; 2] = ["ogdeveloper://connection/new", "dbx://connection/new"];

#[tauri::command]
pub fn pending_open_connection_links(state: tauri::State<'_, DeepLinkOpenState>) -> Vec<String> {
    dedupe_links(state.drain())
}

#[derive(Default)]
pub struct DeepLinkOpenState {
    pending: Mutex<Vec<String>>,
}

impl DeepLinkOpenState {
    pub fn push(&self, links: Vec<String>) {
        if links.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.extend(links);
        }
    }

    fn drain(&self) -> Vec<String> {
        self.pending.lock().map(|mut pending| pending.drain(..).collect()).unwrap_or_default()
    }
}

pub fn connection_deep_links_from_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().filter_map(|arg| connection_deep_link_from_arg(arg.as_ref())).collect()
}

pub fn connection_deep_link_from_arg(arg: &str) -> Option<String> {
    let trimmed = arg.trim();
    let suffix = CONNECTION_DEEP_LINK_PREFIXES.iter().find_map(|prefix| trimmed.strip_prefix(*prefix))?;
    if !(suffix.is_empty()
        || suffix.starts_with('?')
        || suffix.starts_with('#')
        || suffix == "/"
        || suffix.starts_with("/?")
        || suffix.starts_with("/#"))
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn dedupe_links(links: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for link in links {
        if seen.insert(link.clone()) {
            unique.push(link);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_current_and_legacy_connection_links() {
        for scheme in ["ogdeveloper", "dbx"] {
            let link = format!("{scheme}://connection/new?type=opengauss&host=localhost");
            assert_eq!(connection_deep_link_from_arg(&link), Some(link));
            assert!(connection_deep_link_from_arg(&format!("{scheme}://connection/newer")).is_none());
        }
        assert!(connection_deep_link_from_arg("https://connection/new").is_none());
    }

    #[test]
    fn filters_connection_deep_links() {
        let links = connection_deep_links_from_args([
            "dbx://connection/new?type=mysql&host=127.0.0.1",
            "--flag",
            "dbx://open?x=1",
            "dbx://connections/new?type=postgres",
            "dbx://connection/newer?type=mysql",
        ]);

        assert_eq!(links, vec!["dbx://connection/new?type=mysql&host=127.0.0.1".to_string()]);
    }

    #[test]
    fn drains_pending_links_once() {
        let state = DeepLinkOpenState::default();
        state.push(vec!["dbx://connection/new?type=mysql".to_string()]);

        assert_eq!(state.drain(), vec!["dbx://connection/new?type=mysql"]);
        assert!(state.drain().is_empty());
    }

    #[test]
    fn dedupes_links_while_preserving_order() {
        assert_eq!(
            dedupe_links(vec![
                "dbx://connection/new?type=mysql".to_string(),
                "dbx://connection/new?type=postgres".to_string(),
                "dbx://connection/new?type=mysql".to_string(),
            ]),
            vec!["dbx://connection/new?type=mysql", "dbx://connection/new?type=postgres"]
        );
    }
}
