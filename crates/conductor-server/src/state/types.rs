use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use conductor_executors::executor::ExecutorInput;
use conductor_executors::process::PtyDimensions;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;
use tokio::fs::File;
use tokio::io::BufWriter;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

// Re-export core types so existing imports within the server crate continue to work.
pub use conductor_core::types::{
    ConversationEntry, SessionPrInfo, SessionRecord, SessionRecordBuilder, SessionStatus,
    SpawnRequest, DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_SESSION_HISTORY_LIMIT,
};

#[derive(Clone, Debug)]
pub enum TerminalStreamEvent {
    Stream(TerminalStreamChunk),
    Exit(i32),
    Error(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalStreamChunk {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalStateUpdate {
    pub sequence: u64,
    pub restore_snapshot: TerminalRestoreSnapshot,
    pub cwd: Option<String>,
}

const DEFAULT_TERMINAL_STORE_COLS: u16 = 120;
const DEFAULT_TERMINAL_STORE_ROWS: u16 = 32;
// Keep the live per-session terminal store near a 1-2 MB working set. Durable
// capture and replay live on disk, so the in-memory store only needs enough
// short scrollback for attach/reconnect smoothness.
const DEFAULT_TERMINAL_STORE_SCROLLBACK: usize = 768;
const DEFAULT_TERMINAL_HISTORY_BYTES: usize = 192 * 1024;
const MAX_TERMINAL_OSC_PENDING_BYTES: usize = 4096;

pub const TERMINAL_RESTORE_SNAPSHOT_VERSION: u8 = 1;
pub const TERMINAL_RESTORE_SNAPSHOT_FORMAT: &str = "ansi_restore_v1";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModeState {
    pub alternate_screen: bool,
    pub application_keypad: bool,
    pub application_cursor: bool,
    pub hide_cursor: bool,
    pub bracketed_paste: bool,
    pub mouse_protocol_mode: String,
    pub mouse_protocol_encoding: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRestoreSnapshot {
    pub version: u8,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub has_output: bool,
    #[serde(default)]
    pub modes: TerminalModeState,
    #[serde(
        serialize_with = "serialize_terminal_bytes",
        deserialize_with = "deserialize_terminal_bytes"
    )]
    pub history: Vec<u8>,
    #[serde(
        serialize_with = "serialize_terminal_bytes",
        deserialize_with = "deserialize_terminal_bytes"
    )]
    pub screen: Vec<u8>,
}

impl TerminalRestoreSnapshot {
    pub fn is_empty(&self) -> bool {
        !self.has_output
    }

    pub fn history_len(&self) -> usize {
        self.history.len()
    }

    pub fn screen_len(&self) -> usize {
        self.screen.len()
    }

    pub fn render_bytes(&self, max_bytes: usize) -> Vec<u8> {
        if self.is_empty() || max_bytes == 0 {
            return Vec::new();
        }

        let screen = trim_tail_bytes(self.screen.clone(), max_bytes);
        if screen.is_empty() {
            return trim_tail_bytes(self.history.clone(), max_bytes);
        }

        if self.history.is_empty() {
            return screen;
        }

        let separator_len = if self.history.ends_with(b"\n") || self.history.ends_with(b"\r") {
            0
        } else {
            2
        };
        let reserved = screen.len().saturating_add(separator_len);
        if reserved >= max_bytes {
            return screen;
        }

        let mut history = trim_tail_bytes(self.history.clone(), max_bytes.saturating_sub(reserved));
        if separator_len != 0 {
            history.extend_from_slice(b"\r\n");
        }
        history.extend_from_slice(&screen);
        history
    }

    pub fn render_restore_bytes(&self, max_bytes: usize) -> Vec<u8> {
        if self.is_empty() || max_bytes == 0 {
            return Vec::new();
        }
        self.render_bytes(max_bytes)
    }

    pub fn full_render_bytes(&self) -> Vec<u8> {
        self.render_bytes(
            self.history
                .len()
                .saturating_add(self.screen.len())
                .saturating_add(2),
        )
    }

    pub fn transcript(&self, lines: usize, max_bytes: usize) -> String {
        if self.is_empty() || lines == 0 || max_bytes == 0 {
            return String::new();
        }

        let mut store = TerminalStateStore::with_size(self.rows, self.cols);
        store.hydrate_from_snapshot(self);
        store.transcript_tail(lines, max_bytes)
    }
}

pub struct TerminalStateStore {
    parser: vt100::Parser,
    history: VecDeque<u8>,
    sequence: u64,
    has_output: bool,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    osc_pending: Vec<u8>,
}

