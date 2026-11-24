//! Sign-in detection for the subscription-backed agent CLIs.
//!
//! Conductor runs Claude Code and Codex on the user's own Claude or ChatGPT
//! login. This module asks each CLI whether that login exists so the dashboard
//! can prompt for sign-in up front instead of failing after a session starts.

use conductor_core::types::AgentKind;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    SignedIn,
    SignedOut,
    /// The CLI could not be asked, or this agent has no probe. Treated as
    /// usable so agents without a probe keep working as before.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    Subscription,
    ApiKey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAuth {
    pub state: AuthState,
    pub method: Option<AuthMethod>,
    pub plan: Option<String>,
    pub login_command: Option<&'static str>,
}

impl AgentAuth {
    fn unknown(login_command: Option<&'static str>) -> Self {
        Self {
            state: AuthState::Unknown,
            method: None,
            plan: None,
            login_command,
        }
    }

    /// False only when the CLI positively reported that nobody is signed in.
    pub fn is_usable(&self) -> bool {
        self.state != AuthState::SignedOut
    }

    pub fn to_json(&self) -> Value {
        json!({
            "state": match self.state {
                AuthState::SignedIn => "signed_in",
                AuthState::SignedOut => "signed_out",
                AuthState::Unknown => "unknown",
            },
            "method": self.method.map(|method| match method {
                AuthMethod::Subscription => "subscription",
                AuthMethod::ApiKey => "api_key",
            }),
            "plan": self.plan,
            "loginCommand": self.login_command,
        })
    }
}

type AuthCache = Mutex<HashMap<PathBuf, (Instant, AgentAuth)>>;
static AUTH_CACHE: LazyLock<AuthCache> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Report whether the agent CLI at `binary` has a signed-in account.
pub async fn detect_agent_auth(kind: &AgentKind, binary: &Path) -> AgentAuth {
    let login_command = match kind {
        AgentKind::ClaudeCode => "claude auth login",
        AgentKind::Codex => "codex login",
        _ => return AgentAuth::unknown(None),
    };

    if let Some(cached) = cached_auth(binary) {
        return cached;
    }

    let auth = match kind {
        AgentKind::ClaudeCode => {
            // Sessions launch with ANTHROPIC_API_KEY removed so the local
            // Claude login is used; probe under the same condition.
            match run_probe(binary, &["auth", "status"], &["ANTHROPIC_API_KEY"]).await {
                Some(output) => parse_claude_auth_status(&output.stdout, login_command),
                None => AgentAuth::unknown(Some(login_command)),
            }
        }
        _ => match run_probe(binary, &["login", "status"], &[]).await {
            Some(output) => parse_codex_login_status(
                output.success,
                &format!("{}\n{}", output.stdout, output.stderr),
                login_command,
            ),
            None => AgentAuth::unknown(Some(login_command)),
        },
    };

    if let Ok(mut cache) = AUTH_CACHE.lock() {
        cache.insert(binary.to_path_buf(), (Instant::now(), auth.clone()));
    }
    auth
}

fn cached_auth(binary: &Path) -> Option<AgentAuth> {
    let cache = AUTH_CACHE.lock().ok()?;
    let (checked_at, auth) = cache.get(binary)?;
    (checked_at.elapsed() < CACHE_TTL).then(|| auth.clone())
}

struct ProbeOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

