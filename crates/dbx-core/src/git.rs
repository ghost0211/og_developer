use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Characters that must be percent-encoded in URL username/password components.
const URL_CRED_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'?')
    .add(b'{')
    .add(b'}')
    .add(b'/')
    .add(b':')
    .add(b'@')
    .add(b'\\')
    .add(b'^')
    .add(b'|')
    .add(b'%');

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneRequest {
    pub url: String,
    pub target_dir: String,
    pub username: Option<String>,
    pub token: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusInfo {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub current: String,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub old_text: String,
    pub new_text: String,
    pub is_new: bool,
    pub is_deleted: bool,
}

/// Execute a git command using `crate::process::new_tokio_command` (which configures `CREATE_NO_WINDOW` on Windows).
pub async fn run_git_command(args: &[&str], cwd: Option<&Path>) -> Result<std::process::Output, String> {
    let mut cmd = crate::process::new_tokio_command("git");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args);
    match cmd.output().await {
        Ok(output) => Ok(output),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("GIT_NOT_FOUND: git executable not found in PATH: {e}"))
        }
        Err(e) => Err(format!("Failed to execute git: {e}")),
    }
}

/// Injects personal access token or username into HTTP/HTTPS URLs.
/// Returns `(injected_url, was_injected)`.
pub fn inject_git_credentials(url: &str, username: Option<&str>, token: Option<&str>) -> (String, bool) {
    let u = username.map(|s| s.trim()).filter(|s| !s.is_empty());
    let t = token.map(|s| s.trim()).filter(|s| !s.is_empty());

    if u.is_none() && t.is_none() {
        return (url.to_string(), false);
    }

    let (scheme, rest) = if let Some(stripped) = url.strip_prefix("https://") {
        ("https://", stripped)
    } else if let Some(stripped) = url.strip_prefix("http://") {
        ("http://", stripped)
    } else {
        // Only HTTP(S) URLs support token/credential embedding
        return (url.to_string(), false);
    };

    // If rest already has user info before the host (e.g. user:pass@host/path), strip it out
    let host_and_path = if let Some(at_idx) = rest.find('@') {
        let slash_idx = rest.find('/').unwrap_or(rest.len());
        if at_idx < slash_idx {
            &rest[at_idx + 1..]
        } else {
            rest
        }
    } else {
        rest
    };

    let creds = match (u, t) {
        (Some(user), Some(tok)) => {
            let encoded_u = utf8_percent_encode(user, URL_CRED_ENCODE_SET).to_string();
            let encoded_t = utf8_percent_encode(tok, URL_CRED_ENCODE_SET).to_string();
            format!("{encoded_u}:{encoded_t}")
        }
        (None, Some(tok)) => {
            let encoded_t = utf8_percent_encode(tok, URL_CRED_ENCODE_SET).to_string();
            encoded_t
        }
        (Some(user), None) => {
            let encoded_u = utf8_percent_encode(user, URL_CRED_ENCODE_SET).to_string();
            encoded_u
        }
        (None, None) => unreachable!(),
    };

    (format!("{scheme}{creds}@{host_and_path}"), true)
}

/// Sanitizes any sensitive URLs or credential tokens from git output.
pub fn sanitize_git_output(text: &str, sensitive_url: Option<&str>, original_url: Option<&str>) -> String {
    let mut sanitized = text.to_string();
    if let (Some(sens), Some(orig)) = (sensitive_url, original_url) {
        if !sens.is_empty() && sens != orig {
            sanitized = sanitized.replace(sens, orig);
        }
    }

    // Mask any remaining embedded credentials in HTTP/HTTPS URLs (e.g. https://user:pass@host)
    static RE_CREDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE_CREDS.get_or_init(|| regex::Regex::new(r"(https?://)[^/\s@]+@").unwrap());
    sanitized = re.replace_all(&sanitized, "$1").to_string();
    sanitized
}

