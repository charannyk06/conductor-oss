use crate::routes::config::{access_control_enabled, resolve_access_identity, AccessRole};
use crate::state::AppState;
use anyhow::{anyhow, Context, Result};
use axum::http::HeaderMap;
use hmac::{Hmac, Mac};
use serde::Serialize;
use std::sync::{Arc, LazyLock};

pub const DEFAULT_TERMINAL_COLS: u16 = 120;
pub const DEFAULT_TERMINAL_ROWS: u16 = 32;
pub const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 10_000;
pub const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12000;
pub const LIVE_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_REMOTE_SESSION_SECRET";
pub const TERMINAL_TOKEN_TTL_SECONDS: i64 = 60;
pub const TERMINAL_FRAME_PROTOCOL_VERSION: u8 = 2;
pub const TERMINAL_FRAME_MAGIC: [u8; 4] = *b"CTP2";
pub const TERMINAL_FRAME_KIND_RESTORE: u8 = 1;
pub const TERMINAL_FRAME_KIND_STREAM: u8 = 2;
pub const TERMINAL_RESTORE_FRAME_MODE_BYTES: usize = 4;
pub const SERVER_TIMING_HEADER: &str = "server-timing";
pub const TERMINAL_SNAPSHOT_SOURCE_HEADER: &str = "x-conductor-terminal-snapshot-source";
pub const TERMINAL_SNAPSHOT_LIVE_HEADER: &str = "x-conductor-terminal-snapshot-live";
pub const TERMINAL_SNAPSHOT_RESTORED_HEADER: &str = "x-conductor-terminal-snapshot-restored";
pub const TERMINAL_SNAPSHOT_FORMAT_HEADER: &str = "x-conductor-terminal-snapshot-format";
pub const TERMINAL_RESIZE_COLS_HEADER: &str = "x-conductor-terminal-resize-cols";
pub const TERMINAL_RESIZE_ROWS_HEADER: &str = "x-conductor-terminal-resize-rows";
pub const INTERNAL_BACKEND_ORIGIN_HEADER: &str = "x-conductor-backend-origin";

pub static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

type HmacSha256 = Hmac<sha2::Sha256>;

#[derive(Copy, Clone, PartialEq, Eq)]
pub enum TerminalTokenScope {
    Stream,
    Control,
}

impl TerminalTokenScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stream => "stream",
            Self::Control => "control",
        }
    }
}

#[derive(Copy, Clone)]
pub enum TerminalSnapshotReason {
    Attach,
    Lagged,
}