async fn run_probe(binary: &Path, args: &[&str], removed_env: &[&str]) -> Option<ProbeOutput> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in removed_env {
        command.env_remove(name);
    }
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    Some(ProbeOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Parse the JSON printed by `claude auth status`.
fn parse_claude_auth_status(stdout: &str, login_command: &'static str) -> AgentAuth {
    let Ok(status) = serde_json::from_str::<Value>(stdout.trim()) else {
        // Older CLIs have no `auth status`; do not block them.
        return AgentAuth::unknown(Some(login_command));
    };
    let Some(logged_in) = status.get("loggedIn").and_then(Value::as_bool) else {
        return AgentAuth::unknown(Some(login_command));
    };
    if !logged_in {
        return AgentAuth {
            state: AuthState::SignedOut,
            method: None,
            plan: None,
            login_command: Some(login_command),
        };
    }

    let method = status
        .get("authMethod")
        .and_then(Value::as_str)
        .map(|method| {
            let method = method.to_ascii_lowercase();
            if method.contains("api") || method.contains("console") {
                AuthMethod::ApiKey
            } else {
                AuthMethod::Subscription
            }
        });
    let plan = status
        .get("subscriptionType")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(str::to_string);

    AgentAuth {
        state: AuthState::SignedIn,
        method,
        plan,
        login_command: Some(login_command),
    }
}

/// Interpret `codex login status`, which exits non-zero when signed out and
/// otherwise prints which kind of login is active.
fn parse_codex_login_status(success: bool, output: &str, login_command: &'static str) -> AgentAuth {
    let text = output.to_ascii_lowercase();
    if text.contains("not logged in") {
        return AgentAuth {
            state: AuthState::SignedOut,
            method: None,
            plan: None,
            login_command: Some(login_command),
        };
    }
    if !text.contains("logged in") {
        // An unrecognised reply (for example an old CLI without this
        // subcommand) says nothing about the login either way.
        return if success {
            AgentAuth {
                state: AuthState::SignedIn,
                method: None,
                plan: None,
                login_command: Some(login_command),
            }
        } else {
            AgentAuth::unknown(Some(login_command))
        };
    }

    let method = if text.contains("chatgpt") {
        Some(AuthMethod::Subscription)
    } else if text.contains("api key") {
        Some(AuthMethod::ApiKey)
    } else {
        None
    };
    AgentAuth {
        state: AuthState::SignedIn,
        method,
        plan: None,
        login_command: Some(login_command),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_subscription_login_is_signed_in() {
        let auth = parse_claude_auth_status(
            r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#,
            "claude auth login",
        );
        assert_eq!(auth.state, AuthState::SignedIn);
        assert_eq!(auth.method, Some(AuthMethod::Subscription));
        assert_eq!(auth.plan.as_deref(), Some("max"));
        assert!(auth.is_usable());
    }

    #[test]
    fn claude_api_key_login_is_reported_as_api_key() {
        let auth = parse_claude_auth_status(
            r#"{"loggedIn":true,"authMethod":"api_key"}"#,
            "claude auth login",
        );
        assert_eq!(auth.method, Some(AuthMethod::ApiKey));
        assert_eq!(auth.plan, None);
    }

    #[test]
    fn claude_logged_out_is_not_usable() {
        let auth = parse_claude_auth_status(
            r#"{"loggedIn":false,"authMethod":"none"}"#,
            "claude auth login",
        );
        assert_eq!(auth.state, AuthState::SignedOut);
        assert!(!auth.is_usable());
        assert_eq!(auth.to_json()["loginCommand"], "claude auth login");
    }

    #[test]
    fn claude_unparseable_output_stays_usable() {
        let auth = parse_claude_auth_status("error: unknown command 'auth'", "claude auth login");
        assert_eq!(auth.state, AuthState::Unknown);
        assert!(auth.is_usable());
    }

    #[test]
    fn codex_chatgpt_login_is_subscription() {
        let auth = parse_codex_login_status(true, "Logged in using ChatGPT", "codex login");
        assert_eq!(auth.state, AuthState::SignedIn);
        assert_eq!(auth.method, Some(AuthMethod::Subscription));
    }

    #[test]
    fn codex_api_key_login_is_api_key() {
        let auth =
            parse_codex_login_status(true, "Logged in using an API key - sk-***", "codex login");
        assert_eq!(auth.method, Some(AuthMethod::ApiKey));
    }

    #[test]
    fn codex_not_logged_in_is_signed_out() {
        let auth = parse_codex_login_status(false, "Not logged in", "codex login");
        assert_eq!(auth.state, AuthState::SignedOut);
        assert_eq!(auth.to_json()["state"], "signed_out");
    }

    #[test]
    fn codex_unrecognised_failure_stays_usable() {
        let auth = parse_codex_login_status(
            false,
            "error: unrecognized subcommand 'status'",
            "codex login",
        );
        assert_eq!(auth.state, AuthState::Unknown);
    }

    #[tokio::test]
    async fn agents_without_a_probe_are_unknown() {
        let auth = detect_agent_auth(&AgentKind::Gemini, Path::new("/nonexistent/gemini")).await;
        assert_eq!(auth.state, AuthState::Unknown);
        assert_eq!(auth.login_command, None);
    }
}
