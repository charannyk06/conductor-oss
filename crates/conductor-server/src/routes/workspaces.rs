use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use conductor_core::config::ProjectConfig;
use conductor_core::{sync_project_local_config, sync_support_files_for_directory};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;
use tracing::info;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route("/api/workspaces/branches", get(detect_branches))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn created(value: Value) -> ApiResponse {
    (StatusCode::CREATED, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BranchQuery {
    git_url: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceBody {
    mode: String,
    project_id: Option<String>,
    agent: Option<String>,
    agent_model: Option<String>,
    agent_reasoning_effort: Option<String>,
    default_branch: Option<String>,
    use_worktree: Option<bool>,
    git_url: Option<String>,
    path: Option<String>,
    initialize_git: Option<bool>,
}

struct PersistWorkspaceRequest {
    agent: Option<String>,
    agent_model: Option<String>,
    agent_reasoning_effort: Option<String>,
    repo: Option<String>,
    path: PathBuf,
    default_branch: String,
    use_worktree: bool,
}

async fn list_workspaces(State(state): State<Arc<AppState>>) -> ApiResponse {
    let config = state.config.read().await.clone();
    let projects = config
        .projects
        .iter()
        .map(|(id, project)| {
            json!({
                "id": id,
                "name": project.name.clone().unwrap_or_else(|| id.to_string()),
                "repo": project.repo.clone(),
                "workspace": project.workspace.clone().unwrap_or_else(|| "worktree".to_string()),
                "runtime": project.runtime.clone().unwrap_or_else(|| "ttyd".to_string()),
                "path": resolve_path(&state.workspace_path, &project.path).to_string_lossy().to_string(),
                "defaultBranch": project.default_branch.clone(),
                "agent": project.agent.clone().unwrap_or_else(|| config.preferences.coding_agent.clone()),
                "agentModel": project.agent_config.model.clone(),
                "agentReasoningEffort": project.agent_config.reasoning_effort.clone(),
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "workspaces": projects }))
}

async fn detect_branches(Query(query): Query<BranchQuery>) -> ApiResponse {
    if let Some(path) = query
        .path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match detect_local_branches(Path::new(path)).await {
            Ok((branches, default_branch)) => {
                return ok(json!({ "branches": branches, "defaultBranch": default_branch }));
            }
            Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
        }
    }

    if let Some(git_url) = query
        .git_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match detect_remote_branches(git_url).await {
            Ok((branches, default_branch)) => {
                return ok(json!({ "branches": branches, "defaultBranch": default_branch }));
            }
            Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
        }
    }

    error(StatusCode::BAD_REQUEST, "Either path or gitUrl is required")
}

async fn create_workspace(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateWorkspaceBody>,
) -> ApiResponse {
    let mode = body.mode.trim().to_lowercase();
    if mode != "git" && mode != "local" {
        return error(StatusCode::BAD_REQUEST, "mode must be either git or local");
    }

    let default_branch = body
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    let requested_agent = body.agent.clone().filter(|value| !value.trim().is_empty());
    let requested_model = body
        .agent_model
        .clone()
        .filter(|value| !value.trim().is_empty());
    let requested_reasoning_effort = body
        .agent_reasoning_effort
        .clone()
        .filter(|value| !value.trim().is_empty());

    if mode == "git" {
        let Some(git_url) = body
            .git_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return error(StatusCode::BAD_REQUEST, "gitUrl is required for git mode");
        };
        let repo_name = repo_name_from_url(git_url).unwrap_or("workspace");
        let project_id = body
            .project_id
            .as_deref()
            .map(normalize_token)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_token(repo_name));
        let path = body
            .path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| state.workspace_path.join("repos").join(&project_id));

        if let Err(err) = ensure_parent_dir(&path) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
        }

        if !path.join(".git").exists() {
            match clone_repository(git_url, &path, &default_branch).await {
                Ok(()) => {}
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }

        let canonical_path = match canonicalize_existing_path(&path) {
            Ok(path) => path,
            Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        };
        let project_id = body
            .project_id
            .as_deref()
            .map(normalize_token)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_token(repo_name));
        return persist_workspace(
            state,
            &project_id,
            PersistWorkspaceRequest {
                agent: requested_agent,
                agent_model: requested_model,
                agent_reasoning_effort: requested_reasoning_effort,
                repo: Some(git_url.to_string()),
                path: canonical_path,
                default_branch,
                use_worktree: body.use_worktree.unwrap_or(true),
            },
        )
        .await;
    } else {
        let Some(path) = body
            .path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
        else {
            return error(StatusCode::BAD_REQUEST, "path is required for local mode");
        };

        if body.initialize_git.unwrap_or(false) && !path.join(".git").exists() {
            match init_repository(&path, &default_branch).await {
                Ok(()) => {}
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }

        let canonical_path = match canonicalize_existing_path(&path) {
            Ok(path) => path,
            Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
        };
        let folder_name = canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace");
        let project_id = body
            .project_id
            .as_deref()
            .map(normalize_token)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| normalize_token(folder_name));
        let repo = local_repo_name(&canonical_path).await.ok();
        return persist_workspace(
            state,
            &project_id,
            PersistWorkspaceRequest {
                agent: requested_agent,
                agent_model: requested_model,
                agent_reasoning_effort: requested_reasoning_effort,
                repo,
                path: canonical_path,
                default_branch,
                use_worktree: body.use_worktree.unwrap_or(true),
            },
        )
        .await;
    }
}

