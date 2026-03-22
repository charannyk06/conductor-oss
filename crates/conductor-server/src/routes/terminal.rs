use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use crate::routes::config::access_control_enabled;
use crate::routes::ttyd_protocol;
use crate::state::{
    sanitize_terminal_text, trim_lines_tail, AppState, SessionRecord, TerminalRestoreSnapshot,
    DETACHED_LOG_PATH_METADATA_KEY, RUNTIME_MODE_METADATA_KEY, TERMINAL_RESTORE_SNAPSHOT_FORMAT,
    TTYD_PID_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_WS_URL_METADATA_KEY,
};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 10_000;
const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12000;
const MAX_TERMINAL_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_TERMINAL_SESSION_SECRET";
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 60;
const SERVER_TIMING_HEADER: &str = "server-timing";
const TERMINAL_SNAPSHOT_SOURCE_HEADER: &str = "x-conductor-terminal-snapshot-source";
const TERMINAL_SNAPSHOT_LIVE_HEADER: &str = "x-conductor-terminal-snapshot-live";
const TERMINAL_SNAPSHOT_RESTORED_HEADER: &str = "x-conductor-terminal-snapshot-restored";
const TERMINAL_SNAPSHOT_FORMAT_HEADER: &str = "x-conductor-terminal-snapshot-format";
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());
const TTYD_MOBILE_TOUCH_SHIM_MARKER: &str = "conductor-ttyd-mobile-touch-shim";
const TTYD_MOBILE_TOUCH_SHIM: &str = r#"
<!-- conductor-ttyd-mobile-touch-shim -->
<style>
html.conductor-ttyd-touch-shim-enabled,
html.conductor-ttyd-touch-shim-enabled body {
    height: 100%;
    max-height: 100%;
    overflow: hidden;
    overscroll-behavior: contain;
}

html.conductor-ttyd-touch-shim-enabled .xterm-viewport,
html.conductor-ttyd-touch-shim-enabled .xterm-scrollable-element {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
}

html.conductor-ttyd-touch-shim-enabled .xterm,
html.conductor-ttyd-touch-shim-enabled .xterm-viewport,
html.conductor-ttyd-touch-shim-enabled .xterm-scrollable-element,
html.conductor-ttyd-touch-shim-enabled .xterm-screen {
    touch-action: pan-y;
}

