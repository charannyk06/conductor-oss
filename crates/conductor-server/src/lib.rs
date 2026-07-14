pub mod acp;
mod acp_prompt;
mod dispatcher_task_lifecycle;
pub mod error_logger;
pub mod mcp;
pub mod notifier;
pub mod routes;
mod runtime;
mod session_gc;
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
use std::fs;
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::Duration;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::state::AppState;

const TERMINAL_TOKEN_SECRET_ENV: &str = "CONDUCTOR_TERMINAL_SESSION_SECRET";

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub async fn serve(config: &ConductorConfig, db: Database, _event_bus: EventBus) -> Result<()> {
    let config_path = config
        .config_path
        .clone()
        .unwrap_or_else(|| config.workspace.join("conductor.yaml"));
    let state = AppState::new(config_path, config.clone(), db).await;
    ensure_terminal_token_secret(&state.workspace_path)?;
    state.discover_executors().await;
    state.start_terminal_host_watchdog();
    state.start_bridge_registry_watchdog();
    state.start_acp_dispatcher_watchdog();
    state.archive_stale_non_ttyd_sessions().await;
    state.restore_runtime_sessions().await;
    let _runtime = runtime::initialize_runtime(config, state.clone(), _event_bus.clone()).await?;
    state.kick_spawn_supervisor().await;
    state.start_app_update_watchdog();
    state.publish_snapshot().await;

    // GC will query live session IDs on each sweep, so no startup snapshot needed.

    // WebSocket routes are merged AFTER the CorsLayer so they bypass CORS.
    // The CorsLayer adds headers (Vary, Access-Control-*) to 101 Switching
    // Protocols responses, which causes browsers to reject the WebSocket
    // upgrade with an error before onopen fires.
    let ws_routes = routes::terminal::ws_router().with_state(state.clone());

    // Clone for GC before state is moved into the router.
    let gc_state = state.clone();

    let app = Router::new()
        .merge(routes::app_update::router())
        .merge(routes::config::router())
        .merge(routes::dispatcher::router())
        .merge(routes::errors::router())
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
        .merge(routes::project_notes::router())
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
    if !host.is_loopback()
        && allow_remote_backend
        && routes::config::access_control_enabled(&config.access)
        && std::env::var(routes::config::PROXY_AUTH_SECRET_ENV)
            .ok()
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
    {
        anyhow::bail!(
            "Refusing to expose the Rust backend on {} with dashboard access control enabled unless {} is configured. \
Set the same secret in both the dashboard and backend processes so forwarded auth headers can be verified.",
            host,
            routes::config::PROXY_AUTH_SECRET_ENV
        );
    }
    let addr = SocketAddr::new(host, config.effective_port());
    let listener = tokio::net::TcpListener::bind(addr).await?;

    // Start background session GC
    let gc_cancel = std::sync::Arc::new(tokio::sync::Notify::new());
    let gc_conductor_dir = config.workspace.join(".conductor");
    let gc_cancel_clone = gc_cancel.clone();
    let gc_handle = tokio::spawn(async move {
        session_gc::run_session_gc(gc_conductor_dir, gc_state, gc_cancel_clone).await;
    });

    // Graceful shutdown: ctrl_c triggers GC stop + server drain
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    );

    tokio::select! {
        result = server => {
            gc_cancel.notify_one();
            if let Err(e) = gc_handle.await {
                tracing::warn!(error = %e, "session GC task panicked during shutdown");
            }
            result.map_err(Into::into)
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("received shutdown signal");
            gc_cancel.notify_one();
            if let Err(e) = gc_handle.await {
                tracing::warn!(error = %e, "session GC task panicked during shutdown");
            }
            Ok(())
        }
    }
}

