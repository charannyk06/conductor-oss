use anyhow::{anyhow, Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, COOKIE, SEC_WEBSOCKET_PROTOCOL, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path as StdPath, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use url::Host;

use crate::routes::config::access_control_enabled;
use crate::routes::ttyd_protocol;
use crate::state::{
    sanitize_terminal_text, trim_lines_tail, AppState, SessionRecord, TerminalRestoreSnapshot,
    DETACHED_LOG_PATH_METADATA_KEY, RUNTIME_MODE_METADATA_KEY, TERMINAL_RESTORE_SNAPSHOT_FORMAT,
    TTYD_PID_METADATA_KEY, TTYD_RUNTIME_MODE, TTYD_TUNNEL_URL_METADATA_KEY,
    TTYD_WS_URL_METADATA_KEY,
};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<sha2::Sha256>;

const DEFAULT_TERMINAL_SNAPSHOT_LINES: usize = 10_000;
const MAX_TERMINAL_SNAPSHOT_LINES: usize = 12000;
const MAX_TERMINAL_LOG_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const TERMINAL_SNAPSHOT_MAX_BYTES: usize = 2 * 1024 * 1024;
const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_TERMINAL_SESSION_SECRET";
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 300;
const SERVER_TIMING_HEADER: &str = "server-timing";
const TERMINAL_SNAPSHOT_SOURCE_HEADER: &str = "x-conductor-terminal-snapshot-source";
const TERMINAL_SNAPSHOT_LIVE_HEADER: &str = "x-conductor-terminal-snapshot-live";
const TERMINAL_SNAPSHOT_RESTORED_HEADER: &str = "x-conductor-terminal-snapshot-restored";
const TERMINAL_SNAPSHOT_FORMAT_HEADER: &str = "x-conductor-terminal-snapshot-format";
static PROCESS_TERMINAL_TOKEN_SECRET: LazyLock<String> =
    LazyLock::new(|| uuid::Uuid::new_v4().to_string());

/// HttpOnly cookie carrying the HMAC terminal token (avoids `?token=` in URLs and logs).
const TERMINAL_AUTH_COOKIE_NAME: &str = "conductor_ttyd_auth";

fn terminal_token_in_query_enabled() -> bool {
    std::env::var("CONDUCTOR_TERMINAL_TOKEN_IN_QUERY")
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn terminal_auth_cookie_encoded(token: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token.as_bytes())
}

fn terminal_auth_token_from_cookie(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed.as_bytes()) {
        if let Ok(text) = String::from_utf8(bytes) {
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    Some(trimmed.to_string())
}

fn parse_cookie_value<'a>(cookies: &'a str, name: &str) -> Option<&'a str> {
    for part in cookies.split(';') {
        let part = part.trim();
        let (key, value) = part.split_once('=')?;
        if key.trim() == name {
            return Some(value.trim());
        }
    }
    None
}

fn bearer_authorization_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let rest = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn resolve_terminal_auth_token(headers: &HeaderMap, query_token: Option<&str>) -> Option<String> {
    if let Some(token) = query_token.map(str::trim).filter(|value| !value.is_empty()) {
        return Some(token.to_string());
    }
    if let Some(token) = bearer_authorization_token(headers) {
        return Some(token);
    }
    let cookie_header = headers.get(COOKIE)?.to_str().ok()?;
    let raw = parse_cookie_value(cookie_header, TERMINAL_AUTH_COOKIE_NAME)?;
    terminal_auth_token_from_cookie(raw)
}

fn request_expects_secure_cookie(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

fn push_terminal_auth_set_cookie(
    response_headers: &mut HeaderMap,
    request_headers: &HeaderMap,
    session_id: &str,
    token: &str,
) {
    let value = terminal_auth_cookie_encoded(token);
    let path = format!("/api/sessions/{session_id}/terminal");
    let mut parts = vec![
        format!("{TERMINAL_AUTH_COOKIE_NAME}={value}"),
        format!("Path={path}"),
        "HttpOnly".to_string(),
        "SameSite=Lax".to_string(),
        format!("Max-Age={TERMINAL_TOKEN_TTL_SECONDS}"),
    ];
    if request_expects_secure_cookie(request_headers) {
        parts.push("Secure".to_string());
    }
    let joined = parts.join("; ");
    if let Ok(header_value) = HeaderValue::from_str(&joined) {
        response_headers.append(SET_COOKIE, header_value);
    }
}

/// HTTP client for fetching ttyd's bundled HTML from the local ttyd process only.
static TTYD_UPSTREAM_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(4)
        .build()
        .expect("TTYD_UPSTREAM_CLIENT")
});

/// ttyd HTML is small; cap memory use if metadata were wrong or upstream misbehaves.
const MAX_TTYD_HTML_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// Max binary/text WebSocket frame from the browser terminal facade (DoS guard).
const MAX_TTYD_BROWSER_WS_FRAME_BYTES: usize = 512 * 1024;
/// Max bytes accepted from `/api/sessions/:id/keys` and similar inject paths.
const MAX_TERMINAL_KEYS_PAYLOAD_BYTES: usize = 65_536;
/// Max raw input chunk forwarded to the PTY per WebSocket message.
const MAX_TTYD_INPUT_CHUNK_BYTES: usize = 256 * 1024;
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

html.conductor-ttyd-touch-shim-enabled *,
html.conductor-ttyd-touch-shim-enabled *::before,
html.conductor-ttyd-touch-shim-enabled *::after {
    box-sizing: border-box;
}

html.conductor-ttyd-touch-shim-enabled #terminal-container {
    height: 100%;
    min-height: 0;
    overflow: hidden;
}