impl Default for TerminalStateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalStateStore {
    pub fn new() -> Self {
        Self::with_size(DEFAULT_TERMINAL_STORE_ROWS, DEFAULT_TERMINAL_STORE_COLS)
    }

    fn with_size(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows.max(1), cols.max(1), DEFAULT_TERMINAL_STORE_SCROLLBACK),
            history: VecDeque::with_capacity(DEFAULT_TERMINAL_HISTORY_BYTES),
            sequence: 0,
            has_output: false,
            cols: cols.max(1),
            rows: rows.max(1),
            cwd: None,
            osc_pending: Vec::new(),
        }
    }

    pub fn apply_output(&mut self, bytes: &[u8]) -> Option<TerminalStateUpdate> {
        if bytes.is_empty() {
            return None;
        }
        let cwd = self.update_cwd_from_output(bytes);
        self.parser.process(bytes);
        self.history.extend(bytes.iter().copied());
        while self.history.len() > DEFAULT_TERMINAL_HISTORY_BYTES {
            self.history.pop_front();
        }
        self.sequence = self.sequence.saturating_add(1);
        self.has_output = true;
        Some(TerminalStateUpdate {
            sequence: self.sequence,
            restore_snapshot: self.restore_snapshot(),
            cwd,
        })
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> TerminalRestoreSnapshot {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.parser.screen_mut().set_size(self.rows, self.cols);
        self.restore_snapshot()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        screen_restore_bytes(self.parser.screen())
    }

    pub fn history_tail(&self) -> Vec<u8> {
        self.history.iter().copied().collect()
    }

    pub fn restore_snapshot(&self) -> TerminalRestoreSnapshot {
        TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: self.sequence,
            cols: self.cols,
            rows: self.rows,
            has_output: self.has_output,
            modes: terminal_mode_state(self.parser.screen()),
            history: self.history_tail(),
            screen: self.snapshot(),
        }
    }

    pub fn hydrate_from_snapshot(&mut self, snapshot: &TerminalRestoreSnapshot) {
        let mut next = Self::with_size(snapshot.rows, snapshot.cols);
        let bytes = snapshot.full_render_bytes();
        if !bytes.is_empty() {
            next.parser.process(&bytes);
        }
        next.history = snapshot.history.iter().copied().collect();
        next.sequence = snapshot.sequence;
        next.has_output = snapshot.has_output;
        *self = next;
    }

    fn update_cwd_from_output(&mut self, bytes: &[u8]) -> Option<String> {
        let mut merged = Vec::with_capacity(self.osc_pending.len() + bytes.len());
        merged.extend_from_slice(&self.osc_pending);
        merged.extend_from_slice(bytes);

        let mut cursor = 0usize;
        let mut latest_cwd = None;
        let mut pending_start = None;

        while cursor + 1 < merged.len() {
            let Some(relative_start) = find_subsequence(&merged[cursor..], b"\x1b]") else {
                break;
            };
            let start = cursor + relative_start;
            let body_start = start + 2;
            let Some((body_end, terminator_len)) = find_osc_terminator(&merged[body_start..])
            else {
                pending_start = Some(start);
                break;
            };

            if let Some(cwd) = parse_osc_cwd(&merged[body_start..body_start + body_end]) {
                if self.cwd.as_deref() != Some(cwd.as_str()) {
                    self.cwd = Some(cwd.clone());
                    latest_cwd = Some(cwd);
                }
            }

            cursor = body_start + body_end + terminator_len;
        }

        self.osc_pending = if let Some(start) = pending_start {
            trim_osc_pending(&merged[start..])
        } else if merged.ends_with(b"\x1b]") {
            merged[merged.len().saturating_sub(2)..].to_vec()
        } else if merged.ends_with(b"\x1b") {
            merged[merged.len().saturating_sub(1)..].to_vec()
        } else {
            Vec::new()
        };

        latest_cwd
    }

    pub fn transcript_tail(&mut self, lines: usize, max_bytes: usize) -> String {
        if !self.has_output || lines == 0 || max_bytes == 0 {
            return String::new();
        }

        let screen = self.parser.screen_mut();
        let (_, cols) = screen.size();
        let original_scrollback = screen.scrollback();
        screen.set_scrollback(usize::MAX);
        let max_scrollback = screen.scrollback();
        let visible_rows = usize::from(self.rows.max(1));
        let start_offset = max_scrollback.min(lines.saturating_sub(visible_rows));

        let mut collected_rows = screen.rows(0, cols).collect::<Vec<_>>();
        if start_offset > 0 {
            screen.set_scrollback(start_offset);
            collected_rows = screen.rows(0, cols).collect::<Vec<_>>();
            for offset in (0..start_offset).rev() {
                screen.set_scrollback(offset);
                if let Some(last_row) = screen.rows(0, cols).last() {
                    collected_rows.push(last_row);
                }
            }
        }
        screen.set_scrollback(original_scrollback);

        let transcript = trim_lines_tail_text(&collected_rows.join("\n"), lines);
        trim_utf8_tail_string(transcript, max_bytes)
    }
}