fn ensure_terminal_token_secret(workspace_path: &Path) -> Result<()> {
    if std::env::var(TERMINAL_TOKEN_SECRET_ENV)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let secret_path = workspace_path
        .join(".conductor")
        .join("terminal-session-secret");
    if let Some(parent) = secret_path.parent() {
        fs::create_dir_all(parent)?;
        harden_terminal_secret_dir(parent)?;
    }

    let secret = if secret_path.exists() {
        harden_terminal_secret_permissions(&secret_path)?;
        let existing = fs::read_to_string(&secret_path).unwrap_or_default();
        let trimmed = existing.trim();
        if trimmed.is_empty() {
            let generated = Uuid::new_v4().to_string();
            overwrite_terminal_token_secret(&secret_path, &generated)?;
            generated
        } else {
            trimmed.to_string()
        }
    } else {
        let generated = Uuid::new_v4().to_string();
        create_terminal_token_secret(&secret_path, &generated)?;
        generated
    };

    unsafe {
        std::env::set_var(TERMINAL_TOKEN_SECRET_ENV, secret);
    }
    Ok(())
}

fn create_terminal_token_secret(secret_path: &Path, secret: &str) -> Result<()> {
    let temp_path = secret_path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }

    let mut file = options.open(&temp_path)?;
    let write_result = (|| -> Result<()> {
        file.write_all(format!("{secret}\n").as_bytes())?;
        file.flush()?;
        file.sync_data()?;
        Ok(())
    })();
    drop(file);

    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&temp_path, secret_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err.into());
    }

    harden_terminal_secret_permissions(secret_path)?;
    Ok(())
}

fn overwrite_terminal_token_secret(secret_path: &Path, secret: &str) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(secret_path)?;
    file.write_all(format!("{secret}\n").as_bytes())?;
    file.flush()?;
    file.sync_data()?;
    harden_terminal_secret_permissions(secret_path)?;
    Ok(())
}

#[cfg(unix)]
fn harden_terminal_secret_dir(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_terminal_secret_dir(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn harden_terminal_secret_permissions(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn harden_terminal_secret_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_terminal_token_secret, TERMINAL_TOKEN_SECRET_ENV};
    use std::fs;

    struct TerminalSecretEnvScope {
        _guard: tokio::sync::MutexGuard<'static, ()>,
    }

    impl TerminalSecretEnvScope {
        fn new() -> Self {
            let guard = crate::routes::TEST_ENV_LOCK.blocking_lock();
            unsafe {
                std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
            }
            Self { _guard: guard }
        }
    }

    impl Drop for TerminalSecretEnvScope {
        fn drop(&mut self) {
            unsafe {
                std::env::remove_var(TERMINAL_TOKEN_SECRET_ENV);
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn ensure_terminal_token_secret_creates_private_secret_and_directory() {
        use std::os::unix::fs::PermissionsExt;

        let _env = TerminalSecretEnvScope::new();
        let workspace_path = std::env::temp_dir().join(format!(
            "conductor-terminal-secret-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&workspace_path).unwrap();

        ensure_terminal_token_secret(&workspace_path).unwrap();

        let secret_dir = workspace_path.join(".conductor");
        let secret_path = secret_dir.join("terminal-session-secret");
        let secret = fs::read_to_string(&secret_path).unwrap();

        assert!(!secret.trim().is_empty());
        assert_eq!(
            fs::metadata(&secret_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_dir_all(workspace_path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ensure_terminal_token_secret_hardens_existing_insecure_secret() {
        use std::os::unix::fs::PermissionsExt;

        let _env = TerminalSecretEnvScope::new();
        let workspace_path = std::env::temp_dir().join(format!(
            "conductor-terminal-secret-{}",
            uuid::Uuid::new_v4()
        ));
        let secret_dir = workspace_path.join(".conductor");
        let secret_path = secret_dir.join("terminal-session-secret");
        fs::create_dir_all(&secret_dir).unwrap();
        fs::write(&secret_path, "existing-secret\n").unwrap();
        fs::set_permissions(&secret_dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o644)).unwrap();

        ensure_terminal_token_secret(&workspace_path).unwrap();

        assert_eq!(
            fs::metadata(&secret_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&secret_path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_dir_all(workspace_path).unwrap();
    }
}
