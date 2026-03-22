use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use conductor_types::{BridgeStatus, BridgeToBrowserMessage, BrowserToBridgeMessage};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
}

#[derive(Debug, Default)]
struct RelayInner {
    channels: HashMap<String, BridgeChannel>,
    shares: HashMap<String, ShareRecord>,
    pairing_codes: HashMap<String, PendingPairing>,
    device_claims: HashMap<String, PendingDeviceClaim>,
    devices: HashMap<String, DeviceRecord>,
    terminal_sessions: HashMap<String, TerminalSessionRecord>,
    pending_api_requests: HashMap<String, PendingApiRequest>,
    pending_preview_requests: HashMap<String, PendingPreviewRequest>,
    refresh_tokens: HashMap<String, String>,
    rate_limits: HashMap<String, RateBucket>,
    next_connection_id: u64,
}

#[derive(Debug, Default)]
struct BridgeChannel {
    bridge: Option<ConnectionRecord>,
    browsers: HashMap<u64, ConnectionRecord>,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone)]
struct ConnectionRecord {
    id: u64,
    user_id: String,
    tx: mpsc::UnboundedSender<Message>,
}

#[derive(Debug, Clone)]
struct ShareRecord {
    owner_user_id: String,
    device_id: String,
    session_scope: String,
    read_only: bool,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingPairing {
    owner_user_id: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingDeviceClaim {
    poll_token: String,
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
    suggested_name: Option<String>,
    expires_at: Instant,
    paired_response: Option<DevicePairResponse>,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    device_id: String,
    owner_user_id: String,
    name: String,
    hostname: String,
    os: String,
    arch: String,
    refresh_token: String,
}

#[derive(Debug)]
struct TerminalSessionRecord {
    device_id: String,
    owner_user_id: String,
    browser: Option<TerminalConnectionRecord>,
    bridge: Option<TerminalConnectionRecord>,
    bridge_ready_waiters: Vec<oneshot::Sender<()>>,
}

#[derive(Debug, Clone)]
struct TerminalConnectionRecord {
    tx: mpsc::UnboundedSender<Message>,
}

#[derive(Debug)]
struct PendingApiRequest {
    device_id: String,
    tx: oneshot::Sender<ProxiedApiResponse>,
}

#[derive(Debug)]
struct PendingPreviewRequest {
    device_id: String,
    tx: oneshot::Sender<ProxiedPreviewResponse>,
}

#[derive(Debug)]
struct ProxiedApiResponse {
    status: u16,
    body: Value,
}

#[derive(Debug)]
struct ProxiedPreviewResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body_base64: Option<String>,
}

const TERMINAL_SESSION_READY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
struct RateBucket {
    tokens: f64,
    last_refill: Instant,
}

impl RateBucket {
    fn new(now: Instant) -> Self {
        Self {
            tokens: 120.0,
            last_refill: now,
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        const MAX_TOKENS: f64 = 120.0;
        const REFILL_PER_SECOND: f64 = 2.0;

        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.last_refill = now;
        self.tokens = (self.tokens + elapsed * REFILL_PER_SECOND).min(MAX_TOKENS);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WsQuery {
    token: Option<String>,
    jwt: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ShareCreateRequest {
    device_id: String,
    session_id: Option<String>,
    session_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ShareListItem {
    share_id: String,
    session_scope: String,
    browser_url: String,
    read_only: bool,
    created_at_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
struct SharePublicItem {
    share_id: String,
    read_only: bool,
    created_at_secs: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ShareOutputQuery {
    lines: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
struct BridgeListItem {
    bridge_id: String,
    browser_count: usize,
    connected: bool,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceCodeCreateRequest {
    suggested_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceClaimCreateRequest {
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
    suggested_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceClaimCreateResponse {
    claim_token: String,
    poll_token: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceCodeCreateResponse {
    code: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceClaimCompleteRequest {
    claim_token: String,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceClaimCompleteResponse {
    paired: bool,
    already_paired: bool,
    device_id: String,
    device_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceClaimPollResponse {
    status: String,
    expires_in: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DevicePairRequest {
    code: String,
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
}

#[derive(Debug, Clone, Serialize)]
struct DevicePairResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    device_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceListItem {
    device_id: String,
    device_name: String,
    hostname: String,
    os: String,
    arch: String,
    connected: bool,
    last_status: Option<BridgeStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceAuthResolveResponse {
    device_id: String,
    device_name: String,
    hostname: String,
    os: String,
    arch: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceProxyRequest {
    method: String,
    path: String,
    body: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct DevicePreviewRequest {
    session_id: String,
    method: String,
    url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DevicePreviewResponse {
    status: u16,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceTerminalCreateRequest {
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct DeviceTerminalCreateResponse {
    terminal_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct RelayHealth {
    ok: bool,
    bridge_channels: usize,
    browser_connections: usize,
    share_links: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerKind {
    Bridge,
    Browser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalPeerKind {
    Browser,
    Bridge,
}

const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
const DEFAULT_JWT_SECRET_ENV: &str = "RELAY_JWT_SECRET";
const RELAY_JWT_ISSUER: &str = "conductor-dashboard";
const RELAY_JWT_AUDIENCE: &str = "conductor-relay";
const RELAY_JWT_SCOPE_DASHBOARD_API: &str = "dashboard-api";
const RELAY_JWT_SCOPE_TERMINAL_BROWSER: &str = "terminal-browser";
const SHARE_PREFIX: &str = "share-";
const PAIRING_CODE_TTL: Duration = Duration::from_secs(10 * 60);
const DEVICE_ACCESS_TOKEN_TTL_SECS: u64 = 3600;
const DEVICE_PROXY_TIMEOUT: Duration = Duration::from_secs(30);
const BRIDGE_PROXY_META_KEY: &str = "$bridgeProxy";

pub async fn serve() -> Result<()> {
    let bind_addr = env::var("RELAY_BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_string());
    let state = RelayState::default();
    let app = build_router(state);
    let listener = TcpListener::bind(&bind_addr).await?;
    info!(%bind_addr, "relay listening");
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_router(state: RelayState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/bridges", get(list_bridges))
        .route("/api/bridges/{bridge_id}", delete(delete_bridge))
        .route("/api/devices/claims", post(create_device_claim))
        .route("/api/devices/claims/complete", post(complete_device_claim))
        .route(
            "/api/devices/claims/poll/{poll_token}",
            get(poll_device_claim),
        )
        .route("/api/devices/code", post(create_pairing_code))
        .route("/api/devices/pair", post(pair_device))
        .route("/api/devices/list", get(list_devices))
        .route("/api/devices/auth", get(resolve_device_from_token))
        .route("/api/devices/{device_id}/proxy", post(proxy_device_api))
        .route(
            "/api/devices/{device_id}/preview",
            post(proxy_device_preview),
        )
        .route(
            "/api/devices/{device_id}/terminals",
            post(create_terminal_session),
        )
        .route("/api/devices/{device_id}", delete(delete_device))
        .route("/api/shares", get(list_shares).post(create_share))
        .route(
            "/api/shares/{share_id}",
            get(get_share).delete(delete_share),
        )
        .route("/api/shares/{share_id}/output", get(get_share_output))
        .route("/bridge/{scope}", get(bridge_ws))
        .route("/browser/{scope}", get(browser_ws))
        .route("/terminal/{terminal_id}/browser", get(browser_terminal_ws))
        .route("/terminal/{terminal_id}/bridge", get(bridge_terminal_ws))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
                .allow_headers([
                    AUTHORIZATION,
                    axum::http::header::ACCEPT,
                    axum::http::header::CONTENT_TYPE,
                ]),
        )
        .with_state(state)
}

async fn health(State(state): State<RelayState>) -> Json<RelayHealth> {
    let inner = state.inner.lock().await;
    let bridge_channels = inner
        .channels
        .values()
        .filter(|channel| channel.bridge.is_some())
        .count();
    let browser_connections = inner
        .channels
        .values()
        .map(|channel| channel.browsers.len())
        .sum();
    Json(RelayHealth {
        ok: true,
        bridge_channels,
        browser_connections,
        share_links: inner.shares.len(),
    })
}

async fn list_bridges(State(state): State<RelayState>, headers: HeaderMap) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let inner = state.inner.lock().await;
    let mut bridges: HashMap<String, BridgeListItem> = HashMap::new();

    for (bridge_key, channel) in &inner.channels {
        let Some(bridge) = channel.bridge.as_ref() else {
            continue;
        };
        if bridge.user_id != user_id {
            continue;
        }

        let entry = bridges
            .entry(bridge_key.clone())
            .or_insert_with(|| BridgeListItem {
                bridge_id: bridge_key.clone(),
                browser_count: 0,
                connected: true,
                last_status: channel.last_status.clone(),
            });
        entry.browser_count += channel.browsers.len();
        entry.connected = true;
        if channel.last_status.is_some() {
            entry.last_status = channel.last_status.clone();
        }
    }

    (
        StatusCode::OK,
        Json(json!({ "bridges": bridges.into_values().collect::<Vec<_>>() })),
    )
        .into_response()
}

async fn create_pairing_code(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<DeviceCodeCreateRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let code = state
        .create_pairing_code(user_id, body.suggested_name.unwrap_or_default())
        .await;

    (
        StatusCode::CREATED,
        Json(DeviceCodeCreateResponse {
            code,
            expires_in: PAIRING_CODE_TTL.as_secs(),
        }),
    )
        .into_response()
}

async fn create_device_claim(
    State(state): State<RelayState>,
    Json(body): Json<DeviceClaimCreateRequest>,
) -> Response {
    match state.create_device_claim(body).await {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn complete_device_claim(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<DeviceClaimCompleteRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    match state.complete_device_claim(&user_id, body).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn poll_device_claim(
    State(state): State<RelayState>,
    Path(poll_token): Path<String>,
) -> Response {
    match state.poll_device_claim(&poll_token).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn pair_device(
    State(state): State<RelayState>,
    Json(body): Json<DevicePairRequest>,
) -> Response {
    match state.pair_device(body).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn list_devices(State(state): State<RelayState>, headers: HeaderMap) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let devices = state.list_devices_for_user(&user_id).await;
    (StatusCode::OK, Json(json!({ "devices": devices }))).into_response()
}

async fn resolve_device_from_token(
    State(state): State<RelayState>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = resolve_token(&headers, None) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing device refresh token." })),
        )
            .into_response();
    };

    let Some(device) = state.resolve_device_auth(&token).await else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid device refresh token." })),
        )
            .into_response();
    };

    (
        StatusCode::OK,
        Json(DeviceAuthResolveResponse {
            device_id: device.device_id,
            device_name: device.name,
            hostname: device.hostname,
            os: device.os,
            arch: device.arch,
        }),
    )
        .into_response()
}

async fn proxy_device_api(
    State(state): State<RelayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DeviceProxyRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    match state
        .forward_device_api_request(&user_id, &device_id, &body.method, &body.path, body.body)
        .await
    {
        Ok(response) => response_from_proxied_api(response.status, response.body),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn proxy_device_preview(
    State(state): State<RelayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DevicePreviewRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    match state
        .forward_device_preview_request(&user_id, &device_id, body)
        .await
    {
        Ok(response) => (
            StatusCode::OK,
            Json(DevicePreviewResponse {
                status: response.status,
                headers: response.headers,
                body_base64: response.body_base64,
            }),
        )
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn create_terminal_session(
    State(state): State<RelayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DeviceTerminalCreateRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    match state
        .create_terminal_session(&user_id, &device_id, body.session_id.trim())
        .await
    {
        Ok(terminal_id) => (
            StatusCode::CREATED,
            Json(DeviceTerminalCreateResponse { terminal_id }),
        )
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn delete_device(
    State(state): State<RelayState>,
    Path(device_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    match state.delete_device(&user_id, &device_id).await {
        Ok(removed) => {
            if removed {
                (
                    StatusCode::OK,
                    Json(json!({ "device_id": device_id, "deleted": true })),
                )
                    .into_response()
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "Device not found." })),
                )
                    .into_response()
            }
        }
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn browser_terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(terminal_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> Response {
    let Some(jwt) = query.jwt.as_deref() else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing browser relay token." })),
        )
            .into_response();
    };

    let Some(user_id) = resolve_browser_ws_user_id(jwt) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid browser relay token." })),
        )
            .into_response();
    };

    match state
        .authorize_terminal_session_browser(&terminal_id, &user_id)
        .await
    {
        Ok(()) => ws
            .on_upgrade(move |socket| async move {
                if let Err(err) = handle_terminal_connection(
                    state,
                    terminal_id,
                    TerminalPeerKind::Browser,
                    socket,
                )
                .await
                {
                    warn!(error = %err, "browser terminal websocket closed");
                }
            })
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn bridge_terminal_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(terminal_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = resolve_token(&headers, query.token.as_deref()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge token." })),
        )
            .into_response();
    };

    let Some(device) = state.resolve_device_auth(&token).await else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid device token." })),
        )
            .into_response();
    };

    match state
        .authorize_terminal_session_bridge(&terminal_id, &device.device_id)
        .await
    {
        Ok(()) => ws
            .on_upgrade(move |socket| async move {
                if let Err(err) =
                    handle_terminal_connection(state, terminal_id, TerminalPeerKind::Bridge, socket)
                        .await
                {
                    warn!(error = %err, "bridge terminal websocket closed");
                }
            })
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn delete_bridge(
    State(state): State<RelayState>,
    Path(bridge_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let (bridge_closes, browser_closes, pending_requests, removed) =
        state.disconnect_bridge_for_user(&user_id, &bridge_id).await;
    close_senders(bridge_closes).await;
    close_senders(browser_closes).await;
    fail_pending_api_requests(
        pending_requests,
        StatusCode::SERVICE_UNAVAILABLE,
        "Device disconnected.",
    );

    if removed {
        (
            StatusCode::OK,
            Json(json!({ "bridgeId": bridge_id, "deleted": true })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Bridge not found." })),
        )
            .into_response()
    }
}

async fn list_shares(State(state): State<RelayState>, headers: HeaderMap) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let inner = state.inner.lock().await;
    let shares: Vec<ShareListItem> = inner
        .shares
        .iter()
        .filter(|(_, share)| share.owner_user_id == user_id)
        .map(|(share_id, share)| ShareListItem {
            share_id: share_id.clone(),
            session_scope: share.session_scope.clone(),
            browser_url: format!("/bridge/share/{share_id}"),
            read_only: share.read_only,
            created_at_secs: share.created_at.elapsed().as_secs(),
        })
        .collect();
    (StatusCode::OK, Json(json!({ "shares": shares }))).into_response()
}

async fn create_share(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<ShareCreateRequest>,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let session_scope = match body
        .session_scope
        .or(body.session_id)
        .map(|value| value.trim().to_string())
    {
        Some(scope) if !scope.is_empty() => scope,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Missing session id." })),
            )
                .into_response();
        }
    };

    let device_id = body.device_id.trim();
    if device_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing device id." })),
        )
            .into_response();
    }

    let mut inner = state.inner.lock().await;
    match inner.devices.get(device_id) {
        Some(device) if device.owner_user_id == user_id => {}
        Some(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "Device access denied." })),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Device not found." })),
            )
                .into_response();
        }
    }

    let share_id = Uuid::new_v4().to_string();
    let browser_url = format!("/bridge/share/{share_id}");
    inner.shares.insert(
        share_id.clone(),
        ShareRecord {
            owner_user_id: user_id,
            device_id: device_id.to_string(),
            session_scope: session_scope.clone(),
            read_only: true,
            created_at: Instant::now(),
        },
    );

    (
        StatusCode::CREATED,
        Json(json!({
            "shareId": share_id,
            "sessionScope": session_scope,
            "browserUrl": browser_url,
            "readOnly": true,
        })),
    )
        .into_response()
}

async fn get_share(State(state): State<RelayState>, Path(share_id): Path<String>) -> Response {
    let inner = state.inner.lock().await;
    let Some(share) = inner.shares.get(&share_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Share link not found." })),
        )
            .into_response();
    };

    (
        StatusCode::OK,
        Json(SharePublicItem {
            share_id,
            read_only: share.read_only,
            created_at_secs: share.created_at.elapsed().as_secs(),
        }),
    )
        .into_response()
}

async fn get_share_output(
    State(state): State<RelayState>,
    Path(share_id): Path<String>,
    Query(query): Query<ShareOutputQuery>,
) -> Response {
    let Some(share) = state.get_share_record(&share_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Share link not found." })),
        )
            .into_response();
    };

    let lines = query.lines.unwrap_or(500).clamp(1, 2000);
    let output_path = format!("/api/sessions/{}/output?lines={lines}", share.session_scope);

    match state
        .forward_device_api_request(
            &share.owner_user_id,
            &share.device_id,
            "GET",
            &output_path,
            None,
        )
        .await
    {
        Ok(response) => response_from_proxied_api(response.status, response.body),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn delete_share(
    State(state): State<RelayState>,
    Path(share_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(user_id) = resolve_dashboard_api_user_id(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing or invalid dashboard relay token." })),
        )
            .into_response();
    };

    let mut inner = state.inner.lock().await;
    match inner.shares.get(&share_id) {
        Some(share) if share.owner_user_id == user_id => {}
        Some(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "Share access denied." })),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Share link not found." })),
            )
                .into_response();
        }
    }

    if inner.shares.remove(&share_id).is_some() {
        (
            StatusCode::OK,
            Json(json!({ "shareId": share_id, "deleted": true })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Share link not found." })),
        )
            .into_response()
    }
}

async fn browser_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(scope): Path<String>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    let scope = scope.trim().to_string();
    if scope.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing scope." })),
        )
            .into_response();
    }

    let (bridge_key, read_only, user_id) =
        match resolve_browser_connection(&scope, &headers, query.token.as_deref()).await {
            Ok(value) => value,
            Err(response) => return response,
        };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_connection(
            state,
            bridge_key,
            PeerKind::Browser,
            read_only,
            user_id,
            socket,
            None,
        )
        .await
        {
            warn!(error = %err, "browser websocket closed");
        }
    })
    .into_response()
}

async fn bridge_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(scope): Path<String>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    let Some(token) = resolve_token(&headers, query.token.as_deref()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge token." })),
        )
            .into_response();
    };

    let (channel_key, user_id, initial_status) =
        if let Some(device) = state.resolve_device_auth(&token).await {
            (
                device.device_id.clone(),
                device.owner_user_id.clone(),
                Some(BridgeStatus {
                    hostname: device.name.clone(),
                    os: format_device_os(&device.os, &device.arch),
                    connected: true,
                }),
            )
        } else {
            (
                scope.trim().to_string(),
                resolve_user_id(query.jwt.as_deref(), Some(&token)),
                None,
            )
        };

    ws.on_upgrade(move |socket| async move {
        if let Err(err) = handle_connection(
            state,
            channel_key,
            PeerKind::Bridge,
            false,
            user_id,
            socket,
            initial_status,
        )
        .await
        {
            warn!(error = %err, "bridge websocket closed");
        }
    })
    .into_response()
}

async fn resolve_browser_connection(
    scope: &str,
    headers: &HeaderMap,
    token: Option<&str>,
) -> Result<(String, bool, String), Response> {
    if let Some(share_id) = scope.strip_prefix(SHARE_PREFIX) {
        let _ = share_id;
        return Err((
            StatusCode::GONE,
            Json(json!({ "error": "Shared terminal websocket access has been disabled." })),
        )
            .into_response());
    }

    let Some(bridge_token) = resolve_token(headers, token) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge token." })),
        )
            .into_response());
    };

    let user_id = resolve_user_id(None, Some(&bridge_token));
    Ok((bridge_token, false, user_id))
}

async fn handle_connection(
    state: RelayState,
    key: String,
    peer_kind: PeerKind,
    read_only: bool,
    user_id: String,
    socket: WebSocket,
    initial_status: Option<BridgeStatus>,
) -> Result<()> {
    let (mut outbound, mut inbound) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let connection_id = state
        .register_connection(&key, peer_kind, user_id.clone(), tx.clone(), initial_status)
        .await;

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if outbound.send(message).await.is_err() {
                break;
            }
        }
    });

    match peer_kind {
        PeerKind::Bridge => state.broadcast_bridge_status(&key, true).await,
        PeerKind::Browser => state.send_browser_status_snapshot(&key, &tx).await,
    }

    while let Some(message) = inbound.next().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                drop(tx);
                let _ = writer.await;
                state
                    .unregister_connection(&key, peer_kind, connection_id)
                    .await;
                return Err(err.into());
            }
        };

        match message {
            Message::Text(text) => {
                let raw_text = text.to_string();
                match peer_kind {
                    PeerKind::Bridge => {
                        match serde_json::from_str::<BridgeToBrowserMessage>(&raw_text) {
                            Ok(parsed) => state.route_bridge_message(&key, parsed, raw_text).await,
                            Err(err) => warn!(error = %err, "bridge message decode failed"),
                        }
                    }
                    PeerKind::Browser => {
                        match serde_json::from_str::<BrowserToBridgeMessage>(&raw_text) {
                            Ok(parsed) => {
                                if let Err(err) = state
                                    .route_browser_message(
                                        &key, &user_id, read_only, parsed, raw_text, &tx,
                                    )
                                    .await
                                {
                                    warn!(error = %err, "browser message routing failed");
                                }
                            }
                            Err(err) => warn!(error = %err, "browser message decode failed"),
                        }
                    }
                }
            }
            Message::Ping(data) => {
                let _ = tx.send(Message::Pong(data));
            }
            Message::Pong(_) => {}
            Message::Binary(_) => {}
            Message::Close(_) => {
                break;
            }
        }
    }

    drop(tx);
    state
        .unregister_connection(&key, peer_kind, connection_id)
        .await;
    let _ = writer.await;
    Ok(())
}

fn clone_websocket_message(message: &Message) -> Option<Message> {
    match message {
        Message::Text(text) => Some(Message::Text(text.clone())),
        Message::Binary(data) => Some(Message::Binary(data.clone())),
        Message::Ping(data) => Some(Message::Ping(data.clone())),
        Message::Pong(data) => Some(Message::Pong(data.clone())),
        Message::Close(frame) => Some(Message::Close(frame.clone())),
    }
}

async fn handle_terminal_connection(
    state: RelayState,
    terminal_id: String,
    peer_kind: TerminalPeerKind,
    socket: WebSocket,
) -> Result<()> {
    let (mut outbound, mut inbound) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    state
        .register_terminal_connection(&terminal_id, peer_kind, tx.clone())
        .await?;

    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if outbound.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(message) = inbound.next().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                drop(tx);
                let _ = writer.await;
                state
                    .unregister_terminal_connection(&terminal_id, peer_kind)
                    .await;
                return Err(err.into());
            }
        };