html.conductor-ttyd-touch-shim-enabled #terminal-container .terminal {
    height: 100% !important;
    min-height: 0;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom)) !important;
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

    let scrollHost = null;
    let followBottom = true;
    let lastStableScrollTop = 0;
    let active = false;
    let lastX = 0;
    let lastY = 0;
    let touchStartAt = 0;
    let touchMoved = false;
    const LONG_PRESS_THRESHOLD_MS = 300;

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
        const activeMode = typeof forceActive === 'boolean' ? forceActive : isMouseProtocolActive();
        document.documentElement.classList.toggle('conductor-ttyd-wheel-mode', activeMode);
        return activeMode;
    };

    const stickToBottomIfNeeded = () => {
        if (!scrollHost) {
            return;
        }

        if (followBottom) {
            scrollHost.scrollTop = scrollHost.scrollHeight;
            lastStableScrollTop = scrollHost.scrollTop;
            return;
        }

        // When the user is reading scrollback, do not clamp scroll on every mutation.
        // xterm updates the DOM on each keystroke/echo; forcing scrollTop to a stale
        // value fights the renderer and causes jitter or broken input after idle.
    };

    const bindTouchScroll = () => {
    const terminalRoot = document.querySelector('.xterm');
    const nextScrollHost = document.querySelector('.xterm-viewport')
        || document.querySelector('.xterm-scrollable-element');
    if (!terminalRoot) {
        return false;
    }
    if (terminalRoot.dataset.conductorTouchShimBound === 'true') {
        return false;
    }
    if (!nextScrollHost) {
        return false;
    }

    terminalRoot.dataset.conductorTouchShimBound = 'true';
    scrollHost = nextScrollHost;

    const reset = () => {
      active = false;
    };

    const isScrollHostAtBottom = () =>
        scrollHost.scrollHeight - scrollHost.clientHeight - scrollHost.scrollTop <= 1;

    const syncFollowBottom = () => {
        followBottom = isScrollHostAtBottom();
        lastStableScrollTop = scrollHost.scrollTop;
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

            // xterm already handles touch scrolling when mouse reporting is off.
            // When mouse reporting is on (OpenCode), we need to translate touch to wheel.
            // Either way, if viewport scrolling fails, fall back to direct scroll.
            const mouseModeActive = syncTouchActionMode();

            if (event.cancelable) {
                event.preventDefault();
            }

            followBottom = false;
            lastStableScrollTop = scrollHost.scrollTop;

            // OpenCode enables xterm mouse reporting, which disables xterm's built-in
            // touchmove scrolling. Translate the drag into xterm's internal wheel mouse
            // reports so OpenCode receives real scroll input for its own panes.
            if (mouseModeActive) {
                if (!dispatchCoreMouseWheel(deltaY, touch.clientX, touch.clientY)) {
                    if (!dispatchTerminalWheel(deltaX, deltaY, touch.clientX, touch.clientY)) {
                        const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
                        scrollHost.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollHost.scrollTop + deltaY));
                    }
                }
            } else {
                const maxScrollTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
                scrollHost.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollHost.scrollTop + deltaY));
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

    let mutationFlushScheduled = false;
    const flushMutations = () => {
        mutationFlushScheduled = false;
        bindTouchScroll();
        stickToBottomIfNeeded();
        syncTouchActionMode();
    };
    const scheduleMutationFlush = () => {
        if (mutationFlushScheduled) return;
        mutationFlushScheduled = true;
        requestAnimationFrame(flushMutations);
    };
    const observer = new MutationObserver(() => scheduleMutationFlush());
    bindTouchScroll();
    syncTouchActionMode();
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
})();
</script>
"#;

const TTYD_RESIZE_SHIM_MARKER: &str = "conductor-ttyd-resize-shim";
const TTYD_RESIZE_SHIM: &str = r#"
<!-- conductor-ttyd-resize-shim -->
<script>
(() => {
    if (window.__conductorTtydResizeShimInstalled) return;
    window.__conductorTtydResizeShimInstalled = true;

    let lastWidth = -1;
    let lastHeight = -1;
    let lastDevicePixelRatio = -1;
    const burstTimers = new Set();

    const clearBurstTimers = () => {
        for (const timer of burstTimers) {
            window.clearTimeout(timer);
        }
        burstTimers.clear();
    };

    const findXtermScrollHost = () => document.querySelector('.xterm-viewport')
        || document.querySelector('.xterm-scrollable-element');

    const dispatchResize = () => {
        const scrollHost = findXtermScrollHost();
        if (!scrollHost) {
            window.dispatchEvent(new Event('resize'));
            return;
        }

        const maxScroll = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
        const atBottom = maxScroll <= 0 || maxScroll - scrollHost.scrollTop < 12;
        const scrollRatio = maxScroll > 0 ? scrollHost.scrollTop / maxScroll : 1;

        window.dispatchEvent(new Event('resize'));

        const restore = () => {
            const sh = findXtermScrollHost();
            if (!sh) return;
            const newMax = Math.max(0, sh.scrollHeight - sh.clientHeight);
            if (newMax <= 0) return;
            if (atBottom) {
                sh.scrollTop = newMax;
            } else {
                sh.scrollTop = Math.round(scrollRatio * newMax);
            }
        };
        requestAnimationFrame(() => {
            requestAnimationFrame(restore);
        });
    };

    const scheduleResizeBurst = () => {
        clearBurstTimers();
        if (typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(dispatchResize);
        } else {
            dispatchResize();
        }

        burstTimers.add(window.setTimeout(dispatchResize, 120));
        burstTimers.add(window.setTimeout(dispatchResize, 360));
    };

    const syncViewportSize = () => {
        const width = Math.max(0, Math.round(window.innerWidth || 0));
        const height = Math.max(0, Math.round(window.innerHeight || 0));
        const devicePixelRatio = window.devicePixelRatio || 1;

        // Guard: skip if viewport has collapsed to near-zero (tab switch, minimize).
        // Fitting xterm to zero causes content layout to break.
        if (width < 10 || height < 10) return;

        if (
            width === lastWidth
            && height === lastHeight
            && devicePixelRatio === lastDevicePixelRatio
        ) {
            return;
        }

        lastWidth = width;
        lastHeight = height;
        lastDevicePixelRatio = devicePixelRatio;
        scheduleResizeBurst();
    };

    const observeTarget = document.documentElement || document.body;
    const observer = typeof ResizeObserver === 'function' && observeTarget
        ? new ResizeObserver(syncViewportSize)
        : null;

    if (observer) {
        observer.observe(observeTarget);
        if (document.body && document.body !== observeTarget) {
            observer.observe(document.body);
        }
    }

    window.addEventListener('resize', syncViewportSize);
    window.addEventListener('orientationchange', syncViewportSize);
    window.addEventListener('pageshow', scheduleResizeBurst);
    window.addEventListener('focus', scheduleResizeBurst);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleResizeBurst();
        }
    });

    if (document.fonts?.ready) {
        void document.fonts.ready
            .then(() => {
                scheduleResizeBurst();
            })
            .catch(() => {});
    }

    window.addEventListener('message', (event) => {
        if (!event || !event.data) return;
        if (event.data.type !== 'conductor-terminal-resize') return;
        scheduleResizeBurst();
    }, false);

    syncViewportSize();
    scheduleResizeBurst();

    window.addEventListener('beforeunload', () => {
        clearBurstTimers();
        observer?.disconnect();
    }, { once: true });
})();
</script>
"#;