async fn persist_workspace(
    state: Arc<AppState>,
    project_id: &str,
    request: PersistWorkspaceRequest,
) -> ApiResponse {
    let board_dir = project_id.to_string();
    if let Err(err) = ensure_board_file(&state.workspace_path, &board_dir) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    let mut config = state.config.write().await;
    let project = config
        .projects
        .entry(project_id.to_string())
        .or_insert_with(ProjectConfig::default);
    project.name = Some(project_id.to_string());
    project.repo = request.repo.or_else(|| Some(project_id.to_string()));
    project.path = request.path.to_string_lossy().to_string();
    project.default_branch = request.default_branch.clone();
    project.agent = request.agent;
    project.agent_config.model = request.agent_model;
    project.agent_config.reasoning_effort = request.agent_reasoning_effort;
    project.runtime = Some("ttyd".to_string());
    project.workspace = Some(if request.use_worktree {
        "worktree".to_string()
    } else {
        "local".to_string()
    });
    project.board_dir = Some(board_dir.clone());
    let saved = project.clone();
    drop(config);

    if let Err(err) = state.save_config().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    let config = state.config.read().await.clone();
    info!(project_id, path = %request.path.display(), "Persisted workspace project; syncing local scaffold");
    if let Err(err) = ensure_project_root_board(&request.path, project_id) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    let mirrored = match sync_project_local_config(&config, &state.workspace_path, project_id) {
        Ok(mirrored) => mirrored,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    if let Err(err) = sync_support_files_for_directory(&config, &request.path) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    if let Err(err) = sync_support_files_for_directory(&config, &state.workspace_path) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    info!(project_id, mirrored, path = %request.path.display(), "Finished syncing workspace project scaffold");

    created(json!({
        "project": {
            "id": project_id,
            "name": saved.name,
            "repo": saved.repo,
            "path": saved.path,
            "defaultBranch": saved.default_branch,
            "agent": saved.agent,
            "boardDir": saved.board_dir,
        }
    }))
}

fn resolve_path(workspace_path: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

fn normalize_token(value: &str) -> String {
    let input = value.trim().to_lowercase();
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        let is_safe = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        if is_safe {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "workspace".to_string()
    } else {
        out
    }
}

fn repo_name_from_url(value: &str) -> Option<&str> {
    value
        .rsplit('/')
        .next()
        .map(|segment| segment.trim_end_matches(".git"))
        .filter(|segment| !segment.is_empty())
}

/// Validate that a git URL looks like a legitimate repository URL
/// and does not attempt to inject CLI flags or target internal services.
fn validate_git_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    // Reject flag injection: URLs starting with "-" could be interpreted as git flags.
    if trimmed.starts_with('-') {
        return Err("Invalid git URL: must not start with '-'".to_string());
    }
    // Only allow known protocols.
    let has_known_protocol = trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("git://")
        || trimmed.starts_with("git@")
        || trimmed.starts_with("ssh://");
    if !has_known_protocol {
        return Err(
            "Invalid git URL: must use https://, http://, git://, ssh://, or git@ protocol"
                .to_string(),
        );
    }
    // Block requests to cloud metadata endpoints (SSRF).
    let lower = trimmed.to_lowercase();
    if lower.contains("169.254.169.254")
        || lower.contains("metadata.google")
        || lower.contains("[fd00:")
        || lower.contains("localhost")
        || lower.contains("127.0.0.1")
        || lower.contains("[::1]")
    {
        return Err("Invalid git URL: internal/metadata addresses are not allowed".to_string());
    }
    Ok(())
}

/// Validate that a branch name is safe for use as a CLI argument.
fn validate_branch_name(branch: &str) -> Result<(), String> {
    let trimmed = branch.trim();
    if trimmed.starts_with('-') {
        return Err("Invalid branch name: must not start with '-'".to_string());
    }
    if trimmed.contains("..") {
        return Err("Invalid branch name: must not contain '..'".to_string());
    }
    Ok(())
}

fn ensure_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn canonicalize_existing_path(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

fn ensure_board_file(workspace_path: &Path, board_dir: &str) -> std::io::Result<()> {
    let board_path = workspace_path
        .join("projects")
        .join(board_dir)
        .join("CONDUCTOR.md");
    if let Some(parent) = board_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if !board_path.exists() {
        std::fs::write(
            board_path,
            "# Conductor Board\n\n## To do\n\n## Ready\n\n## In progress\n\n## In review\n\n## Done\n\n## Blocked\n",
        )?;
    }
    Ok(())
}

fn ensure_project_root_board(project_path: &Path, project_id: &str) -> std::io::Result<()> {
    let board_path = project_path.join("CONDUCTOR.md");
    if board_path.exists() {
        return Ok(());
    }

    let display_name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(project_id);

    std::fs::write(
        board_path,
        format!(
            "# {display_name}\n\n> Conductor AI agent orchestrator. Tags: `#project/{project_id}` `#agent/claude-code` `#agent/codex` `#agent/gemini`\n\n## Inbox\n\n> Drop rough ideas here.\n\n## Ready to Dispatch\n\n> Move tagged tasks here to dispatch an agent.\n\n## Dispatching\n\n## In Progress\n\n## Review\n\n## Done\n\n## Blocked\n"
        ),
    )
}

async fn clone_repository(git_url: &str, path: &Path, branch: &str) -> anyhow::Result<()> {
    validate_git_url(git_url).map_err(|e| anyhow::anyhow!(e))?;
    validate_branch_name(branch).map_err(|e| anyhow::anyhow!(e))?;

    let output = Command::new("git")
        .args([
            "clone",
            "--branch",
            branch,
            "--", // End of options: prevents git_url from being interpreted as a flag
            git_url,
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

async fn init_repository(path: &Path, branch: &str) -> anyhow::Result<()> {
    validate_branch_name(branch).map_err(|e| anyhow::anyhow!(e))?;
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    let output = Command::new("git")
        .args(["init", "-b", branch, "--", path.to_string_lossy().as_ref()])
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let commit_output = Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "-c",
            "user.name=Conductor",
            "-c",
            "user.email=conductor@local",
            "commit",
            "--allow-empty",
            "-m",
            "Initialize Conductor workspace",
        ])
        .output()
        .await?;
    if !commit_output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&commit_output.stderr).to_string());
    }
    Ok(())
}

