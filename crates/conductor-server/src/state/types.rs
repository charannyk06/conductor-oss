use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use conductor_executors::executor::ExecutorInput;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

// Re-export core types so existing imports within the server crate continue to work.
pub use conductor_core::types::{
    ConversationEntry, SessionPrInfo, SessionRecord, SessionRecordBuilder, SessionStatus,
    SpawnRequest, DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_SESSION_HISTORY_LIMIT,
};

#[derive(Clone, Debug)]
pub enum TerminalStreamEvent {
    Output(Vec<u8>),
    Exit(i32),
    Error(String),
}

const DEFAULT_TERMINAL_STORE_COLS: u16 = 120;
const DEFAULT_TERMINAL_STORE_ROWS: u16 = 32;
const DEFAULT_TERMINAL_STORE_SCROLLBACK: usize = 4000;
const DEFAULT_TERMINAL_HISTORY_BYTES: usize = 512 * 1024;

pub const TERMINAL_RESTORE_SNAPSHOT_VERSION: u8 = 1;
pub const TERMINAL_RESTORE_SNAPSHOT_FORMAT: &str = "ansi_restore_v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRestoreSnapshot {
    pub version: u8,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub has_output: bool,
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

    pub fn full_render_bytes(&self) -> Vec<u8> {
        self.render_bytes(
            self.history
                .len()
                .saturating_add(self.screen.len())
                .saturating_add(2),
        )
    }
}

pub struct TerminalStateStore {
    parser: vt100::Parser,
    history: VecDeque<u8>,
    sequence: u64,
    has_output: bool,
    cols: u16,
    rows: u16,
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
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.parser.process(bytes);
        self.history.extend(bytes.iter().copied());
        while self.history.len() > DEFAULT_TERMINAL_HISTORY_BYTES {
            self.history.pop_front();
        }
        self.sequence = self.sequence.saturating_add(1);
        self.has_output = true;
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        self.parser.screen_mut().set_size(self.rows, self.cols);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.parser.screen().state_formatted()
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
}

fn trim_tail_bytes(bytes: Vec<u8>, max_bytes: usize) -> Vec<u8> {
    if max_bytes == 0 || bytes.len() <= max_bytes {
        return bytes;
    }

    bytes[bytes.len().saturating_sub(max_bytes)..].to_vec()
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
    pub terminal_tx: broadcast::Sender<TerminalStreamEvent>,
    pub terminal_store: Arc<StdMutex<TerminalStateStore>>,
    pub kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[cfg(test)]
mod tests {
    use super::{
        TerminalRestoreSnapshot, TerminalStateStore, TERMINAL_RESTORE_SNAPSHOT_FORMAT,
        TERMINAL_RESTORE_SNAPSHOT_VERSION,
    };

    #[test]
    fn terminal_restore_snapshot_json_round_trip_preserves_bytes() {
        let snapshot = TerminalRestoreSnapshot {
            version: TERMINAL_RESTORE_SNAPSHOT_VERSION,
            sequence: 3,
            cols: 99,
            rows: 28,
            has_output: true,
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
        store.process(b"hello\r\n");
        store.process(b"\x1b[32mworld\x1b[0m");
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
        assert_eq!(restored_snapshot.history, snapshot.history);
        assert_eq!(restored_snapshot.screen, snapshot.screen);
        assert_eq!(
            restored_snapshot.render_bytes(4096),
            snapshot.render_bytes(4096)
        );
    }
}