const TTYD_AUTH_SYNC_SHIM_MARKER: &str = "conductor-ttyd-auth-sync-shim";
const TTYD_AUTH_SYNC_SHIM: &str = r#"
<!-- conductor-ttyd-auth-sync-shim -->
<script>
(() => {
    if (window.__conductorTtydAuthSyncShimInstalled) return;
    window.__conductorTtydAuthSyncShimInstalled = true;

    const LEGACY_STORAGE_KEY = 'conductor.ttyd.token';
    const MESSAGE_TYPE = 'conductor-ttyd-auth-token';
    const REQUEST_MESSAGE_TYPE = 'conductor-ttyd-auth-token-request';
    const READY_MESSAGE_TYPE = 'conductor-ttyd-ready';
    const TOKEN_REQUEST_THROTTLE_MS = 1500;
    const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

    const sessionIdFromPath = () => {
        try {
            const m = window.location.pathname.match(/\/api\/sessions\/([^/]+)\/terminal\/ttyd/);
            return m ? m[1] : '';
        } catch {
            return '';
        }
    };

    const storageKey = () => {
        const sid = sessionIdFromPath();
        return sid ? `conductor.ttyd.token.v2:${sid}` : 'conductor.ttyd.token.v2:unknown';
    };

    const readLocationBridgeId = () => {
        try {
            return new URL(window.location.href).searchParams.get('bridgeId')?.trim() || '';
        } catch {
            return '';
        }
    };

    const resolveProxyWebSocketUrl = () => {
        const url = new URL(window.location.href);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.hash = '';

        // Use the Conductor backend origin injected into the page (if available).
        // This ensures the WebSocket connects directly to the Rust backend's
        // /api/sessions/:id/terminal/ttyd/ws handler rather than through the
        // Next.js dashboard proxy, which cannot forward WebSocket upgrade requests.
        try {
            const backendMeta = document.querySelector('meta[name="conductor-backend-url"]');
            const backendContent = (backendMeta && backendMeta.content || '').trim();
            if (backendContent) {
                const b = new URL(backendContent);
                url.hostname = b.hostname;
                url.port = b.port;
                url.protocol = b.protocol === 'https:' ? 'wss:' : 'ws:';
            }
        } catch {}

        const normalizedPathname = window.location.pathname.replace(/\/+$/, '');
        url.pathname = normalizedPathname.endsWith('/ws')
            ? normalizedPathname
            : `${normalizedPathname}/ws`;
        return url;
    };

    const readStoredToken = () => {
        try {
            const key = storageKey();
            const scoped = window.localStorage.getItem(key)?.trim() || '';
            if (scoped) {
                return scoped;
            }
            const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY)?.trim() || '';
            return legacy;
        } catch {
            return '';
        }
    };

    let currentToken = '';
    let lastTokenRequestAt = 0;
    let unloading = false;
    const setToken = (value) => {
        const token = typeof value === 'string' ? value.trim() : '';
        currentToken = token;

        try {
            const key = storageKey();
            if (token) {
                window.localStorage.setItem(key, token);
            } else {
                window.localStorage.removeItem(key);
            }
        } catch {
        }
    };

    const notifyReady = () => {
        if (unloading || !window.parent || window.parent === window) {
            return;
        }

        try {
            window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*');
        } catch {
        }
    };

    const requestFreshToken = (reason) => {
        if (unloading || !window.parent || window.parent === window) {
            return;
        }

        const now = Date.now();
        if (now - lastTokenRequestAt < TOKEN_REQUEST_THROTTLE_MS) {
            return;
        }
        lastTokenRequestAt = now;

        try {
            window.parent.postMessage({
                type: REQUEST_MESSAGE_TYPE,
                reason,
            }, '*');
        } catch {
        }
    };

    const normalizeWebSocketUrl = (value) => {
        const token = currentToken || readStoredToken();
        const bridgeId = readLocationBridgeId();

        try {
            const candidate = new URL(value, window.location.href);
            const shouldRewriteToProxy =
                LOOPBACK_HOSTS.has(candidate.hostname)
                || candidate.pathname === '/'
                || candidate.pathname === '/ws'
                || candidate.pathname.endsWith('/ws');
            const url = shouldRewriteToProxy ? resolveProxyWebSocketUrl() : candidate;
            if (token) {
                url.searchParams.set('token', token);
            }
            if (bridgeId) {
                url.searchParams.set('bridgeId', bridgeId);
            }
            return url.toString();
        } catch {
            return value;
        }
    };

    const attachSocketListeners = (socket) => {
        if (!socket || socket.__conductorTokenRefreshHookAttached) {
            return socket;
        }

        socket.__conductorTokenRefreshHookAttached = true;
        socket.addEventListener('open', () => {
            notifyReady();
        });
        socket.addEventListener('close', () => {
            requestFreshToken('websocket-close');
        });
        socket.addEventListener('error', () => {
            requestFreshToken('websocket-error');
        });
        return socket;
    };

    const nativeWebSocket = window.WebSocket;
    if (typeof nativeWebSocket === 'function' && !window.__conductorTtydWebSocketPatched) {
        const patchedWebSocket = function(url, protocols) {
            const normalizedUrl = normalizeWebSocketUrl(String(url));
            if (arguments.length > 1) {
                return attachSocketListeners(new nativeWebSocket(normalizedUrl, protocols));
            }
            return attachSocketListeners(new nativeWebSocket(normalizedUrl));
        };

        Object.setPrototypeOf(patchedWebSocket, nativeWebSocket);
        patchedWebSocket.prototype = nativeWebSocket.prototype;
        window.WebSocket = patchedWebSocket;
        window.__conductorTtydWebSocketPatched = true;
    }

    const initialToken = (() => {
        try {
            return new URL(window.location.href).searchParams.get('token')?.trim() || '';
        } catch {
            return '';
        }
    })();

    if (initialToken) {
        setToken(initialToken);
    } else {
        const storedToken = readStoredToken();
        if (storedToken) {
            setToken(storedToken);
        }
    }

    const handleMessage = (event) => {
        if (event.source !== window.parent) {
            return;
        }

        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== MESSAGE_TYPE) {
            return;
        }

        if (typeof data.token === 'string') {
            setToken(data.token);
        }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('beforeunload', () => {
        unloading = true;
        window.removeEventListener('message', handleMessage);
    }, { once: true });
})();
</script>
"#;