html.conductor-ttyd-touch-shim-enabled.conductor-ttyd-wheel-mode .xterm,
html.conductor-ttyd-touch-shim-enabled.conductor-ttyd-wheel-mode .xterm-viewport,
html.conductor-ttyd-touch-shim-enabled.conductor-ttyd-wheel-mode .xterm-scrollable-element,
html.conductor-ttyd-touch-shim-enabled.conductor-ttyd-wheel-mode .xterm-screen {
    touch-action: none;
}
</style>
<script>
(() => {
    if (window.__conductorTtydMobileTouchShimInstalled) return;
    window.__conductorTtydMobileTouchShimInstalled = true;

    // Keep scroll containment active for ttyd terminals on every platform.
    // The touch-specific gesture translation below still only activates on
    // touch-capable devices or compact viewports that use the mobile shell.
    document.documentElement.classList.add('conductor-ttyd-touch-shim-enabled');

    const viewportWidth = typeof window.innerWidth === 'number'
        ? window.innerWidth
        : 0;
    const compactViewport = viewportWidth > 0 && viewportWidth < 1024;
    const coarsePointer = typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches;
    const maxTouchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0;
    if (!compactViewport && !coarsePointer && maxTouchPoints <= 0) return;

    const bindTouchScroll = () => {
    const terminalRoot = document.querySelector('.xterm');
    const scrollHost = document.querySelector('.xterm-viewport')
        || document.querySelector('.xterm-scrollable-element');
    if (!terminalRoot || !scrollHost || terminalRoot.dataset.conductorTouchShimBound === 'true') {
        return false;
    }

    terminalRoot.dataset.conductorTouchShimBound = 'true';

    let followBottom = true;
    let lastStableScrollTop = scrollHost.scrollTop;
    let active = false;
    let lastX = 0;
    let lastY = 0;
    let touchStartAt = 0;
    let touchMoved = false;
    const LONG_PRESS_THRESHOLD_MS = 300;

    const reset = () => {
      active = false;
    };

    const isScrollHostAtBottom = () =>
        scrollHost.scrollHeight - scrollHost.clientHeight - scrollHost.scrollTop <= 1;

    const syncFollowBottom = () => {
        followBottom = isScrollHostAtBottom();
        lastStableScrollTop = scrollHost.scrollTop;
    };

    const stickToBottomIfNeeded = () => {
        if (followBottom) {
            scrollHost.scrollTop = scrollHost.scrollHeight;
            lastStableScrollTop = scrollHost.scrollTop;
            return;
        }

        if (scrollHost.scrollTop !== lastStableScrollTop) {
            scrollHost.scrollTop = lastStableScrollTop;
        }
    };

    const scrollTerminalViewport = (deltaY) => {
        const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        const nextScrollTop = Math.max(0, Math.min(maxScrollTop, scrollHost.scrollTop + deltaY));
        if (nextScrollTop === scrollHost.scrollTop) {
            return false;
        }

        scrollHost.scrollTop = nextScrollTop;
        followBottom = isScrollHostAtBottom();
        lastStableScrollTop = scrollHost.scrollTop;
        return true;
    };

    const resolveXtermCore = () => window.term?._core || window.term?.core || null;
    const resolveCoreMouseService = () => {
        const core = resolveXtermCore();
        return core?.coreMouseService || core?._coreMouseService || null;
        };

        const resolveMouseTrackingMode = () => {
            const publicMode = window.term?.modes?.mouseTrackingMode;
            if (typeof publicMode === 'string' && publicMode.length > 0) {
                return publicMode.toLowerCase();
            }

            const coreMouseService = resolveCoreMouseService();
            const activeProtocol = coreMouseService?.activeProtocol;
            if (typeof activeProtocol === 'string' && activeProtocol.length > 0) {
                return activeProtocol.toLowerCase();
            }

            return coreMouseService?.areMouseEventsActive ? 'unknown' : 'none';
        };

        const isMouseProtocolActive = () => {
            return resolveMouseTrackingMode() !== 'none';
        };

        const syncTouchActionMode = (forceActive) => {
            const active = typeof forceActive === 'boolean' ? forceActive : isMouseProtocolActive();
            document.documentElement.classList.toggle('conductor-ttyd-wheel-mode', active);
            return active;
        };

        const dispatchCoreMouseWheel = (deltaY, clientX, clientY) => {
            const core = resolveXtermCore();
            const mouseService = core?._mouseService || core?.mouseService;
            const coreMouseService = resolveCoreMouseService();
            const viewport = core?.viewport;
            const screenElement = core?.screenElement || terminalRoot.querySelector('.xterm-screen');
            if (!mouseService
                || typeof mouseService.getMouseReportCoords !== 'function'
                || !coreMouseService
                || typeof coreMouseService.triggerMouseEvent !== 'function'
                || !coreMouseService.areMouseEventsActive
                || !viewport
                || typeof viewport.getLinesScrolled !== 'function'
                || !screenElement) {
                return false;
            }

            const wheelDeltaModePixel = typeof WheelEvent === 'function'
                && typeof WheelEvent.DOM_DELTA_PIXEL === 'number'
                ? WheelEvent.DOM_DELTA_PIXEL
                : 0;
            const wheelLikeEvent = {
                clientX,
                clientY,
                deltaY,
                deltaMode: wheelDeltaModePixel,
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
            };
            const amount = viewport.getLinesScrolled(wheelLikeEvent);
            if (!amount) {
                return false;
            }

            const pos = mouseService.getMouseReportCoords(wheelLikeEvent, screenElement);
            if (!pos) {
                return false;
            }

            return coreMouseService.triggerMouseEvent({
                col: pos.col,
                row: pos.row,
                x: pos.x,
                y: pos.y,
                button: 4,
                action: deltaY < 0 ? 0 : 1,
                ctrl: false,
                alt: false,
                shift: false,
            });
        };

        const dispatchTerminalWheel = (deltaX, deltaY, clientX, clientY) => {
            if (typeof WheelEvent !== 'function') {
                return false;
            }

            const term = window.term;
            const eventTarget = document.elementFromPoint(clientX, clientY)
                || term?.element
                || terminalRoot;
            const beforeScrollTop = scrollHost.scrollTop;
            const wheelEvent = new WheelEvent('wheel', {
                deltaX,
                deltaY,
                deltaMode: 0,
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX,
                clientY,
            });

            const cancelled = !eventTarget.dispatchEvent(wheelEvent);
            return cancelled || wheelEvent.defaultPrevented || scrollHost.scrollTop !== beforeScrollTop;
        };

        terminalRoot.addEventListener('touchstart', (event) => {
            if (event.touches.length !== 1) {
                syncTouchActionMode();
                reset();
                return;
            }

            const touch = event.touches[0];
            lastX = touch.clientX;
            lastY = touch.clientY;
            touchStartAt = window.performance?.now?.() ?? Date.now();
            touchMoved = false;
            syncTouchActionMode();
            active = true;
        }, { passive: true });

        terminalRoot.addEventListener('touchmove', (event) => {
            if (!active || event.touches.length !== 1) {
                return;
            }

            touchMoved = true;
            const touch = event.touches[0];
            const deltaX = lastX - touch.clientX;
            const deltaY = lastY - touch.clientY;
            lastX = touch.clientX;
            lastY = touch.clientY;

            if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
                return;
            }

            if (scrollTerminalViewport(deltaY)) {
                if (event.cancelable) {
                    event.preventDefault();
                }
                return;
            }

            // xterm already handles touch scrolling when mouse reporting is off. Only
            // intercept the gesture when the viewport has no remaining scroll range
            // and the app has enabled mouse mode, which is the OpenCode case that
            // blocks native touch scrolling on mobile.
            if (!syncTouchActionMode()) {
                return;
            }

            if (event.cancelable) {
                event.preventDefault();
            }

            followBottom = false;
            lastStableScrollTop = scrollHost.scrollTop;

            // OpenCode enables xterm mouse reporting, which disables xterm's built-in
            // touchmove scrolling. Translate the drag into xterm's internal wheel mouse
            // reports so OpenCode receives real scroll input for its own panes.
            if (!dispatchCoreMouseWheel(deltaY, touch.clientX, touch.clientY)) {
                if (!dispatchTerminalWheel(deltaX, deltaY, touch.clientX, touch.clientY)) {
                    const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
                    scrollHost.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollHost.scrollTop + deltaY));
                }
            }
        }, { passive: false });

        terminalRoot.addEventListener('touchend', () => {
            const touchDuration = (window.performance?.now?.() ?? Date.now()) - touchStartAt;
            if (!touchMoved && touchDuration < LONG_PRESS_THRESHOLD_MS) {
                window.term?.focus?.();
            }
            syncTouchActionMode();
            reset();
        }, { passive: true });
        terminalRoot.addEventListener('touchcancel', () => {
            syncTouchActionMode();
            reset();
        }, { passive: true });
        scrollHost.addEventListener('scroll', syncFollowBottom, { passive: true });
        syncFollowBottom();
        syncTouchActionMode();
        return true;
    };

    const observer = new MutationObserver(() => {
        bindTouchScroll();
        stickToBottomIfNeeded();
        syncTouchActionMode();
    });
    bindTouchScroll();
    syncTouchActionMode();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
})();
</script>
"#;

fn ttyd_session_ws_url(session: &SessionRecord) -> Option<String> {
    let runtime_mode = session
        .metadata
        .get(RUNTIME_MODE_METADATA_KEY)
        .map(String::as_str);
    if runtime_mode != Some(TTYD_RUNTIME_MODE) {
        return None;
    }

    session.metadata.get(TTYD_WS_URL_METADATA_KEY).cloned()
}

