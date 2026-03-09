pub mod app_update;
pub mod attachments;
pub mod auth;
pub mod boards;
pub mod config;
pub mod context_files;
pub mod events;
pub mod filesystem;
pub mod github;
pub mod health;
pub mod middleware;
pub mod notifications;
pub mod projects;
pub mod repositories;
pub mod session_workspace;
pub mod sessions;
pub mod tasks;
pub mod terminal;
pub mod workspaces;

#[cfg(test)]
use std::sync::{LazyLock, Mutex};

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