fn trim_tail_bytes(bytes: Vec<u8>, max_bytes: usize) -> Vec<u8> {
    if max_bytes == 0 || bytes.len() <= max_bytes {
        return bytes;
    }

    bytes[bytes.len().saturating_sub(max_bytes)..].to_vec()
}

fn trim_lines_tail_text(value: &str, lines: usize) -> String {
    if lines == 0 || value.is_empty() {
        return String::new();
    }

    let rows = value.lines().collect::<Vec<_>>();
    let start = rows.len().saturating_sub(lines);
    rows[start..].join("\n")
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }

    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_osc_terminator(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == 0x07 {
            return Some((index, 1));
        }
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, 2));
        }
        index += 1;
    }
    None
}

fn trim_osc_pending(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() <= MAX_TERMINAL_OSC_PENDING_BYTES {
        return bytes.to_vec();
    }
    bytes[bytes.len() - MAX_TERMINAL_OSC_PENDING_BYTES..].to_vec()
}

fn parse_osc_cwd(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let value = text.trim();

    if let Some(path) = value.strip_prefix("7;file://") {
        let path_start = path.find('/')?;
        return normalize_terminal_cwd(&decode_terminal_osc_path(&path[path_start..]));
    }

    if let Some(path) = value.strip_prefix("1337;CurrentDir=") {
        return normalize_terminal_cwd(&decode_terminal_osc_path(path));
    }

    if let Some(path) = value.strip_prefix("633;P;Cwd=") {
        return normalize_terminal_cwd(&decode_terminal_osc_path(path));
    }

    if let Some(path) = value.strip_prefix("9;9;") {
        return normalize_terminal_cwd(&decode_terminal_osc_path(path));
    }

    None
}