fn ttyd_http_url_from_ws_url(ws_url: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(ws_url).ok()?;
    match url.scheme() {
        "ws" => {
            let _ = url.set_scheme("http");
        }
        "wss" => {
            let _ = url.set_scheme("https");
        }
        "http" | "https" => {}
        _ => return None,
    }

    let normalized_path = match url.path() {
        "/ws" => "/".to_string(),
        path if path.ends_with("/ws") => {
            let stripped = &path[..path.len().saturating_sub(3)];
            if stripped.is_empty() {
                "/".to_string()
            } else {
                stripped.to_string()
            }
        }
        "" => "/".to_string(),
        path => path.to_string(),
    };
    url.set_path(&normalized_path);
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn ttyd_session_http_url(session: &SessionRecord) -> Option<String> {
    ttyd_session_ws_url(session).and_then(|ws_url| ttyd_http_url_from_ws_url(&ws_url))
}

fn content_type_is_html(content_type: &HeaderValue) -> bool {
    content_type
        .to_str()
        .ok()
        .map(|value| value.to_ascii_lowercase().starts_with("text/html"))
        .unwrap_or(false)
}

fn should_inject_ttyd_mobile_touch_shim(session: &SessionRecord) -> bool {
    session.agent.trim().eq_ignore_ascii_case("opencode")
}

fn inject_ttyd_mobile_touch_shim(html: &str) -> String {
    if html.contains(TTYD_MOBILE_TOUCH_SHIM_MARKER) {
        return html.to_string();
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + TTYD_MOBILE_TOUCH_SHIM.len());
        output.push_str(&html[..index]);
        output.push_str(TTYD_MOBILE_TOUCH_SHIM);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.rfind("</html>") {
        let mut output = String::with_capacity(html.len() + TTYD_MOBILE_TOUCH_SHIM.len());
        output.push_str(&html[..index]);
        output.push_str(TTYD_MOBILE_TOUCH_SHIM);
        output.push_str(&html[index..]);
        return output;
    }

    let mut output = String::with_capacity(html.len() + TTYD_MOBILE_TOUCH_SHIM.len());
    output.push_str(html);
    output.push_str(TTYD_MOBILE_TOUCH_SHIM);
    output
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum TerminalTokenScope {
    Control,
}

impl TerminalTokenScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Control => "control",
        }
    }
}

/// WebSocket routes that must bypass CorsLayer to avoid 101 response interference.
pub fn ws_router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/api/sessions/{id}/terminal/ttyd/ws",
        get(terminal_ttyd_frontend_websocket),
    )
}

/// Non-WebSocket terminal routes (HTTP) that go through normal CORS middleware.
pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/sessions/{id}/terminal/token", get(terminal_token))
        .route(
            "/api/sessions/{id}/terminal/ttyd",
            get(terminal_ttyd_frontend),
        )
        .route(
            "/api/sessions/{id}/terminal/ttyd/token",
            get(terminal_ttyd_frontend_token),
        )
        .route(
            "/api/sessions/{id}/terminal/snapshot",
            get(terminal_snapshot),
        )
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

fn elapsed_duration_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

fn append_server_timing_metric(headers: &mut HeaderMap, metric_name: &str, duration_ms: f64) {
    let value = format!("{metric_name};dur={duration_ms:.1}");
    if let Ok(header_value) = HeaderValue::from_str(&value) {
        headers.append(HeaderName::from_static(SERVER_TIMING_HEADER), header_value);
    }
}

fn set_terminal_header(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        headers.insert(HeaderName::from_static(name), header_value);
    }
}

fn set_terminal_bool_header(headers: &mut HeaderMap, name: &'static str, value: bool) {
    set_terminal_header(headers, name, if value { "true" } else { "false" });
}

fn timed_error_response(
    status: StatusCode,
    message: impl Into<String>,
    metric_name: &str,
    started_at: Instant,
) -> Response {
    let mut response = error(status, message).into_response();
    append_server_timing_metric(
        response.headers_mut(),
        metric_name,
        elapsed_duration_ms(started_at),
    );
    response
}

fn build_terminal_snapshot_response(payload: Value, started_at: Instant) -> Response {
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .map(str::to_string);
    let live = payload.get("live").and_then(Value::as_bool);
    let restored = payload.get("restored").and_then(Value::as_bool);
    let format = payload
        .get("format")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut response = Json(payload).into_response();
    let headers = response.headers_mut();
    append_server_timing_metric(
        headers,
        "terminal_snapshot",
        elapsed_duration_ms(started_at),
    );
    if let Some(source) = source.as_deref() {
        set_terminal_header(headers, TERMINAL_SNAPSHOT_SOURCE_HEADER, source);
    }
    if let Some(live) = live {
        set_terminal_bool_header(headers, TERMINAL_SNAPSHOT_LIVE_HEADER, live);
    }
    if let Some(restored) = restored {
        set_terminal_bool_header(headers, TERMINAL_SNAPSHOT_RESTORED_HEADER, restored);
    }
    if let Some(format) = format.as_deref() {
        set_terminal_header(headers, TERMINAL_SNAPSHOT_FORMAT_HEADER, format);
    }
    response
}

#[derive(Debug, Deserialize)]
struct TerminalQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TerminalSnapshotQuery {
    lines: Option<usize>,
    live: Option<String>,
}

fn ttyd_frontend_proxy_path(session_id: &str, token: Option<&str>) -> String {
    match token {
        Some(token) if !token.trim().is_empty() => {
            format!("/api/sessions/{session_id}/terminal/ttyd?token={token}")
        }
        _ => format!("/api/sessions/{session_id}/terminal/ttyd"),
    }
}

fn ttyd_frontend_proxy_ws_path(session_id: &str, token: Option<&str>) -> String {
    match token {
        Some(token) if !token.trim().is_empty() => {
            format!("/api/sessions/{session_id}/terminal/ttyd/ws?token={token}")
        }
        _ => format!("/api/sessions/{session_id}/terminal/ttyd/ws"),
    }
}

async fn terminal_ttyd_frontend_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let ws = ws.protocols(["tty"]);
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) = authorize_terminal_access(&state, &id, query.token.as_deref()).await {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    if ttyd_session_ws_url(&session).is_none() {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} is not backed by ttyd"),
        )
        .into_response();
    }

    match state.ensure_session_live(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return error(StatusCode::CONFLICT, format!("Session {id} is not running"))
                .into_response();
        }
        Err(err) => {
            tracing::warn!(
                session_id = %id,
                error = %err,
                "Failed to restore live terminal session before ttyd websocket attach"
            );
            return error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to attach live terminal: {err}"),
            )
            .into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_ttyd_frontend_socket(state, id, socket))
}

async fn terminal_token(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    build_terminal_token_response(state, id, TerminalTokenScope::Control).await
}