fn ttyd_paste_shim_script(project_id: &str, session_id: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let project_id_lit = serde_json::to_string(project_id).unwrap_or_else(|_| "\"\"".to_string());
    let session_id_lit = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".to_string());
    let script = format!(
        r#"<!-- conductor-ttyd-paste-shim -->
<script>
(function() {{
    if (window.__conductorTtydPasteShimInstalled) return;
    window.__conductorTtydPasteShimInstalled = true;

    const PROJECT_ID = {project_id_lit};
    const SESSION_ID = {session_id_lit};
    const TIMESTAMP = {timestamp};

    async function uploadImage(blob) {{
        const formData = new FormData();
        formData.append('projectId', PROJECT_ID);
        formData.append('taskRef', SESSION_ID);
        formData.append('files', blob, 'clipboard-' + TIMESTAMP + '.png');
        
        try {{
            const response = await fetch('/api/attachments', {{
                method: 'POST',
                body: formData,
            }});
            if (response.ok) {{
                const data = await response.json();
                const path = data.files?.[0]?.path || data.path || data.absolutePath;
                if (path && window.term) {{
                    window.term.write('\r\n[pasted image: ' + path + ']\r\n');
                }}
            }}
        }} catch (e) {{
            // Silently ignore upload failures
        }}
    }}

    async function uploadDroppedFiles(files) {{
        const formData = new FormData();
        formData.append('projectId', PROJECT_ID);
        formData.append('taskRef', SESSION_ID);
        files.forEach((file, index) => {{
            const fileName = file && file.name && file.name.trim().length > 0
                ? file.name
                : 'drop-' + TIMESTAMP + '-' + index + '.bin';
            formData.append('files', file, fileName);
        }});

        try {{
            const response = await fetch('/api/attachments', {{
                method: 'POST',
                body: formData,
            }});
            if (response.ok) {{
                const data = await response.json();
                const entries = Array.isArray(data.files) ? data.files : [];
                for (const entry of entries) {{
                    const path = entry.path || entry.absolutePath || data.path || data.absolutePath;
                    if (path && window.term) {{
                        window.term.write('\r\n[attached file: ' + path + ']\r\n');
                    }}
                }}
            }}
        }} catch (e) {{
            // Silently ignore upload failures
        }}
    }}

    function extractImageFromClipboard(clipboardData) {{
        if (!clipboardData.items) return null;
        for (let i = 0; i < clipboardData.items.length; i++) {{
            const item = clipboardData.items[i];
            if (item.type.startsWith('image/')) {{
                return item.getAsFile();
            }}
        }}
        if (!clipboardData.files || clipboardData.files.length === 0) return null;
        for (let i = 0; i < clipboardData.files.length; i++) {{
            const file = clipboardData.files[i];
            if (file.type.startsWith('image/')) {{
                return file;
            }}
        }}
        return null;
    }}

    function extractFilesFromTransfer(transfer) {{
        if (transfer && transfer.files && transfer.files.length > 0) {{
            return Array.from(transfer.files);
        }}
        if (!transfer || !transfer.items || transfer.items.length === 0) return [];
        const files = [];
        for (let i = 0; i < transfer.items.length; i++) {{
            const item = transfer.items[i];
            if (item.kind !== 'file') continue;
            const file = item.getAsFile();
            if (file) {{
                files.push(file);
            }}
        }}
        return files;
    }}

    document.addEventListener('paste', async function(event) {{
        if (!event.clipboardData) return;
        
        const imageBlob = extractImageFromClipboard(event.clipboardData);
        if (imageBlob) {{
            event.preventDefault();
            event.stopPropagation();
            await uploadImage(imageBlob);
        }}
    }}, true);

    document.addEventListener('dragover', function(event) {{
        const files = extractFilesFromTransfer(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        if (event.dataTransfer) {{
            event.dataTransfer.dropEffect = 'copy';
        }}
    }}, true);

    document.addEventListener('drop', async function(event) {{
        const files = extractFilesFromTransfer(event.dataTransfer);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        await uploadDroppedFiles(files);
    }}, true);
}})(document);
</script>"#,
        project_id_lit = project_id_lit,
        session_id_lit = session_id_lit,
        timestamp = timestamp
    );
    script
}

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

/// ttyd is always bound to loopback. Reject anything else so session metadata cannot be turned into SSRF.
fn is_safe_conductor_ttyd_upstream_url(url: &reqwest::Url) -> bool {
    if !url.username().is_empty() {
        return false;
    }
    if url.password().is_some_and(|password| !password.is_empty()) {
        return false;
    }

    let scheme = url.scheme();
    if !matches!(scheme, "ws" | "wss" | "http" | "https") {
        return false;
    }

    let Some(host) = url.host() else {
        return false;
    };

    match host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
    }
}

fn ttyd_http_url_from_ws_url(ws_url: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(ws_url).ok()?;
    if !is_safe_conductor_ttyd_upstream_url(&url) {
        return None;
    }
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
    if !is_safe_conductor_ttyd_upstream_url(&url) {
        return None;
    }
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
    ttyd_session_ws_url(session).is_some()
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

const TTYD_PASTE_SHIM_MARKER: &str = "conductor-ttyd-paste-shim";

fn inject_ttyd_html_fragment(html: &str, marker: &str, fragment: &str) -> String {
    if html.contains(marker) {
        return html.to_string();
    }

    if let Some(index) = html.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + fragment.len());
        output.push_str(&html[..index]);
        output.push_str(fragment);
        output.push_str(&html[index..]);
        return output;
    }

    if let Some(index) = html.rfind("</html>") {
        let mut output = String::with_capacity(html.len() + fragment.len());
        output.push_str(&html[..index]);
        output.push_str(fragment);
        output.push_str(&html[index..]);
        return output;
    }

    let mut output = String::with_capacity(html.len() + fragment.len());
    output.push_str(html);
    output.push_str(fragment);
    output
}

fn inject_ttyd_html_fragment_early(html: &str, marker: &str, fragment: &str) -> String {
    if html.contains(marker) {
        return html.to_string();
    }

    if let Some(head_start) = html.find("<head") {
        if let Some(head_end) = html[head_start..].find('>') {
            let insert_at = head_start + head_end + 1;
            let mut output = String::with_capacity(html.len() + fragment.len());
            output.push_str(&html[..insert_at]);
            output.push_str(fragment);
            output.push_str(&html[insert_at..]);
            return output;
        }
    }

    if let Some(script_start) = html.find("<script") {
        let mut output = String::with_capacity(html.len() + fragment.len());
        output.push_str(&html[..script_start]);
        output.push_str(fragment);
        output.push_str(&html[script_start..]);
        return output;
    }

    inject_ttyd_html_fragment(html, marker, fragment)
}

fn inject_ttyd_resize_shim(html: &str) -> String {
    inject_ttyd_html_fragment(html, TTYD_RESIZE_SHIM_MARKER, TTYD_RESIZE_SHIM)
}

fn inject_ttyd_auth_sync_shim(html: &str) -> String {
    inject_ttyd_html_fragment_early(html, TTYD_AUTH_SYNC_SHIM_MARKER, TTYD_AUTH_SYNC_SHIM)
}

fn inject_ttyd_paste_shim(html: &str, project_id: &str, session_id: &str) -> String {
    let paste_shim = ttyd_paste_shim_script(project_id, session_id);
    inject_ttyd_html_fragment(html, TTYD_PASTE_SHIM_MARKER, &paste_shim)
}

const TTYD_BACKEND_URL_META_MARKER: &str = "conductor-ttyd-backend-url-meta";

/// Inject a `<meta name="conductor-backend-url">` tag so the auth-sync shim can
/// route WebSocket connections directly to the Rust backend rather than through
/// the Next.js dashboard proxy, which cannot forward WebSocket upgrade requests.
fn inject_conductor_backend_url_meta(html: &str, backend_origin: &str) -> String {
    if html.contains(TTYD_BACKEND_URL_META_MARKER) {
        return html.to_string();
    }
    let escaped = backend_origin.replace('"', "&quot;");
    let meta = format!(
        "<!-- {TTYD_BACKEND_URL_META_MARKER} --><meta name=\"conductor-backend-url\" content=\"{escaped}\">"
    );
    // Inject before </head> so the tag is parsed before any script runs.
    if let Some(idx) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + meta.len() + 1);
        out.push_str(&html[..idx]);
        out.push_str(&meta);
        out.push_str(&html[idx..]);
        return out;
    }
    // No </head> found — try after <head>.
    if let Some(idx) = html.find("<head>") {
        let end = idx + "<head>".len();
        let mut out = String::with_capacity(html.len() + meta.len() + 1);
        out.push_str(&html[..end]);
        out.push_str(&meta);
        out.push_str(&html[end..]);
        return out;
    }
    // No head element at all; skip injection.
    html.to_string()
}