async fn detect_local_branches(path: &Path) -> anyhow::Result<(Vec<String>, Option<String>)> {
    if path.join(".git").exists() {
        match Command::new("git")
            .args([
                "-C",
                path.to_string_lossy().as_ref(),
                "remote",
                "update",
                "--prune",
                "--",
            ])
            .output()
            .await
        {
            Ok(sync_output) => {
                if !sync_output.status.success() {
                    tracing::warn!(
                        "Failed to sync remote refs for '{}': {}",
                        path.display(),
                        String::from_utf8_lossy(&sync_output.stderr).trim()
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    "Failed to run git remote update --prune for '{}': {}",
                    path.display(),
                    err
                );
            }
        }
    }

    let branch_output = Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .await?;
    if !branch_output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&branch_output.stderr).to_string());
    }
    let branches = normalize_branch_refs(String::from_utf8_lossy(&branch_output.stdout).lines());
    let default_branch = detect_local_default_branch(path)
        .await?
        .or_else(|| branches.first().cloned());

    Ok((branches, default_branch))
}

async fn detect_remote_branches(git_url: &str) -> anyhow::Result<(Vec<String>, Option<String>)> {
    validate_git_url(git_url).map_err(|e| anyhow::anyhow!(e))?;

    let branch_output = Command::new("git")
        .args(["ls-remote", "--heads", "--", git_url])
        .output()
        .await?;
    if !branch_output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&branch_output.stderr).to_string());
    }
    let mut branches = String::from_utf8_lossy(&branch_output.stdout)
        .lines()
        .filter_map(|line| line.split_whitespace().nth(1))
        .filter_map(|ref_name| ref_name.strip_prefix("refs/heads/"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    branches.sort();

    let head_output = Command::new("git")
        .args(["ls-remote", "--symref", "--", git_url, "HEAD"])
        .output()
        .await?;
    let default_branch = if head_output.status.success() {
        String::from_utf8_lossy(&head_output.stdout)
            .lines()
            .find_map(|line| {
                if !line.starts_with("ref:") {
                    return None;
                }
                line.split_whitespace()
                    .nth(1)
                    .and_then(|ref_name| ref_name.strip_prefix("refs/heads/"))
                    .map(ToOwned::to_owned)
            })
            .or_else(|| branches.first().cloned())
    } else {
        branches.first().cloned()
    };

    Ok((branches, default_branch))
}

async fn local_repo_name(path: &Path) -> anyhow::Result<String> {
    let output = Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "remote",
            "get-url",
            "origin",
        ])
        .output()
        .await?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Ok(url);
        }
    }
    Ok(path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace")
        .to_string())
}