async fn build_terminal_token_response(
    state: Arc<AppState>,
    id: String,
    scope: TerminalTokenScope,
) -> Response {
    let Some(initial_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if ttyd_session_ws_url(&initial_session).is_some()
        && initial_session.metadata.contains_key(TTYD_PID_METADATA_KEY)
    {
        match state.ensure_session_live(&id).await {
            Ok(true) => {}
            Ok(false) => {
                return error(StatusCode::CONFLICT, format!("Session {id} is not running"))
                    .into_response();
            }
            Err(err) => {
                tracing::warn!(
                    session_id = %id,
                    error = %err,
                    "Failed to restore live terminal session before issuing token"
                );
                return error(
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to attach live terminal: {err}"),
                )
                .into_response();
            }
        }
    }

    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let access = state.config.read().await.access.clone();
    let token_required = should_issue_terminal_token(&access);
    let token = if token_required {
        create_scoped_terminal_token(&id, scope).ok()
    } else {
        None
    };
    let Some(_ttyd_ws_url) = ttyd_session_ws_url(&session) else {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} does not expose a ttyd terminal"),
        )
        .into_response();
    };
    let ttyd_http_url = ttyd_frontend_proxy_path(&id, token.as_deref());
    let ttyd_ws_url = ttyd_frontend_proxy_ws_path(&id, token.as_deref());

    Json(json!({
        "token": token,
        "required": token_required,
        "expiresInSeconds": token.as_ref().map(|_| TERMINAL_TOKEN_TTL_SECONDS),
        "ttydHttpUrl": ttyd_http_url,
        "ttydWsUrl": ttyd_ws_url,
    }))
    .into_response()
}

async fn terminal_ttyd_frontend(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
) -> Response {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) = authorize_terminal_access(&state, &id, query.token.as_deref()).await {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
    }

    match state.ensure_session_live(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return error(StatusCode::CONFLICT, format!("Session {id} is not running"))
                .into_response();
        }
        Err(err) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to attach live terminal: {err}"),
            )
            .into_response();
        }
    }

    let Some(ttyd_http_url) = ttyd_session_http_url(&session) else {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} does not expose a ttyd terminal"),
        )
        .into_response();
    };

    let upstream = match reqwest::get(&ttyd_http_url).await {
        Ok(upstream) => upstream,
        Err(err) => {
            tracing::warn!(session_id = %id, error = %err, "Failed to load ttyd frontend HTML");
            return error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to load ttyd frontend: {err}"),
            )
            .into_response();
        }
    };

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("text/html; charset=utf-8"));
    let body = match upstream.bytes().await {
        Ok(body) => body,
        Err(err) => {
            tracing::warn!(session_id = %id, error = %err, "Failed to read ttyd frontend HTML");
            return error(
                StatusCode::BAD_GATEWAY,
                format!("Failed to read ttyd frontend: {err}"),
            )
            .into_response();
        }
    };
    let body =
        if content_type_is_html(&content_type) && should_inject_ttyd_mobile_touch_shim(&session) {
            inject_ttyd_mobile_touch_shim(&String::from_utf8_lossy(&body)).into_bytes()
        } else {
            body.to_vec()
        };

    let mut response = Response::new(body.into());
    *response.status_mut() = status;
    response.headers_mut().insert(CONTENT_TYPE, content_type);
    response
}

async fn terminal_ttyd_frontend_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if ttyd_session_ws_url(&session).is_none() {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} does not expose a ttyd terminal"),
        )
        .into_response();
    }

    Json(json!({ "token": "" })).into_response()
}

async fn terminal_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalSnapshotQuery>,
) -> Response {
    let started_at = Instant::now();
    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let lines = query
        .lines
        .unwrap_or(DEFAULT_TERMINAL_SNAPSHOT_LINES)
        .clamp(25, MAX_TERMINAL_SNAPSHOT_LINES);
    let max_bytes = TERMINAL_SNAPSHOT_MAX_BYTES;
    let live_requested = terminal_snapshot_live_requested(query.live.as_deref());

    match build_terminal_snapshot(&state, &session, lines, max_bytes, live_requested).await {
        Ok(snapshot) => build_terminal_snapshot_response(snapshot, started_at),
        Err(err) => timed_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            err.to_string(),
            "terminal_snapshot",
            started_at,
        ),
    }
}

async fn build_terminal_snapshot(
    state: &AppState,
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
    live_requested: bool,
) -> Result<Value> {
    if let Some(snapshot) = build_terminal_restore_snapshot(state, session).await? {
        let live = state.terminal_runtime_attached(&session.id).await;
        let restore_bytes = if live_requested {
            snapshot.render_restore_bytes(max_bytes)
        } else {
            snapshot.render_bytes(max_bytes)
        };
        let transcript = state
            .current_terminal_transcript(&session.id, lines, max_bytes)
            .await
            .unwrap_or_else(|| snapshot.transcript(lines, max_bytes));
        let transcript = if transcript.trim().is_empty() {
            terminal_snapshot_transcript_fallback(session, lines, max_bytes).await?
        } else {
            transcript
        };
        return Ok(json!({
            "snapshot": String::from_utf8_lossy(&restore_bytes),
            "transcript": transcript,
            "source": "terminal_state",
            "format": TERMINAL_RESTORE_SNAPSHOT_FORMAT,
            "snapshotVersion": snapshot.version,
            "sequence": snapshot.sequence,
            "cols": snapshot.cols,
            "rows": snapshot.rows,
            "modes": snapshot.modes,
            "historyBytes": snapshot.history_len(),
            "screenBytes": snapshot.screen_len(),
            "live": live,
            "restored": true,
        }));
    }

    let terminal_capture_path = state.session_terminal_capture_path(&session.id);
    if let Some(snapshot) = read_terminal_log_tail(&terminal_capture_path, lines, max_bytes).await?
    {
        let live = state.terminal_runtime_attached(&session.id).await;
        return Ok(json!({
            "snapshot": snapshot,
            "source": "terminal_capture",
            "live": live,
            "restored": true,
        }));
    }

    let snapshot = trim_utf8_tail_string(trim_lines_tail(&session.output, lines), max_bytes);
    Ok(json!({
        "snapshot": snapshot,
        "source": if session.output.trim().is_empty() { "empty" } else { "session_output" },
        "live": false,
        "restored": !session.output.trim().is_empty(),
    }))
}