/// Derive the backend's own HTTP origin from the request's Host header.
///
/// When Next.js proxies to the Rust backend it strips the incoming Host header
/// and the HTTP client sets `Host: <backend-ip>:<port>` based on the target URL.
/// Loopback addresses always use `http://`; others follow `x-forwarded-proto`.
fn backend_origin_from_headers(headers: &HeaderMap) -> String {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("127.0.0.1");
    let is_loopback = host.starts_with("127.")
        || host.eq_ignore_ascii_case("localhost")
        || host.starts_with("[::1]");
    let proto = if is_loopback {
        "http"
    } else {
        headers
            .get("x-forwarded-proto")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("http")
    };
    format!("{proto}://{host}")
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

fn client_requests_tty_subprotocol(headers: &HeaderMap) -> bool {
    headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|protocol| protocol.eq_ignore_ascii_case("tty"))
        })
        .unwrap_or(false)
}

async fn terminal_ttyd_frontend_websocket(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ws = if client_requests_tty_subprotocol(&headers) {
        ws.protocols(["tty"])
    } else {
        ws
    };
    let Some(_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) = authorize_terminal_access(&state, &id, &headers, query.token.as_deref()).await
    {
        return error(StatusCode::UNAUTHORIZED, err.to_string()).into_response();
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

    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if ttyd_session_ws_url(&session).is_none() {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} is not backed by ttyd"),
        )
        .into_response();
    }

    ws.on_upgrade(move |socket| handle_ttyd_frontend_socket(state, id, socket))
}

async fn terminal_token(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    build_terminal_token_response(state, id, TerminalTokenScope::Control, &headers).await
}

async fn build_terminal_token_response(
    state: Arc<AppState>,
    id: String,
    scope: TerminalTokenScope,
    request_headers: &HeaderMap,
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
            StatusCode::BAD_REQUEST,
            format!("Session {id} does not expose a ttyd terminal"),
        )
        .into_response();
    };
    let embed_token_in_urls = !token_required || terminal_token_in_query_enabled();
    let url_token = if embed_token_in_urls {
        token.as_deref()
    } else {
        None
    };
    let ttyd_http_url = ttyd_frontend_proxy_path(&id, url_token);
    let ttyd_ws_url = ttyd_frontend_proxy_ws_path(&id, url_token);
    let tunnel_url = session.metadata.get(TTYD_TUNNEL_URL_METADATA_KEY).cloned();

    let mut response = Json(json!({
        "token": token,
        "required": token_required,
        "expiresInSeconds": token.as_ref().map(|_| TERMINAL_TOKEN_TTL_SECONDS),
        "ttydHttpUrl": ttyd_http_url,
        "ttydWsUrl": ttyd_ws_url,
        "tunnelUrl": tunnel_url,
    }))
    .into_response();

    if token_required {
        if let Some(token_value) = token.as_ref() {
            push_terminal_auth_set_cookie(
                response.headers_mut(),
                request_headers,
                &id,
                token_value,
            );
        }
    }

    response
}