        state
            .forward_terminal_message(&terminal_id, peer_kind, &message)
            .await;

        if matches!(message, Message::Close(_)) {
            break;
        }
    }

    drop(tx);
    state
        .unregister_terminal_connection(&terminal_id, peer_kind)
        .await;
    let _ = writer.await;
    Ok(())
}

impl RelayState {
    async fn create_terminal_session(
        &self,
        user_id: &str,
        device_id: &str,
        session_id: &str,
    ) -> std::result::Result<String, (StatusCode, String)> {
        let terminal_id = Uuid::new_v4().to_string();
        let (bridge_ready_tx, bridge_ready_rx) = oneshot::channel();

        let start_message = {
            let mut inner = self.inner.lock().await;
            let Some(device) = inner.devices.get(device_id) else {
                return Err((StatusCode::NOT_FOUND, "Device not found.".to_string()));
            };
            if device.owner_user_id != user_id {
                return Err((StatusCode::FORBIDDEN, "Device access denied.".to_string()));
            }
            if session_id.trim().is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "Session id is required.".to_string(),
                ));
            }

            let bridge_tx = inner
                .channels
                .get(device_id)
                .and_then(|channel| channel.bridge.as_ref().map(|record| record.tx.clone()))
                .ok_or((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device is offline.".to_string(),
                ))?;

            inner.terminal_sessions.insert(
                terminal_id.clone(),
                TerminalSessionRecord {
                    device_id: device_id.to_string(),
                    owner_user_id: user_id.to_string(),
                    browser: None,
                    bridge: None,
                    bridge_ready_waiters: vec![bridge_ready_tx],
                },
            );

            let payload = serde_json::to_string(&BrowserToBridgeMessage::TerminalProxyStart {
                terminal_id: terminal_id.clone(),
                session_id: session_id.trim().to_string(),
            })
            .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;

            (bridge_tx, payload)
        };

        let (bridge_tx, payload) = start_message;
        if bridge_tx.send(Message::Text(payload.into())).is_err() {
            let mut inner = self.inner.lock().await;
            inner.terminal_sessions.remove(&terminal_id);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Device disconnected before terminal could start.".to_string(),
            ));
        }

        match tokio::time::timeout(TERMINAL_SESSION_READY_TIMEOUT, bridge_ready_rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                let mut inner = self.inner.lock().await;
                inner.terminal_sessions.remove(&terminal_id);
                return Err((
                    StatusCode::BAD_GATEWAY,
                    "Device stopped attaching the relay terminal before it became ready."
                        .to_string(),
                ));
            }
            Err(_) => {
                let mut inner = self.inner.lock().await;
                inner.terminal_sessions.remove(&terminal_id);
                return Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Timed out waiting for the paired device relay terminal to become ready."
                        .to_string(),
                ));
            }
        }

        Ok(terminal_id)
    }

    async fn authorize_terminal_session_browser(
        &self,
        terminal_id: &str,
        user_id: &str,
    ) -> std::result::Result<(), (StatusCode, String)> {
        let inner = self.inner.lock().await;
        let Some(session) = inner.terminal_sessions.get(terminal_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                "Terminal session not found.".to_string(),
            ));
        };
        if session.owner_user_id != user_id {
            return Err((StatusCode::FORBIDDEN, "Terminal access denied.".to_string()));
        }
        Ok(())
    }

    async fn authorize_terminal_session_bridge(
        &self,
        terminal_id: &str,
        device_id: &str,
    ) -> std::result::Result<(), (StatusCode, String)> {
        let inner = self.inner.lock().await;
        let Some(session) = inner.terminal_sessions.get(terminal_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                "Terminal session not found.".to_string(),
            ));
        };
        if session.device_id != device_id {
            return Err((StatusCode::FORBIDDEN, "Terminal access denied.".to_string()));
        }
        Ok(())
    }

    async fn register_terminal_connection(
        &self,
        terminal_id: &str,
        peer_kind: TerminalPeerKind,
        tx: mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .terminal_sessions
            .get_mut(terminal_id)
            .ok_or_else(|| anyhow::anyhow!("terminal session not found"))?;
        let record = TerminalConnectionRecord { tx };
        match peer_kind {
            TerminalPeerKind::Browser => session.browser = Some(record),
            TerminalPeerKind::Bridge => {
                session.bridge = Some(record);
                for waiter in session.bridge_ready_waiters.drain(..) {
                    let _ = waiter.send(());
                }
            }
        }
        Ok(())
    }

    async fn unregister_terminal_connection(&self, terminal_id: &str, peer_kind: TerminalPeerKind) {
        let counterpart = {
            let mut inner = self.inner.lock().await;
            let Some(session) = inner.terminal_sessions.remove(terminal_id) else {
                return;
            };

            match peer_kind {
                TerminalPeerKind::Browser => session.bridge.map(|record| record.tx),
                TerminalPeerKind::Bridge => session.browser.map(|record| record.tx),
            }
        };

        if let Some(counterpart) = counterpart {
            let _ = counterpart.send(Message::Close(None));
        }
    }

    async fn forward_terminal_message(
        &self,
        terminal_id: &str,
        peer_kind: TerminalPeerKind,
        message: &Message,
    ) {
        let counterpart = {
            let inner = self.inner.lock().await;
            inner
                .terminal_sessions
                .get(terminal_id)
                .and_then(|session| match peer_kind {
                    TerminalPeerKind::Browser => session.bridge.as_ref(),
                    TerminalPeerKind::Bridge => session.browser.as_ref(),
                })
                .map(|record| record.tx.clone())
        };

        if let (Some(counterpart), Some(cloned)) = (counterpart, clone_websocket_message(message)) {
            let _ = counterpart.send(cloned);
        }
    }

    async fn register_connection(
        &self,
        key: &str,
        peer_kind: PeerKind,
        user_id: String,
        tx: mpsc::UnboundedSender<Message>,
        initial_status: Option<BridgeStatus>,
    ) -> u64 {
        let mut inner = self.inner.lock().await;
        let connection_id = inner.next_connection_id;
        inner.next_connection_id = inner.next_connection_id.saturating_add(1);
        let channel = inner.channels.entry(key.to_string()).or_default();
        let record = ConnectionRecord {
            id: connection_id,
            user_id,
            tx,
        };

        match peer_kind {
            PeerKind::Bridge => {
                channel.bridge = Some(record);
                channel.last_status = Some(initial_status.unwrap_or_else(|| BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected: true,
                }));
            }
            PeerKind::Browser => {
                channel.browsers.insert(connection_id, record);
            }
        }

        connection_id
    }

    async fn unregister_connection(&self, key: &str, peer_kind: PeerKind, connection_id: u64) {
        let mut browsers_to_notify = Vec::new();
        let mut failed_api_requests = Vec::new();
        let mut failed_preview_requests = Vec::new();
        let mut remove_pending_for_device = false;
        let mut remove_channel = false;
        let mut status_to_broadcast = None;

        {
            let mut inner = self.inner.lock().await;
            if let Some(channel) = inner.channels.get_mut(key) {
                match peer_kind {
                    PeerKind::Bridge => {
                        if channel
                            .bridge
                            .as_ref()
                            .is_some_and(|record| record.id == connection_id)
                        {
                            channel.bridge = None;
                            let status = channel
                                .last_status
                                .clone()
                                .map(|last| BridgeStatus {
                                    hostname: last.hostname,
                                    os: last.os,
                                    connected: false,
                                })
                                .unwrap_or(BridgeStatus {
                                    hostname: host_name(),
                                    os: env::consts::OS.to_string(),
                                    connected: false,
                                });
                            channel.last_status = Some(status.clone());
                            status_to_broadcast = Some(status);
                            browsers_to_notify = channel
                                .browsers
                                .values()
                                .map(|record| record.tx.clone())
                                .collect();
                            remove_pending_for_device = true;
                        }
                    }
                    PeerKind::Browser => {
                        channel.browsers.remove(&connection_id);
                    }
                }

                if channel.bridge.is_none() && channel.browsers.is_empty() {
                    remove_channel = true;
                }
            }

            if remove_channel {
                inner.channels.remove(key);
            }

            if remove_pending_for_device {
                let pending_ids = inner
                    .pending_api_requests
                    .iter()
                    .filter(|(_, pending)| pending.device_id == key)
                    .map(|(request_id, _)| request_id.clone())
                    .collect::<Vec<_>>();
                for request_id in pending_ids {
                    if let Some(pending) = inner.pending_api_requests.remove(&request_id) {
                        failed_api_requests.push(pending.tx);
                    }
                }

                let preview_ids = inner
                    .pending_preview_requests
                    .iter()
                    .filter(|(_, pending)| pending.device_id == key)
                    .map(|(request_id, _)| request_id.clone())
                    .collect::<Vec<_>>();
                for request_id in preview_ids {
                    if let Some(pending) = inner.pending_preview_requests.remove(&request_id) {
                        failed_preview_requests.push(pending.tx);
                    }
                }
            }
        }

        for pending in failed_api_requests {
            let _ = pending.send(ProxiedApiResponse {
                status: StatusCode::SERVICE_UNAVAILABLE.as_u16(),
                body: json!({ "error": "Device disconnected." }),
            });
        }

        for pending in failed_preview_requests {
            let _ = pending.send(ProxiedPreviewResponse {
                status: StatusCode::SERVICE_UNAVAILABLE.as_u16(),
                headers: BTreeMap::new(),
                body_base64: None,
            });
        }

        if let Some(status) = status_to_broadcast {
            if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
                hostname: status.hostname,
                os: status.os,
                connected: status.connected,
            }) {
                for browser in browsers_to_notify {
                    let _ = browser.send(Message::Text(text.clone().into()));
                }
            }
        }
    }

    async fn route_browser_message(
        &self,
        key: &str,
        user_id: &str,
        read_only: bool,
        message: BrowserToBridgeMessage,
        raw_text: String,
        browser_tx: &mpsc::UnboundedSender<Message>,
    ) -> Result<()> {
        if read_only {
            match &message {
                BrowserToBridgeMessage::Ping | BrowserToBridgeMessage::FileBrowse { .. } => {}
                BrowserToBridgeMessage::ApiRequest { id, method, .. } => {
                    if !is_safe_method(method) {
                        send_bridge_error(
                            browser_tx,
                            id,
                            StatusCode::FORBIDDEN,
                            "Read-only share links cannot send mutating requests.",
                        )
                        .await;
                        return Ok(());
                    }
                }
                BrowserToBridgeMessage::PreviewRequest { id, method, .. } => {
                    if !is_safe_method(method) {
                        send_bridge_preview_error(
                            browser_tx,
                            id,
                            StatusCode::FORBIDDEN,
                            "Read-only share links cannot send mutating preview requests.",
                        )
                        .await;
                        return Ok(());
                    }
                }
                BrowserToBridgeMessage::TerminalResize { .. }
                | BrowserToBridgeMessage::TerminalInput { .. }
                | BrowserToBridgeMessage::TerminalProxyStart { .. } => {
                    return Ok(());
                }
            }
        }

        let now = Instant::now();
        if !self.consume_rate_limit(user_id, now).await {
            match &message {
                BrowserToBridgeMessage::ApiRequest { id, .. } => {
                    send_bridge_error(
                        browser_tx,
                        id,
                        StatusCode::TOO_MANY_REQUESTS,
                        "Rate limit exceeded.",
                    )
                    .await;
                }
                BrowserToBridgeMessage::PreviewRequest { id, .. } => {
                    send_bridge_preview_error(
                        browser_tx,
                        id,
                        StatusCode::TOO_MANY_REQUESTS,
                        "Rate limit exceeded.",
                    )
                    .await;
                }
                _ => {}
            }
            return Err(anyhow::anyhow!("rate limit exceeded"));
        }

        let bridge_tx = {
            let inner = self.inner.lock().await;
            inner
                .channels
                .get(key)
                .and_then(|channel| channel.bridge.as_ref().map(|record| record.tx.clone()))
        };

        let Some(bridge_tx) = bridge_tx else {
            match &message {
                BrowserToBridgeMessage::ApiRequest { id, .. } => {
                    send_bridge_error(
                        browser_tx,
                        id,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Bridge is offline.",
                    )
                    .await;
                }
                BrowserToBridgeMessage::PreviewRequest { id, .. } => {
                    send_bridge_preview_error(
                        browser_tx,
                        id,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Bridge is offline.",
                    )
                    .await;
                }
                _ => {}
            }
            return Ok(());
        };

        let _ = bridge_tx.send(Message::Text(raw_text.into()));
        Ok(())
    }

    async fn route_bridge_message(
        &self,
        key: &str,
        message: BridgeToBrowserMessage,
        raw_text: String,
    ) {
        if let BridgeToBrowserMessage::ApiResponse { id, status, body } = &message {
            let pending = {
                let mut inner = self.inner.lock().await;
                inner.pending_api_requests.remove(id)
            };

            if let Some(pending) = pending {
                let _ = pending.tx.send(ProxiedApiResponse {
                    status: *status,
                    body: body.clone(),
                });
                return;
            }
        }

        if let BridgeToBrowserMessage::PreviewResponse {
            id,
            status,
            headers,
            body_base64,
        } = &message
        {
            let pending = {
                let mut inner = self.inner.lock().await;
                inner.pending_preview_requests.remove(id)
            };

            if let Some(pending) = pending {
                let _ = pending.tx.send(ProxiedPreviewResponse {
                    status: *status,
                    headers: headers.clone(),
                    body_base64: body_base64.clone(),
                });
                return;
            }
        }

        let browsers = {
            let mut inner = self.inner.lock().await;
            let Some(channel) = inner.channels.get_mut(key) else {
                return;
            };

            if let BridgeToBrowserMessage::BridgeStatus {
                hostname,
                os,
                connected,
            } = &message
            {
                channel.last_status = Some(BridgeStatus {
                    hostname: hostname.clone(),
                    os: os.clone(),
                    connected: *connected,
                });
            }

            channel
                .browsers
                .values()
                .map(|record| record.tx.clone())
                .collect::<Vec<_>>()
        };

        for browser in browsers {
            let _ = browser.send(Message::Text(raw_text.clone().into()));
        }
    }

    async fn broadcast_bridge_status(&self, key: &str, connected: bool) {
        let (status, browsers) = {
            let mut inner = self.inner.lock().await;
            let Some(channel) = inner.channels.get_mut(key) else {
                return;
            };

            let status = channel
                .last_status
                .clone()
                .map(|last| BridgeStatus {
                    hostname: last.hostname,
                    os: last.os,
                    connected,
                })
                .unwrap_or(BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected,
                });

            channel.last_status = Some(status.clone());
            let browsers = channel
                .browsers
                .values()
                .map(|record| record.tx.clone())
                .collect::<Vec<_>>();
            (status, browsers)
        };

        if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
            hostname: status.hostname,
            os: status.os,
            connected: status.connected,
        }) {
            for browser in browsers {
                let _ = browser.send(Message::Text(text.clone().into()));
            }
        }
    }

    async fn send_browser_status_snapshot(&self, key: &str, tx: &mpsc::UnboundedSender<Message>) {
        let status = {
            let inner = self.inner.lock().await;
            inner
                .channels
                .get(key)
                .and_then(|channel| channel.last_status.clone())
                .unwrap_or_else(|| BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected: false,
                })
        };

        if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
            hostname: status.hostname,
            os: status.os,
            connected: status.connected,
        }) {
            let _ = tx.send(Message::Text(text.into()));
        }
    }

    async fn consume_rate_limit(&self, user_id: &str, now: Instant) -> bool {
        let mut inner = self.inner.lock().await;
        let bucket = inner
            .rate_limits
            .entry(user_id.to_string())
            .or_insert_with(|| RateBucket::new(now));
        bucket.allow(now)
    }

    async fn disconnect_bridge_for_user(
        &self,
        user_id: &str,
        bridge_id: &str,
    ) -> (
        Vec<mpsc::UnboundedSender<Message>>,
        Vec<mpsc::UnboundedSender<Message>>,
        Vec<oneshot::Sender<ProxiedApiResponse>>,
        bool,
    ) {
        let mut bridge_txs = Vec::new();
        let mut browser_txs = Vec::new();
        let mut pending_api_requests = Vec::new();
        let mut removed = false;

        let mut inner = self.inner.lock().await;
        let keys: Vec<String> = inner
            .channels
            .iter()
            .filter(|(key, channel)| {
                channel.bridge.as_ref().is_some_and(|record| {
                    record.user_id == user_id
                        && (record.user_id == bridge_id || key.as_str() == bridge_id)
                })
            })
            .map(|(key, _)| key.clone())
            .collect();

        let pending_ids = inner
            .pending_api_requests
            .iter()
            .filter(|(_, pending)| keys.iter().any(|key| key == &pending.device_id))
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();

        for key in keys {
            if let Some(channel) = inner.channels.remove(&key) {
                removed = true;
                if let Some(bridge) = channel.bridge {
                    bridge_txs.push(bridge.tx);
                }
                browser_txs.extend(channel.browsers.into_values().map(|record| record.tx));
            }
        }

        for request_id in pending_ids {
            if let Some(pending) = inner.pending_api_requests.remove(&request_id) {
                pending_api_requests.push(pending.tx);
            }
        }

        (bridge_txs, browser_txs, pending_api_requests, removed)
    }

    async fn get_share_record(&self, share_id: &str) -> Option<ShareRecord> {
        let inner = self.inner.lock().await;
        inner.shares.get(share_id).cloned()
    }

    async fn create_pairing_code(&self, user_id: String, _suggested_name: String) -> String {
        let mut inner = self.inner.lock().await;
        inner.prune_pairing_codes();
        inner.prune_device_claims();

        let code = generate_pairing_code();
        let now = Instant::now();
        inner.pairing_codes.insert(
            code.clone(),
            PendingPairing {
                owner_user_id: user_id,
                expires_at: now + PAIRING_CODE_TTL,
            },
        );
        code
    }

    async fn create_device_claim(
        &self,
        request: DeviceClaimCreateRequest,
    ) -> std::result::Result<DeviceClaimCreateResponse, (StatusCode, &'static str)> {
        if request.device_id.trim().is_empty()
            || request.hostname.trim().is_empty()
            || request.os.trim().is_empty()
            || request.arch.trim().is_empty()
        {
            return Err((StatusCode::BAD_REQUEST, "Missing required claim fields."));
        }

        let claim_token = generate_claim_token();
        let poll_token = generate_claim_token();
        let expires_at = Instant::now() + PAIRING_CODE_TTL;

        let mut inner = self.inner.lock().await;
        inner.prune_device_claims();
        inner.device_claims.insert(
            claim_token.clone(),
            PendingDeviceClaim {
                poll_token: poll_token.clone(),
                device_id: request.device_id.trim().to_string(),
                hostname: request.hostname.trim().to_string(),
                os: request.os.trim().to_string(),
                arch: request.arch.trim().to_string(),
                suggested_name: request
                    .suggested_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                expires_at,
                paired_response: None,
            },
        );

        Ok(DeviceClaimCreateResponse {
            claim_token,
            poll_token,
            expires_in: PAIRING_CODE_TTL.as_secs(),
        })
    }

    async fn complete_device_claim(
        &self,
        user_id: &str,
        request: DeviceClaimCompleteRequest,
    ) -> std::result::Result<DeviceClaimCompleteResponse, (StatusCode, &'static str)> {
        let claim_token = request.claim_token.trim();
        if claim_token.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "Claim token is required."));
        }

        let mut inner = self.inner.lock().await;
        inner.prune_device_claims();

        let Some(claim) = inner.device_claims.get(claim_token).cloned() else {
            return Err((StatusCode::NOT_FOUND, "Claim token is invalid or expired."));
        };

        if let Some(response) = claim.paired_response.clone() {
            return Ok(DeviceClaimCompleteResponse {
                paired: true,
                already_paired: true,
                device_id: claim.device_id.clone(),
                device_name: response.device_name,
            });
        }

        let response = issue_device_pairing(
            &mut inner,
            user_id.to_string(),
            claim.device_id.clone(),
            claim.hostname.clone(),
            claim.os.clone(),
            claim.arch.clone(),
            claim.suggested_name.clone(),
        );
        let device_name = response.device_name.clone();
        let device_id = claim.device_id.clone();
        if let Some(stored_claim) = inner.device_claims.get_mut(claim_token) {
            stored_claim.paired_response = Some(response);
        }

        Ok(DeviceClaimCompleteResponse {
            paired: true,
            already_paired: false,
            device_id,
            device_name,
        })
    }

    async fn pair_device(
        &self,
        request: DevicePairRequest,
    ) -> std::result::Result<DevicePairResponse, (StatusCode, &'static str)> {
        let code = request.code.trim().to_uppercase();
        if code.is_empty()
            || request.device_id.trim().is_empty()
            || request.hostname.trim().is_empty()
            || request.os.trim().is_empty()
            || request.arch.trim().is_empty()
        {
            return Err((StatusCode::BAD_REQUEST, "Missing required pairing fields."));
        }

        let mut inner = self.inner.lock().await;
        inner.prune_pairing_codes();
        inner.prune_device_claims();

        let pairing = inner
            .pairing_codes
            .remove(&code)
            .ok_or((StatusCode::NOT_FOUND, "Pairing code is invalid or expired."))?;

        Ok(issue_device_pairing(
            &mut inner,
            pairing.owner_user_id,
            request.device_id.trim().to_string(),
            request.hostname.trim().to_string(),
            request.os.trim().to_string(),
            request.arch.trim().to_string(),
            None,
        ))
    }

    async fn poll_device_claim(
        &self,
        poll_token: &str,
    ) -> std::result::Result<DeviceClaimPollResponse, (StatusCode, &'static str)> {
        let normalized_poll_token = poll_token.trim();
        if normalized_poll_token.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "Poll token is required."));
        }

        let mut inner = self.inner.lock().await;
        inner.prune_device_claims();

        let now = Instant::now();
        let Some((claim_key, claim)) = inner
            .device_claims
            .iter()
            .find(|(_, claim)| claim.poll_token == normalized_poll_token)
            .map(|(key, claim)| (key.clone(), claim.clone()))
        else {
            return Err((StatusCode::NOT_FOUND, "Claim token is invalid or expired."));
        };

        if let Some(response) = claim.paired_response.clone() {
            inner.device_claims.remove(&claim_key);
            return Ok(DeviceClaimPollResponse {
                status: "paired".to_string(),
                expires_in: response.expires_in,
                access_token: Some(response.access_token),
                refresh_token: Some(response.refresh_token),
                device_id: Some(claim.device_id),
                device_name: Some(response.device_name),
            });
        }

        Ok(DeviceClaimPollResponse {
            status: "pending".to_string(),
            expires_in: claim.expires_at.saturating_duration_since(now).as_secs(),
            access_token: None,
            refresh_token: None,
            device_id: None,
            device_name: None,
        })
    }

    async fn list_devices_for_user(&self, user_id: &str) -> Vec<DeviceListItem> {
        let inner = self.inner.lock().await;
        let mut devices = inner
            .devices
            .values()
            .filter(|device| device.owner_user_id == user_id)
            .map(|device| {
                let channel = inner.channels.get(&device.device_id);
                let connected = channel.and_then(|entry| entry.bridge.as_ref()).is_some()
                    && channel
                        .and_then(|entry| entry.last_status.as_ref())
                        .map(|status| status.connected)
                        .unwrap_or(true);
                let last_status =
                    channel
                        .and_then(|entry| entry.last_status.clone())
                        .or_else(|| {
                            Some(BridgeStatus {
                                hostname: device.name.clone(),
                                os: format_device_os(&device.os, &device.arch),
                                connected: false,
                            })
                        });

                DeviceListItem {
                    device_id: device.device_id.clone(),
                    device_name: device.name.clone(),
                    hostname: device.hostname.clone(),
                    os: device.os.clone(),
                    arch: device.arch.clone(),
                    connected,
                    last_status,
                }
            })
            .collect::<Vec<_>>();

        devices.sort_by(|left, right| left.device_name.cmp(&right.device_name));
        devices
    }

    async fn delete_device(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> std::result::Result<bool, (StatusCode, &'static str)> {
        let (refresh_token, removed) = {
            let mut inner = self.inner.lock().await;
            match inner.devices.get(device_id) {
                Some(device) if device.owner_user_id == user_id => {}
                Some(_) => return Err((StatusCode::FORBIDDEN, "You do not own this device.")),
                None => return Ok(false),
            }

            let refresh_token = inner
                .devices
                .remove(device_id)
                .map(|device| device.refresh_token)
                .unwrap_or_default();
            inner.refresh_tokens.remove(&refresh_token);
            (refresh_token, true)
        };

        let (bridge_closes, browser_closes, pending_requests, _) =
            self.disconnect_bridge_for_user(user_id, device_id).await;
        close_senders(bridge_closes).await;
        close_senders(browser_closes).await;
        fail_pending_api_requests(
            pending_requests,
            StatusCode::SERVICE_UNAVAILABLE,
            "Device disconnected.",
        );
        let _ = refresh_token;

        Ok(removed)
    }

    async fn resolve_device_auth(&self, refresh_token: &str) -> Option<DeviceRecord> {
        let inner = self.inner.lock().await;
        let device_id = inner.refresh_tokens.get(refresh_token)?;
        inner.devices.get(device_id).cloned()
    }

    async fn forward_device_api_request(
        &self,
        user_id: &str,
        device_id: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> std::result::Result<ProxiedApiResponse, (StatusCode, String)> {
        let normalized_method = method.trim().to_ascii_uppercase();
        let normalized_path = path.trim();
        if normalized_method.is_empty() || normalized_path.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing proxy method or path.".to_string(),
            ));
        }

        let request_id = Uuid::new_v4().to_string();
        let message = serde_json::to_string(&BrowserToBridgeMessage::ApiRequest {
            id: request_id.clone(),
            method: normalized_method,
            path: normalized_path.to_string(),
            body,
        })
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

        let (bridge_tx, receiver) = {
            let mut inner = self.inner.lock().await;
            match inner.devices.get(device_id) {
                Some(device) if device.owner_user_id == user_id => {}
                Some(_) => {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "You do not own this device.".to_string(),
                    ))
                }
                None => return Err((StatusCode::NOT_FOUND, "Device not found.".to_string())),
            }

            let Some(bridge_tx) = inner
                .channels
                .get(device_id)
                .and_then(|channel| channel.bridge.as_ref().map(|record| record.tx.clone()))
            else {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device is offline.".to_string(),
                ));
            };

            let (tx, rx) = oneshot::channel();
            inner.pending_api_requests.insert(
                request_id.clone(),
                PendingApiRequest {
                    device_id: device_id.to_string(),
                    tx,
                },
            );

            (bridge_tx, rx)
        };

        if bridge_tx.send(Message::Text(message.into())).is_err() {
            let mut inner = self.inner.lock().await;
            inner.pending_api_requests.remove(&request_id);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Device connection is unavailable.".to_string(),
            ));
        }

        match tokio::time::timeout(DEVICE_PROXY_TIMEOUT, receiver).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Device connection closed.".to_string(),
            )),
            Err(_) => {
                let mut inner = self.inner.lock().await;
                inner.pending_api_requests.remove(&request_id);
                Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Device request timed out.".to_string(),
                ))
            }
        }
    }

    async fn forward_device_preview_request(
        &self,
        user_id: &str,
        device_id: &str,
        request: DevicePreviewRequest,
    ) -> std::result::Result<ProxiedPreviewResponse, (StatusCode, String)> {
        let DevicePreviewRequest {
            session_id,
            method,
            url,
            headers,
            body_base64,
        } = request;

        let normalized_method = method.trim().to_ascii_uppercase();
        let normalized_url = url.trim();
        let normalized_session_id = session_id.trim();
        if normalized_session_id.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing preview session id.".to_string(),
            ));
        }
        if normalized_method.is_empty() || normalized_url.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing preview method or url.".to_string(),
            ));
        }

        let request_id = Uuid::new_v4().to_string();
        let message = serde_json::to_string(&BrowserToBridgeMessage::PreviewRequest {
            id: request_id.clone(),
            session_id: normalized_session_id.to_string(),
            method: normalized_method,
            url: normalized_url.to_string(),
            headers,
            body_base64,
        })
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;

        let (bridge_tx, receiver) = {
            let mut inner = self.inner.lock().await;
            match inner.devices.get(device_id) {
                Some(device) if device.owner_user_id == user_id => {}
                Some(_) => {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "You do not own this device.".to_string(),
                    ))
                }
                None => return Err((StatusCode::NOT_FOUND, "Device not found.".to_string())),
            }

            let Some(bridge_tx) = inner
                .channels
                .get(device_id)
                .and_then(|channel| channel.bridge.as_ref().map(|record| record.tx.clone()))
            else {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device is offline.".to_string(),
                ));
            };

            let (tx, rx) = oneshot::channel();
            inner.pending_preview_requests.insert(
                request_id.clone(),
                PendingPreviewRequest {
                    device_id: device_id.to_string(),
                    tx,
                },
            );

            (bridge_tx, rx)
        };

        if bridge_tx.send(Message::Text(message.into())).is_err() {
            let mut inner = self.inner.lock().await;
            inner.pending_preview_requests.remove(&request_id);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Device connection is unavailable.".to_string(),
            ));
        }

        match tokio::time::timeout(DEVICE_PROXY_TIMEOUT, receiver).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Device connection closed.".to_string(),
            )),
            Err(_) => {
                let mut inner = self.inner.lock().await;
                inner.pending_preview_requests.remove(&request_id);
                Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Device preview request timed out.".to_string(),
                ))
            }
        }
    }
}

