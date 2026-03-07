use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use conductor_core::config::ProjectConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::process::Command;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/workspaces", get(list_workspaces).post(create_workspace))
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
    default_branch: Option<String>,
    use_worktree: Option<bool>,
    git_url: Option<String>,
    path: Option<String>,
    initialize_git: Option<bool>,
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
                "path": resolve_path(&state.workspace_path, &project.path).to_string_lossy().to_string(),
                "defaultBranch": project.default_branch.clone(),
                "agent": project.agent.clone().unwrap_or_else(|| config.preferences.coding_agent.clone()),
            })
        })
        .collect::<Vec<_>>();
    ok(json!({ "projects": projects }))
}

async fn detect_branches(
    Query(query): Query<BranchQuery>,
) -> ApiResponse {
    if let Some(path) = query.path.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        match detect_local_branches(Path::new(path)).await {
            Ok((branches, default_branch)) => {
                return ok(json!({ "branches": branches, "defaultBranch": default_branch }));
            }
            Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
        }
    }

    if let Some(git_url) = query.git_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
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

    let default_branch = body.default_branch.clone().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "main".to_string());
    let requested_agent = body.agent.clone().filter(|value| !value.trim().is_empty());

    if mode == "git" {
        let Some(git_url) = body.git_url.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
            return error(StatusCode::BAD_REQUEST, "gitUrl is required for git mode");
        };
        let repo_name = repo_name_from_url(git_url).unwrap_or("workspace");
        let project_id = body.project_id.as_deref().map(normalize_token).filter(|value| !value.is_empty()).unwrap_or_else(|| normalize_token(repo_name));
        let path = body.path.as_deref().map(str::trim).filter(|value| !value.is_empty())
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

        let project_id = body.project_id.as_deref().map(normalize_token).filter(|value| !value.is_empty()).unwrap_or_else(|| normalize_token(repo_name));
        return persist_workspace(
            state,
            &project_id,
            requested_agent,
            Some(git_url.to_string()),
            path,
            default_branch,
            body.use_worktree.unwrap_or(true),
        ).await;
    } else {
        let Some(path) = body.path.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(PathBuf::from) else {
            return error(StatusCode::BAD_REQUEST, "path is required for local mode");
        };

        if body.initialize_git.unwrap_or(false) && !path.join(".git").exists() {
            match init_repository(&path, &default_branch).await {
                Ok(()) => {}
                Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
            }
        }

        let folder_name = path.file_name().and_then(|value| value.to_str()).unwrap_or("workspace");
        let project_id = body.project_id.as_deref().map(normalize_token).filter(|value| !value.is_empty()).unwrap_or_else(|| normalize_token(folder_name));
        let repo = local_repo_name(&path).await.ok();
        return persist_workspace(
            state,
            &project_id,
            requested_agent,
            repo,
            path,
            default_branch,
            body.use_worktree.unwrap_or(true),
        ).await;
    }
}

async fn persist_workspace(
    state: Arc<AppState>,
    project_id: &str,
    agent: Option<String>,
    repo: Option<String>,
    path: PathBuf,
    default_branch: String,
    use_worktree: bool,
) -> ApiResponse {
    let board_dir = project_id.to_string();
    if let Err(err) = ensure_board_file(&state.workspace_path, &board_dir) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    let mut config = state.config.write().await;
    let default_agent = config.preferences.coding_agent.clone();
    let project = config.projects.entry(project_id.to_string()).or_insert_with(ProjectConfig::default);
    project.name = Some(project_id.to_string());
    project.repo = repo.or_else(|| Some(project_id.to_string()));
    project.path = path.to_string_lossy().to_string();
    project.default_branch = default_branch.clone();
    project.agent = agent.or_else(|| Some(default_agent));
    project.runtime = Some(if use_worktree { "worktree".to_string() } else { "direct".to_string() });
    project.workspace = Some(path.to_string_lossy().to_string());
    project.board_dir = Some(board_dir.clone());
    let saved = project.clone();
    drop(config);

    if let Err(err) = state.save_config().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

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
    if out.is_empty() { "workspace".to_string() } else { out }
}

fn repo_name_from_url(value: &str) -> Option<&str> {
    value.rsplit('/').next().map(|segment| segment.trim_end_matches(".git")).filter(|segment| !segment.is_empty())
}

fn ensure_parent_dir(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn ensure_board_file(workspace_path: &Path, board_dir: &str) -> std::io::Result<()> {
    let board_path = workspace_path.join("projects").join(board_dir).join("CONDUCTOR.md");
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

async fn clone_repository(git_url: &str, path: &Path, branch: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args(["clone", "--branch", branch, git_url, path.to_string_lossy().as_ref()])
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

async fn init_repository(path: &Path, branch: &str) -> anyhow::Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    let output = Command::new("git")
        .args(["init", "-b", branch, path.to_string_lossy().as_ref()])
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

async fn detect_local_branches(path: &Path) -> anyhow::Result<(Vec<String>, Option<String>)> {
    let branch_output = Command::new("git")
        .args(["-C", path.to_string_lossy().as_ref(), "branch", "--format=%(refname:short)"])
        .output()
        .await?;
    if !branch_output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&branch_output.stderr).to_string());
    }
    let mut branches = String::from_utf8_lossy(&branch_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    branches.sort();

    let head_output = Command::new("git")
        .args(["-C", path.to_string_lossy().as_ref(), "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await?;
    let default_branch = if head_output.status.success() {
        let value = String::from_utf8_lossy(&head_output.stdout).trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    } else {
        branches.first().cloned()
    };

    Ok((branches, default_branch))
}

async fn detect_remote_branches(git_url: &str) -> anyhow::Result<(Vec<String>, Option<String>)> {
    let branch_output = Command::new("git")
        .args(["ls-remote", "--heads", git_url])
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
        .args(["ls-remote", "--symref", git_url, "HEAD"])
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
        .args(["-C", path.to_string_lossy().as_ref(), "remote", "get-url", "origin"])
        .output()
        .await?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Ok(url);
        }
    }
    Ok(path.file_name().and_then(|value| value.to_str()).unwrap_or("workspace").to_string())
}
