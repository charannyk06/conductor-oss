use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::routing::get;
use axum::Router;
use std::convert::Infallible;
use std::sync::Arc;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::state::AppState;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/events", get(event_stream))
}

/// SSE endpoint for real-time event streaming.
async fn event_stream(
    State(state): State<Arc<AppState>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = state.event_bus.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| {
        match result {
            Ok(event) => {
                let data = serde_json::to_string(&*event).unwrap_or_default();
                Some(Ok(SseEvent::default().data(data)))
            }
            Err(_) => None, // Skip lagged messages.
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
