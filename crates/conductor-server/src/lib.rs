pub mod mcp;
pub mod notifier;
pub mod routes;
mod runtime;
pub mod state;
mod task_context;
pub mod tracker;

use anyhow::Result;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderValue, Method};
use axum::middleware;
use axum::Router;
use conductor_core::{ConductorConfig, EventBus};
use conductor_db::Database;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

pub async fn serve(config: &ConductorConfig, db: Database, _event_bus: EventBus) -> Result<()> {
    let config_path = config
        .config_path
        .clone()
        .unwrap_or_else(|| config.workspace.join("conductor.yaml"));
    let state = AppState::new(config_path, config.clone(), db).await;
    state.discover_executors().await;
    state.start_terminal_host_watchdog();
    state.start_bridge_registry_watchdog();
    state.archive_stale_non_ttyd_sessions().await;
    state.restore_runtime_sessions().await;
    let _runtime = runtime::initialize_runtime(config, state.clone(), _event_bus.clone()).await?;
    state.kick_spawn_supervisor().await;
    state.start_app_update_watchdog();
    state.publish_snapshot().await;

    // WebSocket routes are merged AFTER the CorsLayer so they bypass CORS.
    // The CorsLayer adds headers (Vary, Access-Control-*) to 101 Switching
    // Protocols responses, which causes browsers to reject the WebSocket
    // upgrade with an error before onopen fires.
    let ws_routes = routes::terminal::ws_router().with_state(state.clone());

    let app = Router::new()
        .merge(routes::app_update::router())
        .merge(routes::config::router())
        .merge(routes::events::router())
        .merge(routes::health::router())
        .merge(routes::sessions::router())
        .merge(routes::session_workspace::router())
        .merge(routes::repositories::router())
        .merge(routes::workspaces::router())
        .merge(routes::skills::router())
        .merge(routes::filesystem::router())
        .merge(routes::context_files::router())
        .merge(routes::boards::router())
        .merge(routes::github::router())
        .merge(routes::attachments::router())
        .merge(routes::notifications::router())
        .merge(routes::projects::router())
        .merge(routes::tasks::router())
        .merge(routes::terminal::router())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::middleware::require_auth_when_remote,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::middleware::rate_limit_global,
        ))
        .with_state(state)
        .layer({
            let mut origins: Vec<HeaderValue> = vec![
                "http://localhost:3000"
                    .parse::<HeaderValue>()
                    .expect("valid hardcoded origin"),
                "http://127.0.0.1:3000"
                    .parse::<HeaderValue>()
                    .expect("valid hardcoded origin"),
                format!("http://localhost:{}", config.effective_port())
                    .parse::<HeaderValue>()
                    .expect("valid hardcoded origin"),
                format!("http://127.0.0.1:{}", config.effective_port())
                    .parse::<HeaderValue>()
                    .expect("valid hardcoded origin"),
            ];
            for extra in &config.server.cors_origins {
                if let Ok(value) = extra.parse::<HeaderValue>() {
                    origins.push(value);
                }
            }
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::header::AUTHORIZATION,
                    axum::http::header::ACCEPT,
                ])
                .allow_credentials(true)
                .max_age(Duration::from_secs(3600))
        })
        // Merge WebSocket routes after CorsLayer so they bypass CORS entirely
        .merge(ws_routes)
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024)) // 10 MB request body limit
        .layer(TraceLayer::new_for_http());

    let host = config
        .server
        .host
        .parse::<IpAddr>()
        .unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let allow_remote_backend = std::env::var("CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND")
        .map(|value| value.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !host.is_loopback() && !allow_remote_backend {
        anyhow::bail!(
            "Refusing to bind the Rust backend to {} without loopback protection. \
Set CONDUCTOR_UNSAFE_ALLOW_REMOTE_BACKEND=true only if you are intentionally exposing the unauthenticated backend.",
            host
        );
    }
    let addr = SocketAddr::new(host, config.effective_port());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
