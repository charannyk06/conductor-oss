//! Heartbeat timing and maintenance for ACP dispatcher sessions.

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use super::acp_dispatcher::ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY;
use super::types::SessionRecord;

pub(crate) const ACP_HEARTBEAT_INTERVAL: ChronoDuration = ChronoDuration::minutes(15);
pub(crate) const ACP_WATCHDOG_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

fn parse_timestamp(value: Option<&String>) -> Option<DateTime<Utc>> {
    value
        .map(String::as_str)
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

pub(crate) fn heartbeat_times(session: &SessionRecord) -> (DateTime<Utc>, DateTime<Utc>, String) {
    let now = Utc::now();
    let last = parse_timestamp(session.metadata.get("acpLastHeartbeatAt"))
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(&session.last_activity_at)
                .ok()
                .map(|parsed| parsed.with_timezone(&Utc))
        })
        .unwrap_or(now);
    let next = parse_timestamp(session.metadata.get("acpNextHeartbeatAt"))
        .unwrap_or_else(|| last + ACP_HEARTBEAT_INTERVAL);
    let state = session
        .metadata
        .get("acpHeartbeatState")
        .cloned()
        .unwrap_or_else(|| {
            if now >= next {
                "due".to_string()
            } else {
                "active".to_string()
            }
        });
    (last, next, state)
}

pub(crate) fn touch_acp_dispatcher_heartbeat(session: &mut SessionRecord) {
    if !super::acp_dispatcher::is_acp_dispatcher_thread(session) {
        return;
    }
    let now = Utc::now();
    session
        .metadata
        .insert("acpHeartbeatState".to_string(), "active".to_string());
    session
        .metadata
        .insert("acpLastHeartbeatAt".to_string(), now.to_rfc3339());
    session.metadata.insert(
        "acpNextHeartbeatAt".to_string(),
        (now + ACP_HEARTBEAT_INTERVAL).to_rfc3339(),
    );
}

pub(crate) fn heartbeat_due_eligible(session: &SessionRecord) -> bool {
    matches!(
        session.status,
        super::types::SessionStatus::Idle | super::types::SessionStatus::NeedsInput
    )
}

pub(crate) fn heartbeat_can_prompt_live_runtime(session: &SessionRecord) -> bool {
    matches!(
        session.status,
        super::types::SessionStatus::Idle | super::types::SessionStatus::NeedsInput
    )
}

pub(crate) const ACP_SESSION_MEMORY_SYNC_INTERVAL: ChronoDuration = ChronoDuration::seconds(5);

pub(crate) fn should_sync_dispatcher_session_memory(
    session: &mut SessionRecord,
    force: bool,
) -> bool {
    if !super::acp_dispatcher::is_acp_dispatcher_thread(session) {
        return false;
    }

    let now = Utc::now();
    let should_sync = force
        || parse_timestamp(
            session
                .metadata
                .get(ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY),
        )
        .map(|last| now.signed_duration_since(last) >= ACP_SESSION_MEMORY_SYNC_INTERVAL)
        .unwrap_or(true);

    if should_sync {
        session.metadata.insert(
            ACP_SESSION_MEMORY_SYNCED_AT_METADATA_KEY.to_string(),
            now.to_rfc3339(),
        );
    }

    should_sync
}