async fn terminal_ttyd_frontend(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(_session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    if let Err(err) = authorize_terminal_access(&state, &id, &headers, query.token.as_deref()).await
    {
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

    let Some(session) = state.get_session(&id).await else {
        return error(StatusCode::NOT_FOUND, format!("Session {id} not found")).into_response();
    };

    let Some(ttyd_http_url) = ttyd_session_http_url(&session) else {
        return error(
            StatusCode::CONFLICT,
            format!("Session {id} does not expose a ttyd terminal"),
        )
        .into_response();
    };

    let parsed_upstream = match reqwest::Url::parse(&ttyd_http_url) {
        Ok(url) => url,
        Err(err) => {
            tracing::warn!(session_id = %id, error = %err, "Malformed ttyd HTTP URL");
            return error(
                StatusCode::BAD_GATEWAY,
                "Malformed ttyd upstream URL".to_string(),
            )
            .into_response();
        }
    };
    if !is_safe_conductor_ttyd_upstream_url(&parsed_upstream) {
        tracing::error!(session_id = %id, "Rejected ttyd upstream URL (not loopback)");
        return error(
            StatusCode::BAD_GATEWAY,
            "Refusing unsafe ttyd upstream URL".to_string(),
        )
        .into_response();
    }

    let upstream = match TTYD_UPSTREAM_CLIENT.get(parsed_upstream).send().await {
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

    if upstream
        .content_length()
        .is_some_and(|len| len > MAX_TTYD_HTML_RESPONSE_BYTES as u64)
    {
        return error(
            StatusCode::BAD_GATEWAY,
            "ttyd frontend response is too large".to_string(),
        )
        .into_response();
    }

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
    if body.len() > MAX_TTYD_HTML_RESPONSE_BYTES {
        return error(
            StatusCode::BAD_GATEWAY,
            "ttyd frontend response is too large".to_string(),
        )
        .into_response();
    }
    let body = if content_type_is_html(&content_type) {
        let mut html = String::from_utf8_lossy(&body).into_owned();
        // Inject backend origin first so the auth-sync shim can read it at runtime.
        let backend_origin = backend_origin_from_headers(&headers);
        html = inject_conductor_backend_url_meta(&html, &backend_origin);
        html = inject_ttyd_paste_shim(&html, &session.project_id, &id);
        html = inject_ttyd_resize_shim(&html);
        html = inject_ttyd_auth_sync_shim(&html);
        if should_inject_ttyd_mobile_touch_shim(&session) {
            html = inject_ttyd_mobile_touch_shim(&html);
        }
        html.into_bytes()
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

    let access = state.config.read().await.access.clone();
    let token = if should_issue_terminal_token(&access) {
        create_scoped_terminal_token(&id, TerminalTokenScope::Control).unwrap_or_default()
    } else {
        String::new()
    };

    Json(json!({ "token": token })).into_response()
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
    if let Err(err) = state.ensure_session_live(&session_id).await {
        tracing::warn!(session_id = %session_id, error = %err, "failed to ensure ttyd session live before frontend attach");
    }
    let handle = state.ensure_terminal_host(&session_id).await;
    let mut terminal_rx = handle.terminal_tx.subscribe();
    let mut last_sequence_sent = 0_u64;
    let mut client_ready = false;
    let mut paused = false;
    // Buffer recent chunks during pause so we can replay them on resume
    // instead of only sending a potentially stale snapshot.
    let mut pause_buffer: Vec<crate::state::TerminalStreamChunk> = Vec::new();
    const PAUSE_BUFFER_CAPACITY: usize = 256;

    loop {
        tokio::select! {
            client_message = client_socket.recv() => {
                match client_message {
                    Some(Ok(Message::Binary(data))) => {
                        if data.len() > MAX_TTYD_BROWSER_WS_FRAME_BYTES {
                            tracing::warn!(
                                session_id = %session_id,
                                len = data.len(),
                                "ttyd browser WebSocket frame too large"
                            );
                            break;
                        }
                        if handle_ttyd_frontend_client_message(
                            &state,
                            &handle,
                            &session_id,
                            &mut client_socket,
                            &mut client_ready,
                            &mut last_sequence_sent,
                            &mut paused,
                            &mut pause_buffer,
                            ttyd_protocol::ClientMessage::from_websocket_frame(&data),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text.len() > MAX_TTYD_BROWSER_WS_FRAME_BYTES {
                            tracing::warn!(
                                session_id = %session_id,
                                len = text.len(),
                                "ttyd browser WebSocket text frame too large"
                            );
                            break;
                        }
                        if handle_ttyd_frontend_client_message(
                            &state,
                            &handle,
                            &session_id,
                            &mut client_socket,
                            &mut client_ready,
                            &mut last_sequence_sent,
                            &mut paused,
                            &mut pause_buffer,
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
                        if paused {
                            // Buffer recent chunks during pause instead of
                            // dropping them. On resume, we replay the buffer
                            // before sending the snapshot for a smooth transition.
                            if pause_buffer.len() >= PAUSE_BUFFER_CAPACITY {
                                pause_buffer.remove(0);
                            }
                            pause_buffer.push(chunk);
                            continue;
                        }
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
                        if paused {
                            continue;
                        }
                        let bytes = render_current_restore_snapshot_bytes(
                            &state,
                            &session_id,
                            &mut last_sequence_sent,
                        )
                        .await;
                        if !bytes.is_empty()
                            && client_socket.send(Message::Binary(ttyd_protocol::encode_output(&bytes).into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

fn render_restore_snapshot_bytes(
    snapshot: &TerminalRestoreSnapshot,
    last_sequence_sent: &mut u64,
) -> Vec<u8> {
    *last_sequence_sent = snapshot.sequence;
    snapshot.render_restore_bytes(TERMINAL_SNAPSHOT_MAX_BYTES)
}

async fn render_current_restore_snapshot_bytes(
    state: &Arc<AppState>,
    session_id: &str,
    last_sequence_sent: &mut u64,
) -> Vec<u8> {
    state
        .current_terminal_restore_snapshot(session_id)
        .await
        .map(|snapshot| render_restore_snapshot_bytes(&snapshot, last_sequence_sent))
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
async fn handle_ttyd_frontend_client_message(
    state: &Arc<AppState>,
    handle: &Arc<crate::state::LiveSessionHandle>,
    session_id: &str,
    client_socket: &mut WebSocket,
    client_ready: &mut bool,
    last_sequence_sent: &mut u64,
    paused: &mut bool,
    pause_buffer: &mut Vec<crate::state::TerminalStreamChunk>,
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
            // Always pull a fresh restore snapshot at handshake time. The browser can
            // attach slightly after the socket opens, and output may arrive during
            // that gap. Re-reading the durable terminal state here keeps reconnects
            // lossless and mirrors Cabinet's "rehydrate from retained session state"
            // behavior without replaying the whole raw stream.
            let bytes =
                render_current_restore_snapshot_bytes(state, session_id, last_sequence_sent).await;
            if !bytes.is_empty() {
                client_socket
                    .send(Message::Binary(ttyd_protocol::encode_output(&bytes).into()))
                    .await?;
            }
        }
        Some(ttyd_protocol::ClientMessage::Input(mut data)) => {
            if data.len() > MAX_TTYD_INPUT_CHUNK_BYTES {
                data.truncate(MAX_TTYD_INPUT_CHUNK_BYTES);
            }
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Err(error_message) = send_terminal_input_with_recovery(
                state,
                handle,
                session_id,
                conductor_executors::executor::ExecutorInput::Raw(text),
            )
            .await
            {
                let message = format!("\r\n[Conductor] {error_message}\r\n");
                let _ = client_socket
                    .send(Message::Binary(
                        ttyd_protocol::encode_output(message.as_bytes()).into(),
                    ))
                    .await;
            }
        }
        Some(ttyd_protocol::ClientMessage::Resize { columns, rows }) => {
            let _ = state.resize_live_terminal(session_id, columns, rows).await;
        }
        Some(ttyd_protocol::ClientMessage::Pause) => {
            *paused = true;
        }
        Some(ttyd_protocol::ClientMessage::Resume) if *paused => {
            *paused = false;
            // Replay buffered chunks collected during pause, skipping any
            // with stale sequence numbers.
            for chunk in pause_buffer.drain(..) {
                if chunk.sequence <= *last_sequence_sent {
                    continue;
                }
                *last_sequence_sent = chunk.sequence;
                client_socket
                    .send(Message::Binary(
                        ttyd_protocol::encode_output(&chunk.bytes).into(),
                    ))
                    .await?;
            }
            // Send the current snapshot as the authoritative terminal state.
            // The snapshot includes all output up to this point, so it
            // provides a smooth transition from the pause gap.
            let bytes =
                render_current_restore_snapshot_bytes(state, session_id, last_sequence_sent).await;
            if !bytes.is_empty() {
                client_socket
                    .send(Message::Binary(ttyd_protocol::encode_output(&bytes).into()))
                    .await?;
            }
        }
        Some(ttyd_protocol::ClientMessage::Resume) => {}
        None => {}
    }

    Ok(())
}

async fn send_terminal_input_with_recovery(
    state: &Arc<AppState>,
    handle: &Arc<crate::state::LiveSessionHandle>,
    session_id: &str,
    input: conductor_executors::executor::ExecutorInput,
) -> std::result::Result<(), String> {
    for attempt in 0..2 {
        if let Some(input_tx) = handle.input_tx.read().await.clone() {
            match input_tx.send(input.clone()).await {
                Ok(()) => return Ok(()),
                Err(err) => {
                    tracing::warn!(
                        session_id = %session_id,
                        attempt,
                        error = %err,
                        "terminal input channel closed, attempting recovery"
                    );
                }
            }
        } else {
            tracing::warn!(
                session_id = %session_id,
                attempt,
                "terminal input channel missing, attempting recovery"
            );
        }

        match state.ensure_session_live(session_id).await {
            Ok(true) => continue,
            Ok(false) => {
                return Err("Terminal is not running. Please reload the terminal.".to_string())
            }
            Err(err) => {
                tracing::warn!(
                    session_id = %session_id,
                    attempt,
                    error = %err,
                    "failed to recover terminal input channel"
                );
                return Err(
                    "Terminal input channel closed. Please reload the terminal.".to_string()
                );
            }
        }
    }

    Err("Terminal input channel closed. Please reload the terminal.".to_string())
}

fn parse_handshake_dimensions(value: &Value) -> Option<(u16, u16)> {
    let columns = u16::try_from(value.get("columns")?.as_u64()?).ok()?;
    let rows = u16::try_from(value.get("rows")?.as_u64()?).ok()?;
    if !(1..=ttyd_protocol::MAX_TERMINAL_COLUMNS).contains(&columns)
        || !(1..=ttyd_protocol::MAX_TERMINAL_ROWS).contains(&rows)
    {
        return None;
    }
    Some((columns, rows))
}

pub(crate) fn resolve_terminal_keys(
    keys: Option<String>,
    special: Option<String>,
) -> Result<String> {
    if let Some(keys) = keys {
        if keys.len() > MAX_TERMINAL_KEYS_PAYLOAD_BYTES {
            return Err(anyhow!(
                "keys payload exceeds {} bytes",
                MAX_TERMINAL_KEYS_PAYLOAD_BYTES
            ));
        }
        return Ok(keys);
    }

    let special = special.ok_or_else(|| anyhow!("keys or special is required"))?;
    let mapped = match special.as_str() {
        "Enter" => "\r".to_string(),
        "Tab" => "\t".to_string(),
        "Backspace" => "\u{7f}".to_string(),
        "Escape" => "\u{1b}".to_string(),
        "ArrowUp" => "\u{1b}[A".to_string(),
        "ArrowDown" => "\u{1b}[B".to_string(),
        "ArrowRight" => "\u{1b}[C".to_string(),
        "ArrowLeft" => "\u{1b}[D".to_string(),
        "C-c" => "\u{3}".to_string(),
        "C-d" => "\u{4}".to_string(),
        other => {
            if other.len() > 128 {
                return Err(anyhow!("special key name is too long"));
            }
            if other.chars().any(|ch| ch.is_control()) {
                return Err(anyhow!("special key contains control characters"));
            }
            other.to_string()
        }
    };

    Ok(mapped)
}

async fn authorize_terminal_access(
    state: &Arc<AppState>,
    session_id: &str,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<()> {
    let access = state.config.read().await.access.clone();
    if !access_control_enabled(&access) {
        return Ok(());
    }

    let token = resolve_terminal_auth_token(headers, query_token)
        .ok_or_else(|| anyhow!("Terminal token is required"))?;
    if verify_terminal_token(session_id, &token)? {
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
    use crate::state::TERMINAL_RESTORE_SNAPSHOT_VERSION;
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

    async fn seed_live_terminal_session(
        state: &Arc<AppState>,
        session_id: &str,
    ) -> (SessionRecord, mpsc::Receiver<ExecutorInput>) {
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

        let (input_tx, input_rx) = mpsc::channel::<ExecutorInput>(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        state
            .attach_terminal_runtime(&session.id, input_tx, None, kill_tx)
            .await;
        state
            .emit_terminal_text(&session.id, "first line\r\nprompt> ")
            .await;

        (session, input_rx)
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
    fn resolve_terminal_keys_rejects_oversized_literal() {
        let huge = "x".repeat(MAX_TERMINAL_KEYS_PAYLOAD_BYTES + 1);
        assert!(resolve_terminal_keys(Some(huge), None).is_err());
    }

    #[test]
    fn resolve_terminal_keys_rejects_control_chars_in_special_other() {
        assert!(resolve_terminal_keys(None, Some("x\u{0}".to_string())).is_err());
    }

    #[test]
    fn ttyd_http_url_from_ws_url_accepts_loopback_only() {
        assert!(ttyd_http_url_from_ws_url("ws://127.0.0.1:4100/ws").is_some());
        assert!(ttyd_http_url_from_ws_url("ws://localhost:4100/ws").is_some());
        assert!(ttyd_http_url_from_ws_url("ws://[::1]:4100/ws").is_some());
        assert!(ttyd_http_url_from_ws_url("ws://192.168.0.1/ws").is_none());
        assert!(ttyd_http_url_from_ws_url("ws://example.com/ws").is_none());
        assert!(ttyd_http_url_from_ws_url("ws://user:pass@127.0.0.1:9/ws").is_none());
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
    fn client_requests_tty_subprotocol_detects_tty_and_ignores_missing_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("tty, binary"),
        );
        assert!(client_requests_tty_subprotocol(&headers));

        let mut non_tty_headers = HeaderMap::new();
        non_tty_headers.insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("binary"));
        assert!(!client_requests_tty_subprotocol(&non_tty_headers));
        assert!(!client_requests_tty_subprotocol(&HeaderMap::new()));
    }

    #[test]
    fn render_restore_snapshot_bytes_advances_sequence_even_for_empty_render() {
        let snapshot = TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: 42,
            cols: 120,
            rows: 32,
            has_output: true,
            modes: Default::default(),
            history: Vec::new(),
            screen: Vec::new(),
        };
        let mut last_sequence_sent = 7;

        let bytes = render_restore_snapshot_bytes(&snapshot, &mut last_sequence_sent);

        assert_eq!(last_sequence_sent, 42);
        assert!(bytes.is_empty());
    }

    #[tokio::test]
    async fn render_current_restore_snapshot_bytes_pulls_fresh_terminal_state() {
        let (state, root) = build_test_state().await;
        let (session, _input_rx) =
            seed_live_terminal_session(&state, "session-handshake-fresh").await;

        let stale = state
            .current_terminal_restore_snapshot(&session.id)
            .await
            .expect("stale snapshot should exist");

        state
            .emit_terminal_text(&session.id, "late line after socket open\r\n")
            .await;

        let mut last_sequence_sent = 0;
        let bytes =
            render_current_restore_snapshot_bytes(&state, &session.id, &mut last_sequence_sent)
                .await;
        let rendered = String::from_utf8_lossy(&bytes);

        assert!(rendered.contains("late line after socket open"));
        assert!(last_sequence_sent > stale.sequence);

        let _ = std::fs::remove_dir_all(root);
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
        assert!(injected.contains("box-sizing: border-box;"));
        assert!(injected.contains("html.conductor-ttyd-touch-shim-enabled #terminal-container {"));
        assert!(injected
            .contains("html.conductor-ttyd-touch-shim-enabled #terminal-container .terminal {"));
        assert!(injected
            .contains("padding: 8px 8px calc(8px + env(safe-area-inset-bottom)) !important;"));
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
        assert!(injected.contains("const mouseModeActive = syncTouchActionMode();"));
        assert!(injected.contains("if (mouseModeActive) {"));
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
    fn inject_ttyd_resize_shim_inserts_before_body_close() {
        let html = "<html><body><main>terminal</main></body></html>";
        let injected = inject_ttyd_resize_shim(html);

        assert!(injected.contains(TTYD_RESIZE_SHIM_MARKER));
        assert!(injected.contains("window.__conductorTtydResizeShimInstalled"));
        assert!(injected.contains("const scheduleResizeBurst = () => {"));
        assert!(injected.contains("const syncViewportSize = () => {"));
        assert!(injected.contains("new ResizeObserver(syncViewportSize)"));
        assert!(injected.contains("window.addEventListener('pageshow', scheduleResizeBurst);"));
        assert!(injected.contains("window.addEventListener('focus', scheduleResizeBurst);"));
        assert!(
            injected.contains("window.addEventListener('orientationchange', syncViewportSize);")
        );
        assert!(injected.contains("document.addEventListener('visibilitychange', () => {"));
        assert!(injected.contains("window.requestAnimationFrame(dispatchResize);"));
        assert!(injected.contains("window.dispatchEvent(new Event('resize'));"));
        assert!(injected.contains("event.data.type !== 'conductor-terminal-resize'"));
        assert!(
            injected.find(TTYD_RESIZE_SHIM_MARKER).unwrap() < injected.rfind("</body>").unwrap()
        );
    }

    #[test]
    fn inject_ttyd_resize_shim_is_idempotent() {
        let html = "<html><body><main>terminal</main></body></html>";
        let once = inject_ttyd_resize_shim(html);
        let twice = inject_ttyd_resize_shim(&once);

        assert_eq!(
            twice.matches(TTYD_RESIZE_SHIM_MARKER).count(),
            1,
            "resize shim should only be injected once"
        );
    }

    #[test]
    fn inject_ttyd_auth_sync_shim_inserts_before_head_scripts() {
        let html = "<html><head><script src=\"/refresh.js\"></script></head><body><main>terminal</main></body></html>";
        let injected = inject_ttyd_auth_sync_shim(html);

        assert!(injected.contains(TTYD_AUTH_SYNC_SHIM_MARKER));
        assert!(injected.contains("window.__conductorTtydAuthSyncShimInstalled"));
        assert!(injected.contains("const LEGACY_STORAGE_KEY = 'conductor.ttyd.token';"));
        assert!(injected.contains("const sessionIdFromPath = () => {"));
        assert!(injected.contains("const storageKey = () => {"));
        assert!(injected.contains("const MESSAGE_TYPE = 'conductor-ttyd-auth-token';"));
        assert!(
            injected.contains("const REQUEST_MESSAGE_TYPE = 'conductor-ttyd-auth-token-request';")
        );
        assert!(injected.contains("const READY_MESSAGE_TYPE = 'conductor-ttyd-ready';"));
        assert!(injected.contains("const TOKEN_REQUEST_THROTTLE_MS = 1500;"));
        assert!(
            injected.contains("const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);")
        );
        assert!(injected.contains("const readLocationBridgeId = () => {"));
        assert!(injected.contains("const resolveProxyWebSocketUrl = () => {"));
        assert!(injected.contains("window.__conductorTtydWebSocketPatched"));
        assert!(injected.contains("const nativeWebSocket = window.WebSocket;"));
        assert!(injected.contains("const notifyReady = () => {"));
        assert!(injected.contains("window.parent.postMessage({ type: READY_MESSAGE_TYPE }, '*');"));
        assert!(injected.contains("const requestFreshToken = (reason) => {"));
        assert!(injected.contains("const attachSocketListeners = (socket) => {"));
        assert!(injected.contains("socket.addEventListener('open', () => {"));
        assert!(injected.contains("notifyReady();"));
        assert!(injected.contains("requestFreshToken('websocket-close');"));
        assert!(injected.contains("requestFreshToken('websocket-error');"));
        assert!(injected.contains("const normalizeWebSocketUrl = (value) => {"));
        assert!(injected.contains("const url = new URL(window.location.href);"));
        assert!(injected.contains("candidate.hostname"));
        assert!(injected.contains("candidate.pathname === '/'"));
        assert!(injected.contains("candidate.pathname === '/ws'"));
        assert!(injected.contains("candidate.pathname.endsWith('/ws')"));
        assert!(injected.contains("url.searchParams.set('token', token);"));
        assert!(injected.contains("url.searchParams.set('bridgeId', bridgeId);"));
        assert!(injected.contains("window.addEventListener('message', handleMessage);"));
        assert!(
            injected.find(TTYD_AUTH_SYNC_SHIM_MARKER).unwrap()
                < injected.find("</script>").unwrap()
        );
        assert!(
            injected.find(TTYD_AUTH_SYNC_SHIM_MARKER).unwrap() < injected.find("</head>").unwrap()
        );
    }

    #[test]
    fn inject_ttyd_auth_sync_shim_is_idempotent() {
        let html = "<html><head><script src=\"/refresh.js\"></script></head><body><main>terminal</main></body></html>";
        let once = inject_ttyd_auth_sync_shim(html);
        let twice = inject_ttyd_auth_sync_shim(&once);

        assert_eq!(
            twice.matches(TTYD_AUTH_SYNC_SHIM_MARKER).count(),
            1,
            "auth sync shim should only be injected once"
        );
    }

    #[test]
    fn should_inject_ttyd_mobile_touch_shim_for_all_ttyd_sessions() {
        let mut ttyd_codex_session = SessionRecord::builder(
            "session-ttyd-codex".to_string(),
            "project-1".to_string(),
            "codex".to_string(),
            "prompt".to_string(),
        )
        .build();
        ttyd_codex_session.metadata.insert(
            RUNTIME_MODE_METADATA_KEY.to_string(),
            TTYD_RUNTIME_MODE.to_string(),
        );
        ttyd_codex_session.metadata.insert(
            TTYD_WS_URL_METADATA_KEY.to_string(),
            "ws://127.0.0.1:41002/ws".to_string(),
        );

        let mut ttyd_opencode_session = SessionRecord::builder(
            "session-ttyd-opencode".to_string(),
            "project-1".to_string(),
            "opencode".to_string(),
            "prompt".to_string(),
        )
        .build();
        ttyd_opencode_session.metadata.insert(
            RUNTIME_MODE_METADATA_KEY.to_string(),
            TTYD_RUNTIME_MODE.to_string(),
        );
        ttyd_opencode_session.metadata.insert(
            TTYD_WS_URL_METADATA_KEY.to_string(),
            "ws://127.0.0.1:41003/ws".to_string(),
        );

        let non_ttyd_session = SessionRecord::builder(
            "session-non-ttyd".to_string(),
            "project-1".to_string(),
            "codex".to_string(),
            "prompt".to_string(),
        )
        .build();

        assert!(should_inject_ttyd_mobile_touch_shim(&ttyd_codex_session));
        assert!(should_inject_ttyd_mobile_touch_shim(&ttyd_opencode_session));
        assert!(!should_inject_ttyd_mobile_touch_shim(&non_ttyd_session));
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
        let (session, _input_rx) = seed_live_terminal_session(&state, "session-live").await;

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
        let (session, _input_rx) = seed_live_terminal_session(&state, "session-restore").await;
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
        let (session, _input_rx) = seed_live_terminal_session(&state, "session-http").await;

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
            &HeaderMap::new(),
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers().get_all(SET_COOKIE).iter().any(|value| {
                value
                    .to_str()
                    .map(|text| text.contains(TERMINAL_AUTH_COOKIE_NAME))
                    .unwrap_or(false)
            }),
            "Set-Cookie should issue terminal auth cookie"
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("token response body should read");
        let payload: Value =
            serde_json::from_slice(&body).expect("token response should be valid json");

        let _token = payload["token"]
            .as_str()
            .expect("token should be included in ttyd token response");
        assert_eq!(
            payload["ttydHttpUrl"],
            Value::String(format!("/api/sessions/{}/terminal/ttyd", session.id))
        );
        assert_eq!(
            payload["ttydWsUrl"],
            Value::String(format!("/api/sessions/{}/terminal/ttyd/ws", session.id))
        );
        assert!(payload.get("token").is_some());

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn ttyd_frontend_token_route_returns_a_token_when_access_control_is_enabled() {
        let (state, root) = build_test_state().await;
        state.config.write().await.access.require_auth = true;
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
        let token = payload["token"].as_str().expect("token should be present");
        assert!(!token.is_empty());

        let _ = std::fs::remove_dir_all(root);
    }
}
