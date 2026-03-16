use crate::state::{AppState, TerminalSupervisor};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::sync::Arc;

pub async fn terminal_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    build_terminal_token_response(state, id, crate::state::TerminalTokenScope::Control).await
}

pub async fn terminal_stream_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    build_terminal_token_response(state, id, crate::state::TerminalTokenScope::Stream).await
}

async fn build_terminal_token_response(
    state: Arc<AppState>,
    id: String,
    scope: crate::state::TerminalTokenScope,
) -> Response {
    if state.get_session(&id).await.is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    }

    let supervisor = TerminalSupervisor::new(state.clone());
    let config = state.config.read().await;
    let access = config.access.clone();
    drop(config);

    let token_required = crate::routes::config::access_control_enabled(&access);
    let token = if token_required {
        supervisor.create_scoped_terminal_token(&id, scope).ok()
    } else {
        None
    };

    Json(json!({
        "token": token,
        "required": token_required,
        "expiresInSeconds": token.as_ref().map(|_| crate::state::TERMINAL_TOKEN_TTL_SECONDS),
    }))
    .into_response()
}