fn normalize_terminal_cwd(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn decode_terminal_osc_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push(((high << 4) | low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn trim_utf8_tail_string(value: String, max_bytes: usize) -> String {
    if max_bytes == 0 {
        return String::new();
    }

    if value.len() <= max_bytes {
        return value;
    }

    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn screen_restore_bytes(screen: &vt100::Screen) -> Vec<u8> {
    let mut bytes = Vec::new();
    if screen.alternate_screen() {
        bytes.extend_from_slice(b"\x1b[?1049h");
    } else {
        bytes.extend_from_slice(b"\x1b[?1049l");
    }
    bytes.extend_from_slice(&screen.state_formatted());
    bytes
}

fn terminal_mode_state(screen: &vt100::Screen) -> TerminalModeState {
    TerminalModeState {
        alternate_screen: screen.alternate_screen(),
        application_keypad: screen.application_keypad(),
        application_cursor: screen.application_cursor(),
        hide_cursor: screen.hide_cursor(),
        bracketed_paste: screen.bracketed_paste(),
        mouse_protocol_mode: format!("{:?}", screen.mouse_protocol_mode()),
        mouse_protocol_encoding: format!("{:?}", screen.mouse_protocol_encoding()),
    }
}

fn serialize_terminal_bytes<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&BASE64_STANDARD.encode(bytes))
}

fn deserialize_terminal_bytes<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    BASE64_STANDARD
        .decode(value)
        .map_err(serde::de::Error::custom)
}

pub struct LiveSessionHandle {
    pub input_tx: RwLock<Option<mpsc::Sender<ExecutorInput>>>,
    pub resize_tx: RwLock<Option<mpsc::Sender<PtyDimensions>>>,
    pub terminal_tx: broadcast::Sender<TerminalStreamEvent>,
    pub terminal_store: Arc<StdMutex<TerminalStateStore>>,
    pub terminal_persistence: Mutex<TerminalPersistenceState>,
    pub terminal_capture: Mutex<TerminalCaptureState>,
    pub kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

pub struct TerminalPersistenceState {
    pub last_persisted_sequence: u64,
    pub last_persisted_at: Option<Instant>,
    pub dirty: bool,
    pub last_touched_at: Instant,
    pub last_detached_at: Option<Instant>,
}

impl Default for TerminalPersistenceState {
    fn default() -> Self {
        Self {
            last_persisted_sequence: 0,
            last_persisted_at: None,
            dirty: false,
            last_touched_at: Instant::now(),
            last_detached_at: None,
        }
    }
}

#[derive(Default)]
pub struct TerminalCaptureState {
    pub writer: Option<BufWriter<File>>,
    pub dirty: bool,
    pub pending_bytes: usize,
    pub last_flushed_at: Option<Instant>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_state_store_history_tail_is_bounded() {
        let mut store = TerminalStateStore::new();
        let payload = vec![b'x'; DEFAULT_TERMINAL_HISTORY_BYTES + 4096];
        let update = store
            .apply_output(&payload)
            .expect("non-empty output should produce a store update");

        let history = store.history_tail();
        assert_eq!(history.len(), DEFAULT_TERMINAL_HISTORY_BYTES);
        assert!(history.iter().all(|byte| *byte == b'x'));
        assert_eq!(update.sequence, 1);
    }

    #[test]
    fn terminal_state_store_resize_preserves_rendered_content() {
        let mut store = TerminalStateStore::new();
        let resized = store.resize(4, 8);
        store.apply_output(b"abcdef");

        let snapshot =
            String::from_utf8(store.snapshot()).expect("snapshot should stay valid utf-8");
        assert!(snapshot.contains("abcd"));
        assert!(snapshot.contains("ef"));
        assert_eq!(resized.cols, 4);
        assert_eq!(resized.rows, 8);
    }

    #[test]
    fn terminal_restore_snapshot_json_round_trip_preserves_bytes() {
        let snapshot = TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: 3,
            cols: 99,
            rows: 28,
            has_output: true,
            modes: TerminalModeState {
                alternate_screen: false,
                application_keypad: false,
                application_cursor: true,
                hide_cursor: false,
                bracketed_paste: true,
                mouse_protocol_mode: "AnyMotion".to_string(),
                mouse_protocol_encoding: "Sgr".to_string(),
            },
            history: b"\x1b[31mhello\r\nworld".to_vec(),
            screen: b"\x1b[Hprompt> ".to_vec(),
        };

        let json = serde_json::to_string(&snapshot).expect("snapshot should serialize");
        let restored: TerminalRestoreSnapshot =
            serde_json::from_str(&json).expect("snapshot should deserialize");

        assert_eq!(restored, snapshot);
        assert_eq!(TERMINAL_RESTORE_SNAPSHOT_FORMAT, "ansi_restore_v1");
    }

    #[test]
    fn terminal_restore_snapshot_round_trip_preserves_rendered_state() {
        let mut store = TerminalStateStore::new();
        store.apply_output(b"hello\r\n");
        store.apply_output(b"\x1b[32mworld\x1b[0m");
        store.resize(132, 40);

        let snapshot = store.restore_snapshot();
        assert!(snapshot.has_output);
        assert_eq!(snapshot.cols, 132);
        assert_eq!(snapshot.rows, 40);

        let mut restored = TerminalStateStore::new();
        restored.hydrate_from_snapshot(&snapshot);
        let restored_snapshot = restored.restore_snapshot();

        assert_eq!(restored_snapshot.sequence, snapshot.sequence);
        assert_eq!(restored_snapshot.cols, snapshot.cols);
        assert_eq!(restored_snapshot.rows, snapshot.rows);
        assert_eq!(restored_snapshot.modes, snapshot.modes);
        assert_eq!(restored_snapshot.history, snapshot.history);
        assert_eq!(restored_snapshot.screen, snapshot.screen);
        assert_eq!(
            restored_snapshot.render_bytes(4096),
            snapshot.render_bytes(4096)
        );
    }

    #[test]
    fn terminal_state_store_snapshot_tracks_input_modes() {
        let mut store = TerminalStateStore::new();
        store.apply_output(b"\x1b[?2004h\x1b[?1h\x1b[?1006h");

        let snapshot = store.restore_snapshot();
        assert!(snapshot.modes.bracketed_paste);
        assert!(snapshot.modes.application_cursor);
        assert_eq!(snapshot.modes.mouse_protocol_encoding, "Sgr");
    }

    #[test]
    fn terminal_state_store_tracks_cwd_from_osc_sequences() {
        let mut store = TerminalStateStore::new();
        let update = store
            .apply_output(b"\x1b]7;file://localhost/Users/demo/project\x07")
            .expect("osc cwd should produce a state update");

        assert_eq!(update.cwd.as_deref(), Some("/Users/demo/project"));
    }

    #[test]
    fn terminal_state_store_tracks_cwd_from_split_osc_sequences() {
        let mut store = TerminalStateStore::new();
        let first = store
            .apply_output(b"\x1b]1337;CurrentDir=/Users/demo")
            .expect("partial osc should still produce a state update");
        assert_eq!(first.cwd, None);

        let second = store
            .apply_output(b"/workspace\x07prompt> ")
            .expect("completed osc should produce a state update");
        assert_eq!(second.cwd.as_deref(), Some("/Users/demo/workspace"));
    }
}