async fn terminal_snapshot_transcript_fallback(
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
) -> Result<String> {
    if let Some(path) = session
        .metadata
        .get(DETACHED_LOG_PATH_METADATA_KEY)
        .map(PathBuf::from)
    {
        if let Some(transcript) = read_terminal_log_transcript(&path, lines, max_bytes).await? {
            return Ok(transcript);
        }
    }

    Ok(trim_utf8_tail_string(
        trim_lines_tail(&session.output, lines),
        max_bytes,
    ))
}

async fn build_terminal_restore_snapshot(
    state: &AppState,
    session: &SessionRecord,
) -> Result<Option<TerminalRestoreSnapshot>> {
    Ok(state.current_terminal_restore_snapshot(&session.id).await)
}

async fn read_terminal_log_tail(
    path: &StdPath,
    lines: usize,
    max_bytes: usize,
) -> Result<Option<String>> {
    let Some(bytes) = read_terminal_log_bytes(path).await? else {
        return Ok(None);
    };
    let snapshot = trim_utf8_tail_string(
        trim_lines_tail(String::from_utf8_lossy(&bytes).as_ref(), lines),
        max_bytes,
    );
    if snapshot.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(snapshot))
    }
}

async fn read_terminal_log_transcript(
    path: &StdPath,
    lines: usize,
    max_bytes: usize,
) -> Result<Option<String>> {
    let Some(bytes) = read_terminal_log_bytes(path).await? else {
        return Ok(None);
    };

    let sanitized = sanitize_terminal_text(String::from_utf8_lossy(&bytes).as_ref());
    let transcript = normalize_terminal_transcript(trim_utf8_tail_string(
        trim_lines_tail(&sanitized, lines),
        max_bytes,
    ));
    if transcript.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(transcript))
    }
}

fn normalize_terminal_transcript(value: String) -> String {
    let mut normalized = Vec::new();
    let mut previous_non_empty: Option<String> = None;
    let mut emitted_blank = false;

    for raw_line in value.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            if normalized.is_empty() || emitted_blank {
                continue;
            }
            normalized.push(String::new());
            emitted_blank = true;
            continue;
        }

        if previous_non_empty.as_deref() == Some(line) {
            continue;
        }

        normalized.push(line.to_string());
        previous_non_empty = Some(line.to_string());
        emitted_blank = false;
    }

    while normalized.last().is_some_and(|line| line.is_empty()) {
        normalized.pop();
    }

    normalized.join("\n")
}

async fn read_terminal_log_bytes(path: &StdPath) -> Result<Option<Vec<u8>>> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };

    let len = file.metadata().await?.len();
    let start = len.saturating_sub(MAX_TERMINAL_LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).await?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    if String::from_utf8_lossy(&bytes).trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(bytes))
    }
}

fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    String::from_utf8_lossy(&trim_utf8_tail_bytes(value.into_bytes(), max_bytes)).into_owned()
}

