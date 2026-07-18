use anyhow::{Context, Result};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::ConnectInfo;
use axum::extract::{Path, Query, State};
use axum::http::{
    header::{AUTHORIZATION, ORIGIN, SEC_WEBSOCKET_PROTOCOL},
    HeaderMap, HeaderValue, Method, StatusCode,
};
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
use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, Mutex};
use tower_http::cors::CorsLayer;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Clone)]
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
    persistence: Arc<Mutex<PersistenceCoordinator>>,
    trusted_proxies: Arc<Vec<TrustedProxyNetwork>>,
    queue_budget: Arc<QueueByteBudget>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedRelayState {
    #[serde(default)]
    revision: u64,
    devices: Vec<DeviceRecord>,
}

#[derive(Debug, Default)]
struct PersistenceCoordinator {
    last_persisted_revision: u64,
}

#[derive(Debug, Default)]
struct RelayInner {
    channels: HashMap<String, BridgeChannel>,
    pairing_codes: HashMap<String, PendingPairing>,
    device_claims: HashMap<String, PendingDeviceClaim>,
    devices: HashMap<String, DeviceRecord>,
    terminal_sessions: HashMap<String, TerminalSessionRecord>,
    pending_api_requests: HashMap<String, PendingApiRequest>,
    pending_preview_requests: HashMap<String, PendingPreviewRequest>,
    pending_api_bytes: usize,
    pending_preview_bytes: usize,
    pending_device_claim_bytes: usize,
    refresh_tokens: HashMap<String, String>,
    rate_limits: HashMap<String, RateBucket>,
    next_connection_id: u64,
    next_terminal_connection_id: u64,
    state_revision: u64,
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
    tx: MessageSender,
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
    pairing_in_progress: bool,
    request_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    terminal_id: String,
    session_id: String,
    device_id: String,
    owner_user_id: String,
    browser: Option<TerminalConnectionRecord>,
    bridge: Option<TerminalConnectionRecord>,
    browser_disconnected_at: Option<Instant>,
    attach_generation: u64,
    attach_deadline: Option<Instant>,
    /// When true, the browser has sent a PAUSE frame and output from the bridge
    /// should not be forwarded until a RESUME frame arrives.
    browser_paused: bool,
    /// Buffered output chunks received while the browser was paused, replayed on resume.
    pause_buffer: Vec<Message>,
    pause_buffer_bytes: usize,
    /// Browser-to-bridge frames received before the bridge proxy attaches.
    pending_browser_frames: Vec<Message>,
    pending_browser_frame_bytes: usize,
}

#[derive(Debug, Clone)]
struct TerminalConnectionRecord {
    id: u64,
    tx: MessageSender,
}

#[derive(Debug)]
struct QueuedMessage {
    message: Message,
    _reservation: QueueByteReservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct QueueBudgetScope {
    user_id: String,
    channel_id: String,
}

impl QueueBudgetScope {
    fn control(user_id: &str, channel_id: &str) -> Self {
        Self {
            user_id: user_id.to_string(),
            channel_id: format!("control:{channel_id}"),
        }
    }

    fn terminal(user_id: &str, terminal_id: &str) -> Self {
        Self {
            user_id: user_id.to_string(),
            channel_id: format!("terminal:{terminal_id}"),
        }
    }
}

#[derive(Debug, Default)]
struct QueueByteBudgetInner {
    global: usize,
    by_user: HashMap<String, usize>,
    by_channel: HashMap<String, usize>,
}

/// Shared accounting for queued WebSocket payloads. Per-connection channel bounds are necessary
/// but insufficient: a single fan-out frame can otherwise be retained once per slow browser.
#[derive(Debug)]
struct QueueByteBudget {
    inner: StdMutex<QueueByteBudgetInner>,
    global_capacity: usize,
    user_capacity: usize,
    channel_capacity: usize,
}

impl QueueByteBudget {
    fn new(global_capacity: usize, user_capacity: usize, channel_capacity: usize) -> Self {
        Self {
            inner: StdMutex::new(QueueByteBudgetInner::default()),
            global_capacity,
            user_capacity,
            channel_capacity,
        }
    }

    fn production() -> Self {
        Self::new(
            GLOBAL_WS_QUEUE_BYTE_CAPACITY,
            USER_WS_QUEUE_BYTE_CAPACITY,
            CHANNEL_WS_QUEUE_BYTE_CAPACITY,
        )
    }

    fn try_reserve(
        self: &Arc<Self>,
        scope: &QueueBudgetScope,
        bytes: usize,
    ) -> Option<QueueByteReservation> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next_global = inner.global.checked_add(bytes)?;
        let next_user = inner
            .by_user
            .get(&scope.user_id)
            .copied()
            .unwrap_or_default()
            .checked_add(bytes)?;
        let next_channel = inner
            .by_channel
            .get(&scope.channel_id)
            .copied()
            .unwrap_or_default()
            .checked_add(bytes)?;
        if next_global > self.global_capacity
            || next_user > self.user_capacity
            || next_channel > self.channel_capacity
        {
            return None;
        }

        inner.global = next_global;
        inner.by_user.insert(scope.user_id.clone(), next_user);
        inner
            .by_channel
            .insert(scope.channel_id.clone(), next_channel);
        drop(inner);

        Some(QueueByteReservation {
            connection_bytes: None,
            aggregate: Arc::clone(self),
            scope: scope.clone(),
            bytes,
        })
    }

    fn release(&self, scope: &QueueBudgetScope, bytes: usize) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.global = inner.global.saturating_sub(bytes);
        release_scoped_queue_bytes(&mut inner.by_user, &scope.user_id, bytes);
        release_scoped_queue_bytes(&mut inner.by_channel, &scope.channel_id, bytes);
    }

    #[cfg(test)]
    fn usage(&self, scope: &QueueBudgetScope) -> (usize, usize, usize) {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            inner.global,
            inner
                .by_user
                .get(&scope.user_id)
                .copied()
                .unwrap_or_default(),
            inner
                .by_channel
                .get(&scope.channel_id)
                .copied()
                .unwrap_or_default(),
        )
    }
}

fn release_scoped_queue_bytes(map: &mut HashMap<String, usize>, key: &str, bytes: usize) {
    let remove = if let Some(queued) = map.get_mut(key) {
        *queued = queued.saturating_sub(bytes);
        *queued == 0
    } else {
        false
    };
    if remove {
        map.remove(key);
    }
}

#[derive(Debug)]
struct QueueByteReservation {
    connection_bytes: Option<Arc<AtomicUsize>>,
    aggregate: Arc<QueueByteBudget>,
    scope: QueueBudgetScope,
    bytes: usize,
}

impl Drop for QueueByteReservation {
    fn drop(&mut self) {
        if let Some(connection_bytes) = self.connection_bytes.as_ref() {
            connection_bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        }
        self.aggregate.release(&self.scope, self.bytes);
    }
}

/// A count- and byte-bounded WebSocket queue. Tokio's channel capacity only bounds the number of
/// messages; without the additional byte reservation a slow peer could retain `capacity` maximum-
/// sized frames in memory.
#[derive(Debug, Clone)]
struct MessageSender {
    tx: mpsc::Sender<QueuedMessage>,
    queued_bytes: Arc<AtomicUsize>,
    byte_capacity: usize,
    aggregate_budget: Arc<QueueByteBudget>,
    budget_scope: QueueBudgetScope,
}

#[derive(Debug)]
struct MessageReceiver {
    rx: mpsc::Receiver<QueuedMessage>,
}

impl MessageSender {
    fn try_send(
        &self,
        message: Message,
    ) -> std::result::Result<(), mpsc::error::TrySendError<Message>> {
        let bytes = websocket_message_size(&message);
        if bytes > self.byte_capacity {
            return Err(mpsc::error::TrySendError::Full(message));
        }

        let reserved =
            self.queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                    queued
                        .checked_add(bytes)
                        .filter(|next| *next <= self.byte_capacity)
                });
        if reserved.is_err() {
            return Err(mpsc::error::TrySendError::Full(message));
        }

        let Some(mut reservation) = self.aggregate_budget.try_reserve(&self.budget_scope, bytes)
        else {
            self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            return Err(mpsc::error::TrySendError::Full(message));
        };
        reservation.connection_bytes = Some(Arc::clone(&self.queued_bytes));

        match self.tx.try_send(QueuedMessage {
            message,
            _reservation: reservation,
        }) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(queued)) => {
                Err(mpsc::error::TrySendError::Full(queued.message))
            }
            Err(mpsc::error::TrySendError::Closed(queued)) => {
                Err(mpsc::error::TrySendError::Closed(queued.message))
            }
        }
    }
}

impl MessageReceiver {
    async fn recv_queued(&mut self) -> Option<QueuedMessage> {
        self.rx.recv().await
    }

    #[cfg(test)]
    async fn recv(&mut self) -> Option<Message> {
        let queued = self.recv_queued().await?;
        Some(queued.message)
    }

    #[cfg(test)]
    fn try_recv(&mut self) -> std::result::Result<Message, mpsc::error::TryRecvError> {
        let queued = self.rx.try_recv()?;
        Ok(queued.message)
    }
}

fn message_channel(
    capacity: usize,
    byte_capacity: usize,
    aggregate_budget: Arc<QueueByteBudget>,
    budget_scope: QueueBudgetScope,
) -> (MessageSender, MessageReceiver) {
    let (tx, rx) = mpsc::channel(capacity);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    (
        MessageSender {
            tx,
            queued_bytes: Arc::clone(&queued_bytes),
            byte_capacity,
            aggregate_budget,
            budget_scope,
        },
        MessageReceiver { rx },
    )
}

impl TerminalSessionRecord {
    fn connection_is_current(&self, peer_kind: TerminalPeerKind, connection_id: u64) -> bool {
        match peer_kind {
            TerminalPeerKind::Browser => self
                .browser
                .as_ref()
                .is_some_and(|record| record.id == connection_id),
            TerminalPeerKind::Bridge => self
                .bridge
                .as_ref()
                .is_some_and(|record| record.id == connection_id),
        }
    }

    fn buffer_paused_output(&mut self, message: Message) -> bool {
        buffer_terminal_message(
            &mut self.pause_buffer,
            &mut self.pause_buffer_bytes,
            TERMINAL_PAUSE_BUFFER_CAPACITY,
            TERMINAL_PAUSE_BUFFER_BYTE_CAPACITY,
            message,
        )
    }

    fn buffer_pending_browser_frame(&mut self, message: Message) -> bool {
        let message_bytes = websocket_message_size(&message);
        if self.pending_browser_frames.len() >= TERMINAL_PENDING_BROWSER_FRAME_CAPACITY
            || self
                .pending_browser_frame_bytes
                .saturating_add(message_bytes)
                > TERMINAL_PENDING_BROWSER_FRAME_BYTE_CAPACITY
        {
            return false;
        }
        self.pending_browser_frame_bytes = self
            .pending_browser_frame_bytes
            .saturating_add(message_bytes);
        self.pending_browser_frames.push(message);
        true
    }
}

fn buffer_terminal_message(
    buffer: &mut Vec<Message>,
    buffer_bytes: &mut usize,
    capacity: usize,
    byte_capacity: usize,
    message: Message,
) -> bool {
    let message_bytes = websocket_message_size(&message);
    if message_bytes > byte_capacity {
        return false;
    }
    while !buffer.is_empty()
        && (buffer.len() >= capacity || buffer_bytes.saturating_add(message_bytes) > byte_capacity)
    {
        let removed = buffer.remove(0);
        *buffer_bytes = buffer_bytes.saturating_sub(websocket_message_size(&removed));
    }
    *buffer_bytes = buffer_bytes.saturating_add(message_bytes);
    buffer.push(message);
    true
}

#[derive(Debug)]
struct PendingApiRequest {
    device_id: String,
    request_bytes: usize,
    tx: oneshot::Sender<ProxiedApiResponse>,
}

#[derive(Debug)]
struct PendingPreviewRequest {
    device_id: String,
    request_bytes: usize,
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

/// Maximum number of output chunks buffered while the browser peer is paused.
const TERMINAL_PAUSE_BUFFER_CAPACITY: usize = 256;
/// Maximum aggregate bytes buffered while a browser terminal is paused.
const TERMINAL_PAUSE_BUFFER_BYTE_CAPACITY: usize = MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES;
/// Browser input/handshake frames held while the paired bridge proxy catches up.
const TERMINAL_PENDING_BROWSER_FRAME_CAPACITY: usize = 256;
const TERMINAL_PENDING_BROWSER_FRAME_BYTE_CAPACITY: usize = 2 * 1024 * 1024;
/// Per-connection outbound queue bounds. A slow peer may drop traffic, but cannot grow memory
/// without limit.
const CONTROL_WS_QUEUE_CAPACITY: usize = 128;
const TERMINAL_WS_QUEUE_CAPACITY: usize = 256;
const CONTROL_WS_QUEUE_BYTE_CAPACITY: usize = 4 * 1024 * 1024;
const TERMINAL_WS_QUEUE_BYTE_CAPACITY: usize = 8 * 1024 * 1024;
/// Aggregate queue ceilings prevent connection fan-out from multiplying the per-connection
/// allowance into unbounded process memory.
const GLOBAL_WS_QUEUE_BYTE_CAPACITY: usize = 128 * 1024 * 1024;
const USER_WS_QUEUE_BYTE_CAPACITY: usize = 32 * 1024 * 1024;
const CHANNEL_WS_QUEUE_BYTE_CAPACITY: usize = 16 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 1024 * 1024;
/// The backend retains up to 2 MiB of terminal history and replays it as one ttyd output
/// message. Account for the ttyd command byte while keeping every other relay WebSocket at the
/// tighter general-purpose limit above.
const MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES: usize = 2 * 1024 * 1024 + 1;
/// ttyd protocol command bytes (first byte of binary WebSocket message).
const TTYD_CMD_RESIZE: u8 = b'1';
const TTYD_CMD_PAUSE: u8 = b'2';
const TTYD_CMD_RESUME: u8 = b'3';
#[cfg(not(test))]
const TERMINAL_BROWSER_REATTACH_GRACE: Duration = Duration::from_secs(60);
#[cfg(test)]
const TERMINAL_BROWSER_REATTACH_GRACE: Duration = Duration::from_millis(25);
#[cfg(not(test))]
const TERMINAL_ATTACH_TTL: Duration = Duration::from_secs(30);
#[cfg(test)]
const TERMINAL_ATTACH_TTL: Duration = Duration::from_millis(100);

#[derive(Debug)]
struct RateBucket {
    tokens: f64,
    last_refill: Instant,
    last_seen: Instant,
    capacity: f64,
    refill_per_second: f64,
}

impl RateBucket {
    fn with_limits(now: Instant, capacity: f64, refill_per_second: f64) -> Self {
        Self {
            tokens: capacity,
            last_refill: now,
            last_seen: now,
            capacity,
            refill_per_second,
        }
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.last_refill = now;
        self.last_seen = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_second).min(self.capacity);
    }

    fn allow(&mut self, now: Instant) -> bool {
        self.refill(now);
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
    ready: bool,
    #[serde(rename = "buildSha")]
    build_sha: String,
    bridge_channels: usize,
    browser_connections: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrustedProxyNetwork {
    address: IpAddr,
    prefix: u8,
}

impl TrustedProxyNetwork {
    fn contains(self, candidate: IpAddr) -> bool {
        match (self.address, candidate) {
            (IpAddr::V4(network), IpAddr::V4(candidate)) => {
                let prefix = self.prefix.min(32);
                let mask = if prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - prefix)
                };
                u32::from(network) & mask == u32::from(candidate) & mask
            }
            (IpAddr::V6(network), IpAddr::V6(candidate)) => {
                let prefix = self.prefix.min(128);
                let mask = if prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - prefix)
                };
                u128::from(network) & mask == u128::from(candidate) & mask
            }
            _ => false,
        }
    }
}

const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
const RELAY_STATE_FILE_ENV: &str = "RELAY_STATE_FILE";
const RELAY_ALLOWED_ORIGINS_ENV: &str = "RELAY_ALLOWED_ORIGINS";
const RELAY_TRUSTED_PROXIES_ENV: &str = "RELAY_TRUSTED_PROXIES";
const DEFAULT_ALLOWED_ORIGINS: &str = "https://app.conductross.com,https://preview.conductross.com";
const CONDUCTOR_BUILD_SHA_ENV: &str = "CONDUCTOR_BUILD_SHA";
const DEFAULT_JWT_SECRET_ENV: &str = "RELAY_JWT_SECRET";
const MIN_RELAY_JWT_SECRET_BYTES: usize = 32;
const RELAY_JWT_ISSUER: &str = "conductor-dashboard";
const RELAY_JWT_AUDIENCE: &str = "conductor-relay";
const RELAY_JWT_SCOPE_DASHBOARD_API: &str = "dashboard-api";
const RELAY_JWT_SCOPE_TERMINAL_BROWSER: &str = "terminal-browser";
const DEFAULT_RATE_LIMIT_BURST: usize = 120;
const DEFAULT_RATE_LIMIT_REFILL_PER_SECOND: f64 = 2.0;
const MAX_RATE_LIMIT_BUCKETS: usize = 4096;
const RATE_LIMIT_BUCKET_TTL: Duration = Duration::from_secs(15 * 60);
const DEVICE_CLAIM_RATE_LIMIT_BURST: usize = 12;
const DEVICE_CLAIM_RATE_LIMIT_REFILL_PER_SECOND: f64 = 0.1;
const DEVICE_CLAIM_GLOBAL_RATE_LIMIT_BURST: usize = 256;
const DEVICE_CLAIM_GLOBAL_RATE_LIMIT_REFILL_PER_SECOND: f64 = 2.0;
const DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY: &str = "device-claims:create:global";
const MAX_FORWARDED_FOR_BYTES: usize = 4096;
const MAX_FORWARDED_FOR_HOPS: usize = 32;
const MAX_PENDING_PAIRING_CODES: usize = 256;
const MAX_PENDING_DEVICE_CLAIMS: usize = 1024;
const MAX_DEVICE_IDENTITY_BYTES: usize = 16 * 1024;
const MAX_PENDING_DEVICE_CLAIM_BYTES: usize = 4 * 1024 * 1024;
const PAIRING_CODE_LENGTH: usize = 10;
const PAIRING_CODE_TTL: Duration = Duration::from_secs(10 * 60);
const DEVICE_ACCESS_TOKEN_TTL_SECS: u64 = 3600;
const DEVICE_PROXY_TIMEOUT: Duration = Duration::from_secs(45);
const DEVICE_PICKER_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_PENDING_API_REQUESTS: usize = 256;
const MAX_PENDING_PREVIEW_REQUESTS: usize = 128;
const MAX_PENDING_API_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_PENDING_PREVIEW_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_TERMINAL_SESSIONS: usize = 256;
const MAX_TERMINAL_SESSIONS_PER_DEVICE: usize = 16;
const MAX_TERMINAL_SESSIONS_PER_USER: usize = 64;
const MAX_PAIRED_DEVICES_GLOBAL: usize = 4096;
const MAX_PAIRED_DEVICES_PER_USER: usize = 64;
const MAX_CONTROL_CONNECTIONS_GLOBAL: usize = 2048;
const MAX_CONTROL_CONNECTIONS_PER_USER: usize = 128;
const MAX_CONTROL_CONNECTIONS_PER_CHANNEL: usize = 33;
const MAX_BROWSER_CONNECTIONS_GLOBAL: usize = 1536;
const MAX_BROWSER_CONNECTIONS_PER_USER: usize = 96;
const MAX_BROWSER_CONNECTIONS_PER_CHANNEL: usize = 32;
const BRIDGE_PROXY_META_KEY: &str = "$bridgeProxy";

impl Default for RelayState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RelayInner::default())),
            persistence: Arc::new(Mutex::new(PersistenceCoordinator::default())),
            trusted_proxies: Arc::new(Vec::new()),
            queue_budget: Arc::new(QueueByteBudget::production()),
        }
    }
}

fn device_claim_rate_limit_key(client_ip: IpAddr) -> String {
    format!("device-claims:create:{client_ip}")
}

fn relay_state_file_path() -> Option<PathBuf> {
    env::var(RELAY_STATE_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn build_persisted_relay_state(inner: &RelayInner) -> PersistedRelayState {
    PersistedRelayState {
        revision: inner.state_revision,
        devices: inner.devices.values().cloned().collect(),
    }
}

async fn persist_devices_snapshot(snapshot: PersistedRelayState) -> Result<()> {
    let Some(path) = relay_state_file_path() else {
        return Ok(());
    };
    if let Some(parent) = state_file_parent(&path) {
        fs::create_dir_all(parent).await?;
    }
    let payload = serde_json::to_vec_pretty(&snapshot)?;
    let temp_path = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(&temp_path).await?;
    let write_result = async {
        file.write_all(&payload).await?;
        file.flush().await?;
        file.sync_data().await?;
        Result::<()>::Ok(())
    }
    .await;
    drop(file);
    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path).await;
        return Err(err);
    }
    if let Err(err) = fs::rename(&temp_path, &path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(err.into());
    }
    harden_state_file_permissions(&path).await?;
    Ok(())
}

