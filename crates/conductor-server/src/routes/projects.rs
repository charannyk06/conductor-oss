use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::Serialize;
use std::io::ErrorKind;
use std::path::Path as FsPath;
use std::sync::Arc;
use tokio::process::Command;

use crate::state::{resolve_board_file, AppState};
use conductor_core::config::ProjectConfig;
use conductor_core::support::{
    resolve_project_path, sync_project_local_config, sync_support_files_for_directory,
};
use conductor_db::repo::project_repo::ProjectRow;
use conductor_db::repo::ProjectRepo;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/projects", get(list_projects))
        .route("/api/projects/{id}", get(get_project))
        .route("/api/projects/{id}/open", post(open_project))
        .route("/api/projects/{id}/setup", post(setup_project))
}

#[derive(Serialize)]
struct ProjectResponse {
    id: String,
    name: String,
    path: String,
    board_path: Option<String>,
    default_executor: Option<String>,
    max_sessions: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenProjectBody {
    ide: Option<String>,
}

async fn list_projects(State(state): State<Arc<AppState>>) -> Json<Vec<ProjectResponse>> {
    let pool = state.db.pool();
    let projects = ProjectRepo::list(pool).await.unwrap_or_default();

    if !projects.is_empty() {
        return Json(projects.into_iter().map(db_project_response).collect());
    }

    let config = state.config.read().await.clone();
    let default_agent = config.preferences.coding_agent.clone();
    Json(
        config
            .projects
            .iter()
            .map(|(id, project)| config_project_response(&state, id, project, &default_agent))
            .collect(),
    )
}

async fn get_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<Option<ProjectResponse>> {
    let pool = state.db.pool();
    let project = ProjectRepo::get(pool, &id).await.unwrap_or(None);

    if let Some(project) = project {
        return Json(Some(db_project_response(project)));
    }

    let config = state.config.read().await.clone();
    let default_agent = config.preferences.coding_agent.clone();
    Json(
        config
            .projects
            .get(&id)
            .map(|project| config_project_response(&state, &id, project, &default_agent)),
    )
}

fn db_project_response(project: ProjectRow) -> ProjectResponse {
    ProjectResponse {
        id: project.id,
        name: project.name,
        path: project.path,
        board_path: project.board_path,
        default_executor: project.default_executor,
        max_sessions: project.max_sessions,
    }
}

fn config_project_response(
    state: &AppState,
    id: &str,
    project: &ProjectConfig,
    default_agent: &str,
) -> ProjectResponse {
    let name = project
        .name
        .clone()
        .or_else(|| project.repo.clone())
        .unwrap_or_else(|| id.to_string());
    let board_dir = project.board_dir.as_deref().unwrap_or(id);
    let board_path = Some(resolve_board_file(
        &state.workspace_path,
        board_dir,
        Some(&project.path),
    ));

    ProjectResponse {
        id: id.to_string(),
        name,
        path: project.path.clone(),
        board_path,
        default_executor: project
            .agent
            .clone()
            .or_else(|| Some(default_agent.to_string())),
        max_sessions: 5,
    }
}

async fn setup_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": format!("Project {id} not found") })),
        );
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let local_config_synced = match sync_project_local_config(&config, &state.workspace_path, &id) {
        Ok(value) => value,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": err.to_string() })),
            )
        }
    };
    let support_files_synced = match sync_support_files_for_directory(&config, &project_root) {
        Ok(value) => value,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": err.to_string() })),
            )
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "projectId": id,
            "path": project_root,
            "localConfigSynced": local_config_synced,
            "supportFilesSynced": support_files_synced,
        })),
    )
}

async fn open_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<OpenProjectBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": format!("Project {id} not found") })),
        );
    };

    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let editor = body
        .ide
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.preferences.ide.trim());

    match launch_project_in_editor(editor, &project_root).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "projectId": id,
                "path": project_root,
                "editor": editor,
            })),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn launch_project_in_editor(editor: &str, path: &FsPath) -> anyhow::Result<()> {
    let path_string = path.to_string_lossy().to_string();
    let use_system_file_manager = editor.eq_ignore_ascii_case("finder");

    if cfg!(target_os = "macos") {
        if use_system_file_manager {
            return run_open_command(
                "open",
                vec!["-a".to_string(), "Finder".to_string(), path_string],
            )
            .await;
        }
        if let Some(app_name) = ide_app_name(editor) {
            return run_open_command(
                "open",
                vec!["-a".to_string(), app_name.to_string(), path_string],
            )
            .await;
        }
        return run_open_command("open", vec![path_string]).await;
    }

    if cfg!(target_os = "windows") {
        if use_system_file_manager {
            return run_open_command("explorer", vec![path_string]).await;
        }
        if let Some(command) = ide_command(editor) {
            if try_open_command(command, vec![path_string.clone()]).await? {
                return Ok(());
            }
        }

        return run_open_command(
            "cmd",
            vec![
                "/C".to_string(),
                "start".to_string(),
                String::new(),
                path_string,
            ],
        )
        .await;
    }

    if use_system_file_manager {
        return run_open_command("xdg-open", vec![path_string]).await;
    }

    if let Some(command) = ide_command(editor) {
        if try_open_command(command, vec![path_string.clone()]).await? {
            return Ok(());
        }
    }

    run_open_command("xdg-open", vec![path_string]).await
}

fn ide_app_name(editor: &str) -> Option<&'static str> {
    if editor.eq_ignore_ascii_case("vscode") {
        Some("Visual Studio Code")
    } else if editor.eq_ignore_ascii_case("vscode-insiders") {
        Some("Visual Studio Code - Insiders")
    } else if editor.eq_ignore_ascii_case("cursor") {
        Some("Cursor")
    } else if editor.eq_ignore_ascii_case("windsurf") {
        Some("Windsurf")
    } else if editor.eq_ignore_ascii_case("intellij-idea") {
        Some("IntelliJ IDEA")
    } else if editor.eq_ignore_ascii_case("zed") {
        Some("Zed")
    } else if editor.eq_ignore_ascii_case("xcode") {
        Some("Xcode")
    } else if editor.eq_ignore_ascii_case("antigravity") {
        Some("Antigravity")
    } else {
        None
    }
}

fn ide_command(editor: &str) -> Option<&'static str> {
    if editor.eq_ignore_ascii_case("vscode") {
        Some("code")
    } else if editor.eq_ignore_ascii_case("vscode-insiders") {
        Some("code-insiders")
    } else if editor.eq_ignore_ascii_case("cursor") {
        Some("cursor")
    } else if editor.eq_ignore_ascii_case("windsurf") {
        Some("windsurf")
    } else if editor.eq_ignore_ascii_case("intellij-idea") {
        Some("idea")
    } else if editor.eq_ignore_ascii_case("zed") {
        Some("zed")
    } else if editor.eq_ignore_ascii_case("antigravity") {
        Some("antigravity")
    } else {
        None
    }
}

async fn try_open_command(program: &str, args: Vec<String>) -> anyhow::Result<bool> {
    match Command::new(program).args(&args).status().await {
        Ok(status) => {
            if status.success() {
                Ok(true)
            } else {
                anyhow::bail!("Opening project failed via {}", program);
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

async fn run_open_command(program: &str, args: Vec<String>) -> anyhow::Result<()> {
    if try_open_command(program, args).await? {
        Ok(())
    } else {
        anyhow::bail!("Required opener is not installed: {}", program)
    }
}