/// Parse `git status --porcelain=v2 --branch -z` output.
pub fn parse_status_porcelain_v2(output_bytes: &[u8]) -> GitStatusInfo {
    let mut branch = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut has_upstream = false;
    let mut entries = Vec::new();

    let mut chunks = output_bytes.split(|&b| b == 0).peekable();

    while let Some(chunk) = chunks.next() {
        if chunk.is_empty() {
            continue;
        }

        if chunk.starts_with(b"# branch.head ") {
            let name = &chunk[b"# branch.head ".len()..];
            let name_str = String::from_utf8_lossy(name).trim().to_string();
            branch = name_str;
        } else if chunk.starts_with(b"# branch.upstream ") {
            let name = &chunk[b"# branch.upstream ".len()..];
            let name_str = String::from_utf8_lossy(name).trim().to_string();
            if !name_str.is_empty() && name_str != "(none)" {
                has_upstream = true;
            }
        } else if chunk.starts_with(b"# branch.ab ") {
            let ab_str = String::from_utf8_lossy(&chunk[b"# branch.ab ".len()..]);
            let mut parts = ab_str.split_whitespace();
            if let Some(a) = parts.next() {
                if let Some(val) = a.strip_prefix('+') {
                    ahead = val.parse::<u32>().unwrap_or(0);
                }
            }
            if let Some(b) = parts.next() {
                if let Some(val) = b.strip_prefix('-') {
                    behind = val.parse::<u32>().unwrap_or(0);
                }
            }
        } else if chunk.starts_with(b"1 ") {
            // Ordinary changed tracked file:
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let line_str = String::from_utf8_lossy(chunk);
            let mut parts = line_str.splitn(9, ' ');
            let _type = parts.next();
            let xy = parts.next().unwrap_or("..");
            let _sub = parts.next();
            let _mh = parts.next();
            let _mi = parts.next();
            let _mw = parts.next();
            let _hh = parts.next();
            let _hi = parts.next();
            let path = parts.next().unwrap_or("").to_string();

            let xy_chars: Vec<char> = xy.chars().collect();
            let x = xy_chars.first().copied().unwrap_or('.');
            let y = xy_chars.get(1).copied().unwrap_or('.');

            // Staged entry
            match x {
                'M' | 'T' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "modified".to_string(),
                    staged: true,
                    old_path: None,
                }),
                'A' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "added".to_string(),
                    staged: true,
                    old_path: None,
                }),
                'D' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "deleted".to_string(),
                    staged: true,
                    old_path: None,
                }),
                _ => {}
            }

            // Unstaged entry
            match y {
                'M' | 'T' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "modified".to_string(),
                    staged: false,
                    old_path: None,
                }),
                'D' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "deleted".to_string(),
                    staged: false,
                    old_path: None,
                }),
                'A' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "added".to_string(),
                    staged: false,
                    old_path: None,
                }),
                _ => {}
            }
        } else if chunk.starts_with(b"2 ") {
            // Renamed/copied tracked file:
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
            // Next chunk in -z mode is <origPath>
            let line_str = String::from_utf8_lossy(chunk);
            let mut parts = line_str.splitn(10, ' ');
            let _type = parts.next();
            let xy = parts.next().unwrap_or("..");
            let _sub = parts.next();
            let _mh = parts.next();
            let _mi = parts.next();
            let _mw = parts.next();
            let _hh = parts.next();
            let _hi = parts.next();
            let _score = parts.next();
            let path = parts.next().unwrap_or("").to_string();

            let orig_path = chunks.next().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();

            let xy_chars: Vec<char> = xy.chars().collect();
            let x = xy_chars.first().copied().unwrap_or('.');
            let y = xy_chars.get(1).copied().unwrap_or('.');

            // Staged rename/copy
            match x {
                'R' | 'C' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "renamed".to_string(),
                    staged: true,
                    old_path: Some(orig_path),
                }),
                'M' | 'T' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "modified".to_string(),
                    staged: true,
                    old_path: None,
                }),
                'A' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "added".to_string(),
                    staged: true,
                    old_path: None,
                }),
                'D' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "deleted".to_string(),
                    staged: true,
                    old_path: None,
                }),
                _ => {}
            }

            // Unstaged modifications on top of rename
            match y {
                'M' | 'T' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "modified".to_string(),
                    staged: false,
                    old_path: None,
                }),
                'D' => entries.push(GitStatusEntry {
                    path: path.clone(),
                    status: "deleted".to_string(),
                    staged: false,
                    old_path: None,
                }),
                _ => {}
            }
        } else if chunk.starts_with(b"u ") {
            // Unmerged (conflicted) file:
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let line_str = String::from_utf8_lossy(chunk);
            let parts: Vec<&str> = line_str.splitn(11, ' ').collect();
            let path = parts.last().copied().unwrap_or("").to_string();
            entries.push(GitStatusEntry { path, status: "conflicted".to_string(), staged: false, old_path: None });
        } else if chunk.starts_with(b"? ") {
            // Untracked file:
            // ? <path>
            let line_str = String::from_utf8_lossy(chunk);
            let path = line_str.strip_prefix("? ").unwrap_or("").to_string();
            entries.push(GitStatusEntry { path, status: "untracked".to_string(), staged: false, old_path: None });
        }
    }

    GitStatusInfo { branch, ahead, behind, has_upstream, entries }
}