async fn persist_newer_devices_snapshot(
    snapshot: PersistedRelayState,
    coordinator: &mut PersistenceCoordinator,
) -> Result<()> {
    if snapshot.revision <= coordinator.last_persisted_revision {
        anyhow::bail!("refusing to persist a stale relay state snapshot");
    }
    let revision = snapshot.revision;
    persist_devices_snapshot(snapshot).await?;
    coordinator.last_persisted_revision = revision;
    Ok(())
}

fn state_file_parent(path: &std::path::Path) -> Option<&std::path::Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

#[cfg(unix)]
async fn harden_state_file_permissions(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn harden_state_file_permissions(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

impl RelayState {
    fn from_persisted(snapshot: PersistedRelayState) -> Result<Self> {
        let mut inner = RelayInner {
            state_revision: snapshot.revision,
            ..Default::default()
        };
        for device in snapshot.devices {
            if device.device_id.trim().is_empty()
                || device.owner_user_id.trim().is_empty()
                || device.refresh_token.trim().is_empty()
            {
                anyhow::bail!("persisted relay device record contains an empty identity field");
            }
            if device_identity_bytes(
                &device.device_id,
                &device.hostname,
                &device.os,
                &device.arch,
                &device.name,
            ) > MAX_DEVICE_IDENTITY_BYTES
            {
                anyhow::bail!("persisted relay device identity exceeds the byte limit");
            }
            if inner.devices.contains_key(&device.device_id) {
                anyhow::bail!("persisted relay state contains a duplicate device id");
            }
            ensure_device_pairing_capacity(&inner, &device.owner_user_id, &device.device_id)
                .map_err(|(_, message)| anyhow::anyhow!(message))?;
            if inner
                .refresh_tokens
                .insert(device.refresh_token.clone(), device.device_id.clone())
                .is_some()
            {
                anyhow::bail!("persisted relay state contains a duplicate refresh token");
            }
            inner.devices.insert(device.device_id.clone(), device);
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            persistence: Arc::new(Mutex::new(PersistenceCoordinator {
                last_persisted_revision: snapshot.revision,
            })),
            trusted_proxies: Arc::new(Vec::new()),
            queue_budget: Arc::new(QueueByteBudget::production()),
        })
    }

    async fn load_persisted() -> Result<Self> {
        let Some(path) = relay_state_file_path() else {
            return Ok(Self::default());
        };
        let contents = match fs::read_to_string(&path).await {
            Ok(contents) => contents,
            Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Self::default()),
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("read persisted relay state from {}", path.display()))
            }
        };
        let snapshot = serde_json::from_str::<PersistedRelayState>(&contents)
            .with_context(|| format!("parse persisted relay state from {}", path.display()))?;
        harden_state_file_permissions(&path)
            .await
            .with_context(|| format!("secure persisted relay state at {}", path.display()))?;
        Self::from_persisted(snapshot)
    }
}

pub async fn serve() -> Result<()> {
    let bind_addr = env::var("RELAY_BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.to_string());
    let state = RelayState::load_persisted().await?;
    let app = build_router(state)?;
    let listener = TcpListener::bind(&bind_addr).await?;
    info!(%bind_addr, "relay listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

fn build_router(mut state: RelayState) -> Result<Router> {
    let jwt_secret = env::var(DEFAULT_JWT_SECRET_ENV).ok();
    validate_relay_jwt_secret(jwt_secret.as_deref())?;
    let allowed_origins = configured_allowed_origins()?;
    state.trusted_proxies = Arc::new(configured_trusted_proxies()?);
    Ok(Router::new()
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
        .route("/bridge/{scope}", get(bridge_ws))
        .route("/browser/{scope}", get(browser_ws))
        .route("/terminal/{terminal_id}/browser", get(browser_terminal_ws))
        .route("/terminal/{terminal_id}/bridge", get(bridge_terminal_ws))
        .layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
                .allow_headers([
                    AUTHORIZATION,
                    axum::http::header::ACCEPT,
                    axum::http::header::CONTENT_TYPE,
                ]),
        )
        .with_state(state))
}

fn configured_allowed_origins() -> Result<Vec<HeaderValue>> {
    match env::var(RELAY_ALLOWED_ORIGINS_ENV) {
        Ok(value) => parse_allowed_origins(Some(&value)),
        Err(env::VarError::NotPresent) => parse_allowed_origins(None),
        Err(env::VarError::NotUnicode(_)) => {
            anyhow::bail!("RELAY_ALLOWED_ORIGINS contains non-Unicode data")
        }
    }
}

fn configured_trusted_proxies() -> Result<Vec<TrustedProxyNetwork>> {
    match env::var(RELAY_TRUSTED_PROXIES_ENV) {
        Ok(value) => parse_trusted_proxies(&value),
        Err(env::VarError::NotPresent) => Ok(Vec::new()),
        Err(env::VarError::NotUnicode(_)) => {
            anyhow::bail!("RELAY_TRUSTED_PROXIES contains non-Unicode data")
        }
    }
}

fn parse_trusted_proxies(configured: &str) -> Result<Vec<TrustedProxyNetwork>> {
    if configured.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut networks = Vec::new();
    for item in configured.split(',') {
        let candidate = item.trim();
        if candidate.is_empty() {
            anyhow::bail!("RELAY_TRUSTED_PROXIES contains an empty entry");
        }
        let (address_text, prefix_text) = candidate
            .split_once('/')
            .map_or((candidate, None), |(address, prefix)| {
                (address, Some(prefix))
            });
        let address = address_text
            .parse::<IpAddr>()
            .with_context(|| format!("invalid trusted proxy address: {address_text}"))?;
        let max_prefix = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix_text {
            Some(value) => value
                .parse::<u8>()
                .with_context(|| format!("invalid trusted proxy prefix: {candidate}"))?,
            None => max_prefix,
        };
        if prefix > max_prefix {
            anyhow::bail!("trusted proxy prefix is out of range: {candidate}");
        }
        let network = TrustedProxyNetwork { address, prefix };
        if !networks.contains(&network) {
            networks.push(network);
        }
    }
    Ok(networks)
}

fn is_trusted_proxy(address: IpAddr, trusted_proxies: &[TrustedProxyNetwork]) -> bool {
    trusted_proxies
        .iter()
        .any(|network| network.contains(address))
}

fn resolve_real_client_ip(
    remote_addr: SocketAddr,
    headers: &HeaderMap,
    trusted_proxies: &[TrustedProxyNetwork],
) -> IpAddr {
    let remote_ip = remote_addr.ip();
    if !is_trusted_proxy(remote_ip, trusted_proxies) {
        return remote_ip;
    }

    let forwarded = headers.get_all("x-forwarded-for");
    let mut hops = Vec::new();
    let mut total_bytes = 0usize;
    for value in forwarded.iter() {
        let Ok(value) = value.to_str() else {
            return remote_ip;
        };
        total_bytes = total_bytes.saturating_add(value.len());
        if total_bytes > MAX_FORWARDED_FOR_BYTES {
            return remote_ip;
        }
        for hop in value.split(',') {
            if hops.len() >= MAX_FORWARDED_FOR_HOPS {
                return remote_ip;
            }
            let Ok(address) = hop.trim().parse::<IpAddr>() else {
                return remote_ip;
            };
            hops.push(address);
        }
    }
    if hops.is_empty() {
        return remote_ip;
    }

    let mut client = remote_ip;
    for forwarded_hop in hops.into_iter().rev() {
        if !is_trusted_proxy(client, trusted_proxies) {
            break;
        }
        client = forwarded_hop;
    }
    client
}

fn parse_allowed_origins(configured: Option<&str>) -> Result<Vec<HeaderValue>> {
    let raw = configured.unwrap_or(DEFAULT_ALLOWED_ORIGINS);
    if raw.trim().is_empty() {
        anyhow::bail!("RELAY_ALLOWED_ORIGINS must contain at least one origin");
    }

    let mut origins = Vec::new();
    for item in raw.split(',') {
        let candidate = item.trim();
        if candidate.is_empty() || candidate == "*" {
            anyhow::bail!("RELAY_ALLOWED_ORIGINS contains an empty or wildcard origin");
        }
        let parsed = url::Url::parse(candidate)
            .with_context(|| format!("invalid relay CORS origin: {candidate}"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            anyhow::bail!("relay CORS entries must be HTTP(S) origins without paths");
        }
        let normalized = parsed.origin().ascii_serialization();
        let header = HeaderValue::try_from(normalized.as_str())
            .with_context(|| format!("invalid relay CORS origin header: {normalized}"))?;
        if !origins.contains(&header) {
            origins.push(header);
        }
    }

    if origins.is_empty() {
        anyhow::bail!("RELAY_ALLOWED_ORIGINS must contain at least one origin");
    }
    Ok(origins)
}

fn ensure_websocket_origin(headers: &HeaderMap) -> std::result::Result<(), Box<Response>> {
    let allowed_origins = configured_allowed_origins().map_err(|err| {
        Box::new(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": format!("Relay CORS configuration is invalid: {err}") })),
            )
                .into_response(),
        )
    })?;
    ensure_websocket_origin_with(headers, &allowed_origins)
}

fn ensure_websocket_origin_with(
    headers: &HeaderMap,
    allowed_origins: &[HeaderValue],
) -> std::result::Result<(), Box<Response>> {
    if headers
        .get(ORIGIN)
        .is_none_or(|origin| allowed_origins.contains(origin))
    {
        Ok(())
    } else {
        Err(Box::new(forbidden_websocket_origin_response()))
    }
}

fn forbidden_websocket_origin_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "WebSocket origin is not allowed." })),
    )
        .into_response()
}

async fn health(State(state): State<RelayState>) -> Response {
    let (bridge_channels, browser_connections) = {
        let inner = state.inner.lock().await;
        (
            inner
                .channels
                .values()
                .filter(|channel| channel.bridge.is_some())
                .count(),
            inner
                .channels
                .values()
                .map(|channel| channel.browsers.len())
                .sum(),
        )
    };

    let readiness_error = relay_readiness_error().await;
    relay_health_response(
        bridge_channels,
        browser_connections,
        readiness_error,
        relay_build_sha(),
    )
}

fn relay_health_response(
    bridge_channels: usize,
    browser_connections: usize,
    readiness_error: Option<String>,
    build_sha: String,
) -> Response {
    let status = if readiness_error.is_some() {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (
        status,
        Json(RelayHealth {
            ok: readiness_error.is_none(),
            ready: readiness_error.is_none(),
            build_sha,
            bridge_channels,
            browser_connections,
            error: readiness_error,
        }),
    )
        .into_response()
}

fn relay_build_sha() -> String {
    normalize_build_sha(env::var(CONDUCTOR_BUILD_SHA_ENV).ok().as_deref())
}

fn normalize_build_sha(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn validate_relay_jwt_secret(secret: Option<&str>) -> Result<&str> {
    let secret = secret
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .context("Relay JWT authentication is not configured.")?;
    if secret.len() < MIN_RELAY_JWT_SECRET_BYTES {
        anyhow::bail!("Relay JWT secret must contain at least {MIN_RELAY_JWT_SECRET_BYTES} bytes.");
    }
    Ok(secret)
}

async fn relay_readiness_error() -> Option<String> {
    if let Err(err) = configured_allowed_origins() {
        return Some(format!("Relay CORS configuration is invalid: {err}"));
    }
    let jwt_secret = env::var(DEFAULT_JWT_SECRET_ENV).ok();
    let state_path = relay_state_file_path();
    relay_readiness_error_for(jwt_secret.as_deref(), state_path.as_deref(), None).await
}

async fn relay_readiness_error_for(
    jwt_secret: Option<&str>,
    state_path: Option<&std::path::Path>,
    allowed_origins: Option<&str>,
) -> Option<String> {
    if let Err(err) = validate_relay_jwt_secret(jwt_secret) {
        return Some(err.to_string());
    }
    if let Err(err) = parse_allowed_origins(allowed_origins) {
        return Some(format!("Relay CORS configuration is invalid: {err}"));
    }

    let path = state_path?;
    probe_relay_state_storage(path)
        .await
        .err()
        .map(|err| format!("Relay state storage is unavailable: {err}"))
}

async fn probe_relay_state_storage(path: &std::path::Path) -> Result<()> {
    if let Some(parent) = state_file_parent(path) {
        fs::create_dir_all(parent).await?;
    }

    match fs::symlink_metadata(path).await {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                anyhow::bail!("configured state path is not a regular file");
            }
            let contents = fs::read_to_string(path).await?;
            let snapshot = serde_json::from_str::<PersistedRelayState>(&contents)
                .context("configured state file is not valid relay state")?;
            RelayState::from_persisted(snapshot)
                .context("configured state file violates relay identity invariants")?;
            harden_state_file_permissions(path).await?;
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }

    let probe_path = path.with_extension(format!("{}.readiness", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut probe = options.open(&probe_path).await?;
    let probe_result = async {
        probe.write_all(b"relay-readiness").await?;
        probe.flush().await?;
        probe.sync_data().await?;
        Result::<()>::Ok(())
    }
    .await;
    drop(probe);
    let cleanup_result = fs::remove_file(&probe_path).await;
    probe_result?;
    cleanup_result?;
    Ok(())
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

    match state
        .create_pairing_code(user_id, body.suggested_name.unwrap_or_default())
        .await
    {
        Ok(code) => (
            StatusCode::CREATED,
            Json(DeviceCodeCreateResponse {
                code,
                expires_in: PAIRING_CODE_TTL.as_secs(),
            }),
        )
            .into_response(),
        Err((status, message)) => (status, Json(json!({ "error": message }))).into_response(),
    }
}

async fn create_device_claim(
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(body): Json<DeviceClaimCreateRequest>,
) -> Response {
    let client_ip = resolve_real_client_ip(remote_addr, &headers, &state.trusted_proxies);
    let rate_limit_key = device_claim_rate_limit_key(client_ip);
    match state.create_device_claim(body, &rate_limit_key).await {
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
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    if let Err(response) = ensure_websocket_origin(&headers) {
        return *response;
    }
    let requested_protocol = resolve_websocket_protocol(&headers);
    let jwt = resolve_browser_terminal_jwt(query.jwt.as_deref(), requested_protocol.as_deref());
    let Some(jwt) = jwt else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing browser relay token." })),
        )
            .into_response();
    };

    let Some(user_id) = resolve_browser_ws_user_id(&jwt) else {
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
        Ok(()) => {
            let upgrade = move |socket| async move {
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
            };

            if let Some(protocol) = requested_protocol {
                ws.max_message_size(MAX_WS_MESSAGE_BYTES)
                    .max_frame_size(MAX_WS_MESSAGE_BYTES)
                    .protocols([protocol])
                    .on_upgrade(upgrade)
                    .into_response()
            } else {
                ws.max_message_size(MAX_WS_MESSAGE_BYTES)
                    .max_frame_size(MAX_WS_MESSAGE_BYTES)
                    .on_upgrade(upgrade)
                    .into_response()
            }
        }
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
    if let Err(response) = ensure_websocket_origin(&headers) {
        return *response;
    }
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
            .max_message_size(MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES)
            .max_frame_size(MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES)
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

    let (bridge_closes, browser_closes, pending_requests, pending_previews, removed) =
        state.disconnect_bridge_for_user(&user_id, &bridge_id).await;
    close_senders(bridge_closes).await;
    close_senders(browser_closes).await;
    fail_pending_api_requests(
        pending_requests,
        StatusCode::SERVICE_UNAVAILABLE,
        "Device disconnected.",
    );
    fail_pending_preview_requests(pending_previews, StatusCode::SERVICE_UNAVAILABLE);

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

async fn browser_ws(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Path(scope): Path<String>,
    headers: HeaderMap,
    Query(query): Query<WsQuery>,
) -> Response {
    if let Err(response) = ensure_websocket_origin(&headers) {
        return *response;
    }
    let scope = scope.trim().to_string();
    if scope.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Missing scope." })),
        )
            .into_response();
    }

    let (bridge_key, user_id) =
        match resolve_browser_connection(&scope, &headers, query.token.as_deref()).await {
            Ok(value) => value,
            Err(response) => return response,
        };

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(err) =
                handle_connection(state, bridge_key, PeerKind::Browser, user_id, socket, None).await
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
    if let Err(response) = ensure_websocket_origin(&headers) {
        return *response;
    }
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
                    version: None,
                }),
            )
        } else if let Some(user_id) = query
            .jwt
            .as_deref()
            .and_then(|jwt| decode_relay_user_id(jwt, RELAY_JWT_SCOPE_DASHBOARD_API).ok())
        {
            (scope.trim().to_string(), user_id, None)
        } else if let Ok(user_id) = decode_relay_user_id(&token, RELAY_JWT_SCOPE_DASHBOARD_API) {
            (scope.trim().to_string(), user_id, None)
        } else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Missing or invalid bridge relay token." })),
            )
                .into_response();
        };

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(err) = handle_connection(
                state,
                channel_key,
                PeerKind::Bridge,
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
) -> Result<(String, String), Response> {
    let Some(jwt) = resolve_token(headers, token) else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Missing bridge relay token." })),
        )
            .into_response());
    };

    let Some(user_id) = decode_relay_user_id(&jwt, RELAY_JWT_SCOPE_DASHBOARD_API).ok() else {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Invalid bridge relay token." })),
        )
            .into_response());
    };

    Ok((scope.trim().to_string(), user_id))
}

