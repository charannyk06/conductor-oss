pub mod routes;
pub mod state;
pub mod webhook;

use anyhow::Result;
use axum::Router;
use conductor_core::config::ConductorConfig;
use conductor_core::event::EventBus;
use conductor_db::Database;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use state::AppState;

/// Build the HTTP server router.
pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .merge(routes::health::router())
        .merge(routes::projects::router())
        .merge(routes::tasks::router())
        .merge(routes::sessions::router())
        .merge(routes::events::router())
        .merge(routes::config::router())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Start the HTTP server.
pub async fn serve(config: &ConductorConfig, db: Database, event_bus: EventBus) -> Result<()> {
    let state = Arc::new(AppState::new(config.clone(), db, event_bus));

    let app = build_router(state);

    let addr: SocketAddr = format!("{}:{}", config.server.host, config.server.port).parse()?;
    tracing::info!("Conductor server listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
