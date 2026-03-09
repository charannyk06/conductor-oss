use conductor_executors::executor::ExecutorInput;
use tokio::sync::{mpsc, Mutex};

// Re-export core types so existing imports within the server crate continue to work.
pub use conductor_core::types::{
    ConversationEntry, SessionPrInfo, SessionRecord, SessionRecordBuilder, SessionStatus,
    SpawnRequest, DEFAULT_OUTPUT_LIMIT_BYTES, DEFAULT_SESSION_HISTORY_LIMIT,
};

pub struct LiveSessionHandle {
    pub input_tx: mpsc::Sender<ExecutorInput>,
    pub kill_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}