impl TerminalSnapshotReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Lagged => "lagged",
        }
    }

    pub fn as_code(self) -> u8 {
        match self {
            Self::Attach => 1,
            Self::Lagged => 2,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalConnectionTransport {
    Websocket,
    Eventstream,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalControlTransport {
    Websocket,
    Http,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalConnectionPath {
    Direct,
    ManagedRemote,
    DashboardProxy,
    AuthLimited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConnectionStreamPayload {
    pub transport: TerminalConnectionTransport,
    pub ws_url: Option<String>,
    pub poll_interval_ms: u64,
    pub fallback_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConnectionControlPayload {
    pub transport: TerminalControlTransport,
    pub ws_url: Option<String>,
    pub interactive: bool,
    pub requires_token: bool,
    pub token_expires_in_seconds: Option<i64>,
    pub fallback_reason: Option<String>,
    pub send_path: String,
    pub keys_path: String,
    pub resize_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalConnectionPayload {
    pub transport: TerminalConnectionTransport,
    pub ws_url: Option<String>,
    pub poll_interval_ms: u64,
    pub interactive: bool,
    pub requires_token: bool,
    pub token_expires_in_seconds: Option<i64>,
    pub fallback_reason: Option<String>,
    pub connection_path: TerminalConnectionPath,
    pub stream: TerminalConnectionStreamPayload,
    pub control: TerminalConnectionControlPayload,
}

pub struct TerminalSupervisor {
    pub state: Arc<AppState>,
}

#[derive(Debug, Clone, Copy)]
pub enum TerminalInputStatus {
    Accepted,
    QueueFull,
}

impl TerminalSupervisor {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    pub async fn prepare_terminal_runtime(
        &self,
        session_id: &str,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<bool> {
        let Some(session) = self.state.get_session(session_id).await else {
            return Ok(false);
        };
        if session.status.is_terminal() {
            return Ok(false);
        }

        let is_live = self.state.ensure_session_live(session_id).await?;
        if is_live {
            self.state
                .resize_live_terminal(
                    session_id,
                    cols.unwrap_or(DEFAULT_TERMINAL_COLS).clamp(1, 500),
                    rows.unwrap_or(DEFAULT_TERMINAL_ROWS).clamp(1, 200),
                )
                .await?;
        }
        Ok(is_live)
    }

    pub async fn resize_terminal(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let cols = cols.clamp(1, 500);
        let rows = rows.clamp(1, 200);
        let _ = self
            .prepare_terminal_runtime(session_id, Some(cols), Some(rows))
            .await?;
        self.state
            .resize_live_terminal(session_id, cols, rows)
            .await
    }

    pub async fn send_terminal_input(
        &self,
        session_id: &str,
        chunk: String,
    ) -> Result<TerminalInputStatus> {
        if !self
            .prepare_terminal_runtime(session_id, None, None)
            .await?
        {
            return Err(anyhow!("Terminal is not currently attached"));
        }

        match self
            .state
            .try_send_raw_to_session(session_id, chunk)
            .await?
        {
            true => Ok(TerminalInputStatus::Accepted),
            false => Ok(TerminalInputStatus::QueueFull),
        }
    }

    pub async fn should_issue_terminal_token(&self) -> bool {
        let access = self.state.config.read().await.access.clone();
        access_control_enabled(&access)
    }

    pub fn create_scoped_terminal_token(
        &self,
        session_id: &str,
        scope: TerminalTokenScope,
    ) -> Result<String> {
        let secret = self.terminal_token_secret();
        let expires_at = chrono::Utc::now().timestamp() + TERMINAL_TOKEN_TTL_SECONDS;
        let payload = format!("{session_id}:{}:{expires_at}", scope.as_str());
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
        mac.update(payload.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        Ok(format!("{}:{expires_at}.{signature}", scope.as_str()))
    }

    pub fn verify_terminal_token(&self, session_id: &str, token: &str) -> Result<bool> {
        self.verify_scoped_terminal_token(session_id, token, &[TerminalTokenScope::Control])
    }

    pub fn verify_terminal_stream_token(&self, session_id: &str, token: &str) -> Result<bool> {
        self.verify_scoped_terminal_token(
            session_id,
            token,
            &[TerminalTokenScope::Stream, TerminalTokenScope::Control],
        )
    }

    fn verify_scoped_terminal_token(
        &self,
        session_id: &str,
        token: &str,
        accepted_scopes: &[TerminalTokenScope],
    ) -> Result<bool> {
        let secret = self.terminal_token_secret();

        let (raw_payload, provided_signature) = token
            .split_once('.')
            .ok_or_else(|| anyhow!("Malformed terminal token"))?;
        let (scope, expires_at_raw, payload) =
            if let Some((scope_raw, expires_at_raw)) = raw_payload.split_once(':') {
                let scope = match scope_raw {
                    "stream" => TerminalTokenScope::Stream,
                    "control" => TerminalTokenScope::Control,
                    _ => return Ok(false),
                };
                (
                    scope,
                    expires_at_raw,
                    format!("{session_id}:{scope_raw}:{expires_at_raw}"),
                )
            } else {
                (
                    TerminalTokenScope::Control,
                    raw_payload,
                    format!("{session_id}:{raw_payload}"),
                )
            };
        if !accepted_scopes.contains(&scope) {
            return Ok(false);
        }

        let expires_at = expires_at_raw
            .parse::<i64>()
            .context("Invalid terminal token expiry")?;
        if chrono::Utc::now().timestamp() > expires_at {
            return Ok(false);
        }

        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
        mac.update(payload.as_bytes());
        let expected_signature = hex::encode(mac.finalize().into_bytes());
        Ok(self.constant_time_equal(expected_signature.as_bytes(), provided_signature.as_bytes()))
    }

    fn constant_time_equal(&self, left: &[u8], right: &[u8]) -> bool {
        if left.len() != right.len() {
            return false;
        }

        let mut mismatch = 0_u8;
        for (lhs, rhs) in left.iter().zip(right.iter()) {
            mismatch |= lhs ^ rhs;
        }
        mismatch == 0
    }

    pub fn terminal_token_secret(&self) -> String {
        std::env::var(TERMINAL_TOKEN_SECRET_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| PROCESS_TERMINAL_TOKEN_SECRET.clone())
    }

    pub async fn authorize_terminal_access(
        &self,
        session_id: &str,
        token: Option<&str>,
        headers: &HeaderMap,
    ) -> Result<()> {
        let access = self.state.config.read().await.access.clone();
        if !access_control_enabled(&access) {
            return Ok(());
        }

        // A valid token is sufficient proof of authentication — the token was
        // issued by the bootstrap endpoint which already verified the caller's
        // identity.  This allows direct browser WebSocket connections (which
        // bypass the Next.js proxy and therefore lack auth headers) to succeed
        // when they carry a valid token.
        if let Some(token) = token {
            if self.verify_terminal_token(session_id, token)? {
                return Ok(());
            }
        }

        let identity = resolve_access_identity(headers, &access).await;
        if identity.authenticated {
            return Ok(());
        }

        tracing::warn!(
            session_id,
            "Terminal access denied: No valid token and identity not authenticated via headers."
        );
        Err(anyhow!("Terminal access denied: Not authenticated"))
    }

    pub async fn authorize_terminal_stream_socket_access(
        &self,
        session_id: &str,
        token: Option<&str>,
    ) -> Result<()> {
        let access = self.state.config.read().await.access.clone();
        if !access_control_enabled(&access) {
            return Ok(());
        }

        let token = token.ok_or_else(|| anyhow!("Terminal token is required"))?;
        if self.verify_terminal_stream_token(session_id, token)? {
            return Ok(());
        }

        Err(anyhow!("Invalid terminal token"))
    }

    pub async fn authorize_terminal_stream_access(
        &self,
        session_id: &str,
        token: Option<&str>,
        headers: &HeaderMap,
    ) -> Result<()> {
        let access = self.state.config.read().await.access.clone();
        if !access_control_enabled(&access) {
            return Ok(());
        }

        let identity = resolve_access_identity(headers, &access).await;
        if crate::routes::config::proxy_request_authorized(headers) {
            if !identity.authenticated {
                return Err(anyhow!("Proxy access is not authenticated"));
            }

            if matches!(identity.role, Some(role) if role.allows(AccessRole::Viewer)) {
                return Ok(());
            }
        }

        self.authorize_terminal_stream_socket_access(session_id, token)
            .await
    }

    pub async fn build_terminal_connection_payload(
        &self,
        session_id: &str,
        headers: &HeaderMap,
    ) -> Result<TerminalConnectionPayload> {
        let access = self.state.config.read().await.access.clone();
        let backend_port = self.state.config.read().await.effective_port();
        let interactive = if access_control_enabled(&access) {
            let identity = resolve_access_identity(headers, &access).await;
            identity
                .role
                .map(|role| role.allows(AccessRole::Operator))
                .unwrap_or(false)
        } else {
            true
        };
        let poll_interval_ms = 700; // terminal_poll_interval_ms()
        let encoded = encode_path_component(session_id);
        let send_path = format!("/api/sessions/{encoded}/send");
        let keys_path = format!("/api/sessions/{encoded}/keys");
        let resize_path = format!("/api/sessions/{encoded}/terminal/resize");
        let fallback_url = format!("/api/sessions/{encoded}/terminal/stream");

        if !interactive {
            return Ok(TerminalConnectionPayload {
                transport: TerminalConnectionTransport::Eventstream,
                ws_url: Some(fallback_url.clone()),
                poll_interval_ms,
                interactive: false,
                requires_token: false,
                token_expires_in_seconds: None,
                fallback_reason: Some(
                    "Live terminal control requires operator access. The terminal stays live in read-only mode."
                        .to_string(),
                ),
                connection_path: TerminalConnectionPath::AuthLimited,
                stream: TerminalConnectionStreamPayload {
                    transport: TerminalConnectionTransport::Eventstream,
                    ws_url: Some(fallback_url.clone()),
                    poll_interval_ms,
                    fallback_url: Some(fallback_url.clone()),
                },
                control: TerminalConnectionControlPayload {
                    transport: TerminalControlTransport::Http,
                    ws_url: None,
                    interactive: false,
                    requires_token: false,
                    token_expires_in_seconds: None,
                    fallback_reason: Some(
                        "Live terminal control requires operator access. The terminal stays live in read-only mode."
                            .to_string(),
                    ),
                    send_path,
                    keys_path,
                    resize_path,
                },
            });
        }

        let request_host = resolve_forwarded_host(headers);
        let dashboard_is_loopback = request_host
            .as_deref()
            .map(is_loopback_hostname)
            .unwrap_or(false);
        let advertised_backend_origin = parse_backend_origin_header(headers);
        let direct_backend_origin = match advertised_backend_origin.as_deref() {
            Some(origin) => {
                let backend_url = reqwest::Url::parse(origin).ok();
                match backend_url {
                    Some(url) if !is_loopback_hostname(url.host_str().unwrap_or_default()) => {
                        Some(origin.to_string())
                    }
                    _ if dashboard_is_loopback => {
                        derive_backend_origin_from_request(headers, backend_port)
                    }
                    _ => None,
                }
            }
            None if dashboard_is_loopback => {
                derive_backend_origin_from_request(headers, backend_port)
            }
            None => None,
        };

        let Some(direct_backend_origin) = direct_backend_origin else {
            return Ok(TerminalConnectionPayload {
                transport: TerminalConnectionTransport::Eventstream,
                ws_url: Some(fallback_url.clone()),
                poll_interval_ms,
                interactive: true,
                requires_token: false,
                token_expires_in_seconds: None,
                fallback_reason: Some(
                    "A browser-connectable terminal websocket is not available for this dashboard URL. Live terminal output is being proxied through the dashboard."
                        .to_string(),
                ),
                connection_path: TerminalConnectionPath::DashboardProxy,
                stream: TerminalConnectionStreamPayload {
                    transport: TerminalConnectionTransport::Eventstream,
                    ws_url: Some(fallback_url.clone()),
                    poll_interval_ms,
                    fallback_url: Some(fallback_url.clone()),
                },
                control: TerminalConnectionControlPayload {
                    transport: TerminalControlTransport::Http,
                    ws_url: None,
                    interactive: true,
                    requires_token: false,
                    token_expires_in_seconds: None,
                    fallback_reason: Some(
                        "A browser-connectable terminal websocket is not available for this dashboard URL. Live terminal output is being proxied through the dashboard."
                            .to_string(),
                    ),
                    send_path,
                    keys_path,
                    resize_path,
                },
            });
        };

        let requires_token = self.should_issue_terminal_token().await;
        // Unified WS uses control-scope token (superset of stream scope)
        let control_token = if requires_token {
            Some(self.create_scoped_terminal_token(session_id, TerminalTokenScope::Control)?)
        } else {
            None
        };

        let ws_origin = websocket_origin_from_http(&direct_backend_origin)
            .ok_or_else(|| anyhow!("Failed to derive terminal websocket origin"))?;
        let encoded_session = encode_path_component(session_id);

        // Unified bidirectional WS URL — used for both stream and control.
        //
        // SECURITY: The token is passed as a URL query parameter because the
        // browser WebSocket API does not support custom headers during the
        // upgrade handshake. This means the token may appear in server access
        // logs and browser history. Mitigations:
        // 1. Token TTL is 60 seconds (TERMINAL_TOKEN_TTL_SECONDS)
        // 2. Token is scoped per-session and per-scope (stream vs control)
        // 3. Token is HMAC-SHA256 signed with constant-time verification
        // 4. Conductor is local-first — traffic stays on loopback by default
        let unified_ws_url = format!(
            "{}/api/sessions/{}/terminal/ws{}",
            ws_origin,
            encoded_session,
            control_token
                .as_deref()
                .map(|token| format!("?token={token}"))
                .unwrap_or_default()
        );
        // Keep the stream URL for SSE fallback reference
        let stream_ws_url = unified_ws_url.clone();
        // Control WS URL now points to the same unified endpoint
        let control_ws_url = unified_ws_url;

        Ok(TerminalConnectionPayload {
            transport: TerminalConnectionTransport::Websocket,
            ws_url: Some(stream_ws_url.clone()),
            poll_interval_ms,
            interactive: true,
            requires_token,
            token_expires_in_seconds: requires_token.then_some(TERMINAL_TOKEN_TTL_SECONDS),
            fallback_reason: None,
            connection_path: if dashboard_is_loopback {
                TerminalConnectionPath::Direct
            } else {
                TerminalConnectionPath::ManagedRemote
            },
            stream: TerminalConnectionStreamPayload {
                transport: TerminalConnectionTransport::Websocket,
                ws_url: Some(stream_ws_url),
                poll_interval_ms,
                fallback_url: Some(fallback_url),
            },
            control: TerminalConnectionControlPayload {
                transport: TerminalControlTransport::Websocket,
                ws_url: Some(control_ws_url),
                interactive: true,
                requires_token,
                token_expires_in_seconds: requires_token.then_some(TERMINAL_TOKEN_TTL_SECONDS),
                fallback_reason: None,
                send_path,
                keys_path,
                resize_path,
            },
        })
    }
}

pub fn encode_path_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => {
                encoded.push('%');
                encoded.push_str(&format!("{byte:02X}"));
            }
        }
    }
    encoded
}

pub fn resolve_forwarded_host(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-host")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            headers
                .get("host")
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

pub fn resolve_forwarded_proto(headers: &HeaderMap) -> &'static str {
    match headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("https") => "https",
        _ => "http",
    }
}

pub fn host_without_port(value: &str) -> &str {
    if let Some(stripped) = value.strip_prefix('[') {
        // Bracketed IPv6 like [::1]:4749 → ::1
        return stripped.split(']').next().unwrap_or(stripped);
    }
    // Only split on the last colon if the result looks like a host (not bare
    // IPv6 which contains multiple colons, e.g. "::1").
    if let Some((host, port)) = value.rsplit_once(':') {
        // If the port part is all digits, this is host:port — return the host.
        // Otherwise it's a bare IPv6 address — return the whole value.
        if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
            return host;
        }
    }
    value
}

pub fn is_loopback_hostname(value: &str) -> bool {
    let candidate = host_without_port(value).trim().trim_matches('.');
    candidate.eq_ignore_ascii_case("localhost")
        || candidate.eq_ignore_ascii_case("127.0.0.1")
        || candidate.eq_ignore_ascii_case("::1")
        || candidate
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

pub fn websocket_origin_from_http(origin: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(origin).ok()?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => "ws",
    }
    .to_string();
    url.set_scheme(&scheme).ok()?;
    Some(url.to_string().trim_end_matches('/').to_string())
}

pub fn derive_backend_origin_from_request(
    headers: &HeaderMap,
    backend_port: u16,
) -> Option<String> {
    let host = resolve_forwarded_host(headers)?;
    let protocol = resolve_forwarded_proto(headers);
    let mut url = reqwest::Url::parse(&format!("{protocol}://{host}")).ok()?;
    url.set_port(Some(backend_port)).ok()?;
    Some(url.to_string().trim_end_matches('/').to_string())
}

pub fn parse_backend_origin_header(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(INTERNAL_BACKEND_ORIGIN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let url = reqwest::Url::parse(value).ok()?;
    Some(
        url.origin()
            .ascii_serialization()
            .trim_end_matches('/')
            .to_string(),
    )
}
