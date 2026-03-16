use crate::routes::terminal::bootstrap::{
    append_server_timing_metric, elapsed_duration_ms, set_terminal_bool_header,
    set_terminal_header, timed_error_response,
};
use crate::state::{
    trim_lines_tail, AppState, SessionRecord, TerminalRestoreSnapshot,
    TERMINAL_RESTORE_SNAPSHOT_VERSION,
};
use anyhow::Result;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path as StdPath;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

#[derive(Debug, Deserialize)]
pub struct TerminalSnapshotQuery {
    pub lines: Option<usize>,
    pub live: Option<String>,
}

pub async fn terminal_snapshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<TerminalSnapshotQuery>,
) -> Response {
    let started_at = Instant::now();
    let Some(session) = state.get_session(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Session {id} not found") })),
        )
            .into_response();
    };

    let lines = query
        .lines
        .unwrap_or(crate::state::DEFAULT_TERMINAL_SNAPSHOT_LINES)
        .clamp(25, crate::state::MAX_TERMINAL_SNAPSHOT_LINES);
    let live_requested = terminal_snapshot_live_requested(query.live.as_deref());
    let max_bytes = if live_requested {
        crate::state::LIVE_TERMINAL_SNAPSHOT_MAX_BYTES
    } else {
        crate::state::READ_ONLY_TERMINAL_SNAPSHOT_MAX_BYTES
    };

    match build_terminal_snapshot(&state, &session, lines, max_bytes).await {
        Ok(snapshot) => build_terminal_snapshot_response(snapshot, started_at),
        Err(err) => timed_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            err.to_string(),
            "terminal_snapshot",
            started_at,
        ),
    }
}

pub fn build_terminal_snapshot_response(payload: Value, started_at: Instant) -> Response {
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
        set_terminal_header(
            headers,
            crate::state::TERMINAL_SNAPSHOT_SOURCE_HEADER,
            source,
        );
    }
    if let Some(live) = live {
        set_terminal_bool_header(headers, crate::state::TERMINAL_SNAPSHOT_LIVE_HEADER, live);
    }
    if let Some(restored) = restored {
        set_terminal_bool_header(
            headers,
            crate::state::TERMINAL_SNAPSHOT_RESTORED_HEADER,
            restored,
        );
    }
    if let Some(format) = format.as_deref() {
        set_terminal_header(
            headers,
            crate::state::TERMINAL_SNAPSHOT_FORMAT_HEADER,
            format,
        );
    }
    response
}

pub async fn build_terminal_snapshot(
    state: &AppState,
    session: &SessionRecord,
    lines: usize,
    max_bytes: usize,
) -> Result<Value> {
    if let Some(snapshot) = build_terminal_restore_snapshot(state, session).await? {
        let live = state.terminal_runtime_attached(&session.id).await;
        return Ok(build_terminal_state_snapshot_payload(
            &snapshot, live, lines, max_bytes,
        ));
    }

    let terminal_capture_path = state.session_terminal_capture_path(&session.id);
    if let Some(snapshot) = read_terminal_log_bytes(&terminal_capture_path)
        .await?
        .and_then(|bytes| render_terminal_log_tail_from_bytes(&bytes, lines, max_bytes))
    {
        let live = state.terminal_runtime_attached(&session.id).await;
        return Ok(json!({
            "snapshotAnsi": snapshot,
            "rehydrateSequences": "",
            "source": "terminal_capture",
            "format": "raw",
            "live": live,
            "restored": true,
        }));
    }

    let snapshot = trim_utf8_tail_string(trim_lines_tail(&session.output, lines), max_bytes);
    Ok(json!({
        "snapshotAnsi": snapshot,
        "rehydrateSequences": "",
        "source": if session.output.trim().is_empty() { "empty" } else { "session_output" },
        "format": "raw",
        "live": false,
        "restored": !session.output.trim().is_empty(),
    }))
}

pub async fn build_terminal_restore_snapshot(
    state: &AppState,
    session: &SessionRecord,
) -> Result<Option<TerminalRestoreSnapshot>> {
    Ok(state.current_terminal_restore_snapshot(&session.id).await)
}