/// Parse refs output from `git for-each-ref --format="%(refname)" refs/heads refs/remotes`.
pub fn parse_branch_refs(refs_text: &str, current: &str) -> GitBranchInfo {
    let mut local = Vec::new();
    let mut remote = Vec::new();

    for line in refs_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(local_branch) = line.strip_prefix("refs/heads/") {
            if !local_branch.is_empty() && !local.contains(&local_branch.to_string()) {
                local.push(local_branch.to_string());
            }
        } else if let Some(remote_ref) = line.strip_prefix("refs/remotes/") {
            // Ignore symbolic HEAD refs like origin/HEAD, dbx/HEAD
            if remote_ref.ends_with("/HEAD") || remote_ref == "HEAD" {
                continue;
            }
            // Strip "origin/" prefix if present for clean UI display, else keep remote/branch
            let branch_name = if let Some(stripped) = remote_ref.strip_prefix("origin/") {
                stripped.to_string()
            } else {
                remote_ref.to_string()
            };
            if !branch_name.is_empty() && !remote.contains(&branch_name) {
                remote.push(branch_name);
            }
        }
    }

    GitBranchInfo { current: current.to_string(), local, remote }
}

// ============================================================================
// Core Git Async Functions
// ============================================================================

/// `git_is_repo(path: String) -> bool`
/// Returns true if the path is inside a git work tree. Returns false if git is missing or path is not a repo.
pub async fn git_is_repo(path: &str) -> bool {
    let p = Path::new(path);
    if !p.exists() {
        return false;
    }
    match run_git_command(&["-C", path, "rev-parse", "--is-inside-work-tree"], None).await {
        Ok(output) => output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true",
        Err(_) => false,
    }
}

/// `git_clone(request: GitCloneRequest) -> Result<String, String>`
/// Clones repository to targetDir with optional branch and credentials. Sanitizes credentials on error.
pub async fn git_clone(request: GitCloneRequest) -> Result<String, String> {
    let target_dir = request.target_dir.trim();
    if target_dir.is_empty() {
        return Err("Target directory is required".to_string());
    }
    let raw_url = request.url.trim();
    if raw_url.is_empty() {
        return Err("Repository URL is required".to_string());
    }

    let (injected_url, has_creds) =
        inject_git_credentials(raw_url, request.username.as_deref(), request.token.as_deref());

    let mut args: Vec<&str> = vec!["clone"];
    if let Some(ref branch) = request.branch {
        let b = branch.trim();
        if !b.is_empty() {
            args.push("--branch");
            args.push(b);
        }
    }
    args.push(&injected_url);
    args.push(target_dir);

    let output = run_git_command(&args, None).await?;
    if output.status.success() {
        Ok(target_dir.to_string())
    } else {
        let err_raw =
            format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        let sanitized =
            sanitize_git_output(&err_raw, if has_creds { Some(&injected_url) } else { None }, Some(raw_url));
        Err(sanitized.trim().to_string())
    }
}