fn terminal_snapshot_live_requested(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn trim_utf8_tail_bytes(bytes: Vec<u8>, max_bytes: usize) -> Vec<u8> {
    if max_bytes == 0 || bytes.len() <= max_bytes {
        return bytes;
    }

    let start = utf8_safe_tail_start(&bytes, bytes.len().saturating_sub(max_bytes));
    bytes[start..].to_vec()
}

fn utf8_safe_tail_start(bytes: &[u8], preferred_start: usize) -> usize {
    let mut start = preferred_start.min(bytes.len());
    while start < bytes.len() && std::str::from_utf8(&bytes[start..]).is_err() {
        start += 1;
    }
    start.min(bytes.len())
}

async fn handle_ttyd_frontend_socket(
    state: Arc<AppState>,
    session_id: String,
    mut client_socket: WebSocket,
) {
    let handle = state.ensure_terminal_host(&session_id).await;
    let mut terminal_rx = handle.terminal_tx.subscribe();
    let snapshot = state.current_terminal_restore_snapshot(&session_id).await;
    let mut last_sequence_sent = 0_u64;
    let mut client_ready = false;

    loop {
        tokio::select! {
            client_message = client_socket.recv() => {
                match client_message {
                    Some(Ok(Message::Binary(data))) => {
                        if handle_ttyd_frontend_client_message(
                            &state,
                            &handle,
                            &session_id,
                            &mut client_socket,
                            &snapshot,
                            &mut client_ready,
                            &mut last_sequence_sent,
                            ttyd_protocol::ClientMessage::from_websocket_frame(&data),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if handle_ttyd_frontend_client_message(
                            &state,
                            &handle,
                            &session_id,
                            &mut client_socket,
                            &snapshot,
                            &mut client_ready,
                            &mut last_sequence_sent,
                            ttyd_protocol::ClientMessage::from_websocket_frame(text.as_bytes()),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if client_socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => {
                        tracing::debug!(
                            session_id = %session_id,
                            error = %err,
                            "Browser ttyd websocket closed"
                        );
                        break;
                    }
                }
            }
            event = terminal_rx.recv(), if client_ready => {
                match event {
                    Ok(crate::state::TerminalStreamEvent::Stream(chunk)) => {
                        if chunk.sequence <= last_sequence_sent {
                            continue;
                        }
                        last_sequence_sent = chunk.sequence;
                        if client_socket.send(Message::Binary(ttyd_protocol::encode_output(&chunk.bytes).into())).await.is_err() {
                            break;
                        }
                    }
                    Ok(crate::state::TerminalStreamEvent::Exit(exit_code)) => {
                        let message = format!("\r\n[Conductor] Terminal exited ({exit_code}).\r\n");
                        let _ = client_socket.send(Message::Binary(ttyd_protocol::encode_output(message.as_bytes()).into())).await;
                        let _ = client_socket.send(Message::Close(None)).await;
                        break;
                    }
                    Ok(crate::state::TerminalStreamEvent::Error(error_message)) => {
                        let message = format!("\r\n[Conductor] {error_message}\r\n");
                        let _ = client_socket.send(Message::Binary(ttyd_protocol::encode_output(message.as_bytes()).into())).await;
                        let _ = client_socket.send(Message::Close(None)).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if let Some(snapshot) = state.current_terminal_restore_snapshot(&session_id).await {
                            let bytes = snapshot.render_restore_bytes(TERMINAL_SNAPSHOT_MAX_BYTES);
                            last_sequence_sent = snapshot.sequence;
                            if !bytes.is_empty()
                                && client_socket.send(Message::Binary(ttyd_protocol::encode_output(&bytes).into())).await.is_err()
                            {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_ttyd_frontend_client_message(
    state: &Arc<AppState>,
    handle: &Arc<crate::state::LiveSessionHandle>,
    session_id: &str,
    client_socket: &mut WebSocket,
    snapshot: &Option<TerminalRestoreSnapshot>,
    client_ready: &mut bool,
    last_sequence_sent: &mut u64,
    message: Option<ttyd_protocol::ClientMessage>,
) -> Result<()> {
    match message {
        Some(ttyd_protocol::ClientMessage::Handshake(value)) => {
            *client_ready = true;
            if let Some((columns, rows)) = parse_handshake_dimensions(&value) {
                let _ = state.resize_live_terminal(session_id, columns, rows).await;
            }
            client_socket
                .send(Message::Binary(
                    ttyd_protocol::encode_preferences(&ttyd_protocol::default_preferences()).into(),
                ))
                .await?;
            if let Some(snapshot) = snapshot.as_ref() {
                let bytes = snapshot.render_restore_bytes(TERMINAL_SNAPSHOT_MAX_BYTES);
                if !bytes.is_empty() {
                    *last_sequence_sent = snapshot.sequence;
                    client_socket
                        .send(Message::Binary(ttyd_protocol::encode_output(&bytes).into()))
                        .await?;
                }
            }
        }
        Some(ttyd_protocol::ClientMessage::Input(data)) => {
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Some(input_tx) = handle.input_tx.read().await.clone() {
                input_tx
                    .send(conductor_executors::executor::ExecutorInput::Raw(text))
                    .await?;
            }
        }
        Some(ttyd_protocol::ClientMessage::Resize { columns, rows }) => {
            let _ = state.resize_live_terminal(session_id, columns, rows).await;
        }
        Some(ttyd_protocol::ClientMessage::Pause)
        | Some(ttyd_protocol::ClientMessage::Resume)
        | None => {}
    }

    Ok(())
}

fn parse_handshake_dimensions(value: &Value) -> Option<(u16, u16)> {
    let columns = value.get("columns")?.as_u64()? as u16;
    let rows = value.get("rows")?.as_u64()? as u16;
    Some((columns, rows))
}

pub(crate) fn resolve_terminal_keys(
    keys: Option<String>,
    special: Option<String>,
) -> Result<String> {
    if let Some(keys) = keys {
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
        other => other,
    };

    Ok(mapped.to_string())
}

async fn authorize_terminal_access(
    state: &Arc<AppState>,
    session_id: &str,
    token: Option<&str>,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(());
    }

    let token = token.ok_or_else(|| anyhow!("Terminal token is required"))?;
    if verify_terminal_token(session_id, token)? {
        return Ok(());
    }

    Err(anyhow!("Invalid terminal token"))
}

fn verify_scoped_terminal_token(
    session_id: &str,
    token: &str,
    accepted_scopes: &[TerminalTokenScope],
) -> Result<bool> {
    let secret = terminal_token_secret();

    let (raw_payload, provided_signature) = token
        .split_once('.')
        .ok_or_else(|| anyhow!("Malformed terminal token"))?;
    let (scope, expires_at_raw, payload) =
        if let Some((scope_raw, expires_at_raw)) = raw_payload.split_once(':') {
            let scope = match scope_raw {
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
    Ok(constant_time_equal(
        expected_signature.as_bytes(),
        provided_signature.as_bytes(),
    ))
}

fn verify_terminal_token(session_id: &str, token: &str) -> Result<bool> {
    verify_scoped_terminal_token(session_id, token, &[TerminalTokenScope::Control])
}

fn create_scoped_terminal_token(session_id: &str, scope: TerminalTokenScope) -> Result<String> {
    let secret = terminal_token_secret();
    let expires_at = chrono::Utc::now().timestamp() + TERMINAL_TOKEN_TTL_SECONDS;
    let payload = format!("{session_id}:{}:{expires_at}", scope.as_str());
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())?;
    mac.update(payload.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    Ok(format!("{}:{expires_at}.{signature}", scope.as_str()))
}

fn terminal_token_secret() -> String {
    std::env::var(TERMINAL_TOKEN_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| PROCESS_TERMINAL_TOKEN_SECRET.clone())
}

fn should_issue_terminal_token(access: &conductor_core::config::DashboardAccessConfig) -> bool {
    access_control_enabled(access)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    let mut mismatch = 0_u8;
    for (lhs, rhs) in left.iter().zip(right.iter()) {
        mismatch |= lhs ^ rhs;
    }
    mismatch == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::extract::{Path, State};
    use axum::http::Request;
    use conductor_core::config::ConductorConfig;
    use conductor_db::Database;
    use conductor_executors::executor::ExecutorInput;
    use std::sync::Arc;
    use tokio::fs;
    use tokio::sync::{mpsc, oneshot};
    use tower::util::ServiceExt;
    use uuid::Uuid;

    async fn build_test_state() -> (Arc<AppState>, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("conductor-terminal-route-test-{}", Uuid::new_v4()));
        let config = ConductorConfig {
            workspace: root.clone(),
            ..ConductorConfig::default()
        };
        let db = Database::in_memory()
            .await
            .expect("in-memory db should initialize");
        let state = AppState::new(root.join("conductor.yaml"), config, db).await;
        (state, root)
    }

    async fn seed_live_terminal_session(state: &Arc<AppState>, session_id: &str) -> SessionRecord {
        let session = SessionRecord::builder(
            session_id.to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate terminal restore".to_string(),
        )
        .build();
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        state
            .attach_terminal_runtime(&session.id, input_tx, None, kill_tx)
            .await;
        state
            .emit_terminal_text(&session.id, "first line\r\nprompt> ")
            .await;

        session
    }

    #[test]
    fn resolve_terminal_keys_prefers_literal_keys() {
        let value = resolve_terminal_keys(Some("hello".to_string()), Some("Enter".to_string()))
            .expect("literal keys should win");
        assert_eq!(value, "hello");
    }

    #[test]
    fn resolve_terminal_keys_maps_special_sequences() {
        let enter = resolve_terminal_keys(None, Some("Enter".to_string())).unwrap();
        let ctrl_c = resolve_terminal_keys(None, Some("C-c".to_string())).unwrap();
        let arrow_up = resolve_terminal_keys(None, Some("ArrowUp".to_string())).unwrap();

        assert_eq!(enter, "\r");
        assert_eq!(ctrl_c, "\u{3}");
        assert_eq!(arrow_up, "\u{1b}[A");
    }

    #[test]
    fn terminal_snapshot_live_requested_accepts_booleanish_query_values() {
        assert!(terminal_snapshot_live_requested(Some("1")));
        assert!(terminal_snapshot_live_requested(Some("true")));
        assert!(terminal_snapshot_live_requested(Some("YES")));
        assert!(!terminal_snapshot_live_requested(Some("0")));
        assert!(!terminal_snapshot_live_requested(Some("false")));
        assert!(!terminal_snapshot_live_requested(None));
    }

    #[test]
    fn inject_ttyd_mobile_touch_shim_inserts_before_body_close() {
        let html = "<html><body><main>terminal</main></body></html>";
        let injected = inject_ttyd_mobile_touch_shim(html);

        assert!(injected.contains(TTYD_MOBILE_TOUCH_SHIM_MARKER));
        assert!(injected.contains("window.__conductorTtydMobileTouchShimInstalled"));
        assert!(
            injected.contains("const compactViewport = viewportWidth > 0 && viewportWidth < 1024;")
        );
        assert!(injected.contains("const terminalRoot = document.querySelector('.xterm');"));
        assert!(injected.contains(".xterm-viewport"));
        assert!(injected.contains(".xterm-scrollable-element"));
        assert!(injected.contains("height: 100%;"));
        assert!(injected.contains("max-height: 100%;"));
        assert!(injected.contains("overflow: hidden;"));
        assert!(injected.contains("touch-action: pan-y;"));
        assert!(injected.contains("conductor-ttyd-wheel-mode"));
        assert!(injected.contains(
            "const resolveXtermCore = () => window.term?._core || window.term?.core || null;"
        ));
        assert!(injected.contains("const publicMode = window.term?.modes?.mouseTrackingMode;"));
        assert!(injected.contains("coreMouseService.areMouseEventsActive"));
        assert!(injected.contains("const syncFollowBottom = () => {"));
        assert!(injected.contains("const stickToBottomIfNeeded = () => {"));
        assert!(injected.contains("const scrollTerminalViewport = (deltaY) => {"));
        assert!(injected.contains("const syncTouchActionMode = (forceActive) => {"));
        assert!(injected.contains("if (scrollTerminalViewport(deltaY)) {"));
        assert!(injected.contains("mouseService.getMouseReportCoords"));
        assert!(injected.contains("viewport.getLinesScrolled(wheelLikeEvent)"));
        assert!(injected.contains("button: 4,"));
        assert!(injected.contains("action: deltaY < 0 ? 0 : 1,"));
        assert!(injected.contains("new WheelEvent('wheel'"));
        assert!(injected.contains("eventTarget.dispatchEvent(wheelEvent)"));
        assert!(injected.contains("terminalRoot.addEventListener('touchmove'"));
        assert!(injected.contains("if (!syncTouchActionMode()) {"));
        assert!(injected.contains("const LONG_PRESS_THRESHOLD_MS = 300;"));
        assert!(injected.contains("touchStartAt = window.performance?.now?.() ?? Date.now();"));
        assert!(injected.contains("touchMoved = true;"));
        assert!(injected.contains(
            "const touchDuration = (window.performance?.now?.() ?? Date.now()) - touchStartAt;"
        ));
        assert!(injected.contains("if (!touchMoved && touchDuration < LONG_PRESS_THRESHOLD_MS) {"));
        assert!(injected.contains("window.term?.focus?.();"));
        assert!(
            injected.find(TTYD_MOBILE_TOUCH_SHIM_MARKER).unwrap()
                < injected.rfind("</body>").unwrap()
        );
    }

    #[test]
    fn inject_ttyd_mobile_touch_shim_is_idempotent() {
        let html = "<html><body><main>terminal</main></body></html>";
        let once = inject_ttyd_mobile_touch_shim(html);
        let twice = inject_ttyd_mobile_touch_shim(&once);

        assert_eq!(
            twice.matches(TTYD_MOBILE_TOUCH_SHIM_MARKER).count(),
            1,
            "touch shim should only be injected once"
        );
    }

    #[test]
    fn should_inject_ttyd_mobile_touch_shim_only_for_opencode_sessions() {
        let opencode_session = SessionRecord::builder(
            "session-opencode".to_string(),
            "project-1".to_string(),
            "opencode".to_string(),
            "prompt".to_string(),
        )
        .build();
        let codex_session = SessionRecord::builder(
            "session-codex".to_string(),
            "project-1".to_string(),
            "codex".to_string(),
            "prompt".to_string(),
        )
        .build();

        assert!(should_inject_ttyd_mobile_touch_shim(&opencode_session));
        assert!(!should_inject_ttyd_mobile_touch_shim(&codex_session));
    }

    #[test]
    fn verify_terminal_token_accepts_valid_signature() {
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::set_var(TERMINAL_TOKEN_SECRET_ENV, "test-secret");
        }

        let expires_at = chrono::Utc::now().timestamp() + 60;
        let payload = format!("session-123:{expires_at}");
        let mut mac = HmacSha256::new_from_slice(b"test-secret").unwrap();
        mac.update(payload.as_bytes());
        let token = format!("{expires_at}.{}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_terminal_token("session-123", &token).unwrap());

        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }
    }

    #[test]
    fn terminal_token_is_not_required_for_local_auth_only_configs() {
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }

        let access = conductor_core::config::DashboardAccessConfig {
            require_auth: true,
            ..conductor_core::config::DashboardAccessConfig::default()
        };

        assert!(access_control_enabled(&access));
        assert!(should_issue_terminal_token(&access));
    }

    #[test]
    fn terminal_token_round_trip_works_without_env_secret() {
        let _guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
        unsafe {
            std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
        }

        let token = create_scoped_terminal_token("session-123", TerminalTokenScope::Control)
            .expect("token should be created");
        assert!(verify_terminal_token("session-123", &token).expect("token should verify"));
    }

    #[tokio::test]
    async fn build_terminal_snapshot_prefers_live_terminal_store_and_marks_session_live() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-live").await;

        let payload = build_terminal_snapshot(&state, &session, 200, 4096, true)
            .await
            .expect("snapshot should build");

        assert_eq!(payload["source"], "terminal_state");
        assert_eq!(payload["live"], true);
        assert_eq!(payload["restored"], true);
        let snapshot = payload["snapshot"]
            .as_str()
            .expect("snapshot should be a string");
        assert!(snapshot.contains("\u{1b}[?1049"));
        assert!(snapshot.contains("prompt> "));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn build_terminal_snapshot_falls_back_to_detached_log_transcript_when_restore_state_is_blank(
    ) {
        let (state, root) = build_test_state().await;
        let log_path = root.join("direct-session.log");
        fs::write(
            &log_path,
            b"\x1b[90mstatus\x1b[0m\r\nplain transcript line\r\nprompt> ",
        )
        .await
        .expect("detached log should write");

        let mut session = SessionRecord::builder(
            "session-log-fallback".to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate transcript fallback".to_string(),
        )
        .build();
        session.metadata.insert(
            DETACHED_LOG_PATH_METADATA_KEY.to_string(),
            log_path.to_string_lossy().to_string(),
        );
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        state
            .persist_terminal_restore_snapshot(
                &session.id,
                &TerminalRestoreSnapshot {
                    version: 1,
                    sequence: 9,
                    cols: 120,
                    rows: 32,
                    has_output: true,
                    modes: Default::default(),
                    history: Vec::new(),
                    screen: b"\x1b[2J\x1b[H".to_vec(),
                },
            )
            .await
            .expect("restore snapshot should persist");

        let payload = build_terminal_snapshot(&state, &session, 200, 4096, true)
            .await
            .expect("snapshot should build");

        assert_eq!(payload["source"], "terminal_state");
        assert_eq!(
            payload["transcript"].as_str(),
            Some("status\nplain transcript line\nprompt>")
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn build_terminal_restore_snapshot_keeps_history_and_utf8_boundaries_under_budget() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-restore").await;
        state
            .emit_terminal_text(&session.id, "emoji: 🙂🙂🙂🙂🙂")
            .await;

        let restored = build_terminal_restore_snapshot(&state, &session)
            .await
            .expect("restore snapshot should build")
            .expect("restore snapshot should exist");

        let rendered = restored.render_bytes(96);
        assert!(rendered.len() <= 96);
        let rendered_text = String::from_utf8_lossy(&rendered);
        assert!(rendered_text.contains("emoji:"));

        let current = state
            .current_terminal_restore_snapshot(&session.id)
            .await
            .expect("live restore snapshot should exist");

        assert_eq!(restored.sequence, current.sequence);
        assert_eq!(restored.cols, current.cols);
        assert_eq!(restored.rows, current.rows);
        assert_eq!(restored.has_output, current.has_output);
        assert_eq!(restored.history, current.history);
        assert_eq!(restored.screen, current.screen);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_snapshot_route_exposes_benchmark_headers() {
        let (state, root) = build_test_state().await;
        let session = seed_live_terminal_session(&state, "session-http").await;

        let response = router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/sessions/{}/terminal/snapshot?lines=200&live=1",
                        session.id
                    ))
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_SOURCE_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("terminal_state")
        );
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_LIVE_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert_eq!(
            response
                .headers()
                .get(TERMINAL_SNAPSHOT_RESTORED_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("true")
        );
        assert!(response
            .headers()
            .get(HeaderName::from_static(SERVER_TIMING_HEADER))
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .contains("terminal_snapshot;dur="));

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_token_response_exposes_backend_ttyd_proxy_urls() {
        let _guard = crate::routes::TEST_ENV_LOCK.lock().await;
        let (state, root) = build_test_state().await;
        let mut session = SessionRecord::builder(
            "session-ttyd-token".to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate ttyd token metadata".to_string(),
        )
        .build();
        session.metadata.insert(
            RUNTIME_MODE_METADATA_KEY.to_string(),
            TTYD_RUNTIME_MODE.to_string(),
        );
        session.metadata.insert(
            TTYD_WS_URL_METADATA_KEY.to_string(),
            "ws://127.0.0.1:41000/ws".to_string(),
        );
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());
        state.config.write().await.access.require_auth = true;

        let response = build_terminal_token_response(
            state.clone(),
            session.id.clone(),
            TerminalTokenScope::Control,
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("token response body should read");
        let payload: Value =
            serde_json::from_slice(&body).expect("token response should be valid json");

        let token = payload["token"]
            .as_str()
            .expect("token should be included in ttyd token response");
        assert_eq!(
            payload["ttydHttpUrl"],
            Value::String(format!(
                "/api/sessions/{}/terminal/ttyd?token={token}",
                session.id
            ))
        );
        assert_eq!(
            payload["ttydWsUrl"],
            Value::String(format!(
                "/api/sessions/{}/terminal/ttyd/ws?token={token}",
                session.id
            ))
        );
        assert!(payload.get("token").is_some());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn ttyd_frontend_token_route_returns_empty_token_for_ttyd_sessions() {
        let (state, root) = build_test_state().await;
        let mut session = SessionRecord::builder(
            "session-ttyd-frontend-token".to_string(),
            "demo".to_string(),
            "codex".to_string(),
            "Validate ttyd frontend token route".to_string(),
        )
        .build();
        session.metadata.insert(
            RUNTIME_MODE_METADATA_KEY.to_string(),
            TTYD_RUNTIME_MODE.to_string(),
        );
        session.metadata.insert(
            TTYD_WS_URL_METADATA_KEY.to_string(),
            "ws://127.0.0.1:41001/ws".to_string(),
        );
        state
            .sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());

        let response =
            terminal_ttyd_frontend_token(State(state.clone()), Path(session.id.clone())).await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("frontend token body should read");
        let payload: Value =
            serde_json::from_slice(&body).expect("frontend token response should be valid json");
        assert_eq!(payload["token"], Value::String(String::new()));

        let _ = std::fs::remove_dir_all(root);
    }
}
