use anyhow::{Context, Result};
use conductor_core::config::McpServerConfig;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const ACP_SESSION_MCP_SERVERS_METADATA_KEY: &str = "acpMcpServers";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcpSessionMcpServerConfig {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}

const fn default_true() -> bool {
    true
}

fn toml_key_segment(segment: &str) -> String {
    if segment
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        segment.to_string()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| format!("\"{segment}\""))
    }
}

fn json_literal<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn normalized_servers(
    servers: impl IntoIterator<Item = (String, McpServerConfig)>,
) -> BTreeMap<String, McpServerConfig> {
    servers
        .into_iter()
        .map(|(name, mut config)| {
            config.command = config.command.trim().to_string();
            config.args = config
                .args
                .iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect();
            config.env = config
                .env
                .iter()
                .filter_map(|(key, value)| {
                    let key = key.trim();
                    if key.is_empty() {
                        return None;
                    }
                    Some((key.to_string(), value.trim().to_string()))
                })
                .collect();
            config.cwd = config
                .cwd
                .take()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            (name.trim().to_string(), config)
        })
        .filter(|(name, config)| !name.is_empty() && config.enabled)
        .filter(|(_, config)| !config.command.is_empty())
        .collect()
}

pub(crate) fn parse_acp_mcp_servers(value: &Value) -> Result<BTreeMap<String, McpServerConfig>> {
    match value {
        Value::Null => Ok(BTreeMap::new()),
        Value::Array(items) => {
            let mut servers = BTreeMap::new();
            for item in items {
                let parsed: AcpSessionMcpServerConfig = serde_json::from_value(item.clone())
                    .context("Invalid ACP session MCP server entry")?;
                servers.insert(
                    parsed.name,
                    McpServerConfig {
                        command: parsed.command,
                        args: parsed.args,
                        env: parsed.env,
                        cwd: parsed.cwd,
                        enabled: parsed.enabled,
                    },
                );
            }
            Ok(normalized_servers(servers))
        }
        Value::Object(_) => {
            let servers =
                serde_json::from_value::<BTreeMap<String, McpServerConfig>>(value.clone())
                    .context("Invalid ACP session MCP server map")?;
            Ok(normalized_servers(servers))
        }
        _ => anyhow::bail!("ACP session MCP servers must be an object, array, or null"),
    }
}

pub(crate) fn serialize_mcp_servers(servers: &BTreeMap<String, McpServerConfig>) -> Option<String> {
    if servers.is_empty() {
        None
    } else {
        serde_json::to_string(servers).ok()
    }
}

pub(crate) fn deserialize_mcp_servers(
    value: Option<&str>,
) -> Result<BTreeMap<String, McpServerConfig>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(BTreeMap::new());
    };
    let servers = serde_json::from_str::<BTreeMap<String, McpServerConfig>>(value)
        .context("Invalid persisted MCP server metadata")?;
    Ok(normalized_servers(servers))
}

pub(crate) fn merge_mcp_servers(
    defaults: &BTreeMap<String, McpServerConfig>,
    project: &BTreeMap<String, McpServerConfig>,
    session: &BTreeMap<String, McpServerConfig>,
    internal: Option<(String, McpServerConfig)>,
) -> BTreeMap<String, McpServerConfig> {
    let mut merged = defaults.clone();
    merged.extend(project.clone());
    merged.extend(session.clone());
    if let Some((name, config)) = internal {
        merged.insert(name, config);
    }
    normalized_servers(merged)
}

pub(crate) fn build_codex_mcp_config_args(
    servers: &BTreeMap<String, McpServerConfig>,
) -> Vec<String> {
    let mut args = Vec::new();
    for (name, server) in servers {
        let key = toml_key_segment(name);
        args.push("-c".to_string());
        args.push(format!(
            "mcp_servers.{key}.command={}",
            json_literal(&server.command)
        ));
        if !server.args.is_empty() {
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{key}.args={}",
                json_literal(&server.args)
            ));
        }
        if let Some(cwd) = server.cwd.as_ref() {
            args.push("-c".to_string());
            args.push(format!("mcp_servers.{key}.cwd={}", json_literal(cwd)));
        }
        for (env_key, env_value) in &server.env {
            let env_key = toml_key_segment(env_key);
            args.push("-c".to_string());
            args.push(format!(
                "mcp_servers.{key}.env.{env_key}={}",
                json_literal(env_value)
            ));
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_acp_mcp_servers_accepts_array_payloads() {
        let servers = parse_acp_mcp_servers(&json!([
            {
                "name": "filesystem",
                "command": "npx",
                "args": ["@modelcontextprotocol/server-filesystem", "/tmp"],
                "env": { "TOKEN": "secret" }
            }
        ]))
        .expect("mcp servers should parse");

        assert_eq!(servers["filesystem"].command, "npx");
        assert_eq!(
            servers["filesystem"].args,
            vec![
                "@modelcontextprotocol/server-filesystem".to_string(),
                "/tmp".to_string()
            ]
        );
        assert_eq!(servers["filesystem"].env["TOKEN"], "secret");
    }

    #[test]
    fn merge_mcp_servers_allows_project_and_session_overrides() {
        let defaults = BTreeMap::from([(
            "filesystem".to_string(),
            McpServerConfig {
                command: "npx".to_string(),
                args: vec!["default".to_string()],
                ..McpServerConfig::default()
            },
        )]);
        let project = BTreeMap::from([(
            "filesystem".to_string(),
            McpServerConfig {
                command: "npx".to_string(),
                args: vec!["project".to_string()],
                ..McpServerConfig::default()
            },
        )]);
        let session = BTreeMap::from([(
            "memory".to_string(),
            McpServerConfig {
                command: "npx".to_string(),
                args: vec!["memory".to_string()],
                ..McpServerConfig::default()
            },
        )]);
        let internal = Some((
            "conductor".to_string(),
            McpServerConfig {
                command: "/tmp/conductor".to_string(),
                args: vec!["mcp-server".to_string()],
                ..McpServerConfig::default()
            },
        ));

        let merged = merge_mcp_servers(&defaults, &project, &session, internal);

        assert_eq!(merged["filesystem"].args, vec!["project".to_string()]);
        assert_eq!(merged["memory"].args, vec!["memory".to_string()]);
        assert_eq!(merged["conductor"].command, "/tmp/conductor");
    }

    #[test]
    fn build_codex_mcp_config_args_emits_config_overrides() {
        let servers = BTreeMap::from([(
            "conductor".to_string(),
            McpServerConfig {
                command: "/tmp/conductor".to_string(),
                args: vec![
                    "--workspace".to_string(),
                    "/tmp/ws".to_string(),
                    "mcp-server".to_string(),
                ],
                env: BTreeMap::from([(
                    "CONDUCTOR_SESSION_ID".to_string(),
                    "session-1".to_string(),
                )]),
                cwd: Some("/tmp/ws".to_string()),
                enabled: true,
            },
        )]);

        let args = build_codex_mcp_config_args(&servers);

        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.conductor.command=\"/tmp/conductor\""));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.conductor.cwd=\"/tmp/ws\""));
        assert!(args
            .iter()
            .any(|arg| { arg == "mcp_servers.conductor.env.CONDUCTOR_SESSION_ID=\"session-1\"" }));
    }
}
