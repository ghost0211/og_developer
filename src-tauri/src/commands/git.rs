use ogdeveloper_core::git::{GitBranchInfo, GitCloneRequest, GitFileDiff, GitStatusInfo};

#[tauri::command]
pub async fn git_is_repo(path: String) -> bool {
    ogdeveloper_core::git::git_is_repo(&path).await
}

#[tauri::command]
pub async fn git_clone(request: GitCloneRequest) -> Result<String, String> {
    ogdeveloper_core::git::git_clone(request).await
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusInfo, String> {
    ogdeveloper_core::git::git_status(&repo_path).await
}

#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<GitBranchInfo, String> {
    ogdeveloper_core::git::git_branches(&repo_path).await
}

#[tauri::command]
pub async fn git_checkout(repo_path: String, branch: String, create: bool) -> Result<(), String> {
    ogdeveloper_core::git::git_checkout(&repo_path, &branch, create).await
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    ogdeveloper_core::git::git_stage(&repo_path, &paths).await
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    ogdeveloper_core::git::git_unstage(&repo_path, &paths).await
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<(), String> {
    ogdeveloper_core::git::git_commit(&repo_path, &message).await
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String> {
    ogdeveloper_core::git::git_pull(&repo_path).await
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String> {
    ogdeveloper_core::git::git_push(&repo_path).await
}

#[tauri::command]
pub async fn git_file_diff(repo_path: String, path: String, staged: bool) -> Result<GitFileDiff, String> {
    ogdeveloper_core::git::git_file_diff(&repo_path, &path, staged).await
}