async fn handle_connection(
    state: RelayState,
    key: String,
    peer_kind: PeerKind,
    user_id: String,
    socket: WebSocket,
    initial_status: Option<BridgeStatus>,
) -> Result<()> {
    let (mut outbound, mut inbound) = socket.split();
    let (tx, mut rx) = message_channel(
        CONTROL_WS_QUEUE_CAPACITY,
        CONTROL_WS_QUEUE_BYTE_CAPACITY,
        Arc::clone(&state.queue_budget),
        QueueBudgetScope::control(&user_id, &key),
    );
    let connection_id = match state
        .register_connection(&key, peer_kind, user_id.clone(), tx.clone(), initial_status)
        .await
    {
        Ok(connection_id) => connection_id,
        Err(err) => {
            let _ = outbound
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "Relay channel ownership conflict.".into(),
                })))
                .await;
            return Err(err);
        }
    };

    let writer = tokio::spawn(async move {
        while let Some(queued) = rx.recv_queued().await {
            let QueuedMessage {
                message,
                _reservation: reservation,
            } = queued;
            let send_result = outbound.send(message).await;
            drop(reservation);
            if send_result.is_err() {
                break;
            }
        }
    });

    match peer_kind {
        PeerKind::Bridge => {
            state
                .broadcast_bridge_status(&key, connection_id, true)
                .await
        }
        PeerKind::Browser => state.send_browser_status_snapshot(&key, &tx).await,
    }

    while let Some(message) = inbound.next().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                drop(tx);
                state
                    .unregister_connection(&key, peer_kind, connection_id)
                    .await;
                let _ = writer.await;
                return Err(err.into());
            }
        };

        match message {
            Message::Text(text) => {
                let raw_text = text.to_string();
                match peer_kind {
                    PeerKind::Bridge => {
                        match serde_json::from_str::<BridgeToBrowserMessage>(&raw_text) {
                            Ok(parsed) => {
                                if !state
                                    .route_bridge_message(&key, connection_id, parsed, raw_text)
                                    .await
                                {
                                    break;
                                }
                            }
                            Err(err) => warn!(error = %err, "bridge message decode failed"),
                        }
                    }
                    PeerKind::Browser => {
                        match serde_json::from_str::<BrowserToBridgeMessage>(&raw_text) {
                            Ok(parsed) => {
                                if let Err(err) = state
                                    .route_browser_message(
                                        &key,
                                        connection_id,
                                        &user_id,
                                        parsed,
                                        raw_text,
                                        &tx,
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
                let _ = tx.try_send(Message::Pong(data));
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

fn websocket_message_size(message: &Message) -> usize {
    match message {
        Message::Text(text) => text.len(),
        Message::Binary(data) | Message::Ping(data) | Message::Pong(data) => data.len(),
        Message::Close(frame) => frame
            .as_ref()
            .map(|frame| frame.reason.len() + std::mem::size_of::<u16>())
            .unwrap_or_default(),
    }
}

async fn handle_terminal_connection(
    state: RelayState,
    terminal_id: String,
    peer_kind: TerminalPeerKind,
    socket: WebSocket,
) -> Result<()> {
    let connected_at = Instant::now();
    let (mut outbound, mut inbound) = socket.split();
    let budget_scope = state.terminal_queue_budget_scope(&terminal_id).await?;
    let (tx, mut rx) = message_channel(
        TERMINAL_WS_QUEUE_CAPACITY,
        TERMINAL_WS_QUEUE_BYTE_CAPACITY,
        Arc::clone(&state.queue_budget),
        budget_scope,
    );
    let connection_id = state
        .register_terminal_connection(&terminal_id, peer_kind, tx.clone())
        .await?;

    info!(
        event = "relay_terminal_connection",
        action = "attached",
        %terminal_id,
        connection_id,
        peer = ?peer_kind,
        "relay terminal peer attached"
    );

    let outbound_messages = Arc::new(AtomicUsize::new(0));
    let outbound_bytes = Arc::new(AtomicUsize::new(0));
    let writer_messages = Arc::clone(&outbound_messages);
    let writer_bytes = Arc::clone(&outbound_bytes);

    let writer = tokio::spawn(async move {
        while let Some(queued) = rx.recv_queued().await {
            let QueuedMessage {
                message,
                _reservation: reservation,
            } = queued;
            let message_bytes = websocket_message_size(&message);
            let send_result = outbound.send(message).await;
            drop(reservation);
            if send_result.is_err() {
                return true;
            }
            writer_messages.fetch_add(1, Ordering::Relaxed);
            writer_bytes.fetch_add(message_bytes, Ordering::Relaxed);
        }
        false
    });

    let mut inbound_messages = 0_usize;
    let mut inbound_bytes = 0_usize;
    let mut resize_messages = 0_usize;
    let mut close_reason = "peer_closed";
    let mut connection_error = None;
    while let Some(message) = inbound.next().await {
        let message = match message {
            Ok(message) => message,
            Err(err) => {
                close_reason = "read_error";
                connection_error = Some(anyhow::Error::from(err));
                break;
            }
        };

        inbound_messages = inbound_messages.saturating_add(1);
        inbound_bytes = inbound_bytes.saturating_add(websocket_message_size(&message));
        if peer_kind == TerminalPeerKind::Browser
            && RelayState::extract_ttyd_command(&message) == Some(TTYD_CMD_RESIZE)
        {
            resize_messages = resize_messages.saturating_add(1);
        }

        if !state
            .forward_terminal_message(&terminal_id, peer_kind, connection_id, &message)
            .await
        {
            close_reason = "forward_rejected";
            break;
        }

        if matches!(message, Message::Close(_)) {
            close_reason = "close_frame";
            break;
        }
    }

    drop(tx);
    state
        .unregister_terminal_connection(&terminal_id, peer_kind, connection_id)
        .await;
    let writer_failed = writer.await.unwrap_or(true);
    info!(
        event = "relay_terminal_connection",
        action = "detached",
        %terminal_id,
        connection_id,
        peer = ?peer_kind,
        close_reason,
        duration_ms = connected_at.elapsed().as_millis() as u64,
        inbound_messages,
        inbound_bytes,
        outbound_messages = outbound_messages.load(Ordering::Relaxed),
        outbound_bytes = outbound_bytes.load(Ordering::Relaxed),
        resize_messages,
        writer_failed,
        error = connection_error.as_ref().map(ToString::to_string),
        "relay terminal peer detached"
    );
    if let Some(err) = connection_error {
        return Err(err);
    }
    Ok(())
}

impl RelayState {
    async fn terminal_queue_budget_scope(&self, terminal_id: &str) -> Result<QueueBudgetScope> {
        let inner = self.inner.lock().await;
        let session = inner
            .terminal_sessions
            .get(terminal_id)
            .ok_or_else(|| anyhow::anyhow!("terminal session not found"))?;
        Ok(QueueBudgetScope::terminal(
            &session.owner_user_id,
            terminal_id,
        ))
    }

    async fn create_terminal_session(
        &self,
        user_id: &str,
        device_id: &str,
        session_id: &str,
    ) -> std::result::Result<String, (StatusCode, String)> {
        let normalized_session_id = session_id.trim();
        if normalized_session_id.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Session id is required.".to_string(),
            ));
        }

        enum TerminalSessionStart {
            Reuse {
                terminal_id: String,
            },
            StartOrRetry {
                terminal_id: String,
                attach_generation: u64,
                bridge_tx: MessageSender,
                payload: String,
            },
        }

        let start = {
            let mut inner = self.inner.lock().await;
            let Some(device) = inner.devices.get(device_id) else {
                return Err((StatusCode::NOT_FOUND, "Device not found.".to_string()));
            };
            if device.owner_user_id != user_id {
                return Err((StatusCode::FORBIDDEN, "Device access denied.".to_string()));
            }

            let bridge_tx = inner
                .channels
                .get(device_id)
                .and_then(|channel| channel.bridge.as_ref())
                .filter(|record| record.user_id == user_id)
                .map(|record| record.tx.clone())
                .ok_or((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device is offline.".to_string(),
                ))?;

            if let Some(existing) = inner.terminal_sessions.values_mut().find(|session| {
                session.owner_user_id == user_id
                    && session.device_id == device_id
                    && session.session_id == normalized_session_id
                    && session.browser.is_none()
            }) {
                let terminal_id = existing.terminal_id.clone();
                existing.browser_disconnected_at = None;
                if existing.bridge.is_some() {
                    TerminalSessionStart::Reuse { terminal_id }
                } else {
                    existing.attach_generation = existing.attach_generation.saturating_add(1);
                    existing.attach_deadline = Some(Instant::now() + TERMINAL_ATTACH_TTL);
                    let attach_generation = existing.attach_generation;
                    let payload =
                        serde_json::to_string(&BrowserToBridgeMessage::TerminalProxyStart {
                            terminal_id: terminal_id.clone(),
                            session_id: normalized_session_id.to_string(),
                        })
                        .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;

                    TerminalSessionStart::StartOrRetry {
                        terminal_id,
                        attach_generation,
                        bridge_tx,
                        payload,
                    }
                }
            } else {
                if inner
                    .terminal_sessions
                    .values()
                    .filter(|session| session.owner_user_id == user_id)
                    .count()
                    >= MAX_TERMINAL_SESSIONS_PER_USER
                {
                    return Err((
                        StatusCode::TOO_MANY_REQUESTS,
                        "Too many relay terminal sessions for this user.".to_string(),
                    ));
                }
                if inner.terminal_sessions.len() >= MAX_TERMINAL_SESSIONS
                    || inner
                        .terminal_sessions
                        .values()
                        .filter(|session| session.device_id == device_id)
                        .count()
                        >= MAX_TERMINAL_SESSIONS_PER_DEVICE
                {
                    return Err((
                        StatusCode::TOO_MANY_REQUESTS,
                        "Too many relay terminal sessions.".to_string(),
                    ));
                }
                let terminal_id = Uuid::new_v4().to_string();
                let attach_generation = 1;

                inner.terminal_sessions.insert(
                    terminal_id.clone(),
                    TerminalSessionRecord {
                        terminal_id: terminal_id.clone(),
                        session_id: normalized_session_id.to_string(),
                        device_id: device_id.to_string(),
                        owner_user_id: user_id.to_string(),
                        browser: None,
                        bridge: None,
                        browser_disconnected_at: None,
                        attach_generation,
                        attach_deadline: Some(Instant::now() + TERMINAL_ATTACH_TTL),
                        browser_paused: false,
                        pause_buffer: Vec::new(),
                        pause_buffer_bytes: 0,
                        pending_browser_frames: Vec::new(),
                        pending_browser_frame_bytes: 0,
                    },
                );

                let payload = serde_json::to_string(&BrowserToBridgeMessage::TerminalProxyStart {
                    terminal_id: terminal_id.clone(),
                    session_id: normalized_session_id.to_string(),
                })
                .map_err(|err| (StatusCode::BAD_GATEWAY, err.to_string()))?;

                TerminalSessionStart::StartOrRetry {
                    terminal_id,
                    attach_generation,
                    bridge_tx,
                    payload,
                }
            }
        };

        let terminal_id = match start {
            TerminalSessionStart::Reuse { terminal_id } => {
                info!(
                    event = "relay_terminal_session",
                    action = "reuse",
                    %terminal_id,
                    %device_id,
                    session_id = normalized_session_id,
                    "reusing attached relay terminal session"
                );
                terminal_id
            }
            TerminalSessionStart::StartOrRetry {
                terminal_id,
                attach_generation,
                bridge_tx,
                payload,
            } => {
                info!(
                    event = "relay_terminal_session",
                    action = "start_or_retry",
                    %terminal_id,
                    %device_id,
                    session_id = normalized_session_id,
                    attach_generation,
                    "requesting bridge terminal proxy"
                );
                if bridge_tx.try_send(Message::Text(payload.into())).is_err() {
                    warn!(
                        event = "relay_terminal_session",
                        action = "bridge_start_queue_failed",
                        %terminal_id,
                        %device_id,
                        session_id = normalized_session_id,
                        attach_generation,
                        "bridge disconnected before terminal proxy request could be queued"
                    );
                    let mut inner = self.inner.lock().await;
                    if inner
                        .terminal_sessions
                        .get(&terminal_id)
                        .is_some_and(|session| {
                            session.attach_generation == attach_generation
                                && session.bridge.is_none()
                        })
                    {
                        inner.terminal_sessions.remove(&terminal_id);
                    }
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Device disconnected before terminal could start.".to_string(),
                    ));
                }
                self.schedule_terminal_attach_timeout(terminal_id.clone(), attach_generation);
                terminal_id
            }
        };

        Ok(terminal_id)
    }

    fn schedule_terminal_attach_timeout(&self, terminal_id: String, attach_generation: u64) {
        let state = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(TERMINAL_ATTACH_TTL).await;
            state
                .expire_unattached_terminal(&terminal_id, attach_generation)
                .await;
        });
    }

    async fn expire_unattached_terminal(&self, terminal_id: &str, attach_generation: u64) {
        let browser = {
            let mut inner = self.inner.lock().await;
            let should_expire = inner
                .terminal_sessions
                .get(terminal_id)
                .is_some_and(|session| {
                    session.attach_generation == attach_generation
                        && session.bridge.is_none()
                        && session
                            .attach_deadline
                            .is_some_and(|deadline| deadline <= Instant::now())
                });
            if !should_expire {
                return;
            }
            inner
                .terminal_sessions
                .remove(terminal_id)
                .and_then(|session| session.browser.map(|record| record.tx))
        };

        if let Some(browser) = browser {
            warn!(
                event = "relay_terminal_session",
                action = "attach_timeout",
                %terminal_id,
                attach_generation,
                "bridge did not attach the relay terminal before the deadline"
            );
            let _ = browser.try_send(Message::Close(Some(CloseFrame {
                code: 1013,
                reason: "Paired device failed to attach the relay terminal.".into(),
            })));
        }
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
        if session.bridge.is_none()
            && session
                .attach_deadline
                .is_some_and(|deadline| deadline <= Instant::now())
        {
            return Err((
                StatusCode::GATEWAY_TIMEOUT,
                "Paired device failed to attach the relay terminal.".to_string(),
            ));
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
        let Some(device) = inner.devices.get(device_id) else {
            return Err((StatusCode::NOT_FOUND, "Device not found.".to_string()));
        };
        if session.device_id != device_id || session.owner_user_id != device.owner_user_id {
            return Err((StatusCode::FORBIDDEN, "Terminal access denied.".to_string()));
        }
        Ok(())
    }

    async fn register_terminal_connection(
        &self,
        terminal_id: &str,
        peer_kind: TerminalPeerKind,
        tx: MessageSender,
    ) -> Result<u64> {
        let pending_tx = tx.clone();
        let (connection_id, replaced, pending_browser_messages) = {
            let mut inner = self.inner.lock().await;
            let connection_id = inner.next_terminal_connection_id;
            inner.next_terminal_connection_id = inner.next_terminal_connection_id.saturating_add(1);
            let session = inner
                .terminal_sessions
                .get_mut(terminal_id)
                .ok_or_else(|| anyhow::anyhow!("terminal session not found"))?;
            if peer_kind == TerminalPeerKind::Bridge
                && session.bridge.is_none()
                && session
                    .attach_deadline
                    .is_some_and(|deadline| deadline <= Instant::now())
            {
                anyhow::bail!("terminal attach deadline expired");
            }
            let record = TerminalConnectionRecord {
                id: connection_id,
                tx,
            };
            let (replaced, pending_browser_messages) = match peer_kind {
                TerminalPeerKind::Browser => {
                    session.browser_disconnected_at = None;
                    session.pending_browser_frames.clear();
                    session.pending_browser_frame_bytes = 0;
                    (
                        session.browser.replace(record).map(|record| record.tx),
                        Vec::new(),
                    )
                }
                TerminalPeerKind::Bridge => {
                    let replaced = session.bridge.replace(record).map(|record| record.tx);
                    session.attach_deadline = None;
                    // The browser is intentionally allowed to connect while the bridge
                    // catches up. Preserve its ttyd handshake/input until the bridge
                    // socket exists so the first readiness frame cannot be lost.
                    session.pending_browser_frame_bytes = 0;
                    let pending = std::mem::take(&mut session.pending_browser_frames);
                    (replaced, pending)
                }
            };
            (connection_id, replaced, pending_browser_messages)
        };

        if let Some(previous) = replaced {
            let _ = previous.try_send(Message::Close(None));
        }
        if !pending_browser_messages.is_empty() {
            let pending_count = pending_browser_messages.len();
            let mut replayed_count = 0_usize;
            let mut replay_failure = None;
            for message in pending_browser_messages {
                match pending_tx.try_send(message) {
                    Ok(()) => replayed_count = replayed_count.saturating_add(1),
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        replay_failure = Some("queue_full");
                        break;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        replay_failure = Some("queue_closed");
                        break;
                    }
                }
            }
            if let Some(reason) = replay_failure {
                warn!(
                    event = "relay_terminal_connection",
                    action = "pending_browser_replay_failed",
                    %terminal_id,
                    connection_id,
                    pending_count,
                    replayed_count,
                    reason,
                    "failed to replay browser terminal frames after bridge attach"
                );
                self.unregister_terminal_connection(
                    terminal_id,
                    TerminalPeerKind::Bridge,
                    connection_id,
                )
                .await;
                anyhow::bail!("failed to replay pending browser terminal frames: {reason}");
            }
            info!(
                event = "relay_terminal_connection",
                action = "pending_browser_replayed",
                %terminal_id,
                connection_id,
                pending_count,
                replayed_count,
                "replayed browser terminal frames after bridge attach"
            );
        }
        Ok(connection_id)
    }

    async fn unregister_terminal_connection(
        &self,
        terminal_id: &str,
        peer_kind: TerminalPeerKind,
        connection_id: u64,
    ) {
        let mut bridge_cleanup = None;
        let counterpart = {
            let mut inner = self.inner.lock().await;
            let Some(session) = inner.terminal_sessions.get_mut(terminal_id) else {
                return;
            };

            let is_current = match peer_kind {
                TerminalPeerKind::Browser => session
                    .browser
                    .as_ref()
                    .is_some_and(|record| record.id == connection_id),
                TerminalPeerKind::Bridge => session
                    .bridge
                    .as_ref()
                    .is_some_and(|record| record.id == connection_id),
            };
            if !is_current {
                return;
            }

            match peer_kind {
                TerminalPeerKind::Browser => {
                    session.browser = None;
                    if session.bridge.is_some() || session.browser_disconnected_at.is_some() {
                        let disconnected_at =
                            session.browser_disconnected_at.unwrap_or_else(Instant::now);
                        session.browser_disconnected_at = Some(disconnected_at);
                        bridge_cleanup = Some(disconnected_at);
                        None
                    } else {
                        inner.terminal_sessions.remove(terminal_id);
                        None
                    }
                }
                TerminalPeerKind::Bridge => {
                    session.bridge = None;
                    if session.browser.is_some() {
                        let disconnected_at = Instant::now();
                        session.browser_disconnected_at = Some(disconnected_at);
                        bridge_cleanup = Some(disconnected_at);
                        session.browser.as_ref().map(|record| record.tx.clone())
                    } else {
                        inner.terminal_sessions.remove(terminal_id);
                        None
                    }
                }
            }
        };

        if let Some(disconnected_at) = bridge_cleanup {
            let state = self.clone();
            let terminal_id = terminal_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(TERMINAL_BROWSER_REATTACH_GRACE).await;
                state
                    .cleanup_terminal_session_if_browser_absent(&terminal_id, disconnected_at)
                    .await;
            });
        }

        if let Some(counterpart) = counterpart {
            let _ = counterpart.try_send(Message::Close(None));
        }
    }

    async fn cleanup_terminal_session_if_browser_absent(
        &self,
        terminal_id: &str,
        disconnected_at: Instant,
    ) {
        let bridge = {
            let mut inner = self.inner.lock().await;
            let Some(session) = inner.terminal_sessions.get(terminal_id) else {
                return;
            };
            if session.browser.is_some() || session.browser_disconnected_at != Some(disconnected_at)
            {
                return;
            }

            inner
                .terminal_sessions
                .remove(terminal_id)
                .and_then(|session| session.bridge.map(|record| record.tx))
        };

        if let Some(bridge) = bridge {
            let _ = bridge.try_send(Message::Close(None));
        }
    }

    async fn forward_terminal_message(
        &self,
        terminal_id: &str,
        peer_kind: TerminalPeerKind,
        connection_id: u64,
        message: &Message,
    ) -> bool {
        let current_sender = {
            let inner = self.inner.lock().await;
            inner
                .terminal_sessions
                .get(terminal_id)
                .and_then(|session| match peer_kind {
                    TerminalPeerKind::Browser => session.browser.as_ref(),
                    TerminalPeerKind::Bridge => session.bridge.as_ref(),
                })
                .filter(|record| record.id == connection_id)
                .map(|record| record.tx.clone())
        };
        let Some(current_sender) = current_sender else {
            return false;
        };
        let message_bytes = websocket_message_size(message);
        let message_limit = match peer_kind {
            TerminalPeerKind::Browser => MAX_WS_MESSAGE_BYTES,
            TerminalPeerKind::Bridge => MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES,
        };
        if message_bytes > message_limit {
            warn!(
                event = "relay_terminal_message",
                action = "rejected_oversized",
                %terminal_id,
                ?peer_kind,
                message_bytes,
                message_limit,
                "relay terminal message exceeded its directional byte limit"
            );
            let _ = current_sender.try_send(Message::Close(Some(CloseFrame {
                code: 1009,
                reason: "Relay WebSocket message exceeded the byte limit.".into(),
            })));
            return false;
        }

        // Handle PAUSE/RESUME control frames from the browser peer.
        if peer_kind == TerminalPeerKind::Browser {
            if let Some(cmd) = Self::extract_ttyd_command(message) {
                match cmd {
                    TTYD_CMD_PAUSE => {
                        info!(%terminal_id, "relay terminal browser sent PAUSE");
                        let bridge_tx = {
                            let mut inner = self.inner.lock().await;
                            let Some(session) = inner.terminal_sessions.get_mut(terminal_id) else {
                                return false;
                            };
                            if !session.connection_is_current(peer_kind, connection_id) {
                                return false;
                            }
                            session.browser_paused = true;
                            session.pause_buffer.clear();
                            session.pause_buffer_bytes = 0;
                            session.bridge.as_ref().map(|record| record.tx.clone())
                        };
                        // Forward PAUSE to bridge so upstream can also pause if supported.
                        if let Some(tx) = bridge_tx {
                            let _ = tx.try_send(Message::Binary(vec![TTYD_CMD_PAUSE].into()));
                        }
                        return true;
                    }
                    TTYD_CMD_RESUME => {
                        info!(%terminal_id, "relay terminal browser sent RESUME");
                        // Collect buffered messages, replay them, and forward RESUME — all
                        // orchestrated from a SINGLE lock acquisition to prevent bridge frames
                        // from racing between the pause_buffer drain and the state change.
                        let bridge_tx = {
                            let mut inner = self.inner.lock().await;
                            if let Some(session) = inner.terminal_sessions.get_mut(terminal_id) {
                                if !session.connection_is_current(peer_kind, connection_id) {
                                    return false;
                                }
                                let buffered = std::mem::take(&mut session.pause_buffer);
                                session.pause_buffer_bytes = 0;
                                let browser_tx = session.browser.as_ref().map(|r| r.tx.clone());
                                // Replay buffered messages WHILE still holding the lock so no
                                // bridge frame can overtake or sneak into the drained buffer.
                                if let Some(ref tx) = browser_tx {
                                    for buffered_msg in buffered {
                                        if tx.try_send(buffered_msg).is_err() {
                                            break;
                                        }
                                    }
                                }
                                // Only NOW mark as un-paused — after replay is complete.
                                session.browser_paused = false;
                                session.bridge.as_ref().map(|r| r.tx.clone())
                            } else {
                                None
                            }
                        };
                        // Lock is dropped; safe to forward RESUME to bridge.
                        if let Some(tx) = bridge_tx {
                            let _ = tx.try_send(Message::Binary(vec![TTYD_CMD_RESUME].into()));
                        }
                        return true;
                    }
                    TTYD_CMD_RESIZE => {
                        let (bridge_tx, buffered) = {
                            let mut inner = self.inner.lock().await;
                            let Some(session) = inner.terminal_sessions.get_mut(terminal_id) else {
                                return false;
                            };
                            if !session.connection_is_current(peer_kind, connection_id) {
                                return false;
                            }
                            let bridge_tx = session.bridge.as_ref().map(|record| record.tx.clone());
                            let buffered = if bridge_tx.is_none() {
                                clone_websocket_message(message).is_some_and(|cloned| {
                                    session.buffer_pending_browser_frame(cloned)
                                })
                            } else {
                                false
                            };
                            (bridge_tx, buffered)
                        };
                        if bridge_tx.is_none() {
                            return buffered;
                        }
                        if let (Some(tx), Some(cloned)) =
                            (bridge_tx, clone_websocket_message(message))
                        {
                            match tx.try_send(cloned) {
                                Ok(()) => {}
                                Err(mpsc::error::TrySendError::Full(_)) => {
                                    warn!(
                                        event = "relay_terminal_forward_failed",
                                        %terminal_id,
                                        connection_id,
                                        direction = "browser_to_bridge",
                                        reason = "queue_full",
                                        "terminal resize could not be forwarded"
                                    );
                                    return false;
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    warn!(
                                        event = "relay_terminal_forward_failed",
                                        %terminal_id,
                                        connection_id,
                                        direction = "browser_to_bridge",
                                        reason = "queue_closed",
                                        "terminal resize could not be forwarded"
                                    );
                                    return false;
                                }
                            }
                        }
                        return true;
                    }
                    _ => {}
                }
            }
        }

        // When the browser is paused, buffer bridge→browser output instead of forwarding.
        // Check browser_paused AND append in a single lock acquisition to prevent TOCTOU races
        // where a bridge frame could arrive between the check and the append.
        if peer_kind == TerminalPeerKind::Bridge {
            let mut inner = self.inner.lock().await;
            let Some(session) = inner.terminal_sessions.get_mut(terminal_id) else {
                return false;
            };
            if !session.connection_is_current(peer_kind, connection_id) {
                return false;
            }
            if session.browser_paused {
                if let Some(cloned) = clone_websocket_message(message) {
                    let _ = session.buffer_paused_output(cloned);
                }
                return true;
            }
        }

        // Default: forward to the counterpart peer.
        let counterpart = {
            let inner = self.inner.lock().await;
            inner
                .terminal_sessions
                .get(terminal_id)
                .filter(|session| session.connection_is_current(peer_kind, connection_id))
                .and_then(|session| match peer_kind {
                    TerminalPeerKind::Browser => session.bridge.as_ref(),
                    TerminalPeerKind::Bridge => session.browser.as_ref(),
                })
                .map(|record| record.tx.clone())
        };

        if counterpart.is_none() && peer_kind == TerminalPeerKind::Browser {
            let mut inner = self.inner.lock().await;
            let Some(session) = inner.terminal_sessions.get_mut(terminal_id) else {
                return false;
            };
            if !session.connection_is_current(peer_kind, connection_id) {
                return false;
            }
            if let Some(cloned) = clone_websocket_message(message) {
                return session.buffer_pending_browser_frame(cloned);
            }
        }

        if let (Some(counterpart), Some(cloned)) = (counterpart, clone_websocket_message(message)) {
            match counterpart.try_send(cloned) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    warn!(
                        event = "relay_terminal_forward_failed",
                        %terminal_id,
                        connection_id,
                        peer = ?peer_kind,
                        reason = "queue_full",
                        message_bytes = websocket_message_size(message),
                        "terminal frame could not be forwarded"
                    );
                    return false;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    warn!(
                        event = "relay_terminal_forward_failed",
                        %terminal_id,
                        connection_id,
                        peer = ?peer_kind,
                        reason = "queue_closed",
                        message_bytes = websocket_message_size(message),
                        "terminal frame could not be forwarded"
                    );
                    return false;
                }
            }
        }
        true
    }

    /// Extract the ttyd command byte from a WebSocket message.
    /// Returns the first byte for binary messages, or None for text/non-binary.
    fn extract_ttyd_command(message: &Message) -> Option<u8> {
        match message {
            Message::Binary(data) if !data.is_empty() => Some(data[0]),
            _ => None,
        }
    }

    async fn register_connection(
        &self,
        key: &str,
        peer_kind: PeerKind,
        user_id: String,
        tx: MessageSender,
        initial_status: Option<BridgeStatus>,
    ) -> Result<u64> {
        let (connection_id, replaced) = {
            let mut inner = self.inner.lock().await;
            if inner
                .devices
                .get(key)
                .is_some_and(|device| device.owner_user_id != user_id)
            {
                anyhow::bail!("device owner does not match relay channel owner");
            }

            if let Some(channel) = inner.channels.get(key) {
                if channel
                    .bridge
                    .as_ref()
                    .is_some_and(|bridge| bridge.user_id != user_id)
                    || channel
                        .browsers
                        .values()
                        .any(|browser| browser.user_id != user_id)
                {
                    anyhow::bail!("relay channel is already owned by another user");
                }
            }

            inner.ensure_connection_capacity(key, peer_kind, &user_id)?;

            let connection_id = inner.next_connection_id;
            inner.next_connection_id = inner.next_connection_id.saturating_add(1);
            let channel = inner.channels.entry(key.to_string()).or_default();
            let record = ConnectionRecord {
                id: connection_id,
                user_id,
                tx,
            };

            let replaced = match peer_kind {
                PeerKind::Bridge => {
                    let replaced = channel.bridge.replace(record).map(|record| record.tx);
                    channel.last_status = Some(initial_status.unwrap_or_else(|| BridgeStatus {
                        hostname: host_name(),
                        os: env::consts::OS.to_string(),
                        connected: true,
                        version: None,
                    }));
                    replaced
                }
                PeerKind::Browser => {
                    channel.browsers.insert(connection_id, record);
                    None
                }
            };
            (connection_id, replaced)
        };

        if let Some(replaced) = replaced {
            let _ = replaced.try_send(Message::Close(Some(CloseFrame {
                code: 1012,
                reason: "Relay control channel was replaced by a reconnect.".into(),
            })));
        }
        Ok(connection_id)
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
                                    version: last.version,
                                })
                                .unwrap_or(BridgeStatus {
                                    hostname: host_name(),
                                    os: env::consts::OS.to_string(),
                                    connected: false,
                                    version: None,
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
                    if let Some(pending) = inner.take_pending_api(&request_id) {
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
                    if let Some(pending) = inner.take_pending_preview(&request_id) {
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
                version: status.version,
            }) {
                for browser in browsers_to_notify {
                    let _ = browser.try_send(Message::Text(text.clone().into()));
                }
            }
        }
    }

    async fn route_browser_message(
        &self,
        key: &str,
        connection_id: u64,
        user_id: &str,
        message: BrowserToBridgeMessage,
        raw_text: String,
        browser_tx: &MessageSender,
    ) -> Result<()> {
        let authorized = {
            let inner = self.inner.lock().await;
            inner.channels.get(key).is_some_and(|channel| {
                channel.browsers.get(&connection_id).is_some_and(|browser| {
                    browser.user_id == user_id
                        && channel
                            .bridge
                            .as_ref()
                            .is_some_and(|bridge| bridge.user_id == user_id)
                        && inner
                            .devices
                            .get(key)
                            .is_none_or(|device| device.owner_user_id == user_id)
                })
            })
        };
        if !authorized {
            match &message {
                BrowserToBridgeMessage::ApiRequest { id, .. } => {
                    send_bridge_error(
                        browser_tx,
                        id,
                        StatusCode::FORBIDDEN,
                        "Relay channel access denied.",
                    )
                    .await;
                }
                BrowserToBridgeMessage::PreviewRequest { id, .. } => {
                    send_bridge_preview_error(
                        browser_tx,
                        id,
                        StatusCode::FORBIDDEN,
                        "Relay channel access denied.",
                    )
                    .await;
                }
                _ => {}
            }
            anyhow::bail!("relay channel access denied");
        }
        if raw_text.len() > MAX_WS_MESSAGE_BYTES {
            anyhow::bail!("relay message exceeded the byte limit");
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

        if bridge_tx.try_send(Message::Text(raw_text.into())).is_err() {
            match &message {
                BrowserToBridgeMessage::ApiRequest { id, .. } => {
                    send_bridge_error(
                        browser_tx,
                        id,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Bridge outbound queue is full.",
                    )
                    .await;
                }
                BrowserToBridgeMessage::PreviewRequest { id, .. } => {
                    send_bridge_preview_error(
                        browser_tx,
                        id,
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Bridge outbound queue is full.",
                    )
                    .await;
                }
                _ => {}
            }
            anyhow::bail!("bridge outbound queue is full");
        }
        Ok(())
    }

    async fn route_bridge_message(
        &self,
        key: &str,
        connection_id: u64,
        message: BridgeToBrowserMessage,
        raw_text: String,
    ) -> bool {
        let active = {
            let inner = self.inner.lock().await;
            inner.bridge_connection_is_current(key, connection_id)
        };
        if !active || raw_text.len() > MAX_WS_MESSAGE_BYTES {
            return false;
        }

        if let BridgeToBrowserMessage::ApiResponse { id, status, body } = &message {
            let (pending, wrong_device) = {
                let mut inner = self.inner.lock().await;
                if !inner.bridge_connection_is_current(key, connection_id) {
                    return false;
                }
                let wrong_device = inner
                    .pending_api_requests
                    .get(id)
                    .is_some_and(|pending| pending.device_id != key);
                (inner.take_pending_api_for_device(id, key), wrong_device)
            };

            if let Some(pending) = pending {
                let _ = pending.tx.send(ProxiedApiResponse {
                    status: *status,
                    body: body.clone(),
                });
                return true;
            }
            if wrong_device {
                return true;
            }
        }

        if let BridgeToBrowserMessage::PreviewResponse {
            id,
            status,
            headers,
            body_base64,
        } = &message
        {
            let (pending, wrong_device) = {
                let mut inner = self.inner.lock().await;
                if !inner.bridge_connection_is_current(key, connection_id) {
                    return false;
                }
                let wrong_device = inner
                    .pending_preview_requests
                    .get(id)
                    .is_some_and(|pending| pending.device_id != key);
                (inner.take_pending_preview_for_device(id, key), wrong_device)
            };

            if let Some(pending) = pending {
                let _ = pending.tx.send(ProxiedPreviewResponse {
                    status: *status,
                    headers: headers.clone(),
                    body_base64: body_base64.clone(),
                });
                return true;
            }
            if wrong_device {
                return true;
            }
        }

        let browsers = {
            let mut inner = self.inner.lock().await;
            if !inner.bridge_connection_is_current(key, connection_id) {
                return false;
            }
            let Some(channel) = inner.channels.get_mut(key) else {
                return false;
            };
            let Some(bridge_owner) = channel
                .bridge
                .as_ref()
                .filter(|bridge| bridge.id == connection_id)
                .map(|bridge| bridge.user_id.clone())
            else {
                return false;
            };

            if let BridgeToBrowserMessage::BridgeStatus {
                hostname,
                os,
                connected,
                version,
            } = &message
            {
                channel.last_status = Some(BridgeStatus {
                    hostname: hostname.clone(),
                    os: os.clone(),
                    connected: *connected,
                    version: normalize_bridge_version(version.clone()),
                });
            }

            channel
                .browsers
                .values()
                .filter(|record| record.user_id == bridge_owner)
                .map(|record| record.tx.clone())
                .collect::<Vec<_>>()
        };

        for browser in browsers {
            let _ = browser.try_send(Message::Text(raw_text.clone().into()));
        }
        true
    }

    async fn broadcast_bridge_status(&self, key: &str, connection_id: u64, connected: bool) {
        let (status, browsers) = {
            let mut inner = self.inner.lock().await;
            let Some(channel) = inner.channels.get_mut(key) else {
                return;
            };
            if channel
                .bridge
                .as_ref()
                .is_none_or(|bridge| bridge.id != connection_id)
            {
                return;
            }

            let status = channel
                .last_status
                .clone()
                .map(|last| BridgeStatus {
                    hostname: last.hostname,
                    os: last.os,
                    connected,
                    version: last.version,
                })
                .unwrap_or(BridgeStatus {
                    hostname: host_name(),
                    os: env::consts::OS.to_string(),
                    connected,
                    version: None,
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
            version: status.version,
        }) {
            for browser in browsers {
                let _ = browser.try_send(Message::Text(text.clone().into()));
            }
        }
    }

    async fn send_browser_status_snapshot(&self, key: &str, tx: &MessageSender) {
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
                    version: None,
                })
        };

        if let Ok(text) = serde_json::to_string(&BridgeToBrowserMessage::BridgeStatus {
            hostname: status.hostname,
            os: status.os,
            connected: status.connected,
            version: status.version,
        }) {
            let _ = tx.try_send(Message::Text(text.into()));
        }
    }

    async fn consume_rate_limit(&self, user_id: &str, now: Instant) -> bool {
        let mut inner = self.inner.lock().await;
        let key = format!("dashboard:{user_id}");
        inner.ensure_rate_limit_bucket(
            &key,
            now,
            DEFAULT_RATE_LIMIT_BURST as f64,
            DEFAULT_RATE_LIMIT_REFILL_PER_SECOND,
        );
        let bucket = inner
            .rate_limits
            .get_mut(&key)
            .expect("rate-limit bucket should exist");
        bucket.allow(now)
    }

    async fn consume_device_claim_rate_limit(&self, rate_limit_key: &str, now: Instant) -> bool {
        let mut inner = self.inner.lock().await;
        inner.ensure_rate_limit_bucket(
            rate_limit_key,
            now,
            DEVICE_CLAIM_RATE_LIMIT_BURST as f64,
            DEVICE_CLAIM_RATE_LIMIT_REFILL_PER_SECOND,
        );
        inner.ensure_rate_limit_bucket(
            DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY,
            now,
            DEVICE_CLAIM_GLOBAL_RATE_LIMIT_BURST as f64,
            DEVICE_CLAIM_GLOBAL_RATE_LIMIT_REFILL_PER_SECOND,
        );

        for key in [rate_limit_key, DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY] {
            inner
                .rate_limits
                .get_mut(key)
                .expect("device-claim rate-limit bucket should exist")
                .refill(now);
        }
        if [rate_limit_key, DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY]
            .iter()
            .any(|key| {
                inner
                    .rate_limits
                    .get(*key)
                    .is_none_or(|bucket| bucket.tokens < 1.0)
            })
        {
            return false;
        }
        for key in [rate_limit_key, DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY] {
            let bucket = inner
                .rate_limits
                .get_mut(key)
                .expect("device-claim rate-limit bucket should exist");
            bucket.tokens -= 1.0;
        }
        true
    }

    async fn disconnect_bridge_for_user(
        &self,
        user_id: &str,
        bridge_id: &str,
    ) -> (
        Vec<MessageSender>,
        Vec<MessageSender>,
        Vec<oneshot::Sender<ProxiedApiResponse>>,
        Vec<oneshot::Sender<ProxiedPreviewResponse>>,
        bool,
    ) {
        let mut bridge_txs = Vec::new();
        let mut browser_txs = Vec::new();
        let mut pending_api_requests = Vec::new();
        let mut pending_preview_requests = Vec::new();
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
        let pending_preview_ids = inner
            .pending_preview_requests
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
            if let Some(pending) = inner.take_pending_api(&request_id) {
                pending_api_requests.push(pending.tx);
            }
        }
        for request_id in pending_preview_ids {
            if let Some(pending) = inner.take_pending_preview(&request_id) {
                pending_preview_requests.push(pending.tx);
            }
        }

        (
            bridge_txs,
            browser_txs,
            pending_api_requests,
            pending_preview_requests,
            removed,
        )
    }

    async fn create_pairing_code(
        &self,
        user_id: String,
        _suggested_name: String,
    ) -> std::result::Result<String, (StatusCode, &'static str)> {
        let mut inner = self.inner.lock().await;
        inner.prune_pairing_codes();
        inner.prune_device_claims();

        if inner.pairing_codes.len() >= MAX_PENDING_PAIRING_CODES {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Too many pending pairing codes.",
            ));
        }

        let code = generate_pairing_code();
        let now = Instant::now();
        inner.pairing_codes.insert(
            code.clone(),
            PendingPairing {
                owner_user_id: user_id,
                expires_at: now + PAIRING_CODE_TTL,
            },
        );
        Ok(code)
    }

    async fn create_device_claim(
        &self,
        request: DeviceClaimCreateRequest,
        rate_limit_key: &str,
    ) -> std::result::Result<DeviceClaimCreateResponse, (StatusCode, &'static str)> {
        if request.device_id.trim().is_empty()
            || request.hostname.trim().is_empty()
            || request.os.trim().is_empty()
            || request.arch.trim().is_empty()
        {
            return Err((StatusCode::BAD_REQUEST, "Missing required claim fields."));
        }
        let suggested_name = request
            .suggested_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let request_bytes = device_identity_bytes(
            request.device_id.trim(),
            request.hostname.trim(),
            request.os.trim(),
            request.arch.trim(),
            suggested_name
                .as_deref()
                .unwrap_or_else(|| request.hostname.trim()),
        );
        if request_bytes > MAX_DEVICE_IDENTITY_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Device claim fields exceed the relay byte limit.",
            ));
        }

        let now = Instant::now();
        if !self
            .consume_device_claim_rate_limit(rate_limit_key, now)
            .await
        {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Too many device claim requests. Please try again later.",
            ));
        }

        let claim_token = generate_claim_token();
        let poll_token = generate_claim_token();
        let expires_at = now + PAIRING_CODE_TTL;

        let mut inner = self.inner.lock().await;
        inner.prune_device_claims();
        if inner.device_claims.len() >= MAX_PENDING_DEVICE_CLAIMS
            || inner
                .pending_device_claim_bytes
                .saturating_add(request_bytes)
                > MAX_PENDING_DEVICE_CLAIM_BYTES
        {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "Too many pending device claims.",
            ));
        }
        inner.device_claims.insert(
            claim_token.clone(),
            PendingDeviceClaim {
                poll_token: poll_token.clone(),
                device_id: request.device_id.trim().to_string(),
                hostname: request.hostname.trim().to_string(),
                os: request.os.trim().to_string(),
                arch: request.arch.trim().to_string(),
                suggested_name,
                expires_at,
                paired_response: None,
                pairing_in_progress: false,
                request_bytes,
            },
        );
        inner.pending_device_claim_bytes = inner
            .pending_device_claim_bytes
            .saturating_add(request_bytes);

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

        let mut persistence = self.persistence.lock().await;
        let (claim, response, rollback, snapshot) = {
            let mut inner = self.inner.lock().await;
            inner.prune_device_claims();

            let Some(stored_claim) = inner.device_claims.get_mut(claim_token) else {
                return Err((StatusCode::NOT_FOUND, "Claim token is invalid or expired."));
            };

            if let Some(response) = stored_claim.paired_response.clone() {
                return Ok(DeviceClaimCompleteResponse {
                    paired: true,
                    already_paired: true,
                    device_id: stored_claim.device_id.clone(),
                    device_name: response.device_name,
                });
            }
            if stored_claim.pairing_in_progress {
                return Err((StatusCode::CONFLICT, "Claim is already being completed."));
            }

            stored_claim.pairing_in_progress = true;
            let claim = stored_claim.clone();
            let pairing_result = issue_device_pairing(
                &mut inner,
                user_id.to_string(),
                claim.device_id.clone(),
                claim.hostname.clone(),
                claim.os.clone(),
                claim.arch.clone(),
                claim.suggested_name.clone(),
            );
            let (response, rollback) = match pairing_result {
                Ok(pairing) => pairing,
                Err(err) => {
                    if let Some(stored_claim) = inner.device_claims.get_mut(claim_token) {
                        stored_claim.pairing_in_progress = false;
                    }
                    return Err(err);
                }
            };
            inner.state_revision = inner.state_revision.saturating_add(1);
            let snapshot = build_persisted_relay_state(&inner);
            (claim, response, rollback, snapshot)
        };

        if let Err(err) = persist_newer_devices_snapshot(snapshot, &mut persistence).await {
            warn!(error = %err, "failed to persist relay device state");
            let mut inner = self.inner.lock().await;
            rollback_device_pairing(&mut inner, rollback);
            if let Some(stored_claim) = inner.device_claims.get_mut(claim_token) {
                stored_claim.pairing_in_progress = false;
            }
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist device state.",
            ));
        }

        let device_name = response.device_name.clone();
        let device_id = claim.device_id.clone();
        let mut inner = self.inner.lock().await;
        if let Some(stored_claim) = inner.device_claims.get_mut(claim_token) {
            stored_claim.paired_response = Some(response);
            stored_claim.pairing_in_progress = false;
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
        if device_identity_bytes(
            request.device_id.trim(),
            request.hostname.trim(),
            request.os.trim(),
            request.arch.trim(),
            request.hostname.trim(),
        ) > MAX_DEVICE_IDENTITY_BYTES
        {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Device identity fields exceed the relay byte limit.",
            ));
        }

        let mut persistence = self.persistence.lock().await;
        let (code_key, pairing) = {
            let mut inner = self.inner.lock().await;
            inner.prune_pairing_codes();
            inner.prune_device_claims();

            let pairing = inner
                .pairing_codes
                .remove(&code)
                .ok_or((StatusCode::NOT_FOUND, "Pairing code is invalid or expired."))?;
            (code.clone(), pairing)
        };

        let (response, rollback, snapshot) = {
            let mut inner = self.inner.lock().await;
            let pairing_result = issue_device_pairing(
                &mut inner,
                pairing.owner_user_id.clone(),
                request.device_id.trim().to_string(),
                request.hostname.trim().to_string(),
                request.os.trim().to_string(),
                request.arch.trim().to_string(),
                None,
            );
            let (response, rollback) = match pairing_result {
                Ok(pairing_result) => pairing_result,
                Err(err) => {
                    inner.pairing_codes.insert(code_key, pairing);
                    return Err(err);
                }
            };
            inner.state_revision = inner.state_revision.saturating_add(1);
            let snapshot = build_persisted_relay_state(&inner);
            (response, rollback, snapshot)
        };

        if let Err(err) = persist_newer_devices_snapshot(snapshot, &mut persistence).await {
            warn!(error = %err, "failed to persist relay device state");
            let mut inner = self.inner.lock().await;
            inner.pairing_codes.insert(code_key, pairing);
            rollback_device_pairing(&mut inner, rollback);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist device state.",
            ));
        }

        Ok(response)
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
            if let Some(stored_claim) = inner.device_claims.get_mut(&claim_key) {
                stored_claim.poll_token.clear();
            }
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
                let channel = inner.channels.get(&device.device_id).filter(|channel| {
                    channel
                        .bridge
                        .as_ref()
                        .is_some_and(|bridge| bridge.user_id == device.owner_user_id)
                });
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
                                version: None,
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
        let mut persistence = self.persistence.lock().await;
        let (removed_device, snapshot) = {
            let mut inner = self.inner.lock().await;
            match inner.devices.get(device_id) {
                Some(device) if device.owner_user_id == user_id => {}
                Some(_) => return Err((StatusCode::FORBIDDEN, "You do not own this device.")),
                None => return Ok(false),
            }

            let removed_device = inner
                .devices
                .remove(device_id)
                .expect("device should exist after ownership check");
            inner.refresh_tokens.remove(&removed_device.refresh_token);
            inner.state_revision = inner.state_revision.saturating_add(1);
            let snapshot = build_persisted_relay_state(&inner);
            (removed_device, snapshot)
        };

        if let Err(err) = persist_newer_devices_snapshot(snapshot, &mut persistence).await {
            warn!(error = %err, "failed to persist relay device state");
            let mut inner = self.inner.lock().await;
            inner.refresh_tokens.insert(
                removed_device.refresh_token.clone(),
                removed_device.device_id.clone(),
            );
            inner
                .devices
                .insert(removed_device.device_id.clone(), removed_device);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to persist device state.",
            ));
        }

        let (connection_closes, pending_requests, pending_previews) =
            self.disconnect_device_runtime(device_id).await;
        close_senders(connection_closes).await;
        fail_pending_api_requests(
            pending_requests,
            StatusCode::SERVICE_UNAVAILABLE,
            "Device disconnected.",
        );
        fail_pending_preview_requests(pending_previews, StatusCode::SERVICE_UNAVAILABLE);

        Ok(true)
    }

    async fn disconnect_device_runtime(
        &self,
        device_id: &str,
    ) -> (
        Vec<MessageSender>,
        Vec<oneshot::Sender<ProxiedApiResponse>>,
        Vec<oneshot::Sender<ProxiedPreviewResponse>>,
    ) {
        let mut connection_closes = Vec::new();
        let mut pending_api = Vec::new();
        let mut pending_preview = Vec::new();
        let mut inner = self.inner.lock().await;

        if let Some(channel) = inner.channels.remove(device_id) {
            if let Some(bridge) = channel.bridge {
                connection_closes.push(bridge.tx);
            }
            connection_closes.extend(channel.browsers.into_values().map(|record| record.tx));
        }

        let api_ids = inner
            .pending_api_requests
            .iter()
            .filter(|(_, pending)| pending.device_id == device_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in api_ids {
            if let Some(pending) = inner.take_pending_api(&request_id) {
                pending_api.push(pending.tx);
            }
        }

        let preview_ids = inner
            .pending_preview_requests
            .iter()
            .filter(|(_, pending)| pending.device_id == device_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        for request_id in preview_ids {
            if let Some(pending) = inner.take_pending_preview(&request_id) {
                pending_preview.push(pending.tx);
            }
        }

        let terminal_ids = inner
            .terminal_sessions
            .iter()
            .filter(|(_, session)| session.device_id == device_id)
            .map(|(terminal_id, _)| terminal_id.clone())
            .collect::<Vec<_>>();
        for terminal_id in terminal_ids {
            if let Some(session) = inner.terminal_sessions.remove(&terminal_id) {
                if let Some(browser) = session.browser {
                    connection_closes.push(browser.tx);
                }
                if let Some(bridge) = session.bridge {
                    connection_closes.push(bridge.tx);
                }
            }
        }

        inner
            .device_claims
            .retain(|_, claim| claim.device_id != device_id);
        inner.pending_device_claim_bytes = inner
            .device_claims
            .values()
            .map(|claim| claim.request_bytes)
            .sum();
        (connection_closes, pending_api, pending_preview)
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

        let max_attempts = if normalized_method == "GET" { 2 } else { 1 };

        let request_timeout = device_proxy_timeout_for_url(normalized_path);

        for attempt in 1..=max_attempts {
            let request_id = Uuid::new_v4().to_string();
            let message = serde_json::to_string(&BrowserToBridgeMessage::ApiRequest {
                id: request_id.clone(),
                method: normalized_method.clone(),
                path: normalized_path.to_string(),
                body: body.clone(),
            })
            .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
            let request_bytes = message.len();
            if request_bytes > MAX_WS_MESSAGE_BYTES {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Device API request exceeds the relay byte limit.".to_string(),
                ));
            }

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
                    .and_then(|channel| channel.bridge.as_ref())
                    .filter(|record| record.user_id == user_id)
                    .map(|record| record.tx.clone())
                else {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Device is offline.".to_string(),
                    ));
                };

                let (tx, rx) = oneshot::channel();
                if inner.pending_api_requests.len() >= MAX_PENDING_API_REQUESTS
                    || inner.pending_api_bytes.saturating_add(request_bytes)
                        > MAX_PENDING_API_REQUEST_BYTES
                {
                    return Err((
                        StatusCode::TOO_MANY_REQUESTS,
                        "Too many in-flight device API requests.".to_string(),
                    ));
                }
                inner.pending_api_requests.insert(
                    request_id.clone(),
                    PendingApiRequest {
                        device_id: device_id.to_string(),
                        request_bytes,
                        tx,
                    },
                );
                inner.pending_api_bytes = inner.pending_api_bytes.saturating_add(request_bytes);

                (bridge_tx, rx)
            };

            if bridge_tx.try_send(Message::Text(message.into())).is_err() {
                let mut inner = self.inner.lock().await;
                inner.take_pending_api(&request_id);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device connection is unavailable.".to_string(),
                ));
            }

            match await_proxied_api_response(request_timeout, receiver).await {
                Ok(response) => return Ok(response),
                Err(ProxyResponseWaitError::Closed) => {
                    let mut inner = self.inner.lock().await;
                    inner.take_pending_api(&request_id);
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Device connection closed.".to_string(),
                    ));
                }
                Err(ProxyResponseWaitError::TimedOut) => {
                    warn!(
                        request_id = %request_id,
                        attempt = attempt,
                        path = %normalized_path,
                        timeout_secs = request_timeout.as_secs(),
                        "Device API request timed out while waiting for bridge response"
                    );

                    if attempt < max_attempts {
                        let mut inner = self.inner.lock().await;
                        inner.take_pending_api(&request_id);
                        drop(inner);
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }

                    let mut inner = self.inner.lock().await;
                    inner.take_pending_api(&request_id);
                    return Err((
                        StatusCode::GATEWAY_TIMEOUT,
                        format!(
                            "Device request timed out after {timeout_secs}s for {normalized_path}",
                            timeout_secs = request_timeout.as_secs(),
                            normalized_path = normalized_path
                        ),
                    ));
                }
            }
        }

        Err((
            StatusCode::GATEWAY_TIMEOUT,
            format!(
                "Device request timed out after {timeout_secs}s for {normalized_path}",
                timeout_secs = request_timeout.as_secs(),
                normalized_path = normalized_path
            ),
        ))
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
        let request_bytes = message.len();
        if request_bytes > MAX_WS_MESSAGE_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Device preview request exceeds the relay byte limit.".to_string(),
            ));
        }

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
                .and_then(|channel| channel.bridge.as_ref())
                .filter(|record| record.user_id == user_id)
                .map(|record| record.tx.clone())
            else {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Device is offline.".to_string(),
                ));
            };

            let (tx, rx) = oneshot::channel();
            if inner.pending_preview_requests.len() >= MAX_PENDING_PREVIEW_REQUESTS
                || inner.pending_preview_bytes.saturating_add(request_bytes)
                    > MAX_PENDING_PREVIEW_REQUEST_BYTES
            {
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many in-flight device preview requests.".to_string(),
                ));
            }
            inner.pending_preview_requests.insert(
                request_id.clone(),
                PendingPreviewRequest {
                    device_id: device_id.to_string(),
                    request_bytes,
                    tx,
                },
            );
            inner.pending_preview_bytes = inner.pending_preview_bytes.saturating_add(request_bytes);

            (bridge_tx, rx)
        };

        if bridge_tx.try_send(Message::Text(message.into())).is_err() {
            let mut inner = self.inner.lock().await;
            inner.take_pending_preview(&request_id);
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
                inner.take_pending_preview(&request_id);
                Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Device preview request timed out.".to_string(),
                ))
            }
        }
    }
}

