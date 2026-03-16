use crate::state::AppState;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

pub mod auth;
pub mod bootstrap;
pub mod control;
pub mod snapshot;
pub mod stream;
pub mod ttyd;

pub use control::resolve_terminal_keys;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/api/sessions/{id}/terminal/connection",
            get(bootstrap::terminal_connection),
        )
        .route(
            "/api/sessions/{id}/terminal/bootstrap",
            get(bootstrap::terminal_bootstrap),
        )
        .route(
            "/api/sessions/{id}/terminal/fast-bootstrap",
            get(bootstrap::terminal_fast_bootstrap),
        )
        .route(
            "/api/sessions/{id}/terminal/ws",
            get(stream::terminal_websocket),
        )
        .route(
            "/api/sessions/{id}/terminal/control/ws",
            get(control::terminal_control_websocket),
        )
        .route(
            "/api/sessions/{id}/terminal/stream-token",
            get(auth::terminal_stream_token),
        )
        .route(
            "/api/sessions/{id}/terminal/token",
            get(auth::terminal_token),
        )
        .route(
            "/api/sessions/{id}/terminal/resize",
            post(control::terminal_resize),
        )
        .route(
            "/api/sessions/{id}/terminal/snapshot",
            get(snapshot::terminal_snapshot),
        )
        .route(
            "/api/sessions/{id}/terminal/stream",
            get(stream::terminal_stream),
        )
        .route(
            "/api/sessions/{id}/ttyd/spawn",
            get(ttyd::spawn_ttyd_session),
        )
        .route(
            "/api/sessions/{id}/ttyd/kill",
            post(ttyd::kill_ttyd_session),
        )
}