/// `git_status(repo_path: String) -> Result<GitStatusInfo, String>`
/// Retrieves detailed status using `git status --porcelain=v2 --branch -z`.
pub async fn git_status(repo_path: &str) -> Result<GitStatusInfo, String> {
    let output = run_git_command(&["-C", repo_path, "status", "--porcelain=v2", "--branch", "-z"], None).await?;
    if output.status.success() {
        Ok(parse_status_porcelain_v2(&output.stdout))
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(sanitize_git_output(err.trim(), None, None))
    }
}

/// `git_branches(repo_path: String) -> Result<GitBranchInfo, String>`
/// Retrieves current, local, and remote branches.
pub async fn git_branches(repo_path: &str) -> Result<GitBranchInfo, String> {
    // 1. Get branch refs
    let refs_output =
        run_git_command(&["-C", repo_path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], None)
            .await?;

    if !refs_output.status.success() {
        let err = String::from_utf8_lossy(&refs_output.stderr).to_string();
        return Err(sanitize_git_output(err.trim(), None, None));
    }

    let refs_text = String::from_utf8_lossy(&refs_output.stdout);

    // 2. Get current branch
    let current_output = run_git_command(&["-C", repo_path, "branch", "--show-current"], None).await?;
    let mut current = String::from_utf8_lossy(&current_output.stdout).trim().to_string();

    // If detached HEAD or unborn branch, resolve commit hash or detached state
    if current.is_empty() {
        let head_output = run_git_command(&["-C", repo_path, "rev-parse", "--short", "HEAD"], None).await;
        if let Ok(head_out) = head_output {
            if head_out.status.success() {
                let hash = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
                current = format!("(detached at {hash})");
            } else {
                current = "(detached)".to_string();
            }
        } else {
            current = "(detached)".to_string();
        }
    }

    Ok(parse_branch_refs(&refs_text, &current))
}

/// `git_checkout(repo_path: String, branch: String, create: bool) -> Result<(), String>`
/// Switches branch or creates and switches branch.
pub async fn git_checkout(repo_path: &str, branch: &str, create: bool) -> Result<(), String> {
    let output = if create {
        run_git_command(&["-C", repo_path, "checkout", "-b", branch], None).await?
    } else {
        run_git_command(&["-C", repo_path, "checkout", branch], None).await?
    };

    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(sanitize_git_output(err.trim(), None, None))
    }
}

/// `git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String>`
/// Adds paths to the staging area via `git add -- <paths...>`.
pub async fn git_stage(repo_path: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut args: Vec<&str> = vec!["-C", repo_path, "add", "--"];
    for p in paths {
        args.push(p.as_str());
    }

    let output = run_git_command(&args, None).await?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        Err(sanitize_git_output(err.trim(), None, None))
    }
}

/// `git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String>`
/// Removes paths from the staging area. Uses `git restore --staged -- <paths...>`, with a fallback to `git reset HEAD --` for older git versions or initial repo states.
pub async fn git_unstage(repo_path: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut restore_args: Vec<&str> = vec!["-C", repo_path, "restore", "--staged", "--"];
    for p in paths {
        restore_args.push(p.as_str());
    }

    let restore_output = run_git_command(&restore_args, None).await?;
    if restore_output.status.success() {
        return Ok(());
    }

    // Fallback: older Git or unborn HEAD fallback via `git reset HEAD --`
    let mut reset_args: Vec<&str> = vec!["-C", repo_path, "reset", "--"];
    for p in paths {
        reset_args.push(p.as_str());
    }

    let reset_output = run_git_command(&reset_args, None).await?;
    if reset_output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&reset_output.stderr).to_string();
        Err(sanitize_git_output(err.trim(), None, None))
    }
}

