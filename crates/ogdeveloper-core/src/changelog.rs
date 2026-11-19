use serde::{Deserialize, Serialize};

const GITHUB_RELEASES_API_URL: &str = "https://api.github.com/repos/ghost0211/og_developer/releases?per_page=30";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogItem {
    pub title: String,
    #[serde(default)]
    pub desc: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangelogSection {
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub items: Vec<ChangelogItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangelogRelease {
    pub tag: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub sections: Vec<ChangelogSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogData {
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub releases: Vec<ChangelogRelease>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseEntry {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
}

/// Normalize UI locale / short lang into `cn` or `en`.
pub fn normalize_changelog_lang(lang: &str) -> &'static str {
    let trimmed = lang.trim();
    if trimmed.eq_ignore_ascii_case("cn")
        || trimmed.eq_ignore_ascii_case("zh")
        || trimmed.eq_ignore_ascii_case("zh-CN")
        || trimmed.eq_ignore_ascii_case("zh-TW")
    {
        "cn"
    } else {
        "en"
    }
}

fn is_app_release_tag(tag: &str) -> bool {
    let Some(version) = tag.strip_prefix('v') else {
        return false;
    };
    let mut parts = version.splitn(3, '.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch_and_suffix) = parts.next() else {
        return false;
    };
    if major.is_empty()
        || minor.is_empty()
        || !major.bytes().all(|byte| byte.is_ascii_digit())
        || !minor.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }

    let patch_len = patch_and_suffix.bytes().take_while(u8::is_ascii_digit).count();
    if patch_len == 0 {
        return false;
    }
    let suffix = &patch_and_suffix[patch_len..];
    suffix.is_empty()
        || ((suffix.starts_with('.') || suffix.starts_with('-'))
            && suffix.len() > 1
            && suffix[1..].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-'))
}

fn classify_section_type(heading: &str) -> &'static str {
    let lower = heading.trim().to_lowercase();
    if lower.contains("fix") || lower.contains("bug") || heading.contains("修复") {
        return "fixed";
    }
    if lower.contains("improv")
        || lower.contains("enhanc")
        || lower.contains("perf")
        || heading.contains("改进")
        || heading.contains("优化")
    {
        return "improved";
    }
    if lower.contains("remov") || lower.contains("deprecat") || heading.contains("移除") || heading.contains("删除")
    {
        return "removed";
    }
    if lower.contains("chang") || lower.contains("refactor") || heading.contains("变更") {
        return "changed";
    }
    "added"
}

fn strip_markdown_emphasis(text: &str) -> String {
    let trimmed = text.trim();
    if let Some(rest) = trimmed.strip_prefix("**").and_then(|s| s.strip_suffix("**")) {
        return rest.trim().to_string();
    }
    trimmed.to_string()
}

fn parse_changelog_bullet(raw: &str) -> Option<ChangelogItem> {
    let text = raw.trim();
    if text.is_empty() || text.starts_with("**Full Changelog**:") || text.starts_with("Full Changelog:") {
        return None;
    }

    if let Some(rest) = text.strip_prefix("**") {
        if let Some((bold_title, remainder)) = rest.split_once("**") {
            let desc = remainder.trim_start().trim_start_matches([':', '：', '-', '—']).trim().to_string();
            let title = bold_title.trim().to_string();
            if !title.is_empty() {
                return Some(ChangelogItem { title, desc });
            }
        }
    }

    for sep in [" — ", " - ", "：", ": "] {
        if let Some((title, desc)) = text.split_once(sep) {
            let clean_title = strip_markdown_emphasis(title);
            let clean_desc = desc.trim().to_string();
            if !clean_title.is_empty() && !clean_desc.is_empty() {
                return Some(ChangelogItem { title: clean_title, desc: clean_desc });
            }
        }
    }

    Some(ChangelogItem { title: strip_markdown_emphasis(text), desc: String::new() })
}

pub fn parse_github_release_body(body: &str) -> Vec<ChangelogSection> {
    let mut sections: Vec<ChangelogSection> = Vec::new();
    let mut current_title = String::new();
    let mut current_type = "added".to_string();
    let mut current_items: Vec<ChangelogItem> = Vec::new();

    for raw_line in body.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(heading) = line.strip_prefix("###").or_else(|| line.strip_prefix("##")) {
            let heading_text = heading.trim_start_matches('#').trim();
            if heading_text.is_empty() {
                continue;
            }
            if !current_items.is_empty() {
                sections.push(ChangelogSection {
                    r#type: current_type.clone(),
                    title: current_title.clone(),
                    items: std::mem::take(&mut current_items),
                });
            }
            current_type = classify_section_type(heading_text).to_string();
            current_title = heading_text.to_string();
            continue;
        }

        if let Some(bullet) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            if let Some(item) = parse_changelog_bullet(bullet) {
                current_items.push(item);
            }
        }
    }

    if !current_items.is_empty() {
        sections.push(ChangelogSection { r#type: current_type, title: current_title, items: current_items });
    }

    sections
}

pub async fn fetch_changelog(lang: &str) -> Result<ChangelogData, String> {
    let _lang = normalize_changelog_lang(lang);
    let client = build_changelog_http_client()?;

    let resp = client
        .get(GITHUB_RELEASES_API_URL)
        .header(reqwest::header::USER_AGENT, "ogdeveloper-changelog")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Failed to fetch changelog: {e}"))?;

    let entries: Vec<GithubReleaseEntry> = resp.json().await.map_err(|e| format!("Failed to parse changelog: {e}"))?;
    let mut updated_at = String::new();
    let mut releases = Vec::new();

    for entry in entries {
        if entry.draft {
            continue;
        }
        let tag = entry.tag_name.trim().to_string();
        if !is_app_release_tag(&tag) {
            continue;
        }
        let date = entry.published_at.as_deref().or(entry.created_at.as_deref()).unwrap_or("").trim().to_string();
        if updated_at.is_empty() && !date.is_empty() {
            updated_at = date.clone();
        }
        let name = entry.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&tag).to_string();
        let sections = entry.body.as_deref().map(parse_github_release_body).unwrap_or_default();
        releases.push(ChangelogRelease { tag, name, date, sections });
    }

    Ok(ChangelogData { updated_at, releases })
}

fn build_changelog_http_client() -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).user_agent("ogdeveloper-changelog");

    if let Some(proxy_url) = crate::update::system_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("Invalid system proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|e| format!("Failed to create HTTP client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{is_app_release_tag, normalize_changelog_lang, parse_github_release_body};

    #[test]
    fn normalizes_changelog_lang() {
        assert_eq!(normalize_changelog_lang("cn"), "cn");
        assert_eq!(normalize_changelog_lang("zh-CN"), "cn");
        assert_eq!(normalize_changelog_lang("zh-TW"), "cn");
        assert_eq!(normalize_changelog_lang("en"), "en");
        assert_eq!(normalize_changelog_lang("ja"), "en");
    }

    #[test]
    fn recognizes_only_app_release_tags() {
        assert!(is_app_release_tag("v0.5.66"));
        assert!(is_app_release_tag("v1.2.3-hotfix.1"));
        assert!(!is_app_release_tag("packages-v0.4.42"));
        assert!(!is_app_release_tag("agents-v0.2.64"));
        assert!(!is_app_release_tag("v0.5"));
        assert!(!is_app_release_tag("v0.5.x"));
    }

    #[test]
    fn parses_github_markdown_release_body() {
        let body = "\
### 新功能 (Added)
- **选区统计**: 实时多维聚合摘要
- Quick Open — 支持命令面板

### 问题修复 (Fixed)
- **悬浮窗背景**: 修复透明背景问题

**Full Changelog**: https://github.com/ghost0211/og_developer/compare/v0.3.2...v0.3.3
";
        let sections = parse_github_release_body(body);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].r#type, "added");
        assert_eq!(sections[0].items.len(), 2);
        assert_eq!(sections[0].items[0].title, "选区统计");
        assert_eq!(sections[0].items[0].desc, "实时多维聚合摘要");
        assert_eq!(sections[0].items[1].title, "Quick Open");
        assert_eq!(sections[0].items[1].desc, "支持命令面板");
        assert_eq!(sections[1].r#type, "fixed");
        assert_eq!(sections[1].items[0].title, "悬浮窗背景");
    }
}