impl RelayInner {
    fn prune_pairing_codes(&mut self) {
        let now = Instant::now();
        self.pairing_codes
            .retain(|_, pairing| pairing.expires_at > now);
    }

    fn prune_device_claims(&mut self) {
        let now = Instant::now();
        self.device_claims.retain(|_, claim| claim.expires_at > now);
    }
}

async fn close_senders(senders: Vec<mpsc::UnboundedSender<Message>>) {
    for sender in senders {
        let _ = sender.send(Message::Close(None));
    }
}

fn fail_pending_api_requests(
    requests: Vec<oneshot::Sender<ProxiedApiResponse>>,
    status: StatusCode,
    message: &str,
) {
    for request in requests {
        let _ = request.send(ProxiedApiResponse {
            status: status.as_u16(),
            body: json!({ "error": message }),
        });
    }
}

fn response_from_proxied_api(status: u16, body: Value) -> Response {
    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);

    let Some(meta) = body
        .as_object()
        .and_then(|value| value.get(BRIDGE_PROXY_META_KEY))
        .and_then(Value::as_object)
    else {
        return (status_code, Json(body)).into_response();
    };

    let kind = meta
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let content_type = meta
        .get("contentType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");

    match kind.as_str() {
        "text" => {
            let text = meta
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            (
                status_code,
                [(axum::http::header::CONTENT_TYPE, content_type)],
                text,
            )
                .into_response()
        }
        "bytes" => {
            let Some(encoded) = meta.get("base64").and_then(Value::as_str) else {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "Missing proxied response payload." })),
                )
                    .into_response();
            };

            match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(bytes) => (
                    status_code,
                    [(axum::http::header::CONTENT_TYPE, content_type)],
                    bytes,
                )
                    .into_response(),
                Err(err) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": format!("Invalid proxied response payload: {err}") })),
                )
                    .into_response(),
            }
        }
        _ => (status_code, Json(body)).into_response(),
    }
}

