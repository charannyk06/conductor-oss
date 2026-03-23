use chrono::{DateTime, Utc};
use serde::Serialize;

use super::types::SessionStatus;

pub(crate) const BRIDGE_OFFLINE_STATUS: &str = "bridge_offline";
pub(crate) const BRIDGE_HEARTBEAT_TIMEOUT_SECS: i64 = 60;

#[derive(Clone, Debug)]
pub(crate) struct BridgeConnectionRecord {
    pub bridge_id: String,
    pub hostname: String,
    pub os: String,
    pub capabilities: Vec<String>,
    pub connected: bool,
    pub connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeConnectionStatus {
    pub bridge_id: String,
    pub hostname: String,
    pub os: String,
    pub capabilities: Vec<String>,
    pub connected: bool,
    pub status: String,
    pub connected_at: String,
    pub last_seen_at: String,
}

impl From<&BridgeConnectionRecord> for BridgeConnectionStatus {
    fn from(value: &BridgeConnectionRecord) -> Self {
        Self {
            bridge_id: value.bridge_id.clone(),
            hostname: value.hostname.clone(),
            os: value.os.clone(),
            capabilities: value.capabilities.clone(),
            connected: value.connected,
            status: if value.connected { "online" } else { "offline" }.to_string(),
            connected_at: value.connected_at.to_rfc3339(),
            last_seen_at: value.last_seen_at.to_rfc3339(),
        }
    }
}

pub(crate) fn normalize_bridge_text(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn normalize_bridge_capabilities(capabilities: Vec<String>) -> Vec<String> {
    let mut normalized = capabilities
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

pub(crate) fn bridge_offline_status() -> SessionStatus {
    SessionStatus::Other(BRIDGE_OFFLINE_STATUS.to_string())
}