impl RelayInner {
    fn ensure_connection_capacity(
        &self,
        key: &str,
        peer_kind: PeerKind,
        user_id: &str,
    ) -> Result<()> {
        let replacing_bridge = peer_kind == PeerKind::Bridge
            && self
                .channels
                .get(key)
                .is_some_and(|channel| channel.bridge.is_some());
        if replacing_bridge {
            return Ok(());
        }

        let control_global = self
            .channels
            .values()
            .map(|channel| usize::from(channel.bridge.is_some()) + channel.browsers.len())
            .sum::<usize>();
        if control_global >= MAX_CONTROL_CONNECTIONS_GLOBAL {
            anyhow::bail!("relay control connection capacity reached");
        }

        let control_for_user = self
            .channels
            .values()
            .map(|channel| {
                usize::from(
                    channel
                        .bridge
                        .as_ref()
                        .is_some_and(|bridge| bridge.user_id == user_id),
                ) + channel
                    .browsers
                    .values()
                    .filter(|browser| browser.user_id == user_id)
                    .count()
            })
            .sum::<usize>();
        if control_for_user >= MAX_CONTROL_CONNECTIONS_PER_USER {
            anyhow::bail!("relay control connection capacity reached for this user");
        }

        let channel = self.channels.get(key);
        let control_for_channel = channel
            .map(|channel| usize::from(channel.bridge.is_some()) + channel.browsers.len())
            .unwrap_or_default();
        if control_for_channel >= MAX_CONTROL_CONNECTIONS_PER_CHANNEL {
            anyhow::bail!("relay control connection capacity reached for this channel");
        }

        if peer_kind == PeerKind::Browser {
            let browser_global = self
                .channels
                .values()
                .map(|channel| channel.browsers.len())
                .sum::<usize>();
            if browser_global >= MAX_BROWSER_CONNECTIONS_GLOBAL {
                anyhow::bail!("relay browser connection capacity reached");
            }

            let browsers_for_user = self
                .channels
                .values()
                .flat_map(|channel| channel.browsers.values())
                .filter(|browser| browser.user_id == user_id)
                .count();
            if browsers_for_user >= MAX_BROWSER_CONNECTIONS_PER_USER {
                anyhow::bail!("relay browser connection capacity reached for this user");
            }

            let browsers_for_channel = channel
                .map(|channel| channel.browsers.len())
                .unwrap_or_default();
            if browsers_for_channel >= MAX_BROWSER_CONNECTIONS_PER_CHANNEL {
                anyhow::bail!("relay browser connection capacity reached for this channel");
            }
        }
        Ok(())
    }

