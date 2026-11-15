//! Settings API for the MCP servers agents are launched with, globally or per project.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use conductor_core::config::McpServerConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

/// Placeholder returned instead of environment values, which often hold credentials. Sending
/// it back unchanged keeps the stored value.
const MASKED_ENV_VALUE: &str = "••••••••";
/// Injected by Conductor itself for dispatcher sessions.
const RESERVED_SERVER_NAME: &str = "conductor";
const MAX_SERVERS: usize = 32;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route(
        "/api/mcp-servers",
        get(list_mcp_servers).put(replace_mcp_servers),
    )
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBody {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct ReplaceBody {
    servers: Vec<ServerBody>,
}

fn scope_project_id(query: &ScopeQuery) -> Option<String> {
    query
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn is_valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn serialize_servers(servers: &BTreeMap<String, McpServerConfig>) -> Vec<Value> {
    servers
        .iter()
        .map(|(name, server)| {
            json!({
                "name": name,
                "command": server.command,
                "args": server.args,
                "env": server
                    .env
                    .keys()
                    .map(|key| (key.clone(), Value::String(MASKED_ENV_VALUE.to_string())))
                    .collect::<serde_json::Map<_, _>>(),
                "cwd": server.cwd,
                "enabled": server.enabled,
            })
        })
        .collect()
}

/// Validate a replacement set, keeping stored values for env entries sent back masked.
fn build_servers(
    incoming: Vec<ServerBody>,
    existing: &BTreeMap<String, McpServerConfig>,
) -> Result<BTreeMap<String, McpServerConfig>, String> {
    if incoming.len() > MAX_SERVERS {
        return Err(format!("At most {MAX_SERVERS} MCP servers are supported"));
    }
    let mut servers = BTreeMap::new();
    for server in incoming {
        let name = server.name.trim().to_string();
        if !is_valid_server_name(&name) {
            return Err(format!(
                "Invalid MCP server name `{name}`; use letters, numbers, `-` and `_`"
            ));
        }
        if name.eq_ignore_ascii_case(RESERVED_SERVER_NAME) {
            return Err(format!(
                "`{RESERVED_SERVER_NAME}` is reserved for Conductor's built-in MCP server"
            ));
        }
        let command = server.command.trim().to_string();
        if command.is_empty() {
            return Err(format!("MCP server `{name}` needs a command"));
        }
        let previous = existing.get(&name);
        let mut env = BTreeMap::new();
        for (key, value) in server.env {
            let key = key.trim().to_string();
            if key.is_empty() {
                continue;
            }
            let value = if value == MASKED_ENV_VALUE {
                match previous.and_then(|previous| previous.env.get(&key)) {
                    Some(stored) => stored.clone(),
                    None => {
                        return Err(format!(
                            "Environment variable `{key}` on `{name}` has no stored value to keep"
                        ))
                    }
                }
            } else {
                value
            };
            env.insert(key, value);
        }
        let config = McpServerConfig {
            command,
            args: server
                .args
                .into_iter()
                .map(|arg| arg.trim().to_string())
                .filter(|arg| !arg.is_empty())
                .collect(),
            env,
            cwd: server
                .cwd
                .map(|cwd| cwd.trim().to_string())
                .filter(|cwd| !cwd.is_empty()),
            enabled: server.enabled,
        };
        if servers.insert(name.clone(), config).is_some() {
            return Err(format!("MCP server `{name}` is listed twice"));
        }
    }
    Ok(servers)
}

async fn list_mcp_servers(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ScopeQuery>,
) -> ApiResponse {
    let config = state.config.read().await;
    let servers = match scope_project_id(&query) {
        Some(project_id) => match config.projects.get(&project_id) {
            Some(project) => serialize_servers(&project.mcp_servers),
            None => {
                return error(
                    StatusCode::NOT_FOUND,
                    format!("Unknown project: {project_id}"),
                )
            }
        },
        None => serialize_servers(&config.defaults.mcp_servers),
    };
    (StatusCode::OK, Json(json!({ "servers": servers })))
}

async fn replace_mcp_servers(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ScopeQuery>,
    Json(body): Json<ReplaceBody>,
) -> ApiResponse {
    let project_id = scope_project_id(&query);
    let serialized = {
        let mut config = state.config.write().await;
        let target = match project_id.as_deref() {
            Some(project_id) => match config.projects.get_mut(project_id) {
                Some(project) => &mut project.mcp_servers,
                None => {
                    return error(
                        StatusCode::NOT_FOUND,
                        format!("Unknown project: {project_id}"),
                    )
                }
            },
            None => &mut config.defaults.mcp_servers,
        };
        match build_servers(body.servers, target) {
            Ok(servers) => *target = servers,
            Err(message) => return error(StatusCode::BAD_REQUEST, message),
        }
        serialize_servers(target)
    };
    if let Err(err) = state.save_config().await {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to save MCP servers: {err}"),
        );
    }
    (StatusCode::OK, Json(json!({ "servers": serialized })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(name: &str, command: &str, env: &[(&str, &str)]) -> ServerBody {
        ServerBody {
            name: name.to_string(),
            command: command.to_string(),
            args: vec![" --stdio ".to_string(), String::new()],
            env: env
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            cwd: Some("  ".to_string()),
            enabled: true,
        }
    }

    #[test]
    fn masked_env_values_keep_the_stored_secret() {
        let existing = BTreeMap::from([(
            "github".to_string(),
            McpServerConfig {
                command: "gh-mcp".to_string(),
                env: BTreeMap::from([("TOKEN".to_string(), "secret".to_string())]),
                ..McpServerConfig::default()
            },
        )]);
        let servers = build_servers(
            vec![body(
                "github",
                "gh-mcp",
                &[("TOKEN", MASKED_ENV_VALUE), ("MODE", "ro")],
            )],
            &existing,
        )
        .unwrap();
        let server = &servers["github"];
        assert_eq!(server.env["TOKEN"], "secret");
        assert_eq!(server.env["MODE"], "ro");
        assert_eq!(server.args, vec!["--stdio".to_string()]);
        assert_eq!(server.cwd, None);

        let listed = serialize_servers(&servers);
        assert_eq!(listed[0]["env"]["TOKEN"], MASKED_ENV_VALUE);
        assert!(!listed[0].to_string().contains("secret"));
    }

    #[test]
    fn invalid_servers_are_rejected() {
        let empty = BTreeMap::new();
        assert!(build_servers(vec![body("bad name", "x", &[])], &empty).is_err());
        assert!(build_servers(vec![body("conductor", "x", &[])], &empty).is_err());
        assert!(build_servers(vec![body("fs", "  ", &[])], &empty).is_err());
        assert!(build_servers(vec![body("fs", "a", &[]), body("fs", "b", &[])], &empty).is_err());
        assert!(
            build_servers(vec![body("fs", "a", &[("KEY", MASKED_ENV_VALUE)])], &empty).is_err(),
            "a masked value with nothing stored cannot be kept"
        );
    }
}