/// `git_commit(repo_path: String, message: String) -> Result<(), String>`
/// Commits staged changes with the provided commit message.
pub async fn git_commit(repo_path: &str, message: &str) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }

    let output = run_git_command(&["-C", repo_path, "commit", "-m", message], None).await?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        let err = if err.trim().is_empty() { String::from_utf8_lossy(&output.stdout).to_string() } else { err };
        Err(sanitize_git_output(err.trim(), None, None))
    }
}

/// `git_pull(repo_path: String) -> Result<String, String>`
/// Pulls remote changes (respecting user pull configuration) and returns output summary.
pub async fn git_pull(repo_path: &str) -> Result<String, String> {
    let output = run_git_command(&["-C", repo_path, "pull"], None).await?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        let summary = if !stdout.is_empty() {
            stdout
        } else if !stderr.is_empty() {
            stderr
        } else {
            "Pull completed successfully.".to_string()
        };
        Ok(sanitize_git_output(&summary, None, None))
    } else {
        let err = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Git pull failed".to_string()
        };
        Err(sanitize_git_output(&err, None, None))
    }
}

/// `git_push(repo_path: String) -> Result<String, String>`
/// Pushes current branch. Automatically configures upstream tracking if not present.
pub async fn git_push(repo_path: &str) -> Result<String, String> {
    // Check if upstream branch is configured
    let upstream_check =
        run_git_command(&["-C", repo_path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], None).await;

    let has_upstream = match upstream_check {
        Ok(ref out) => out.status.success() && !out.stdout.is_empty(),
        Err(_) => false,
    };

    let output = if has_upstream {
        run_git_command(&["-C", repo_path, "push"], None).await?
    } else {
        // Find current branch name
        let branch_out = run_git_command(&["-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"], None).await?;
        let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
        if branch.is_empty() || branch == "HEAD" {
            return Err("Cannot push in detached HEAD state without a branch name".to_string());
        }
        run_git_command(&["-C", repo_path, "push", "-u", "origin", &branch], None).await?
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        let summary = match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (false, true) => stdout,
            (true, false) => stderr,
            (true, true) => "Push completed successfully.".to_string(),
        };
        Ok(sanitize_git_output(&summary, None, None))
    } else {
        let err = match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (false, true) => stdout,
            (true, false) => stderr,
            (true, true) => "Git push failed".to_string(),
        };
        Err(sanitize_git_output(&err, None, None))
    }
}