    fn ensure_rate_limit_bucket(
        &mut self,
        key: &str,
        now: Instant,
        capacity: f64,
        refill_per_second: f64,
    ) {
        if self.rate_limits.contains_key(key) {
            return;
        }
        self.rate_limits.retain(|_, bucket| {
            now.saturating_duration_since(bucket.last_seen) <= RATE_LIMIT_BUCKET_TTL
        });

        if self.rate_limits.len() >= MAX_RATE_LIMIT_BUCKETS {
            let eviction_key = self
                .rate_limits
                .iter()
                .filter(|(candidate, _)| candidate.as_str() != DEVICE_CLAIM_GLOBAL_RATE_LIMIT_KEY)
                .min_by_key(|(_, bucket)| bucket.last_seen)
                .map(|(candidate, _)| candidate.clone())
                .or_else(|| self.rate_limits.keys().next().cloned());
            if let Some(eviction_key) = eviction_key {
                self.rate_limits.remove(&eviction_key);
            }
        }

        self.rate_limits.insert(
            key.to_string(),
            RateBucket::with_limits(now, capacity, refill_per_second),
        );
    }

    fn bridge_connection_is_current(&self, key: &str, connection_id: u64) -> bool {
        self.channels.get(key).is_some_and(|channel| {
            channel.bridge.as_ref().is_some_and(|bridge| {
                bridge.id == connection_id
                    && self
                        .devices
                        .get(key)
                        .is_none_or(|device| device.owner_user_id == bridge.user_id)
            })
        })
    }

    fn take_pending_api(&mut self, request_id: &str) -> Option<PendingApiRequest> {
        let pending = self.pending_api_requests.remove(request_id)?;
        self.pending_api_bytes = self.pending_api_bytes.saturating_sub(pending.request_bytes);
        Some(pending)
    }

    fn take_pending_api_for_device(
        &mut self,
        request_id: &str,
        device_id: &str,
    ) -> Option<PendingApiRequest> {
        if self
            .pending_api_requests
            .get(request_id)
            .is_none_or(|pending| pending.device_id != device_id)
        {
            return None;
        }
        self.take_pending_api(request_id)
    }

    fn take_pending_preview(&mut self, request_id: &str) -> Option<PendingPreviewRequest> {
        let pending = self.pending_preview_requests.remove(request_id)?;
        self.pending_preview_bytes = self
            .pending_preview_bytes
            .saturating_sub(pending.request_bytes);
        Some(pending)
    }

    fn take_pending_preview_for_device(
        &mut self,
        request_id: &str,
        device_id: &str,
    ) -> Option<PendingPreviewRequest> {
        if self
            .pending_preview_requests
            .get(request_id)
            .is_none_or(|pending| pending.device_id != device_id)
        {
            return None;
        }
        self.take_pending_preview(request_id)
    }

    fn prune_pairing_codes(&mut self) {
        let now = Instant::now();
        self.pairing_codes
            .retain(|_, pairing| pairing.expires_at > now);
    }

    fn prune_device_claims(&mut self) {
        let now = Instant::now();
        self.device_claims.retain(|_, claim| claim.expires_at > now);
        self.pending_device_claim_bytes = self
            .device_claims
            .values()
            .map(|claim| claim.request_bytes)
            .sum();
    }
}

async fn close_senders(senders: Vec<MessageSender>) {
    for sender in senders {
        let _ = sender.try_send(Message::Close(None));
    }
}