async fn detect_local_default_branch(path: &Path) -> anyhow::Result<Option<String>> {
    let remote_head_output = Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
        ])
        .output()
        .await?;
    if remote_head_output.status.success() {
        let value = String::from_utf8_lossy(&remote_head_output.stdout);
        if let Some(branch) = normalize_branch_ref(value.trim()) {
            return Ok(Some(branch));
        }
    }

    let head_output = Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ])
        .output()
        .await?;
    if !head_output.status.success() {
        return Ok(None);
    }

    Ok(normalize_branch_ref(
        String::from_utf8_lossy(&head_output.stdout).trim(),
    ))
}

fn normalize_branch_refs<'a>(refs: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    refs.into_iter()
        .filter_map(normalize_branch_ref)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_branch_ref(ref_name: &str) -> Option<String> {
    let trimmed = ref_name.trim();
    if trimmed.is_empty() || trimmed == "HEAD" {
        return None;
    }

    if let Some(branch) = trimmed.strip_prefix("refs/heads/") {
        return Some(branch.to_string());
    }

    if let Some(remote_ref) = trimmed.strip_prefix("refs/remotes/") {
        let (_, branch) = remote_ref.split_once('/')?;
        return (branch != "HEAD").then(|| branch.to_string());
    }

    if let Some(branch) = trimmed.strip_prefix("origin/") {
        return (branch != "HEAD").then(|| branch.to_string());
    }

    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::{normalize_branch_ref, normalize_branch_refs};

    #[test]
    fn normalize_branch_refs_merges_local_and_remote_refs() {
        let branches = normalize_branch_refs([
            "refs/heads/main",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            "refs/remotes/origin/feature/review-fix",
            "refs/remotes/upstream/feature/review-fix",
        ]);

        assert_eq!(
            branches,
            vec!["feature/review-fix".to_string(), "main".to_string()]
        );
    }

    #[test]
    fn normalize_branch_ref_handles_short_remote_refs() {
        assert_eq!(
            normalize_branch_ref("origin/main"),
            Some("main".to_string())
        );
        assert_eq!(
            normalize_branch_ref("feature/review"),
            Some("feature/review".to_string())
        );
        assert_eq!(normalize_branch_ref("origin/HEAD"), None);
    }
}