/// `git_file_diff(repo_path: String, path: String, staged: bool) -> Result<GitFileDiff, String>`
/// Returns oldText/newText/isNew/isDeleted for row-level diffing in frontend.
pub async fn git_file_diff(repo_path: &str, path: &str, staged: bool) -> Result<GitFileDiff, String> {
    if staged {
        // Staged diff: compare HEAD vs Index
        let head_ref = format!("HEAD:{path}");
        let head_out = run_git_command(&["-C", repo_path, "show", &head_ref], None).await;
        let (old_text, head_exists) = match head_out {
            Ok(out) if out.status.success() => (String::from_utf8_lossy(&out.stdout).into_owned(), true),
            _ => (String::new(), false),
        };

        let index_ref = format!(":{path}");
        let index_out = run_git_command(&["-C", repo_path, "show", &index_ref], None).await;
        let (new_text, index_exists) = match index_out {
            Ok(out) if out.status.success() => (String::from_utf8_lossy(&out.stdout).into_owned(), true),
            _ => (String::new(), false),
        };

        let is_new = !head_exists && index_exists;
        let is_deleted = head_exists && !index_exists;

        Ok(GitFileDiff { old_text, new_text, is_new, is_deleted })
    } else {
        // Unstaged diff: compare Index (or HEAD) vs Worktree file
        let full_path = Path::new(repo_path).join(path);
        let (new_text, worktree_exists) = if full_path.is_file() {
            match tokio::fs::read(&full_path).await {
                Ok(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), true),
                Err(_) => (String::new(), false),
            }
        } else {
            (String::new(), false)
        };

        // Try Index first (:path), then HEAD (HEAD:path)
        let index_ref = format!(":{path}");
        let index_out = run_git_command(&["-C", repo_path, "show", &index_ref], None).await;
        let (old_text, base_exists) = match index_out {
            Ok(out) if out.status.success() => (String::from_utf8_lossy(&out.stdout).into_owned(), true),
            _ => {
                let head_ref = format!("HEAD:{path}");
                let head_out = run_git_command(&["-C", repo_path, "show", &head_ref], None).await;
                match head_out {
                    Ok(out) if out.status.success() => (String::from_utf8_lossy(&out.stdout).into_owned(), true),
                    _ => (String::new(), false),
                }
            }
        };

        let is_new = !base_exists && worktree_exists;
        let is_deleted = base_exists && !worktree_exists;

        Ok(GitFileDiff { old_text, new_text, is_new, is_deleted })
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_git_credentials() {
        // Plain URL without creds
        let (url, injected) = inject_git_credentials("https://github.com/org/repo.git", None, None);
        assert_eq!(url, "https://github.com/org/repo.git");
        assert!(!injected);

        // Username + Token
        let (url, injected) =
            inject_git_credentials("https://github.com/org/repo.git", Some("alice"), Some("ghp_secret123"));
        assert_eq!(url, "https://alice:ghp_secret123@github.com/org/repo.git");
        assert!(injected);

        // Token only
        let (url, injected) = inject_git_credentials("https://github.com/org/repo.git", None, Some("ghp_secret123"));
        assert_eq!(url, "https://ghp_secret123@github.com/org/repo.git");
        assert!(injected);

        // Special characters in username and token
        let (url, injected) =
            inject_git_credentials("https://github.com/org/repo.git", Some("alice@corp.com"), Some("p@ss:word#1"));
        assert_eq!(url, "https://alice%40corp.com:p%40ss%3Aword%231@github.com/org/repo.git");
        assert!(injected);

        // Existing creds replacement
        let (url, injected) =
            inject_git_credentials("https://olduser:oldpass@github.com/org/repo.git", Some("newuser"), Some("newpass"));
        assert_eq!(url, "https://newuser:newpass@github.com/org/repo.git");
        assert!(injected);

        // SSH URLs untouched
        let (url, injected) = inject_git_credentials("git@github.com:org/repo.git", Some("user"), Some("token"));
        assert_eq!(url, "git@github.com:org/repo.git");
        assert!(!injected);
    }

    #[test]
    fn test_sanitize_git_output() {
        let sensitive = "https://alice:secret_token@github.com/org/repo.git";
        let original = "https://github.com/org/repo.git";
        let raw_err = format!("fatal: Authentication failed for '{sensitive}'");
        let sanitized = sanitize_git_output(&raw_err, Some(sensitive), Some(original));
        assert_eq!(sanitized, "fatal: Authentication failed for 'https://github.com/org/repo.git'");

        // Generic regex masking
        let generic_err = "error: unable to access 'https://bob:token123@gitlab.com/test.git': 403";
        let sanitized = sanitize_git_output(generic_err, None, None);
        assert_eq!(sanitized, "error: unable to access 'https://gitlab.com/test.git': 403");
    }

    #[test]
    fn test_parse_status_porcelain_v2_clean() {
        let data =
            b"# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0";
        let status = parse_status_porcelain_v2(data);
        assert_eq!(status.branch, "main");
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
        assert!(status.has_upstream);
        assert!(status.entries.is_empty());
    }

    #[test]
    fn test_parse_status_porcelain_v2_ahead_behind_and_no_upstream() {
        let data = b"# branch.head feature/test\0# branch.upstream (none)\0# branch.ab +3 -1\0";
        let status = parse_status_porcelain_v2(data);
        assert_eq!(status.branch, "feature/test");
        assert_eq!(status.ahead, 3);
        assert_eq!(status.behind, 1);
        assert!(!status.has_upstream);
    }

    #[test]
    fn test_parse_status_porcelain_v2_entries() {
        let mut buffer = Vec::new();
        // Header
        buffer.extend_from_slice(b"# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\0");
        // Type 1: Staged modified (.M in porcelain means unstaged modified; M. is staged modified; MM is both)
        buffer.extend_from_slice(b"1 M. N... 100644 100644 100644 ce4a9 ce4a9 src/main.rs\0");
        // Type 1: Unstaged modified
        buffer.extend_from_slice(b"1 .M N... 100644 100644 100644 ce4a9 ce4a9 src/lib.rs\0");
        // Type 1: Staged Added & Unstaged Deleted
        buffer.extend_from_slice(b"1 AD N... 100644 100644 000000 ce4a9 ce4a9 src/temp.rs\0");
        // Type 2: Staged Rename
        buffer.extend_from_slice(b"2 R. N... 100644 100644 100644 ce4a9 ce4a9 R100 src/new_name.rs\0src/old_name.rs\0");
        // Type u: Conflicted
        buffer.extend_from_slice(b"u UU N... 100644 100644 100644 100644 ce4a9 ce4a9 ce4a9 src/conflict.rs\0");
        // Type ?: Untracked
        buffer.extend_from_slice(b"? untracked_file.txt\0");

        let status = parse_status_porcelain_v2(&buffer);
        assert_eq!(status.branch, "main");
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 2);
        assert!(status.has_upstream);

        let entries = status.entries;
        assert_eq!(entries.len(), 7);

        // 1. src/main.rs (staged modified)
        assert_eq!(entries[0].path, "src/main.rs");
        assert_eq!(entries[0].status, "modified");
        assert!(entries[0].staged);

        // 2. src/lib.rs (unstaged modified)
        assert_eq!(entries[1].path, "src/lib.rs");
        assert_eq!(entries[1].status, "modified");
        assert!(!entries[1].staged);

        // 3. src/temp.rs staged added
        assert_eq!(entries[2].path, "src/temp.rs");
        assert_eq!(entries[2].status, "added");
        assert!(entries[2].staged);

        // 4. src/temp.rs unstaged deleted
        assert_eq!(entries[3].path, "src/temp.rs");
        assert_eq!(entries[3].status, "deleted");
        assert!(!entries[3].staged);

        // 5. src/new_name.rs staged renamed
        assert_eq!(entries[4].path, "src/new_name.rs");
        assert_eq!(entries[4].status, "renamed");
        assert!(entries[4].staged);
        assert_eq!(entries[4].old_path.as_deref(), Some("src/old_name.rs"));

        // 6. src/conflict.rs conflicted
        assert_eq!(entries[5].path, "src/conflict.rs");
        assert_eq!(entries[5].status, "conflicted");
        assert!(!entries[5].staged);

        // 7. untracked_file.txt untracked
        assert_eq!(entries[6].path, "untracked_file.txt");
        assert_eq!(entries[6].status, "untracked");
        assert!(!entries[6].staged);
    }

    #[test]
    fn test_parse_branch_refs() {
        let refs = "refs/heads/main\nrefs/heads/feature/login\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/remotes/origin/feature/login\nrefs/remotes/upstream/v1.0\n";
        let info = parse_branch_refs(refs, "main");
        assert_eq!(info.current, "main");
        assert_eq!(info.local, vec!["main", "feature/login"]);
        assert_eq!(info.remote, vec!["main", "feature/login", "upstream/v1.0"]);
    }

    #[tokio::test]
    async fn test_git_repo_e2e_workflow() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let repo_path = temp_dir.path().to_str().unwrap().to_string();

        // 1. Not a repo initially
        assert!(!git_is_repo(&repo_path).await);

        // 2. Initialize repo
        let init_out = run_git_command(&["-C", &repo_path, "init"], None).await.unwrap();
        assert!(init_out.status.success());
        let _ = run_git_command(&["-C", &repo_path, "config", "user.name", "Test User"], None).await;
        let _ = run_git_command(&["-C", &repo_path, "config", "user.email", "test@example.com"], None).await;

        // 3. Now is a repo
        assert!(git_is_repo(&repo_path).await);

        // 4. Create an untracked file
        let file_path = temp_dir.path().join("hello.txt");
        tokio::fs::write(&file_path, "Hello World\n").await.unwrap();

        let status = git_status(&repo_path).await.unwrap();
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "hello.txt");
        assert_eq!(status.entries[0].status, "untracked");
        assert!(!status.entries[0].staged);

        // Test diff on untracked file
        let diff_untracked = git_file_diff(&repo_path, "hello.txt", false).await.unwrap();
        assert!(diff_untracked.is_new);
        assert!(!diff_untracked.is_deleted);
        assert_eq!(diff_untracked.old_text, "");
        assert_eq!(diff_untracked.new_text, "Hello World\n");

        // 5. Stage file
        git_stage(&repo_path, &["hello.txt".to_string()]).await.unwrap();
        let status_staged = git_status(&repo_path).await.unwrap();
        assert_eq!(status_staged.entries.len(), 1);
        assert_eq!(status_staged.entries[0].status, "added");
        assert!(status_staged.entries[0].staged);

        // Test diff on staged new file
        let diff_staged = git_file_diff(&repo_path, "hello.txt", true).await.unwrap();
        assert!(diff_staged.is_new);
        assert_eq!(diff_staged.old_text, "");
        assert_eq!(diff_staged.new_text, "Hello World\n");

        // 6. Unstage file
        git_unstage(&repo_path, &["hello.txt".to_string()]).await.unwrap();
        let status_unstaged = git_status(&repo_path).await.unwrap();
        assert_eq!(status_unstaged.entries.len(), 1);
        assert_eq!(status_unstaged.entries[0].status, "untracked");
        assert!(!status_unstaged.entries[0].staged);

        // 7. Stage again and commit
        git_stage(&repo_path, &["hello.txt".to_string()]).await.unwrap();
        git_commit(&repo_path, "Initial commit").await.unwrap();

        let status_clean = git_status(&repo_path).await.unwrap();
        assert!(status_clean.entries.is_empty());

        // 8. Branches check
        let branches = git_branches(&repo_path).await.unwrap();
        assert!(!branches.current.is_empty());
        assert!(!branches.local.is_empty());

        // 9. Create and checkout new branch
        git_checkout(&repo_path, "feature-1", true).await.unwrap();
        let branches_after_checkout = git_branches(&repo_path).await.unwrap();
        assert_eq!(branches_after_checkout.current, "feature-1");
        assert!(branches_after_checkout.local.contains(&"feature-1".to_string()));

        // 10. Modify file and check diff
        tokio::fs::write(&file_path, "Hello World modified\n").await.unwrap();
        let diff_mod = git_file_diff(&repo_path, "hello.txt", false).await.unwrap();
        assert!(!diff_mod.is_new);
        assert!(!diff_mod.is_deleted);
        assert_eq!(diff_mod.old_text, "Hello World\n");
        assert_eq!(diff_mod.new_text, "Hello World modified\n");
    }
}