fn is_safe_method(method: &str) -> bool {
    matches!(
        method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "OPTIONS"
    )
}

async fn send_bridge_error(
    tx: &mpsc::UnboundedSender<Message>,
    id: &str,
    status: StatusCode,
    message: &str,
) {
    let response = BridgeToBrowserMessage::ApiResponse {
        id: id.to_string(),
        status: status.as_u16(),
        body: json!({ "error": message }),
    };

    if let Ok(text) = serde_json::to_string(&response) {
        let _ = tx.send(Message::Text(text.into()));
    }
}

async fn send_bridge_preview_error(
    tx: &mpsc::UnboundedSender<Message>,
    id: &str,
    status: StatusCode,
    message: &str,
) {
    let response = BridgeToBrowserMessage::PreviewResponse {
        id: id.to_string(),
        status: status.as_u16(),
        headers: BTreeMap::from([(
            "content-type".to_string(),
            "text/plain; charset=utf-8".to_string(),
        )]),
        body_base64: Some(base64::engine::general_purpose::STANDARD.encode(message.as_bytes())),
    };

    if let Ok(text) = serde_json::to_string(&response) {
        let _ = tx.send(Message::Text(text.into()));
    }
}

fn resolve_token(headers: &HeaderMap, query_token: Option<&str>) -> Option<String> {
    if let Some(token) = query_token.and_then(|token| {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }) {
        return Some(token);
    }

    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_dashboard_api_user_id(headers: &HeaderMap) -> Option<String> {
    let jwt = resolve_token(headers, None)?;
    decode_relay_user_id(&jwt, RELAY_JWT_SCOPE_DASHBOARD_API).ok()
}

fn resolve_browser_ws_user_id(jwt: &str) -> Option<String> {
    decode_relay_user_id(jwt, RELAY_JWT_SCOPE_TERMINAL_BROWSER).ok()
}

fn resolve_user_id(jwt: Option<&str>, fallback: Option<&str>) -> String {
    if let Some(jwt) = jwt.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }) {
        if let Ok(user_id) = decode_relay_user_id(jwt, RELAY_JWT_SCOPE_DASHBOARD_API) {
            return user_id;
        }
    }

    fallback.unwrap_or("anonymous").to_string()
}

