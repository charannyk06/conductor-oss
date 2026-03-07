use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, sync::Arc, time::Duration};

const INTERNAL_TOKEN_HEADER: &str = "x-conductor-executor-internal-token";
const REMOTE_TOKEN_HEADER: &str = "x-conductor-executor-token";

#[derive(Clone)]
struct AppState {
    client: Client,
    web_base_url: String,
    internal_token: Option<String>,
    remote_token: Option<String>,
}

#[derive(Deserialize)]
struct FeedQuery {
    lines: Option<u32>,
}

#[tokio::main]
async fn main() {
    let port = env::var("CONDUCTOR_EXECUTOR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4318);

    let web_base_url = env::var("CONDUCTOR_WEB_INTERNAL_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string())
        .trim_end_matches('/')
        .to_string();

    let state = Arc::new(AppState {
        client: Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client"),
        web_base_url,
        internal_token: env::var("CONDUCTOR_EXECUTOR_INTERNAL_TOKEN").ok().filter(|value| !value.is_empty()),
        remote_token: env::var("CONDUCTOR_EXECUTOR_REMOTE_TOKEN").ok().filter(|value| !value.is_empty()),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/sessions/{id}/feed", get(session_feed))
        .route("/sessions/{id}/send", post(session_send))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind sidecar port");

    println!("conductor runtime sidecar listening on {}", port);
    axum::serve(listener, app)
        .await
        .expect("runtime sidecar server failed");
}

async fn health(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<Value>) {
    if let Err(response) = authorize(&headers, &state.remote_token) {
        return response;
    }

    (
        StatusCode::OK,
        Json(json!({
            "status": "ok",
            "mode": "remote",
            "transport": "rust-sidecar-proxy",
            "remoteUrl": null,
            "capabilities": ["feed", "send"],
            "proxyTarget": state.web_base_url,
        })),
    )
}

async fn session_feed(
    Path(session_id): Path<String>,
    Query(query): Query<FeedQuery>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> (StatusCode, Json<Value>) {
    if let Err(response) = authorize(&headers, &state.remote_token) {
        return response;
    }

    let lines = query.lines.unwrap_or(1200);
    let path = format!(
        "/api/internal/executor/sessions/{}/feed?lines={}",
        percent_encode_path(&session_id),
        lines
    );

    proxy_get(&state, &path).await
}

async fn session_send(
    Path(session_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if let Err(response) = authorize(&headers, &state.remote_token) {
        return response;
    }

    let path = format!(
        "/api/internal/executor/sessions/{}/send",
        percent_encode_path(&session_id)
    );

    proxy_post(&state, &path, payload).await
}

fn authorize(headers: &HeaderMap, expected_token: &Option<String>) -> Result<(), (StatusCode, Json<Value>)> {
    let Some(expected) = expected_token else {
        return Ok(());
    };

    let provided = headers
        .get(REMOTE_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    if provided == expected {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized" })),
        ))
    }
}

async fn proxy_get(state: &AppState, path: &str) -> (StatusCode, Json<Value>) {
    let mut request = state.client.get(format!("{}{}", state.web_base_url, path));
    if let Some(token) = &state.internal_token {
        request = request.header(INTERNAL_TOKEN_HEADER, token);
    }

    match request.send().await {
        Ok(response) => map_response(response).await,
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Failed to reach web backend: {}", error) })),
        ),
    }
}

async fn proxy_post(state: &AppState, path: &str, payload: Value) -> (StatusCode, Json<Value>) {
    let mut request = state
        .client
        .post(format!("{}{}", state.web_base_url, path))
        .json(&payload);

    if let Some(token) = &state.internal_token {
        request = request.header(INTERNAL_TOKEN_HEADER, token);
    }

    match request.send().await {
        Ok(response) => map_response(response).await,
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Failed to reach web backend: {}", error) })),
        ),
    }
}

async fn map_response(response: reqwest::Response) -> (StatusCode, Json<Value>) {
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    match response.json::<Value>().await {
        Ok(payload) => (status, Json(payload)),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("Invalid backend response: {}", error) })),
        ),
    }
}

fn percent_encode_path(input: &str) -> String {
    input.replace('%', "%25").replace('/', "%2F")
}