fn device_proxy_timeout_for_url(url: &str) -> Duration {
    let normalized = url.trim();
    if normalized.starts_with("/api/filesystem/pick-directory") {
        DEVICE_PICKER_TIMEOUT
    } else if normalized.starts_with("/api/filesystem/directory") {
        Duration::from_secs(90)
    } else {
        DEVICE_PROXY_TIMEOUT
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyResponseWaitError {
    Closed,
    TimedOut,
}

async fn await_proxied_api_response(
    request_timeout: Duration,
    receiver: oneshot::Receiver<ProxiedApiResponse>,
) -> std::result::Result<ProxiedApiResponse, ProxyResponseWaitError> {
    match tokio::time::timeout(request_timeout, receiver).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(_)) => Err(ProxyResponseWaitError::Closed),
        Err(_) => Err(ProxyResponseWaitError::TimedOut),
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

fn fail_pending_preview_requests(
    requests: Vec<oneshot::Sender<ProxiedPreviewResponse>>,
    status: StatusCode,
) {
    for request in requests {
        let _ = request.send(ProxiedPreviewResponse {
            status: status.as_u16(),
            headers: BTreeMap::new(),
            body_base64: None,
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

async fn send_bridge_error(tx: &MessageSender, id: &str, status: StatusCode, message: &str) {
    let response = BridgeToBrowserMessage::ApiResponse {
        id: id.to_string(),
        status: status.as_u16(),
        body: json!({ "error": message }),
    };

    if let Ok(text) = serde_json::to_string(&response) {
        let _ = tx.try_send(Message::Text(text.into()));
    }
}

async fn send_bridge_preview_error(
    tx: &MessageSender,
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
        let _ = tx.try_send(Message::Text(text.into()));
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

fn resolve_websocket_protocol(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(',')
                .map(str::trim)
                .find(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn resolve_browser_terminal_jwt(
    query_jwt: Option<&str>,
    requested_protocol: Option<&str>,
) -> Option<String> {
    query_jwt
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            requested_protocol
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn resolve_dashboard_api_user_id(headers: &HeaderMap) -> Option<String> {
    let jwt = resolve_token(headers, None)?;
    decode_relay_user_id(&jwt, RELAY_JWT_SCOPE_DASHBOARD_API).ok()
}

fn resolve_browser_ws_user_id(jwt: &str) -> Option<String> {
    decode_relay_user_id(jwt, RELAY_JWT_SCOPE_TERMINAL_BROWSER).ok()
}

fn host_name() -> String {
    env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn normalize_bridge_version(version: Option<String>) -> Option<String> {
    version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn format_device_os(os: &str, arch: &str) -> String {
    format!("{}/{}", os.trim(), arch.trim())
}

fn device_identity_bytes(
    device_id: &str,
    hostname: &str,
    os: &str,
    arch: &str,
    device_name: &str,
) -> usize {
    device_id.len() + hostname.len() + os.len() + arch.len() + device_name.len()
}

fn preferred_device_name(suggested_name: Option<String>, hostname: String) -> String {
    suggested_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(hostname)
}

#[derive(Debug)]
struct DevicePairingRollback {
    device_id: String,
    previous_device: Option<DeviceRecord>,
    new_refresh_token: String,
}

fn rollback_device_pairing(inner: &mut RelayInner, rollback: DevicePairingRollback) {
    inner.refresh_tokens.remove(&rollback.new_refresh_token);
    if let Some(previous_device) = rollback.previous_device {
        inner.refresh_tokens.insert(
            previous_device.refresh_token.clone(),
            previous_device.device_id.clone(),
        );
        inner
            .devices
            .insert(previous_device.device_id.clone(), previous_device);
    } else {
        inner.devices.remove(&rollback.device_id);
    }
}

fn issue_device_pairing(
    inner: &mut RelayInner,
    owner_user_id: String,
    device_id: String,
    hostname: String,
    os: String,
    arch: String,
    suggested_name: Option<String>,
) -> std::result::Result<(DevicePairResponse, DevicePairingRollback), (StatusCode, &'static str)> {
    if inner
        .devices
        .get(&device_id)
        .is_some_and(|device| device.owner_user_id != owner_user_id)
        || inner.channels.get(&device_id).is_some_and(|channel| {
            channel
                .bridge
                .as_ref()
                .is_some_and(|bridge| bridge.user_id != owner_user_id)
                || channel
                    .browsers
                    .values()
                    .any(|browser| browser.user_id != owner_user_id)
        })
    {
        return Err((
            StatusCode::CONFLICT,
            "Device id is already paired to another user.",
        ));
    }
    ensure_device_pairing_capacity(inner, &owner_user_id, &device_id)?;
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

    let previous_device = inner.devices.insert(device.device_id.clone(), device);
    if let Some(previous_device) = previous_device.as_ref() {
        inner.refresh_tokens.remove(&previous_device.refresh_token);
    }
    inner
        .refresh_tokens
        .insert(refresh_token.clone(), device_id.clone());

    Ok((
        DevicePairResponse {
            access_token,
            refresh_token: refresh_token.clone(),
            expires_in: DEVICE_ACCESS_TOKEN_TTL_SECS,
            device_name,
        },
        DevicePairingRollback {
            device_id,
            previous_device,
            new_refresh_token: refresh_token,
        },
    ))
}

fn ensure_device_pairing_capacity(
    inner: &RelayInner,
    owner_user_id: &str,
    device_id: &str,
) -> std::result::Result<(), (StatusCode, &'static str)> {
    if inner.devices.contains_key(device_id) {
        return Ok(());
    }
    if inner.devices.len() >= MAX_PAIRED_DEVICES_GLOBAL {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Relay device capacity reached.",
        ));
    }
    if inner
        .devices
        .values()
        .filter(|device| device.owner_user_id == owner_user_id)
        .count()
        >= MAX_PAIRED_DEVICES_PER_USER
    {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many paired devices for this user.",
        ));
    }
    Ok(())
}

fn generate_pairing_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = Uuid::new_v4().into_bytes();
    (0..PAIRING_CODE_LENGTH)
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
    use std::sync::LazyLock;

    static RELAY_STATE_ENV_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));
    use axum::extract::ws::Message;

    fn test_message_channel(capacity: usize) -> (MessageSender, MessageReceiver) {
        let byte_capacity = if capacity == TERMINAL_WS_QUEUE_CAPACITY {
            TERMINAL_WS_QUEUE_BYTE_CAPACITY
        } else {
            CONTROL_WS_QUEUE_BYTE_CAPACITY
        };
        message_channel(
            capacity,
            byte_capacity,
            Arc::new(QueueByteBudget::production()),
            QueueBudgetScope::control("test-user", &Uuid::new_v4().to_string()),
        )
    }

    #[test]
    fn trusted_proxy_resolution_ignores_untrusted_forwarding_headers() {
        let trusted = parse_trusted_proxies("10.0.0.0/8, 2001:db8::/32")
            .expect("trusted proxy configuration");
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.25"));

        let untrusted_remote = SocketAddr::from(([203, 0, 113, 9], 443));
        assert_eq!(
            resolve_real_client_ip(untrusted_remote, &headers, &trusted),
            untrusted_remote.ip(),
            "an untrusted peer must not be able to spoof X-Forwarded-For"
        );

        let trusted_remote = SocketAddr::from(([10, 1, 2, 3], 443));
        assert_eq!(
            resolve_real_client_ip(trusted_remote, &headers, &trusted),
            "198.51.100.25".parse::<IpAddr>().expect("client ip")
        );
    }

    #[test]
    fn trusted_proxy_resolution_stops_at_the_nearest_untrusted_hop() {
        let trusted =
            parse_trusted_proxies("10.0.0.0/8,192.0.2.0/24").expect("trusted proxy configuration");
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.200, 198.51.100.40, 192.0.2.10"),
        );

        assert_eq!(
            resolve_real_client_ip(SocketAddr::from(([10, 0, 0, 5], 443)), &headers, &trusted),
            "198.51.100.40"
                .parse::<IpAddr>()
                .expect("nearest untrusted hop"),
            "a spoofed prefix before the nearest untrusted hop must be ignored"
        );
    }

    #[test]
    fn websocket_queue_enforces_and_releases_its_byte_budget() {
        let scope = QueueBudgetScope::control("user-a", "channel-a");
        let aggregate = Arc::new(QueueByteBudget::new(64, 64, 64));
        let (tx, mut rx) = message_channel(8, 8, Arc::clone(&aggregate), scope.clone());
        tx.try_send(Message::Binary(vec![1; 5].into()))
            .expect("first message should reserve bytes");
        assert_eq!(aggregate.usage(&scope), (5, 5, 5));
        assert!(
            tx.try_send(Message::Binary(vec![2; 4].into())).is_err(),
            "aggregate bytes must be bounded even when message slots remain"
        );
        assert!(matches!(rx.try_recv(), Ok(Message::Binary(_))));
        assert_eq!(aggregate.usage(&scope), (0, 0, 0));
        tx.try_send(Message::Binary(vec![2; 4].into()))
            .expect("receiving a message should release its byte reservation");
        drop(rx);
        assert_eq!(aggregate.usage(&scope), (0, 0, 0));
    }

    #[test]
    fn websocket_queue_enforces_global_user_and_channel_byte_budgets() {
        let aggregate = Arc::new(QueueByteBudget::new(12, 8, 6));
        let scope_a = QueueBudgetScope::control("user-a", "channel-a");
        let scope_b = QueueBudgetScope::control("user-a", "channel-b");
        let scope_c = QueueBudgetScope::control("user-b", "channel-c");
        let (tx_a, rx_a) = message_channel(8, 32, Arc::clone(&aggregate), scope_a.clone());
        let (tx_b, rx_b) = message_channel(8, 32, Arc::clone(&aggregate), scope_b.clone());
        let (tx_c, rx_c) = message_channel(8, 32, Arc::clone(&aggregate), scope_c.clone());

        tx_a.try_send(Message::Binary(vec![1; 6].into()))
            .expect("first channel should fill its scoped allowance");
        assert!(
            tx_a.try_send(Message::Binary(vec![2; 1].into())).is_err(),
            "channel allowance must be enforced"
        );
        tx_b.try_send(Message::Binary(vec![3; 2].into()))
            .expect("same user should use the remainder of its user allowance");
        assert!(
            tx_b.try_send(Message::Binary(vec![4; 1].into())).is_err(),
            "user allowance must be enforced across channels"
        );
        tx_c.try_send(Message::Binary(vec![5; 4].into()))
            .expect("another user should use the remainder of the global allowance");
        assert!(
            tx_c.try_send(Message::Binary(vec![6; 1].into())).is_err(),
            "global allowance must be enforced across users"
        );

        drop(rx_a);
        assert_eq!(aggregate.usage(&scope_a), (6, 2, 0));
        tx_b.try_send(Message::Binary(vec![7; 4].into()))
            .expect("dropping a receiver must release every queued reservation");

        drop((rx_b, rx_c));
        assert_eq!(aggregate.usage(&scope_b), (0, 0, 0));
    }

    #[tokio::test]
    async fn rate_limit_storage_is_bounded_and_expired_buckets_are_pruned() {
        let state = RelayState::default();
        let now = Instant::now();
        {
            let mut inner = state.inner.lock().await;
            for index in 0..(MAX_RATE_LIMIT_BUCKETS + 50) {
                inner.ensure_rate_limit_bucket(&format!("attacker-{index}"), now, 1.0, 0.0);
            }
            assert_eq!(inner.rate_limits.len(), MAX_RATE_LIMIT_BUCKETS);
            for bucket in inner.rate_limits.values_mut() {
                bucket.last_seen = now - RATE_LIMIT_BUCKET_TTL - Duration::from_secs(1);
            }
            inner.ensure_rate_limit_bucket("fresh", now, 1.0, 0.0);
            assert_eq!(inner.rate_limits.len(), 1);
            assert!(inner.rate_limits.contains_key("fresh"));
        }
    }

    #[tokio::test]
    async fn device_claim_global_limit_is_separate_from_caller_limits() {
        let state = RelayState::default();
        let now = Instant::now();
        for index in 0..DEVICE_CLAIM_GLOBAL_RATE_LIMIT_BURST {
            assert!(
                state
                    .consume_device_claim_rate_limit(&format!("caller-{index}"), now)
                    .await,
                "unique callers should be accepted until the global burst is exhausted"
            );
        }
        assert!(
            !state
                .consume_device_claim_rate_limit("new-caller", now)
                .await,
            "rotating caller IPs must not bypass the global claim limiter"
        );
    }

    fn test_device(device_id: &str, owner_user_id: &str) -> DeviceRecord {
        DeviceRecord {
            device_id: device_id.to_string(),
            owner_user_id: owner_user_id.to_string(),
            name: "Test device".to_string(),
            hostname: "test-host".to_string(),
            os: "darwin".to_string(),
            arch: "arm64".to_string(),
            refresh_token: format!("refresh-{device_id}"),
        }
    }

    fn detached_terminal(
        terminal_id: &str,
        session_id: &str,
        device_id: &str,
        owner_user_id: &str,
    ) -> TerminalSessionRecord {
        TerminalSessionRecord {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            device_id: device_id.to_string(),
            owner_user_id: owner_user_id.to_string(),
            browser: None,
            bridge: None,
            browser_disconnected_at: None,
            attach_generation: 1,
            attach_deadline: None,
            browser_paused: false,
            pause_buffer: Vec::new(),
            pause_buffer_bytes: 0,
            pending_browser_frames: Vec::new(),
            pending_browser_frame_bytes: 0,
        }
    }

    #[tokio::test]
    async fn device_claim_pairs_and_polls_once() {
        let _guard = RELAY_STATE_ENV_LOCK.lock().await;
        unsafe {
            std::env::remove_var(RELAY_STATE_FILE_ENV);
        }
        let state = RelayState::default();
        let created = state
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "device-123".to_string(),
                    hostname: "macbook-pro".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: Some("My Laptop".to_string()),
                },
                "device-claims:create:test-client",
            )
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

        let already_paired = state
            .complete_device_claim(
                "user@example.com",
                DeviceClaimCompleteRequest {
                    claim_token: created.claim_token.clone(),
                },
            )
            .await
            .expect("claim should stay resumable for the browser after polling");
        assert!(already_paired.already_paired);
        assert_eq!(already_paired.device_id, "device-123");

        let missing = state.poll_device_claim(&created.poll_token).await;
        assert!(matches!(missing, Err((StatusCode::NOT_FOUND, _))));
    }

    #[test]
    fn generate_pairing_code_uses_the_expected_length_and_charset() {
        let code = generate_pairing_code();
        const ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

        assert_eq!(code.len(), PAIRING_CODE_LENGTH);
        assert!(code.chars().all(|ch| ALPHABET.contains(ch)));
    }

    #[tokio::test]
    async fn create_pairing_code_rejects_when_the_queue_is_full() {
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            let expires_at = Instant::now() + PAIRING_CODE_TTL;

            for index in 0..MAX_PENDING_PAIRING_CODES {
                inner.pairing_codes.insert(
                    format!("PAIR{index:06}"),
                    PendingPairing {
                        owner_user_id: format!("user-{index}"),
                        expires_at,
                    },
                );
            }
        }

        let err = state
            .create_pairing_code("user@example.com".to_string(), "My Laptop".to_string())
            .await
            .expect_err("pairing code creation should be rate-limited when full");

        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn create_device_claim_rejects_when_the_queue_is_full() {
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            let expires_at = Instant::now() + PAIRING_CODE_TTL;

            for index in 0..MAX_PENDING_DEVICE_CLAIMS {
                inner.device_claims.insert(
                    format!("claim-{index:06}"),
                    PendingDeviceClaim {
                        poll_token: format!("poll-{index:06}"),
                        device_id: format!("device-{index}"),
                        hostname: format!("host-{index}"),
                        os: "darwin".to_string(),
                        arch: "arm64".to_string(),
                        suggested_name: None,
                        expires_at,
                        paired_response: None,
                        pairing_in_progress: false,
                        request_bytes: 0,
                    },
                );
            }
        }

        let err = state
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "device-overflow".to_string(),
                    hostname: "macbook-pro".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                },
                "device-claims:create:test-client",
            )
            .await
            .expect_err("device claim creation should be rate-limited when full");

        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn device_claim_memory_is_bounded_by_bytes() {
        let oversized = RelayState::default()
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "x".repeat(MAX_DEVICE_IDENTITY_BYTES + 1),
                    hostname: "host".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                },
                "device-claims:create:oversized",
            )
            .await
            .expect_err("one oversized claim must be rejected");
        assert_eq!(oversized.0, StatusCode::PAYLOAD_TOO_LARGE);

        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            inner.device_claims.insert(
                "claim-existing".to_string(),
                PendingDeviceClaim {
                    poll_token: "poll-existing".to_string(),
                    device_id: "device-existing".to_string(),
                    hostname: "host".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                    expires_at: Instant::now() + PAIRING_CODE_TTL,
                    paired_response: None,
                    pairing_in_progress: false,
                    request_bytes: MAX_PENDING_DEVICE_CLAIM_BYTES,
                },
            );
            inner.pending_device_claim_bytes = MAX_PENDING_DEVICE_CLAIM_BYTES;
        }
        let aggregate = state
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "device-next".to_string(),
                    hostname: "host".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                },
                "device-claims:create:aggregate",
            )
            .await
            .expect_err("aggregate pending claim bytes must be capped");
        assert_eq!(aggregate.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn create_device_claim_is_rate_limited_before_the_queue_fills() {
        let state = RelayState::default();

        for index in 0..DEVICE_CLAIM_RATE_LIMIT_BURST {
            state
                .create_device_claim(
                    DeviceClaimCreateRequest {
                        device_id: format!("device-{index}"),
                        hostname: format!("host-{index}"),
                        os: "darwin".to_string(),
                        arch: "arm64".to_string(),
                        suggested_name: None,
                    },
                    "device-claims:create:test-client",
                )
                .await
                .expect("device claim should be created before the burst is exhausted");
        }

        let err = state
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "device-overflow".to_string(),
                    hostname: "macbook-pro".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                },
                "device-claims:create:test-client",
            )
            .await
            .expect_err("device claim creation should be rate-limited before the queue fills");

        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn create_device_claim_rate_limit_is_scoped_per_caller() {
        let state = RelayState::default();

        for index in 0..DEVICE_CLAIM_RATE_LIMIT_BURST {
            state
                .create_device_claim(
                    DeviceClaimCreateRequest {
                        device_id: format!("device-a-{index}"),
                        hostname: format!("host-a-{index}"),
                        os: "darwin".to_string(),
                        arch: "arm64".to_string(),
                        suggested_name: None,
                    },
                    "device-claims:create:caller-a",
                )
                .await
                .expect("first caller should stay within its own bucket");
        }

        state
            .create_device_claim(
                DeviceClaimCreateRequest {
                    device_id: "device-b-0".to_string(),
                    hostname: "host-b-0".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                },
                "device-claims:create:caller-b",
            )
            .await
            .expect("different callers should get independent rate-limit buckets");
    }

    #[tokio::test]
    async fn forward_device_api_request_rejects_when_too_many_requests_are_in_flight() {
        let state = RelayState::default();
        let (bridge_tx, _bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            inner.devices.insert(
                "device-123".to_string(),
                DeviceRecord {
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    name: "My Laptop".to_string(),
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
                        tx: bridge_tx.clone(),
                    }),
                    ..Default::default()
                },
            );

            for index in 0..MAX_PENDING_API_REQUESTS {
                let (tx, _rx) = oneshot::channel();
                inner.pending_api_requests.insert(
                    format!("api-{index}"),
                    PendingApiRequest {
                        device_id: "device-123".to_string(),
                        request_bytes: 0,
                        tx,
                    },
                );
            }
        }

        let err = state
            .forward_device_api_request(
                "user@example.com",
                "device-123",
                "GET",
                "/api/sessions",
                None,
            )
            .await
            .expect_err("api request queue should reject overflow");

        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(err.1, "Too many in-flight device API requests.");
    }

    #[tokio::test]
    async fn forward_device_preview_request_rejects_when_too_many_requests_are_in_flight() {
        let state = RelayState::default();
        let (bridge_tx, _bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            inner.devices.insert(
                "device-123".to_string(),
                DeviceRecord {
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    name: "My Laptop".to_string(),
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
                    ..Default::default()
                },
            );

            for index in 0..MAX_PENDING_PREVIEW_REQUESTS {
                let (tx, _rx) = oneshot::channel();
                inner.pending_preview_requests.insert(
                    format!("preview-{index}"),
                    PendingPreviewRequest {
                        device_id: "device-123".to_string(),
                        request_bytes: 0,
                        tx,
                    },
                );
            }
        }

        let err = state
            .forward_device_preview_request(
                "user@example.com",
                "device-123",
                DevicePreviewRequest {
                    session_id: "session-123".to_string(),
                    method: "GET".to_string(),
                    url: "http://127.0.0.1:3000".to_string(),
                    headers: BTreeMap::new(),
                    body_base64: None,
                },
            )
            .await
            .expect_err("preview request queue should reject overflow");

        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(err.1, "Too many in-flight device preview requests.");
    }

    #[test]
    fn device_proxy_timeout_tracks_slow_filesystem_routes() {
        assert_eq!(
            device_proxy_timeout_for_url("/api/filesystem/pick-directory"),
            DEVICE_PICKER_TIMEOUT
        );
        assert_eq!(
            device_proxy_timeout_for_url("/api/filesystem/directory?path=C:/Users"),
            Duration::from_secs(90)
        );
        assert_eq!(
            device_proxy_timeout_for_url("/api/sessions"),
            DEVICE_PROXY_TIMEOUT
        );
    }

    #[test]
    fn resolve_browser_terminal_jwt_prefers_query_token_over_requested_protocol() {
        assert_eq!(
            resolve_browser_terminal_jwt(Some("jwt-from-query"), Some("ttyd")),
            Some("jwt-from-query".to_string())
        );
        assert_eq!(
            resolve_browser_terminal_jwt(None, Some("jwt-from-protocol")),
            Some("jwt-from-protocol".to_string())
        );
        assert_eq!(
            resolve_browser_terminal_jwt(Some("   "), Some("ttyd")),
            Some("ttyd".to_string())
        );
        assert_eq!(resolve_browser_terminal_jwt(None, None), None);
    }

    #[tokio::test]
    async fn create_terminal_session_returns_before_bridge_connection() {
        let state = RelayState::default();
        let (bridge_tx, mut bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

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

        let created_terminal_id = tokio::time::timeout(Duration::from_millis(100), create_task)
            .await
            .expect("create task should not wait for the bridge terminal")
            .expect("create task should finish")
            .expect("terminal should be created");
        assert_eq!(created_terminal_id, terminal_id);
        state
            .authorize_terminal_session_browser(&terminal_id, "user@example.com")
            .await
            .expect("browser should be able to attach before the bridge terminal is ready");
    }

    #[tokio::test]
    async fn browser_handshake_survives_pause_before_bridge_attaches() {
        let state = RelayState::default();
        state.inner.lock().await.terminal_sessions.insert(
            "terminal-1".to_string(),
            detached_terminal("terminal-1", "session-1", "device-1", "owner-a"),
        );

        let (browser_tx, _browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let browser_connection_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser connection");
        let handshake = Message::Binary(br#"{"columns":120,"rows":40}"#.to_vec().into());
        assert!(
            state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Browser,
                    browser_connection_id,
                    &handshake,
                )
                .await,
            "browser handshake should be retained while the bridge catches up"
        );
        let pause = Message::Binary(vec![TTYD_CMD_PAUSE].into());
        assert!(
            state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Browser,
                    browser_connection_id,
                    &pause,
                )
                .await,
            "pause should not erase browser-to-bridge frames"
        );

        let (bridge_tx, mut bridge_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Bridge, bridge_tx)
            .await
            .expect("bridge connection");

        assert_eq!(
            bridge_rx.recv().await,
            Some(handshake),
            "the ttyd readiness handshake must reach the late bridge connection"
        );
    }

    #[test]
    fn pending_browser_frame_overflow_preserves_the_initial_handshake() {
        let mut session = detached_terminal("terminal-1", "session-1", "device-1", "owner-a");
        let handshake = Message::Binary(br#"{"columns":120,"rows":40}"#.to_vec().into());
        assert!(session.buffer_pending_browser_frame(handshake.clone()));
        for _ in 1..TERMINAL_PENDING_BROWSER_FRAME_CAPACITY {
            assert!(session.buffer_pending_browser_frame(Message::Binary(vec![b'0'].into())));
        }

        assert!(!session.buffer_pending_browser_frame(Message::Binary(vec![b'0'].into())));
        assert_eq!(session.pending_browser_frames.first(), Some(&handshake));
        assert_eq!(
            session.pending_browser_frames.len(),
            TERMINAL_PENDING_BROWSER_FRAME_CAPACITY
        );
    }

    #[tokio::test]
    async fn incomplete_pending_browser_replay_rolls_back_bridge_registration() {
        let state = RelayState::default();
        state.inner.lock().await.terminal_sessions.insert(
            "terminal-1".to_string(),
            detached_terminal("terminal-1", "session-1", "device-1", "owner-a"),
        );

        let (browser_tx, mut browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let browser_connection_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser connection");
        let handshake = Message::Binary(br#"{"columns":120,"rows":40}"#.to_vec().into());
        assert!(
            state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Browser,
                    browser_connection_id,
                    &handshake,
                )
                .await
        );

        let (bridge_tx, mut bridge_rx) = test_message_channel(1);
        bridge_tx
            .try_send(Message::Ping(Vec::new().into()))
            .expect("bridge queue should be full before replay");
        let err = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Bridge, bridge_tx)
            .await
            .expect_err("partial pending-frame replay must reject the bridge connection");
        assert!(err
            .to_string()
            .contains("failed to replay pending browser terminal frames"));

        assert!(matches!(browser_rx.recv().await, Some(Message::Close(_))));
        assert!(matches!(bridge_rx.recv().await, Some(Message::Ping(_))));
        let inner = state.inner.lock().await;
        let session = inner
            .terminal_sessions
            .get("terminal-1")
            .expect("browser-owned relay terminal should remain reconnectable");
        assert!(session.bridge.is_none());
        assert!(session.pending_browser_frames.is_empty());
        assert_eq!(session.pending_browser_frame_bytes, 0);
    }

    #[tokio::test]
    async fn create_terminal_session_retries_start_for_existing_terminal_without_bridge() {
        let state = RelayState::default();
        let (control_bridge_tx, mut control_bridge_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

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
                        tx: control_bridge_tx,
                    }),
                    browsers: HashMap::new(),
                    last_status: None,
                },
            );
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-abc".to_string(),
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    browser: None,
                    bridge: None,
                    browser_disconnected_at: Some(Instant::now()),
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        let terminal_id = state
            .create_terminal_session("user@example.com", "device-123", "session-abc")
            .await
            .expect("terminal should be reused and restarted");
        assert_eq!(terminal_id, "terminal-1");

        let start_message = control_bridge_rx
            .recv()
            .await
            .expect("bridge restart message");
        let Message::Text(payload) = start_message else {
            panic!("expected text restart payload");
        };
        let envelope: BrowserToBridgeMessage =
            serde_json::from_str(payload.as_str()).expect("decode restart payload");
        match envelope {
            BrowserToBridgeMessage::TerminalProxyStart {
                terminal_id,
                session_id,
            } => {
                assert_eq!(terminal_id, "terminal-1");
                assert_eq!(session_id, "session-abc");
            }
            other => panic!("unexpected bridge message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_terminal_session_reuses_existing_detached_terminal() {
        let state = RelayState::default();
        let (control_bridge_tx, mut control_bridge_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (terminal_bridge_tx, _terminal_bridge_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

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
                        tx: control_bridge_tx,
                    }),
                    browsers: HashMap::new(),
                    last_status: None,
                },
            );
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-abc".to_string(),
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    browser: None,
                    bridge: Some(TerminalConnectionRecord {
                        id: 2,
                        tx: terminal_bridge_tx,
                    }),
                    browser_disconnected_at: Some(Instant::now()),
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        let terminal_id = state
            .create_terminal_session("user@example.com", "device-123", "session-abc")
            .await
            .expect("terminal should be reused");

        assert_eq!(terminal_id, "terminal-1");
        assert!(
            control_bridge_rx.try_recv().is_err(),
            "reuse should not start a new bridge proxy session"
        );
    }

    #[tokio::test]
    async fn bridge_disconnect_keeps_terminal_restartable_during_browser_reconnect() {
        let state = RelayState::default();
        let (control_bridge_tx, mut control_bridge_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (browser_tx, mut browser_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (terminal_bridge_tx, _terminal_bridge_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

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
                        tx: control_bridge_tx,
                    }),
                    browsers: HashMap::new(),
                    last_status: None,
                },
            );
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-abc".to_string(),
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    browser: Some(TerminalConnectionRecord {
                        id: 1,
                        tx: browser_tx,
                    }),
                    bridge: Some(TerminalConnectionRecord {
                        id: 2,
                        tx: terminal_bridge_tx,
                    }),
                    browser_disconnected_at: None,
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        state
            .unregister_terminal_connection("terminal-1", TerminalPeerKind::Bridge, 2)
            .await;

        let close_message = browser_rx
            .recv()
            .await
            .expect("browser should be told to reconnect");
        assert!(matches!(close_message, Message::Close(_)));

        state
            .unregister_terminal_connection("terminal-1", TerminalPeerKind::Browser, 1)
            .await;

        let terminal_id = state
            .create_terminal_session("user@example.com", "device-123", "session-abc")
            .await
            .expect("terminal should be reusable after the bridge drops");
        assert_eq!(terminal_id, "terminal-1");

        let start_message = control_bridge_rx
            .recv()
            .await
            .expect("bridge restart message");
        let Message::Text(payload) = start_message else {
            panic!("expected text restart payload");
        };
        let envelope: BrowserToBridgeMessage =
            serde_json::from_str(payload.as_str()).expect("decode restart payload");
        match envelope {
            BrowserToBridgeMessage::TerminalProxyStart {
                terminal_id,
                session_id,
            } => {
                assert_eq!(terminal_id, "terminal-1");
                assert_eq!(session_id, "session-abc");
            }
            other => panic!("unexpected bridge message: {other:?}"),
        }
    }

    #[tokio::test]
    async fn browser_disconnect_keeps_bridge_alive_long_enough_to_reattach() {
        let state = RelayState::default();
        let (browser_tx, _browser_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (bridge_tx, mut bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

        {
            let mut inner = state.inner.lock().await;
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-abc".to_string(),
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    browser: Some(TerminalConnectionRecord {
                        id: 1,
                        tx: browser_tx,
                    }),
                    bridge: Some(TerminalConnectionRecord {
                        id: 2,
                        tx: bridge_tx,
                    }),
                    browser_disconnected_at: None,
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        state
            .unregister_terminal_connection("terminal-1", TerminalPeerKind::Browser, 1)
            .await;

        let (replacement_browser_tx, _replacement_browser_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection(
                "terminal-1",
                TerminalPeerKind::Browser,
                replacement_browser_tx,
            )
            .await
            .expect("browser should reattach");

        tokio::time::sleep(TERMINAL_BROWSER_REATTACH_GRACE + Duration::from_millis(10)).await;

        {
            let inner = state.inner.lock().await;
            let session = inner
                .terminal_sessions
                .get("terminal-1")
                .expect("session should stay alive after browser reattach");
            assert!(session.browser.is_some());
            assert!(session.bridge.is_some());
        }
        assert!(
            bridge_rx.try_recv().is_err(),
            "bridge should stay open after reattach"
        );
    }

    #[tokio::test]
    async fn browser_disconnect_eventually_closes_bridge_if_not_reattached() {
        let state = RelayState::default();
        let (browser_tx, _browser_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (bridge_tx, mut bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);

        {
            let mut inner = state.inner.lock().await;
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-abc".to_string(),
                    device_id: "device-123".to_string(),
                    owner_user_id: "user@example.com".to_string(),
                    browser: Some(TerminalConnectionRecord {
                        id: 1,
                        tx: browser_tx,
                    }),
                    bridge: Some(TerminalConnectionRecord {
                        id: 2,
                        tx: bridge_tx,
                    }),
                    browser_disconnected_at: None,
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        state
            .unregister_terminal_connection("terminal-1", TerminalPeerKind::Browser, 1)
            .await;

        tokio::time::sleep(TERMINAL_BROWSER_REATTACH_GRACE + Duration::from_millis(10)).await;

        {
            let inner = state.inner.lock().await;
            assert!(
                !inner.terminal_sessions.contains_key("terminal-1"),
                "session should be cleaned up after grace period"
            );
        }

        let close_message = bridge_rx
            .recv()
            .await
            .expect("bridge should receive cleanup close");
        assert!(matches!(close_message, Message::Close(_)));
    }

    #[tokio::test]
    async fn persisted_device_state_round_trips() {
        let _guard = RELAY_STATE_ENV_LOCK.lock().await;
        let path =
            std::env::temp_dir().join(format!("conductor-relay-state-{}.json", Uuid::new_v4()));
        unsafe {
            std::env::set_var(RELAY_STATE_FILE_ENV, &path);
        }

        let mut inner = RelayInner::default();
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
        inner
            .refresh_tokens
            .insert("refresh-token".to_string(), "device-123".to_string());
        inner.state_revision = 1;
        persist_devices_snapshot(build_persisted_relay_state(&inner))
            .await
            .expect("device state should persist");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("persisted state metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "relay state must be owner-readable only");
        }

        let stale_snapshot = build_persisted_relay_state(&inner);
        inner.state_revision = 2;
        inner
            .devices
            .get_mut("device-123")
            .expect("device should exist")
            .name = "Mac (newer)".to_string();
        let mut coordinator = PersistenceCoordinator {
            last_persisted_revision: 1,
        };
        persist_newer_devices_snapshot(build_persisted_relay_state(&inner), &mut coordinator)
            .await
            .expect("newer snapshot should persist");
        persist_newer_devices_snapshot(stale_snapshot, &mut coordinator)
            .await
            .expect_err("an older snapshot must not overwrite newer relay state");

        let stored: PersistedRelayState =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read persisted state"))
                .expect("parse persisted state");
        assert_eq!(stored.revision, 2);
        assert_eq!(stored.devices[0].name, "Mac (newer)");

        let loaded = RelayState::load_persisted()
            .await
            .expect("persisted relay state should load");
        let loaded_inner = loaded.inner.lock().await;
        let loaded_device = loaded_inner
            .devices
            .get("device-123")
            .expect("device should reload");
        assert_eq!(loaded_device.owner_user_id, "user@example.com");
        assert_eq!(loaded_device.name, "Mac (newer)");
        assert_eq!(
            loaded_inner.refresh_tokens.get("refresh-token"),
            Some(&"device-123".to_string())
        );
        drop(loaded_inner);

        unsafe {
            std::env::remove_var(RELAY_STATE_FILE_ENV);
        }
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn pairing_rejects_a_device_id_owned_by_another_user() {
        let _guard = RELAY_STATE_ENV_LOCK.lock().await;
        unsafe {
            std::env::remove_var(RELAY_STATE_FILE_ENV);
        }
        let state = RelayState::default();
        let first_code = state
            .create_pairing_code("owner-a".to_string(), "First".to_string())
            .await
            .expect("first pairing code");
        state
            .pair_device(DevicePairRequest {
                code: first_code,
                device_id: "shared-device-id".to_string(),
                hostname: "first-host".to_string(),
                os: "darwin".to_string(),
                arch: "arm64".to_string(),
            })
            .await
            .expect("first owner should pair the device id");

        let second_code = state
            .create_pairing_code("owner-b".to_string(), "Second".to_string())
            .await
            .expect("second pairing code");
        let err = state
            .pair_device(DevicePairRequest {
                code: second_code,
                device_id: "shared-device-id".to_string(),
                hostname: "second-host".to_string(),
                os: "linux".to_string(),
                arch: "x86_64".to_string(),
            })
            .await
            .expect_err("another owner must not take over an existing device id");

        assert_eq!(err.0, StatusCode::CONFLICT);
        let inner = state.inner.lock().await;
        assert_eq!(
            inner
                .devices
                .get("shared-device-id")
                .map(|device| device.owner_user_id.as_str()),
            Some("owner-a")
        );
    }

    #[tokio::test]
    async fn replacing_a_control_bridge_closes_the_stale_generation() {
        let state = RelayState::default();
        let (old_tx, mut old_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_connection(
                "device-123",
                PeerKind::Bridge,
                "owner-a".to_string(),
                old_tx,
                None,
            )
            .await
            .expect("first control bridge should register");

        let (new_tx, _new_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_connection(
                "device-123",
                PeerKind::Bridge,
                "owner-a".to_string(),
                new_tx,
                None,
            )
            .await
            .expect("replacement control bridge should register");

        assert!(matches!(old_rx.recv().await, Some(Message::Close(_))));
    }

    #[tokio::test]
    async fn stale_terminal_cleanup_does_not_unregister_a_replacement() {
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            inner.terminal_sessions.insert(
                "terminal-1".to_string(),
                TerminalSessionRecord {
                    terminal_id: "terminal-1".to_string(),
                    session_id: "session-1".to_string(),
                    device_id: "device-1".to_string(),
                    owner_user_id: "owner-a".to_string(),
                    browser: None,
                    bridge: None,
                    browser_disconnected_at: None,
                    attach_generation: 1,
                    attach_deadline: None,
                    browser_paused: false,
                    pause_buffer: Vec::new(),
                    pause_buffer_bytes: 0,
                    pending_browser_frames: Vec::new(),
                    pending_browser_frame_bytes: 0,
                },
            );
        }

        let (old_tx, _old_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let old_connection_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, old_tx)
            .await
            .expect("first browser connection");
        let (replacement_tx, _replacement_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, replacement_tx)
            .await
            .expect("replacement browser connection");

        state
            .unregister_terminal_connection(
                "terminal-1",
                TerminalPeerKind::Browser,
                old_connection_id,
            )
            .await;

        let inner = state.inner.lock().await;
        assert!(
            inner
                .terminal_sessions
                .get("terminal-1")
                .and_then(|session| session.browser.as_ref())
                .is_some(),
            "cleanup from the stale socket must not remove its replacement"
        );
    }

    #[tokio::test]
    async fn stale_terminal_generation_cannot_forward_messages() {
        let state = RelayState::default();
        state.inner.lock().await.terminal_sessions.insert(
            "terminal-1".to_string(),
            detached_terminal("terminal-1", "session-1", "device-1", "owner-a"),
        );
        let (browser_tx, mut browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser connection");
        let (old_bridge_tx, _old_bridge_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let old_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Bridge, old_bridge_tx)
            .await
            .expect("old bridge connection");
        let (new_bridge_tx, _new_bridge_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let new_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Bridge, new_bridge_tx)
            .await
            .expect("replacement bridge connection");

        let output = Message::Binary(b"terminal output".to_vec().into());
        assert!(
            !state
                .forward_terminal_message("terminal-1", TerminalPeerKind::Bridge, old_id, &output,)
                .await
        );
        assert!(browser_rx.try_recv().is_err());

        assert!(
            state
                .forward_terminal_message("terminal-1", TerminalPeerKind::Bridge, new_id, &output,)
                .await
        );
        assert!(matches!(browser_rx.recv().await, Some(Message::Binary(_))));
    }

    #[tokio::test]
    async fn terminal_bridge_output_accepts_backend_snapshot_above_control_limit() {
        let state = RelayState::default();
        state.inner.lock().await.terminal_sessions.insert(
            "terminal-1".to_string(),
            detached_terminal("terminal-1", "session-1", "device-1", "owner-a"),
        );
        let (browser_tx, mut browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser connection");
        let (bridge_tx, _bridge_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let bridge_connection_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Bridge, bridge_tx)
            .await
            .expect("bridge connection");

        // This is the exact retained-screen frame size observed in production. It is larger than
        // the general relay limit but remains below the backend's bounded 2 MiB snapshot ceiling.
        let snapshot_bytes = MAX_WS_MESSAGE_BYTES + 4096;
        let output = Message::Binary(vec![b'0'; snapshot_bytes].into());
        assert!(
            state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Bridge,
                    bridge_connection_id,
                    &output,
                )
                .await
        );
        let forwarded = browser_rx
            .recv()
            .await
            .expect("snapshot should be forwarded");
        assert_eq!(websocket_message_size(&forwarded), snapshot_bytes);
    }

    #[tokio::test]
    async fn terminal_browser_input_keeps_the_general_message_limit() {
        let state = RelayState::default();
        state.inner.lock().await.terminal_sessions.insert(
            "terminal-1".to_string(),
            detached_terminal("terminal-1", "session-1", "device-1", "owner-a"),
        );
        let (browser_tx, mut browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let browser_connection_id = state
            .register_terminal_connection("terminal-1", TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser connection");
        let oversized_input = Message::Binary(vec![b'0'; MAX_WS_MESSAGE_BYTES + 1].into());

        assert!(
            !state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Browser,
                    browser_connection_id,
                    &oversized_input,
                )
                .await
        );
        assert!(matches!(browser_rx.recv().await, Some(Message::Close(_))));
    }

    #[tokio::test]
    async fn device_channel_registration_rejects_a_different_owner() {
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
        }

        let (tx, _rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let err = state
            .register_connection(
                "device-1",
                PeerKind::Bridge,
                "owner-b".to_string(),
                tx,
                None,
            )
            .await
            .expect_err("a live channel cannot disagree with persisted device ownership");
        assert!(err.to_string().contains("device owner"));
        assert!(state.inner.lock().await.channels.is_empty());
    }

    #[tokio::test]
    async fn pairing_rejects_a_device_id_with_a_different_live_channel_owner() {
        let mut inner = RelayInner::default();
        let (bridge_tx, _bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        inner.channels.insert(
            "device-1".to_string(),
            BridgeChannel {
                bridge: Some(ConnectionRecord {
                    id: 1,
                    user_id: "owner-b".to_string(),
                    tx: bridge_tx,
                }),
                ..Default::default()
            },
        );

        let err = issue_device_pairing(
            &mut inner,
            "owner-a".to_string(),
            "device-1".to_string(),
            "host".to_string(),
            "darwin".to_string(),
            "arm64".to_string(),
            None,
        )
        .expect_err("pairing must not overwrite a differently owned live channel");
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert!(!inner.devices.contains_key("device-1"));
    }

    #[tokio::test]
    async fn stale_control_generation_cannot_complete_a_pending_request() {
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
        }

        let (old_tx, _old_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let old_id = state
            .register_connection(
                "device-1",
                PeerKind::Bridge,
                "owner-a".to_string(),
                old_tx,
                None,
            )
            .await
            .expect("old bridge registration");
        let (new_tx, _new_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let new_id = state
            .register_connection(
                "device-1",
                PeerKind::Bridge,
                "owner-a".to_string(),
                new_tx,
                None,
            )
            .await
            .expect("replacement bridge registration");

        let (pending_tx, pending_rx) = oneshot::channel();
        {
            let mut inner = state.inner.lock().await;
            inner.pending_api_requests.insert(
                "request-1".to_string(),
                PendingApiRequest {
                    device_id: "device-1".to_string(),
                    request_bytes: 16,
                    tx: pending_tx,
                },
            );
            inner.pending_api_bytes = 16;
        }

        let response = BridgeToBrowserMessage::ApiResponse {
            id: "request-1".to_string(),
            status: 200,
            body: json!({"source": "bridge"}),
        };
        let raw = serde_json::to_string(&response).expect("serialize response");
        assert!(
            !state
                .route_bridge_message("device-1", old_id, response.clone(), raw.clone())
                .await,
            "the replaced bridge generation must be rejected"
        );
        assert!(state
            .inner
            .lock()
            .await
            .pending_api_requests
            .contains_key("request-1"));

        assert!(
            state
                .route_bridge_message("device-1", new_id, response, raw)
                .await
        );
        let delivered = pending_rx
            .await
            .expect("active bridge should deliver response");
        assert_eq!(delivered.status, 200);
        let inner = state.inner.lock().await;
        assert_eq!(inner.pending_api_bytes, 0);
        assert!(!inner.pending_api_requests.contains_key("request-1"));
    }

    #[tokio::test]
    async fn unattached_terminal_expires_and_notifies_the_browser() {
        let state = RelayState::default();
        let (control_tx, mut control_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
            inner.channels.insert(
                "device-1".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "owner-a".to_string(),
                        tx: control_tx,
                    }),
                    ..Default::default()
                },
            );
        }

        let terminal_id = state
            .create_terminal_session("owner-a", "device-1", "session-1")
            .await
            .expect("terminal record should be created");
        assert!(matches!(control_rx.recv().await, Some(Message::Text(_))));
        let (browser_tx, mut browser_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        state
            .register_terminal_connection(&terminal_id, TerminalPeerKind::Browser, browser_tx)
            .await
            .expect("browser should attach while the device terminal starts");

        let close = tokio::time::timeout(Duration::from_secs(1), browser_rx.recv())
            .await
            .expect("attach timeout should notify the browser")
            .expect("browser queue should receive a close frame");
        let Message::Close(Some(frame)) = close else {
            panic!("expected terminal attach failure close frame");
        };
        assert_eq!(frame.code, 1013);
        assert!(frame.reason.contains("failed to attach"));
        assert!(!state
            .inner
            .lock()
            .await
            .terminal_sessions
            .contains_key(&terminal_id));
    }

    #[tokio::test]
    async fn terminal_session_count_is_capped_per_device() {
        let state = RelayState::default();
        let (control_tx, _control_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
            inner.channels.insert(
                "device-1".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "owner-a".to_string(),
                        tx: control_tx,
                    }),
                    ..Default::default()
                },
            );
            for index in 0..MAX_TERMINAL_SESSIONS_PER_DEVICE {
                inner.terminal_sessions.insert(
                    format!("terminal-{index}"),
                    detached_terminal(
                        &format!("terminal-{index}"),
                        &format!("session-{index}"),
                        "device-1",
                        "owner-a",
                    ),
                );
            }
        }

        let err = state
            .create_terminal_session("owner-a", "device-1", "one-too-many")
            .await
            .expect_err("terminal session allocation must be capped");
        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn paused_terminal_output_is_bounded_by_bytes() {
        let state = RelayState::default();
        let (bridge_tx, _bridge_rx) = test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let mut terminal = detached_terminal("terminal-1", "session-1", "device-1", "owner-a");
        terminal.browser_paused = true;
        terminal.bridge = Some(TerminalConnectionRecord {
            id: 7,
            tx: bridge_tx,
        });
        state
            .inner
            .lock()
            .await
            .terminal_sessions
            .insert("terminal-1".to_string(), terminal);

        let retained_snapshot =
            Message::Binary(vec![0_u8; MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES].into());
        assert!(
            state
                .forward_terminal_message(
                    "terminal-1",
                    TerminalPeerKind::Bridge,
                    7,
                    &retained_snapshot,
                )
                .await
        );
        assert_eq!(
            state
                .inner
                .lock()
                .await
                .terminal_sessions
                .get("terminal-1")
                .expect("terminal remains active")
                .pause_buffer_bytes,
            MAX_TERMINAL_BRIDGE_WS_MESSAGE_BYTES
        );

        let chunk = Message::Binary(vec![0_u8; 700 * 1024].into());
        for _ in 0..4 {
            assert!(
                state
                    .forward_terminal_message("terminal-1", TerminalPeerKind::Bridge, 7, &chunk,)
                    .await
            );
        }

        let inner = state.inner.lock().await;
        let terminal = inner
            .terminal_sessions
            .get("terminal-1")
            .expect("terminal remains active");
        assert!(terminal.pause_buffer_bytes <= TERMINAL_PAUSE_BUFFER_BYTE_CAPACITY);
        assert_eq!(
            terminal.pause_buffer_bytes,
            terminal
                .pause_buffer
                .iter()
                .map(websocket_message_size)
                .sum::<usize>()
        );
        assert!(
            terminal.pause_buffer.len() < 4,
            "old output must be evicted"
        );
    }

    #[tokio::test]
    async fn pending_request_byte_budget_is_enforced() {
        let state = RelayState::default();
        let (bridge_tx, _bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (pending_tx, _pending_rx) = oneshot::channel();
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
            inner.channels.insert(
                "device-1".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "owner-a".to_string(),
                        tx: bridge_tx,
                    }),
                    ..Default::default()
                },
            );
            inner.pending_api_requests.insert(
                "large-pending".to_string(),
                PendingApiRequest {
                    device_id: "device-1".to_string(),
                    request_bytes: MAX_PENDING_API_REQUEST_BYTES,
                    tx: pending_tx,
                },
            );
            inner.pending_api_bytes = MAX_PENDING_API_REQUEST_BYTES;
        }

        let err = state
            .forward_device_api_request("owner-a", "device-1", "GET", "/api/sessions", None)
            .await
            .expect_err("aggregate pending bytes must be capped");
        assert_eq!(err.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn oversized_proxy_request_is_rejected_before_queueing() {
        let state = RelayState::default();
        let err = state
            .forward_device_api_request(
                "owner-a",
                "device-1",
                "POST",
                "/api/test",
                Some(json!({"payload": "x".repeat(MAX_WS_MESSAGE_BYTES)})),
            )
            .await
            .expect_err("oversized requests must not enter a websocket queue");
        assert_eq!(err.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(state.inner.lock().await.pending_api_requests.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_device_cleans_all_runtime_state() {
        let _guard = RELAY_STATE_ENV_LOCK.lock().await;
        unsafe {
            std::env::remove_var(RELAY_STATE_FILE_ENV);
        }
        let state = RelayState::default();
        let (control_tx, mut control_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (dashboard_tx, mut dashboard_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        let (terminal_browser_tx, mut terminal_browser_rx) =
            test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let (terminal_bridge_tx, mut terminal_bridge_rx) =
            test_message_channel(TERMINAL_WS_QUEUE_CAPACITY);
        let (api_tx, api_rx) = oneshot::channel();
        let (preview_tx, preview_rx) = oneshot::channel();

        {
            let mut inner = state.inner.lock().await;
            let device = test_device("device-1", "owner-a");
            inner
                .refresh_tokens
                .insert(device.refresh_token.clone(), device.device_id.clone());
            inner.devices.insert(device.device_id.clone(), device);
            inner.channels.insert(
                "device-1".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "owner-a".to_string(),
                        tx: control_tx,
                    }),
                    browsers: HashMap::from([(
                        2,
                        ConnectionRecord {
                            id: 2,
                            user_id: "owner-a".to_string(),
                            tx: dashboard_tx,
                        },
                    )]),
                    last_status: None,
                },
            );
            inner.pending_api_requests.insert(
                "api-1".to_string(),
                PendingApiRequest {
                    device_id: "device-1".to_string(),
                    request_bytes: 11,
                    tx: api_tx,
                },
            );
            inner.pending_api_bytes = 11;
            inner.pending_preview_requests.insert(
                "preview-1".to_string(),
                PendingPreviewRequest {
                    device_id: "device-1".to_string(),
                    request_bytes: 13,
                    tx: preview_tx,
                },
            );
            inner.pending_preview_bytes = 13;

            let mut terminal = detached_terminal("terminal-1", "session-1", "device-1", "owner-a");
            terminal.browser = Some(TerminalConnectionRecord {
                id: 3,
                tx: terminal_browser_tx,
            });
            terminal.bridge = Some(TerminalConnectionRecord {
                id: 4,
                tx: terminal_bridge_tx,
            });
            inner
                .terminal_sessions
                .insert("terminal-1".to_string(), terminal);
            inner.device_claims.insert(
                "claim-1".to_string(),
                PendingDeviceClaim {
                    poll_token: "poll-1".to_string(),
                    device_id: "device-1".to_string(),
                    hostname: "host".to_string(),
                    os: "darwin".to_string(),
                    arch: "arm64".to_string(),
                    suggested_name: None,
                    expires_at: Instant::now() + PAIRING_CODE_TTL,
                    paired_response: None,
                    pairing_in_progress: false,
                    request_bytes: 0,
                },
            );
        }

        assert!(state
            .delete_device("owner-a", "device-1")
            .await
            .expect("device deletion should succeed"));

        let inner = state.inner.lock().await;
        assert!(!inner.devices.contains_key("device-1"));
        assert!(!inner.channels.contains_key("device-1"));
        assert!(!inner.terminal_sessions.contains_key("terminal-1"));
        assert!(inner.pending_api_requests.is_empty());
        assert!(inner.pending_preview_requests.is_empty());
        assert_eq!(inner.pending_api_bytes, 0);
        assert_eq!(inner.pending_preview_bytes, 0);
        assert!(inner.device_claims.is_empty());
        drop(inner);

        for receiver in [&mut control_rx, &mut dashboard_rx] {
            assert!(matches!(receiver.recv().await, Some(Message::Close(_))));
        }
        for receiver in [&mut terminal_browser_rx, &mut terminal_bridge_rx] {
            assert!(matches!(receiver.recv().await, Some(Message::Close(_))));
        }
        assert_eq!(
            api_rx
                .await
                .expect("pending API request should fail")
                .status,
            StatusCode::SERVICE_UNAVAILABLE.as_u16()
        );
        assert_eq!(
            preview_rx
                .await
                .expect("pending preview request should fail")
                .status,
            StatusCode::SERVICE_UNAVAILABLE.as_u16()
        );
    }

    #[tokio::test]
    async fn browser_connection_caps_are_isolated_and_release_on_disconnect() {
        let state = RelayState::default();
        let (tx, _rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            let mut channel = BridgeChannel::default();
            for id in 0..MAX_BROWSER_CONNECTIONS_PER_CHANNEL as u64 {
                channel.browsers.insert(
                    id,
                    ConnectionRecord {
                        id,
                        user_id: "owner-a".to_string(),
                        tx: tx.clone(),
                    },
                );
            }
            inner.channels.insert("device-a".to_string(), channel);
        }

        let (overflow_tx, _overflow_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(state
            .register_connection(
                "device-a",
                PeerKind::Browser,
                "owner-a".to_string(),
                overflow_tx.clone(),
                None,
            )
            .await
            .expect_err("per-channel browser cap should reject overflow")
            .to_string()
            .contains("channel"));

        state
            .unregister_connection("device-a", PeerKind::Browser, 0)
            .await;
        state
            .register_connection(
                "device-a",
                PeerKind::Browser,
                "owner-a".to_string(),
                overflow_tx,
                None,
            )
            .await
            .expect("disconnecting a browser should release its capacity");

        let (bridge_tx, _bridge_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_connection(
                "device-a",
                PeerKind::Bridge,
                "owner-a".to_string(),
                bridge_tx,
                None,
            )
            .await
            .expect("the channel should still have room for its one control bridge");
        let (channel_control_overflow_tx, _channel_control_overflow_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(state
            .register_connection(
                "device-a",
                PeerKind::Browser,
                "owner-a".to_string(),
                channel_control_overflow_tx,
                None,
            )
            .await
            .expect_err("combined per-channel control cap should reject overflow")
            .to_string()
            .contains("control connection capacity reached for this channel"));

        let per_user_state = RelayState::default();
        {
            let mut inner = per_user_state.inner.lock().await;
            for id in 0..MAX_BROWSER_CONNECTIONS_PER_USER as u64 {
                inner.channels.insert(
                    format!("user-channel-{id}"),
                    BridgeChannel {
                        browsers: HashMap::from([(
                            id,
                            ConnectionRecord {
                                id,
                                user_id: "owner-a".to_string(),
                                tx: tx.clone(),
                            },
                        )]),
                        ..Default::default()
                    },
                );
            }
        }
        let (user_overflow_tx, _user_overflow_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(per_user_state
            .register_connection(
                "new-user-channel",
                PeerKind::Browser,
                "owner-a".to_string(),
                user_overflow_tx,
                None,
            )
            .await
            .expect_err("per-user browser cap should reject overflow")
            .to_string()
            .contains("user"));

        let global_state = RelayState::default();
        {
            let mut inner = global_state.inner.lock().await;
            for id in 0..MAX_BROWSER_CONNECTIONS_GLOBAL as u64 {
                inner.channels.insert(
                    format!("global-browser-channel-{id}"),
                    BridgeChannel {
                        browsers: HashMap::from([(
                            id,
                            ConnectionRecord {
                                id,
                                user_id: format!("owner-{id}"),
                                tx: tx.clone(),
                            },
                        )]),
                        ..Default::default()
                    },
                );
            }
        }
        let (global_overflow_tx, _global_overflow_rx) =
            test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(global_state
            .register_connection(
                "global-overflow",
                PeerKind::Browser,
                "new-owner".to_string(),
                global_overflow_tx,
                None,
            )
            .await
            .expect_err("global browser cap should reject overflow")
            .to_string()
            .contains("browser connection capacity"));
    }

    #[tokio::test]
    async fn control_connection_caps_allow_bridge_replacement_without_growth() {
        let state = RelayState::default();
        let (shared_tx, mut shared_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            for id in 0..MAX_CONTROL_CONNECTIONS_GLOBAL as u64 {
                inner.channels.insert(
                    format!("control-channel-{id}"),
                    BridgeChannel {
                        bridge: Some(ConnectionRecord {
                            id,
                            user_id: format!("owner-{id}"),
                            tx: shared_tx.clone(),
                        }),
                        ..Default::default()
                    },
                );
            }
            inner.next_connection_id = MAX_CONTROL_CONNECTIONS_GLOBAL as u64;
        }

        let (overflow_tx, _overflow_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(state
            .register_connection(
                "new-channel",
                PeerKind::Bridge,
                "new-owner".to_string(),
                overflow_tx,
                None,
            )
            .await
            .expect_err("global control cap should reject a new connection")
            .to_string()
            .contains("control connection capacity"));

        let (replacement_tx, _replacement_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        state
            .register_connection(
                "control-channel-0",
                PeerKind::Bridge,
                "owner-0".to_string(),
                replacement_tx,
                None,
            )
            .await
            .expect("replacing a live bridge must not consume additional capacity");
        assert!(matches!(shared_rx.recv().await, Some(Message::Close(_))));

        let per_user_state = RelayState::default();
        {
            let mut inner = per_user_state.inner.lock().await;
            for id in 0..MAX_CONTROL_CONNECTIONS_PER_USER as u64 {
                inner.channels.insert(
                    format!("owner-control-{id}"),
                    BridgeChannel {
                        bridge: Some(ConnectionRecord {
                            id,
                            user_id: "owner-a".to_string(),
                            tx: shared_tx.clone(),
                        }),
                        ..Default::default()
                    },
                );
            }
        }
        let (user_overflow_tx, _user_overflow_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        assert!(per_user_state
            .register_connection(
                "owner-control-overflow",
                PeerKind::Bridge,
                "owner-a".to_string(),
                user_overflow_tx,
                None,
            )
            .await
            .expect_err("per-user control cap should reject overflow")
            .to_string()
            .contains("user"));
    }

    #[test]
    fn paired_device_quotas_allow_repair_but_reject_growth() {
        let mut inner = RelayInner::default();
        for id in 0..MAX_PAIRED_DEVICES_PER_USER {
            let device_id = format!("owner-device-{id}");
            inner
                .devices
                .insert(device_id.clone(), test_device(&device_id, "owner-a"));
        }

        issue_device_pairing(
            &mut inner,
            "owner-a".to_string(),
            "owner-device-0".to_string(),
            "host".to_string(),
            "darwin".to_string(),
            "arm64".to_string(),
            None,
        )
        .expect("repairing an existing device must not consume quota");
        let per_user_error = issue_device_pairing(
            &mut inner,
            "owner-a".to_string(),
            "owner-device-overflow".to_string(),
            "host".to_string(),
            "darwin".to_string(),
            "arm64".to_string(),
            None,
        )
        .expect_err("per-user device quota should reject growth");
        assert_eq!(per_user_error.0, StatusCode::TOO_MANY_REQUESTS);

        let mut global = RelayInner::default();
        for id in 0..MAX_PAIRED_DEVICES_GLOBAL {
            let device_id = format!("global-device-{id}");
            global.devices.insert(
                device_id.clone(),
                test_device(&device_id, &format!("owner-{id}")),
            );
        }
        let global_error = issue_device_pairing(
            &mut global,
            "new-owner".to_string(),
            "global-device-overflow".to_string(),
            "host".to_string(),
            "darwin".to_string(),
            "arm64".to_string(),
            None,
        )
        .expect_err("global device quota should reject growth");
        assert_eq!(global_error.0, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn terminal_per_user_quota_releases_when_a_session_is_removed() {
        let state = RelayState::default();
        let (control_tx, mut control_rx) = test_message_channel(CONTROL_WS_QUEUE_CAPACITY);
        {
            let mut inner = state.inner.lock().await;
            inner
                .devices
                .insert("device-1".to_string(), test_device("device-1", "owner-a"));
            inner.channels.insert(
                "device-1".to_string(),
                BridgeChannel {
                    bridge: Some(ConnectionRecord {
                        id: 1,
                        user_id: "owner-a".to_string(),
                        tx: control_tx,
                    }),
                    ..Default::default()
                },
            );
            for id in 0..MAX_TERMINAL_SESSIONS_PER_USER {
                let terminal_id = format!("terminal-{id}");
                inner.terminal_sessions.insert(
                    terminal_id.clone(),
                    detached_terminal(
                        &terminal_id,
                        &format!("existing-session-{id}"),
                        &format!("device-{id}"),
                        "owner-a",
                    ),
                );
            }
        }

        let error = state
            .create_terminal_session("owner-a", "device-1", "new-session")
            .await
            .expect_err("terminal per-user quota should reject growth");
        assert_eq!(error.0, StatusCode::TOO_MANY_REQUESTS);

        state
            .inner
            .lock()
            .await
            .terminal_sessions
            .remove("terminal-0");
        state
            .create_terminal_session("owner-a", "device-1", "new-session")
            .await
            .expect("removing a terminal should release per-user capacity");
        assert!(matches!(control_rx.recv().await, Some(Message::Text(_))));
    }

    #[tokio::test]
    async fn readiness_requires_auth_and_usable_state_storage() {
        assert_eq!(
            relay_readiness_error_for(None, None, None).await.as_deref(),
            Some("Relay JWT authentication is not configured.")
        );
        assert!(relay_readiness_error_for(Some("too-short"), None, None)
            .await
            .expect("weak secrets must fail readiness")
            .contains("at least 32 bytes"));

        let unusable =
            std::env::temp_dir().join(format!("conductor-relay-state-dir-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&unusable).expect("create unusable state directory");
        let error = relay_readiness_error_for(
            Some("configured-secret-at-least-32-bytes"),
            Some(&unusable),
            None,
        )
        .await
        .expect("a directory cannot be used as a state file");
        assert!(error.contains("not a regular file"));
        std::fs::remove_dir_all(&unusable).expect("remove unusable state directory");

        let usable =
            std::env::temp_dir().join(format!("conductor-relay-ready-{}.json", Uuid::new_v4()));
        assert!(
            relay_readiness_error_for(
                Some("configured-secret-at-least-32-bytes"),
                Some(&usable),
                None,
            )
            .await
            .is_none(),
            "a writable state-file location should be ready"
        );
        assert!(
            !usable.exists(),
            "readiness probes must not create state data"
        );
    }

    #[tokio::test]
    async fn health_response_exposes_explicit_ready_state() {
        let unavailable = relay_health_response(
            1,
            2,
            Some("Relay JWT authentication is not configured.".to_string()),
            "test-build-sha".to_string(),
        );
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(unavailable.into_body(), 16 * 1024)
            .await
            .expect("health response body");
        let value: Value = serde_json::from_slice(&body).expect("health JSON");
        assert_eq!(value["ok"], false);
        assert_eq!(value["ready"], false);
        assert_eq!(value["buildSha"], "test-build-sha");

        let ready = relay_health_response(1, 2, None, "test-build-sha".to_string());
        assert_eq!(ready.status(), StatusCode::OK);
        let body = axum::body::to_bytes(ready.into_body(), 16 * 1024)
            .await
            .expect("health response body");
        let value: Value = serde_json::from_slice(&body).expect("health JSON");
        assert_eq!(value["ok"], true);
        assert_eq!(value["ready"], true);
        assert_eq!(value["buildSha"], "test-build-sha");
        assert_eq!(normalize_build_sha(None), "unknown");
        assert_eq!(normalize_build_sha(Some("  ")), "unknown");
        assert_eq!(normalize_build_sha(Some(" abc123 ")), "abc123");
    }

    #[test]
    fn cors_origins_are_explicit_and_validated() {
        let defaults = parse_allowed_origins(None).expect("production default origin");
        assert_eq!(
            defaults,
            vec![
                HeaderValue::from_static("https://app.conductross.com"),
                HeaderValue::from_static("https://preview.conductross.com"),
            ]
        );

        let configured = parse_allowed_origins(Some(
            "https://app.conductross.com, http://localhost:3000/, http://127.0.0.1:3000",
        ))
        .expect("explicit local development origins");
        assert_eq!(configured.len(), 3);
        assert!(configured.contains(&HeaderValue::from_static("http://localhost:3000")));
        assert!(parse_allowed_origins(Some("")).is_err());
        assert!(parse_allowed_origins(Some("*")).is_err());
        assert!(parse_allowed_origins(Some("https://example.com/path")).is_err());
        assert!(parse_allowed_origins(Some("javascript:alert(1)")).is_err());

        let mut headers = HeaderMap::new();
        assert!(
            ensure_websocket_origin_with(&headers, &configured).is_ok(),
            "native bridge clients without Origin must remain supported"
        );
        headers.insert(ORIGIN, HeaderValue::from_static("http://localhost:3000"));
        assert!(ensure_websocket_origin_with(&headers, &configured).is_ok());
        headers.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        let denied = ensure_websocket_origin_with(&headers, &configured)
            .expect_err("disallowed browser origin must be rejected");
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn malformed_cors_configuration_fails_readiness() {
        let error =
            relay_readiness_error_for(Some("configured-secret-at-least-32-bytes"), None, Some("*"))
                .await
                .expect("wildcard CORS must fail readiness");
        assert!(error.contains("CORS configuration is invalid"));
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
    let secret = env::var(DEFAULT_JWT_SECRET_ENV).ok();
    let secret = validate_relay_jwt_secret(secret.as_deref())?;
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