fn build_terminal_state_snapshot_payload(
    snapshot: &TerminalRestoreSnapshot,
    live: bool,
    lines: usize,
    max_bytes: usize,
) -> Value {
    let rendered = String::from_utf8_lossy(&snapshot.render_restore_bytes(max_bytes)).into_owned();
    let transcript = if snapshot.modes.alternate_screen {
        String::new()
    } else {
        snapshot.transcript(lines, max_bytes)
    };

    json!({
        "snapshot": rendered,
        "transcript": transcript,
        "source": "terminal_state",
        "format": TERMINAL_RESTORE_SNAPSHOT_VERSION,
        "snapshotVersion": TERMINAL_RESTORE_SNAPSHOT_VERSION,
        "sequence": snapshot.sequence,
        "cols": snapshot.cols,
        "rows": snapshot.rows,
        "modes": snapshot.modes,
        "live": live,
        "restored": true,
    })
}

fn render_terminal_log_tail_from_bytes(
    bytes: &[u8],
    lines: usize,
    max_bytes: usize,
) -> Option<String> {
    let snapshot = trim_utf8_tail_string(
        trim_lines_tail(String::from_utf8_lossy(bytes).as_ref(), lines),
        max_bytes,
    );
    if snapshot.trim().is_empty() {
        None
    } else {
        Some(snapshot)
    }
}

async fn read_terminal_log_bytes(path: &StdPath) -> Result<Option<Vec<u8>>> {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };

    let len = file.metadata().await?.len();
    let start = len.saturating_sub(8 * 1024 * 1024); // MAX_TERMINAL_LOG_TAIL_BYTES
    file.seek(SeekFrom::Start(start)).await?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    if String::from_utf8_lossy(&bytes).trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(bytes))
    }
}

pub fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    String::from_utf8_lossy(&trim_utf8_tail_bytes(value.into_bytes(), max_bytes)).into_owned()
}

pub fn terminal_snapshot_live_requested(value: Option<&str>) -> bool {
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

#[cfg(test)]
mod tests {
    use super::build_terminal_state_snapshot_payload;
    use crate::state::types::TerminalModeState;
    use crate::state::{TerminalRestoreSnapshot, TERMINAL_RESTORE_SNAPSHOT_VERSION};

    #[test]
    fn terminal_state_snapshot_payload_omits_transcript_for_alternate_screen() {
        let snapshot = TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: 12,
            cols: 120,
            rows: 32,
            has_output: true,
            modes: TerminalModeState {
                alternate_screen: true,
                application_keypad: false,
                application_cursor: false,
                hide_cursor: false,
                bracketed_paste: false,
                mouse_protocol_mode: "None".to_string(),
                mouse_protocol_encoding: "Default".to_string(),
            },
            history: b"history that should not be replayed".to_vec(),
            screen: b"\x1b[Hfull-screen tui".to_vec(),
        };

        let payload = build_terminal_state_snapshot_payload(&snapshot, false, 200, 4096);

        assert_eq!(payload["transcript"].as_str(), Some(""));
        let rendered = payload["snapshot"].as_str().unwrap_or_default();
        assert!(rendered.contains("full-screen tui"));
        assert!(!rendered.contains("history that should not be replayed"));
    }

    #[test]
    fn terminal_state_snapshot_payload_keeps_transcript_for_standard_shell() {
        let snapshot = TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: 13,
            cols: 120,
            rows: 32,
            has_output: true,
            modes: TerminalModeState {
                alternate_screen: false,
                application_keypad: false,
                application_cursor: false,
                hide_cursor: false,
                bracketed_paste: false,
                mouse_protocol_mode: "None".to_string(),
                mouse_protocol_encoding: "Default".to_string(),
            },
            history: b"echo hi\r\nhi\r\n".to_vec(),
            screen: b"prompt> ".to_vec(),
        };

        let payload = build_terminal_state_snapshot_payload(&snapshot, false, 200, 4096);

        let transcript = payload["transcript"].as_str().unwrap_or_default();
        assert!(transcript.contains("echo hi"));
        assert!(transcript.contains("prompt>"));
    }
}
