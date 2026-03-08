use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use conductor_core::config::ProjectConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/repositories", get(list_repositories).put(save_repository))
        .route("/api/repositories/{id}", delete(delete_repository))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRepositoryBody {
    id: String,
    display_name: Option<String>,
    repo: String,
    path: String,
    agent: Option<String>,
    agent_model: Option<String>,
    agent_reasoning_effort: Option<String>,
    default_working_directory: Option<String>,
    default_branch: Option<String>,
    dev_server_script: Option<String>,
    setup_script: Option<String>,
    run_setup_in_parallel: Option<bool>,
    cleanup_script: Option<String>,
    archive_script: Option<String>,
    copy_files: Option<String>,
}

async fn list_repositories(State(state): State<Arc<AppState>>) -> ApiResponse {
    let config = state.config.read().await.clone();
    let repositories = config
        .projects
        .iter()
        .map(|(id, project)| repository_payload(id, project, &config.preferences.coding_agent, &state.workspace_path))
        .collect::<Vec<_>>();
    ok(json!({ "repositories": repositories }))
}

async fn save_repository(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SaveRepositoryBody>,
) -> ApiResponse {
    if body.id.trim().is_empty() || body.repo.trim().is_empty() || body.path.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "id, repo, and path are required");
    }

    let mut config = state.config.write().await;
    let project = config.projects.entry(body.id.clone()).or_insert_with(ProjectConfig::default);
    project.name = body.display_name.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    project.repo = Some(body.repo.trim().to_string());
    project.path = body.path.trim().to_string();
    project.agent = body.agent.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    project.default_branch = body.default_branch.unwrap_or_else(|| "main".to_string()).trim().to_string();
    project.default_working_directory = body.default_working_directory.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    project.agent_config.model = body.agent_model.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    project.agent_config.reasoning_effort = body.agent_reasoning_effort.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    project.run_setup_in_parallel = body.run_setup_in_parallel.unwrap_or(false);
    project.dev_server_script = split_lines(body.dev_server_script.as_deref());
    project.setup_script = split_lines(body.setup_script.as_deref());
    project.cleanup_script = split_lines(body.cleanup_script.as_deref());
    project.archive_script = split_lines(body.archive_script.as_deref());
    project.copy_files = split_lines(body.copy_files.as_deref());
    let saved = project.clone();
    let default_agent = config.preferences.coding_agent.clone();
    drop(config);

    if let Err(err) = state.save_config().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    ok(json!({
        "repository": repository_payload(&body.id, &saved, &default_agent, &state.workspace_path)
    }))
}

async fn delete_repository(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> ApiResponse {
    let mut config = state.config.write().await;
    if !config.projects.contains_key(&id) {
        return error(StatusCode::NOT_FOUND, format!("Repository not found: {id}"));
    }
    config.projects.remove(&id);
    drop(config);

    if let Err(err) = state.save_config().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }

    ok(json!({ "ok": true }))
}

fn split_lines(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn repository_payload(id: &str, project: &ProjectConfig, default_agent: &str, workspace_path: &Path) -> Value {
    let resolved_path = resolve_project_path(workspace_path, &project.path);
    let exists = resolved_path.exists();
    let is_git_repository = resolved_path.join(".git").exists();
    let suggested_path = suggest_git_path(workspace_path, id, project, &resolved_path)
        .map(|value| value.to_string_lossy().to_string());

    json!({
        "id": id,
        "displayName": project.name.clone().unwrap_or_else(|| id.to_string()),
        "repo": project.repo.clone().unwrap_or_else(|| id.to_string()),
        "path": resolved_path.to_string_lossy().to_string(),
        "agent": project.agent.clone().unwrap_or_else(|| default_agent.to_string()),
        "agentModel": project.agent_config.model.clone(),
        "agentReasoningEffort": project.agent_config.reasoning_effort.clone(),
        "workspaceMode": "local",
        "runtimeMode": project.runtime.clone().unwrap_or_else(|| "rust".to_string()),
        "scmMode": "git",
        "defaultWorkingDirectory": project.default_working_directory.clone().unwrap_or_default(),
        "defaultBranch": project.default_branch.clone(),
        "devServerScript": project.dev_server_script.join("\n"),
        "setupScript": project.setup_script.join("\n"),
        "runSetupInParallel": project.run_setup_in_parallel,
        "cleanupScript": project.cleanup_script.join("\n"),
        "archiveScript": project.archive_script.join("\n"),
        "copyFiles": project.copy_files.join("\n"),
        "pathHealth": {
            "exists": exists,
            "isGitRepository": is_git_repository,
            "suggestedPath": suggested_path,
        }
    })
}

fn resolve_project_path(workspace_path: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

fn suggest_git_path(workspace_path: &Path, id: &str, project: &ProjectConfig, resolved_path: &Path) -> Option<PathBuf> {
    if resolved_path.join(".git").exists() {
        return None;
    }

    let repo_name = project
        .repo
        .as_deref()
        .and_then(|value| value.rsplit('/').next())
        .map(|value| value.trim_end_matches(".git"))
        .filter(|value| !value.is_empty())
        .unwrap_or(id);

    let candidates = [
        workspace_path.join(repo_name),
        workspace_path.join("repos").join(repo_name),
        workspace_path.join("projects").join(id),
    ];

    candidates.into_iter().find(|candidate| candidate.join(".git").exists())
}