fn host_name() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn format_device_os(os: &str, arch: &str) -> String {
    format!("{}/{}", os.trim(), arch.trim())
}

fn preferred_device_name(suggested_name: Option<String>, hostname: String) -> String {
    suggested_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(hostname)
}

fn issue_device_pairing(
    inner: &mut RelayInner,
    owner_user_id: String,
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
    suggested_name: Option<String>,
) -> DevicePairResponse {
    let previous_refresh_token = inner
        .devices
        .get(device_id.as_str())
        .map(|device| device.refresh_token.clone());
    if let Some(previous_refresh_token) = previous_refresh_token {
        inner.refresh_tokens.remove(&previous_refresh_token);
    }

    let access_token = Uuid::new_v4().to_string();
    let refresh_token = Uuid::new_v4().to_string();
    let device_name = preferred_device_name(suggested_name, hostname.clone());
    let device = DeviceRecord {
        device_id: device_id.clone(),
        owner_user_id,
        name: device_name.clone(),
        hostname,
        os,
        arch,
        refresh_token: refresh_token.clone(),
    };

    inner
        .refresh_tokens
        .insert(refresh_token.clone(), device.device_id.clone());
    inner.devices.insert(device.device_id.clone(), device);

    DevicePairResponse {
        access_token,
        refresh_token,
        expires_in: DEVICE_ACCESS_TOKEN_TTL_SECS,
        device_name,
    }
}

