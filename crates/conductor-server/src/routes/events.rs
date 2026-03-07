use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use serde_json::json;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{self as stream, StreamExt};

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/events", get(event_stream))
}

async fn event_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let initial = state.snapshot_event_json().await;
    let initial_stream = stream::iter(vec![Ok(SseEvent::default().data(initial))]);
    let updates = BroadcastStream::new(state.event_snapshots.subscribe()).filter_map(|result| {
        match result {
            Ok(payload) => Some(Ok(SseEvent::default().data(payload))),
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(count)) => {
                tracing::warn!("Event snapshot SSE stream lagged by {count} messages");
                Some(Ok(SseEvent::default().event("refresh").data(
                    json!({"type": "refresh", "reason": "lagged", "missed": count}).to_string(),
                )))
            }
        }
    });

    Sse::new(initial_stream.chain(updates)).keep_alive(KeepAlive::default())
}
