use conductor_executors::executor::ExecutorInput;
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

pub struct TerminalStateStore {
    parser: vt100::Parser,
    history: VecDeque<u8>,
}

impl Default for TerminalStateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalStateStore {
    pub fn new() -> Self {
        Self {
            parser: vt100::Parser::new(
                DEFAULT_TERMINAL_STORE_ROWS,
                DEFAULT_TERMINAL_STORE_COLS,
                DEFAULT_TERMINAL_STORE_SCROLLBACK,
            ),
            history: VecDeque::with_capacity(DEFAULT_TERMINAL_HISTORY_BYTES),
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
        self.history.extend(bytes.iter().copied());
        while self.history.len() > DEFAULT_TERMINAL_HISTORY_BYTES {
            self.history.pop_front();
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.parser.screen().state_formatted()
    }

    pub fn history_tail(&self) -> Vec<u8> {
        self.history.iter().copied().collect()
    }
}

pub struct LiveSessionHandle {
    pub input_tx: RwLock<Option<mpsc::Sender<ExecutorInput>>>,
    pub terminal_tx: broadcast::Sender<TerminalStreamEvent>,
    pub terminal_store: Arc<StdMutex<TerminalStateStore>>,
    pub kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}