fn generate_pairing_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = Uuid::new_v4().into_bytes();
    (0..6)
        .map(|index| {
            let position = bytes[index] as usize % ALPHABET.len();
            ALPHABET[position] as char
        })
        .collect()
}

fn generate_claim_token() -> String {
    let left = Uuid::new_v4().simple().to_string();
    let right = Uuid::new_v4().simple().to_string();
    format!("{left}{right}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::Message;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn device_claim_pairs_and_polls_once() {
        let state = RelayState::default();
        let created = state
            .create_device_claim(DeviceClaimCreateRequest {
                device_id: "device-123".to_string(),
                hostname: "macbook-pro".to_string(),
                os: "darwin".to_string(),
                arch: "arm64".to_string(),
                suggested_name: Some("My Laptop".to_string()),
            })
            .await
            .expect("claim should be created");

        let pending = state
            .poll_device_claim(&created.poll_token)
            .await
            .expect("pending poll should succeed");
        assert_eq!(pending.status, "pending");
        assert!(pending.refresh_token.is_none());

        let completed = state
            .complete_device_claim(
                "user@example.com",
                DeviceClaimCompleteRequest {
                    claim_token: created.claim_token.clone(),
                },
            )
            .await
            .expect("claim should complete");
        assert_eq!(completed.device_id, "device-123");
        assert_eq!(completed.device_name, "My Laptop");
        assert!(!completed.already_paired);

        let paired = state
            .poll_device_claim(&created.poll_token)
            .await
            .expect("paired poll should succeed");
        assert_eq!(paired.status, "paired");
        assert_eq!(paired.device_id.as_deref(), Some("device-123"));
        assert_eq!(paired.device_name.as_deref(), Some("My Laptop"));
        assert!(paired.refresh_token.is_some());

        let missing = state.poll_device_claim(&created.poll_token).await;
        assert!(matches!(missing, Err((StatusCode::NOT_FOUND, _))));
    }

    #[tokio::test]
    async fn create_terminal_session_waits_for_bridge_connection() {
        let state = RelayState::default();
        let (bridge_tx, mut bridge_rx) = mpsc::unbounded_channel::<Message>();

        {
            let mut inner = state.inner.lock().await;
            inner.devices.insert(
                "device-123".to_string(),
                DeviceRecord {
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    name: "Mac".to_string(),
                    hostname: "macbook-pro".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    refresh_token: "refresh-token".to_string(),
                },
            );
            inner.channels.insert(
                "device-123".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "user@example.com".to_string(),
                        tx: bridge_tx,
                    }),
                    browsers: HashMap::new(),
                    last_status: None,
                },
            );
        }

        let create_task = tokio::spawn({
            let state = state.clone();
            async move {
                state
                    .create_terminal_session("user@example.com", "device-123", "session-abc")
                    .await
            }
        });

        let start_message = bridge_rx.recv().await.expect("bridge start message");
        let Message::Text(payload) = start_message else {
            panic!("expected text start payload");
        };
        let envelope: BrowserToBridgeMessage =
            serde_json::from_str(payload.as_str()).expect("decode start payload");
        let terminal_id = match envelope {
            BrowserToBridgeMessage::TerminalProxyStart { terminal_id, .. } => terminal_id,
            other => panic!("unexpected bridge message: {other:?}"),
        };

        let (terminal_tx, _terminal_rx) = mpsc::unbounded_channel::<Message>();
        state
            .register_terminal_connection(&terminal_id, TerminalPeerKind::Bridge, terminal_tx)
            .await
            .expect("register bridge terminal connection");

        let created_terminal_id = create_task
            .await
            .expect("create task should finish")
            .expect("terminal should be created");
        assert_eq!(created_terminal_id, terminal_id);
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Claims {
    sub: Option<String>,
    user_id: Option<String>,
    scope: Option<String>,
    exp: Option<usize>,
}

fn decode_relay_user_id(jwt: &str, expected_scope: &str) -> Result<String> {
    let secret = env::var(DEFAULT_JWT_SECRET_ENV).context("relay jwt secret is not configured")?;
    let key = jsonwebtoken::DecodingKey::from_secret(secret.as_bytes());
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.set_issuer(&[RELAY_JWT_ISSUER]);
    validation.set_audience(&[RELAY_JWT_AUDIENCE]);
    let claims = jsonwebtoken::decode::<Claims>(jwt, &key, &validation)?;

    let scope = claims
        .claims
        .scope
        .as_deref()
        .context("missing relay jwt scope")?;
    if scope != expected_scope {
        anyhow::bail!("relay jwt scope mismatch");
    }

    claims
        .claims
        .user_id
        .or(claims.claims.sub)
        .context("missing user id in relay jwt")
}
