use crate::state::AppState;
use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use conductor_executors::{TtydConfig, TtydProcess};
use conductor_core::types::AgentKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Serialize, Deserialize)]
pub struct TtydSessionInfo {
    pub ws_url: String,
    pub http_url: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TtydQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub writable: Option<bool>,
}

pub async fn spawn_ttyd_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    Query(query): Query<TtydQuery>,
) -> Result<Json<TtydSessionInfo>, (axum::http::StatusCode, String)> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| (axum::http::StatusCode::NOT_FOUND, "Session not found".to_string()))?;

    let agent = &session.agent;
    let working_dir = session
        .workspace_path
        .clone()
        .ok_or_else(|| (axum::http::StatusCode::BAD_REQUEST, "Session has no working directory".to_string()))?;

    let agent_kind = AgentKind::parse(agent);
    let (command, env) = build_agent_command(&agent_kind, &working_dir, &session.model)
        .await
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;

    let config = TtydConfig {
        port: 0,
        writable: query.writable.unwrap_or(true),
        credential: None,
        ssl: false,
        ssl_cert: None,
        ssl_key: None,
        cols: query.cols.unwrap_or(120),
        rows: query.rows.unwrap_or(32),
        terminal_type: "xterm-256color".to_string(),
        max_clients: 0,
    };

    let ttyd_process = TtydProcess::new(
        session_id.clone(),
        &command,
        std::path::Path::new(&working_dir),
        &env,
        config,
    )
    .await
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let ws_url = ttyd_process.ws_url.clone();
    let http_url = ttyd_process.http_url.clone();

    state.ttyd_sessions.write().await.insert(
        session_id.clone(),
        RwLock::new(Some(ttyd_process)),
    );

    let info = TtydSessionInfo {
        ws_url,
        http_url,
        session_id,
    };

    Ok(Json(info))
}

pub async fn kill_ttyd_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, impl IntoResponse> {
    let process = state.ttyd_sessions.write().await.remove(&session_id);

    if let Some(process) = process {
        if let Some(mut p) = process.write().await.take() {
            p.kill().await.map_err(|e| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    e.to_string(),
                )
            })?;
        }
    }

    Ok::<_, (axum::http::StatusCode, String)>(axum::http::StatusCode::NO_CONTENT)
}

async fn build_agent_command(
    executor: &AgentKind,
    _cwd: &str,
    model: &Option<String>,
) -> Result<(Vec<String>, HashMap<String, String>)> {
    let mut env = std::env::vars().collect::<HashMap<String, String>>();
    env.insert("HOME".to_string(), std::env::var("HOME").unwrap_or_default());

    let command = match executor {
        AgentKind::ClaudeCode => {
            vec!["claude".to_string(), "--dangerously-skip-permissions".to_string(), "-p".to_string()]
        }
        AgentKind::Codex => vec!["npx".to_string(), "-y".to_string(), "@anthropic-ai/codex".to_string()],
        AgentKind::Gemini => vec!["gemini".to_string()],
        AgentKind::QwenCode => vec!["qwen-coder".to_string()],
        AgentKind::Amp => vec!["amp".to_string()],
        AgentKind::CursorCli => {
            vec!["cursor".to_string()]
        }
        AgentKind::OpenCode => vec!["opencode".to_string()],
        AgentKind::Droid => vec!["droid".to_string()],
        AgentKind::GithubCopilot => vec!["gh".to_string(), "copilot".to_string()],
        AgentKind::Ccr => vec!["ccr".to_string()],
        AgentKind::Custom(_) => vec!["bash".to_string(), "-l".to_string()],
    };

    if let Some(ref m) = model {
        if let Some(idx) = command.iter().position(|c| c == "--model" || c == "-m") {
            if idx + 1 < command.len() {
                env.insert("MODEL".to_string(), m.clone());
            }
        }
    }

    Ok((command, env))
}
