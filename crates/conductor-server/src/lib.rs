pub mod routes;
pub mod state;

use anyhow::Result;
use axum::Router;
use axum::http::{HeaderValue, Method};
use conductor_core::{ConductorConfig, EventBus};
use conductor_db::Database;
use std::net::{IpAddr, SocketAddr};
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
    state.publish_snapshot().await;

    let app = Router::new()
        .merge(routes::config::router())
        .merge(routes::events::router())
        .merge(routes::health::router())
        .merge(routes::sessions::router())
        .merge(routes::session_workspace::router())
        .merge(routes::repositories::router())
        .merge(routes::workspaces::router())
        .merge(routes::filesystem::router())
        .merge(routes::context_files::router())
        .merge(routes::boards::router())
        .merge(routes::github::router())
        .merge(routes::attachments::router())
        .merge(routes::notifications::router())
        .merge(routes::auth::router())
        .with_state(state)
        .layer({
            let mut origins: Vec<HeaderValue> = vec![
                "http://localhost:3000".parse::<HeaderValue>().unwrap(),
                "http://127.0.0.1:3000".parse::<HeaderValue>().unwrap(),
                format!("http://localhost:{}", config.effective_port()).parse::<HeaderValue>().unwrap(),
                format!("http://127.0.0.1:{}", config.effective_port()).parse::<HeaderValue>().unwrap(),
            ];
            for extra in &config.server.cors_origins {
                if let Ok(value) = extra.parse::<HeaderValue>() {
                    origins.push(value);
                }
            }
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::header::AUTHORIZATION,
                    axum::http::header::ACCEPT,
                ])
                .allow_credentials(true)
        })
        .layer(TraceLayer::new_for_http());

    let host = config.server.host.parse::<IpAddr>().unwrap_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let addr = SocketAddr::new(host, config.effective_port());
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
