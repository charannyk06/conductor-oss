//! Minimal Chrome DevTools Protocol client over one WebSocket.

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::BrowserError;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Long enough for the user to answer Chrome's connection prompt, short
/// enough that an endpoint which never completes the handshake cannot hold a
/// tool call open indefinitely.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct CdpClient {
    writer: tokio::sync::Mutex<SplitSink<Socket, Message>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: tokio::task::JoinHandle<()>,
}

impl CdpClient {
    pub async fn connect(ws_url: &str) -> Result<Self, BrowserError> {
        let (socket, _) =
            tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(ws_url))
                .await
                .map_err(|_| BrowserError::ConnectTimeout)?
                .map_err(|err| BrowserError::Connect(err.to_string()))?;
        let (writer, reader) = socket.split();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let reader = tokio::spawn(read_loop(reader, pending.clone(), closed.clone()));
        Ok(Self {
            writer: tokio::sync::Mutex::new(writer),
            pending,
            next_id: AtomicU64::new(1),
            closed,
            reader,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Send one command, optionally to an attached target session, and wait
    /// for its result.
    pub async fn call(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, BrowserError> {
        if self.is_closed() {
            return Err(BrowserError::Disconnected);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }

        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(id, sender);
        let sent = self
            .writer
            .lock()
            .await
            .send(Message::Text(message.to_string().into()))
            .await;
        if sent.is_err() {
            lock(&self.pending).remove(&id);
            self.closed.store(true, Ordering::SeqCst);
            return Err(BrowserError::Disconnected);
        }

        match tokio::time::timeout(CALL_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(BrowserError::Protocol(format!("{method}: {message}"))),
            Ok(Err(_)) => Err(BrowserError::Disconnected),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(BrowserError::Timeout(method.to_string()))
            }
        }
    }
}

impl Drop for CdpClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn read_loop(mut reader: SplitStream<Socket>, pending: Pending, closed: Arc<AtomicBool>) {
    while let Some(Ok(message)) = reader.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        // Messages without an id are events; this client does not use them.
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(sender) = lock(&pending).remove(&id) else {
            continue;
        };
        let outcome = match value.get("error") {
            Some(error) => Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string()),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(outcome);
    }
    closed.store(true, Ordering::SeqCst);
    // Dropping the senders wakes every waiting call with `Disconnected`.
    lock(&pending).clear();
}
