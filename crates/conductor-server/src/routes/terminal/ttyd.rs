use crate::state::AppState;
use anyhow::{anyhow, Result};
use axum::{
    extract::{ws::WebSocketUpgrade, Path, Query, State},
    response::IntoResponse,
    Json,
};
use conductor_core::types::AgentKind;
use conductor_ttyd::websocket::{handle_ttyd_websocket, TtydPrefs};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
pub struct TtydSessionInfo {
    pub session_id: String,
    pub native: bool,
    pub interactive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TtydQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// Spawn (or reattach to) a native ttyd session (PTY + WebSocket).
///
/// Uses `get_or_spawn` for idempotent spawning — reconnects (tab away/back,
/// network drops) reuse the existing session instead of failing.
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
        .ok_or_else(|| {
            (
                axum::http::StatusCode::BAD_REQUEST,
                "Session has no working directory".to_string(),
            )
        })?;

    let agent_kind = AgentKind::parse(agent);
    let prompt = if session.prompt.trim().is_empty() {
        None
    } else {
        Some(session.prompt.clone())
    };
    let (command, env) = build_agent_command(&agent_kind, &session.model, prompt.as_deref())
        .await
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;

    state
        .ttyd_server
        .get_or_spawn(
            session_id.clone(),
            command,
            working_dir,
            env,
            query.cols,
            query.rows,
        )
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TtydSessionInfo {
        session_id,
        native: true,
        interactive: true,
        notice: None,
    }))
}

/// Kill a native ttyd session.
pub async fn kill_ttyd_session(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, impl IntoResponse> {
    state.ttyd_server.kill_session(&session_id).await;
    Ok::<_, (axum::http::StatusCode, String)>(axum::http::StatusCode::NO_CONTENT)
}

/// Native ttyd WebSocket endpoint.
/// Client connects here after spawning a session via the spawn endpoint.
pub async fn ttyd_websocket(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, (axum::http::StatusCode, String)> {
    let session = state
        .ttyd_server
        .get_session(&session_id)
        .await
        .ok_or_else(|| {
            (
                axum::http::StatusCode::NOT_FOUND,
                "ttyd session not found".to_string(),
            )
        })?;

    Ok(ws.on_upgrade(move |socket| async move {
        handle_ttyd_websocket(socket, session, TtydPrefs::default()).await;
    }))
}

const MAX_TERMINAL_KEYS_BYTES: usize = 64 * 1024;

pub fn resolve_terminal_keys(keys: Option<String>, special: Option<String>) -> Result<String> {
    if let Some(keys) = keys {
        if keys.len() > MAX_TERMINAL_KEYS_BYTES {
            anyhow::bail!(
                "Terminal keys input exceeds maximum size ({} bytes > {} limit)",
                keys.len(),
                MAX_TERMINAL_KEYS_BYTES,
            );
        }
        return Ok(keys);
    }

    let special = special.ok_or_else(|| anyhow!("keys or special is required"))?;
    let mapped = match special.as_str() {
        "Enter" => "\r",
        "Tab" => "\t",
        "Backspace" => "\u{7f}",
        "Escape" => "\u{1b}",
        "ArrowUp" => "\u{1b}[A",
        "ArrowDown" => "\u{1b}[B",
        "ArrowRight" => "\u{1b}[C",
        "ArrowLeft" => "\u{1b}[D",
        "C-c" => "\u{3}",
        "C-d" => "\u{4}",
        "C-z" => "\u{1a}",
        "C-a" => "\u{1}",
        "C-e" => "\u{5}",
        "C-k" => "\u{b}",
        "C-u" => "\u{15}",
        "C-w" => "\u{17}",
        "C-l" => "\u{c}",
        "C-r" => "\u{12}",
        "C-s" => "\u{13}",
        "C-q" => "\u{11}",
        "C-b" => "\u{2}",
        "C-f" => "\u{6}",
        "C-n" => "\u{e}",
        "C-p" => "\u{10}",
        "C-y" => "\u{19}",
        _ => anyhow::bail!("Unknown special key: {}", special),
    };
    Ok(mapped.to_string())
}

async fn build_agent_command(
    executor: &AgentKind,
    model: &Option<String>,
    prompt: Option<&str>,
) -> Result<(Vec<String>, HashMap<String, String>)> {
    let mut env = std::env::vars().collect::<HashMap<String, String>>();
    env.insert(
        "HOME".to_string(),
        std::env::var("HOME").unwrap_or_default(),
    );

    let command = match executor {
        AgentKind::ClaudeCode => {
            let mut cmd = vec![
                "claude".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ];
            if let Some(p) = prompt {
                cmd.push("-p".to_string());
                cmd.push(p.to_string());
            }
            cmd
        }
        AgentKind::Codex => {
            let mut cmd = vec![
                "npx".to_string(),
                "-y".to_string(),
                "@openai/codex".to_string(),
            ];
            if let Some(p) = prompt {
                cmd.push(p.to_string());
            }
            cmd
        }
        AgentKind::Gemini => {
            let mut cmd = vec!["gemini".to_string()];
            if let Some(p) = prompt {
                cmd.push("-p".to_string());
                cmd.push(p.to_string());
            }
            cmd
        }
        AgentKind::QwenCode => vec!["qwen-coder".to_string()],
        AgentKind::Amp => vec!["amp".to_string()],
        AgentKind::CursorCli => vec!["cursor".to_string()],
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
