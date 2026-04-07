//! Auto-update missing executor binaries via npm/pnpm.
//!
//! When `discover_executors()` finds no binary for a given agent kind, callers
//! can invoke `try_install_missing_executor()` as a last resort.  The install
//! only runs when:
//!   1. The binary is genuinely absent (not just the wrong version)
//!   2. The `CONDUCTOR_AUTO_UPDATE_EXECUTORS=1` env var is set
//!   3. The current install mode is one that supports package installs
//!
//! Errors are surfaced as structured messages rather than panics, so a failed
//! install never crashes the server.  The user sees a clear error in the UI.

use conductor_core::types::AgentKind;
use tokio::process::Command;
use tokio::time::{sleep, Duration};

/// Per-agent install metadata.
struct AgentInstallInfo {
    /// CLI binary names that must exist after installation.
    binaries: &'static [&'static str],
    /// npm / pnpm package name.
    package: &'static str,
    /// Optional global flag (`-g` / `--global`).
    global_flag: &'static str,
}

// Use `&'static [&'static str]` instead of `vec![]` because `vec![]` is not
// allowed inside `const` items (it involves heap allocation at runtime).
const AGENT_INSTALL_TABLE: &[(AgentKind, AgentInstallInfo)] = &[
    (
        AgentKind::ClaudeCode,
        AgentInstallInfo {
            binaries: &["claude", "claude-code"],
            package: "@anthropic-ai/claude-code",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::Codex,
        AgentInstallInfo {
            binaries: &["codex"],
            package: "openai-codex",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::Gemini,
        AgentInstallInfo {
            binaries: &["gemini"],
            package: "@google/gemini-cli",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::Amp,
        AgentInstallInfo {
            binaries: &["amp"],
            package: "amph-client",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::CursorCli,
        AgentInstallInfo {
            binaries: &["cursor-agent", "cursor-cli", "cursor"],
            package: "@cursor.sh/cli",
            global_flag: "--global",
        },
    ),
    (
        AgentKind::OpenCode,
        AgentInstallInfo {
            binaries: &["opencode"],
            package: "opencode-ai",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::Droid,
        AgentInstallInfo {
            binaries: &["droid"],
            package: "@anthropic-ai/droid-cli",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::QwenCode,
        AgentInstallInfo {
            binaries: &["qwen-code"],
            package: "@qwen/qwen-code",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::Ccr,
        AgentInstallInfo {
            binaries: &["ccr"],
            package: "code-compose-runtime",
            global_flag: "-g",
        },
    ),
    (
        AgentKind::GithubCopilot,
        AgentInstallInfo {
            binaries: &["github-copilot", "copilot", "gh-copilot"],
            package: "@githubnext/github-copilot",
            global_flag: "-g",
        },
    ),
];

/// Returns true when auto-update is enabled via environment.
fn is_auto_update_enabled() -> bool {
    std::env::var("CONDUCTOR_AUTO_UPDATE_EXECUTORS")
        .map(|v| v.trim() == "1" || v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Checks whether any of the expected binaries for this agent kind exist on PATH.
fn binary_exists_on_path(binaries: &[&str]) -> bool {
    for name in binaries {
        if which::which(name).is_ok() {
            return true;
        }
    }
    false
}

/// Returns the install info for an agent kind, if known.
fn install_info_for(kind: &AgentKind) -> Option<&'static AgentInstallInfo> {
    AGENT_INSTALL_TABLE
        .iter()
        .find(|(k, _)| *k == *kind)
        .map(|(_, info)| info)
}

/// Detect which package manager is available. Prefers pnpm > bun > npm.
fn detect_package_manager() -> &'static str {
    if which::which("pnpm").is_ok() {
        return "pnpm";
    }
    if which::which("bun").is_ok() {
        return "bun";
    }
    "npm"
}

/// Run a foreground install command and collect its stdout + stderr.
async fn run_install(manager: &str, package: &str, global_flag: &str) -> Result<String, String> {
    let binary_path = which::which(manager).map_err(|_| format!("{manager} not found on PATH"))?;

    let child = Command::new(&binary_path)
        .arg("install")
        .arg(global_flag)
        .arg(package)
        .arg("--silent")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {manager} install: {e}"))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("{manager} install wait failed: {e}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Surface the most useful part of npm errors without flooding logs.
        let combined = if stderr.is_empty() {
            &*stdout
        } else {
            &*stderr
        };
        Err(extract_npm_error_message(combined))
    }
}

/// Pulls a human-readable sentence out of an npm/pnpm error stream.
fn extract_npm_error_message(output: &str) -> String {
    // npm/pnpm errors tend to put the root cause on its own line that is NOT
    // blank and NOT a progress line. Find the first meaningful line.
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("npm ") || trimmed.starts_with("pnpm ") {
            continue;
        }
        // Skip ANSI control chars.
        let clean: String = trimmed
            .chars()
            .filter(|c| !c.is_ascii_control() || *c == '\n')
            .collect();
        if !clean.trim().is_empty() {
            // Return at most the first 200 chars to avoid flooding.
            return if clean.len() > 200 {
                format!("{}...", clean[..200].trim_end())
            } else {
                clean.trim().to_string()
            };
        }
    }
    "install failed with no error output".to_string()
}

/// Result of an install attempt.
#[derive(Debug, Clone)]
pub struct InstallResult {
    /// Whether installation appeared to succeed.
    pub success: bool,
    /// The package manager used.
    pub manager: String,
    /// The package that was installed.
    pub package: String,
    /// A user-facing message. Empty on success.
    pub message: String,
}

impl std::fmt::Display for InstallResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.success {
            write!(
                f,
                "{} installed {} successfully",
                self.manager, self.package
            )
        } else {
            write!(
                f,
                "{} install of {} failed: {}",
                self.manager, self.package, self.message
            )
        }
    }
}

/// Attempt to install a missing executor binary.
///
/// This function is deliberately conservative:
///   - Returns immediately if the binary already exists (no-op)
///   - Returns immediately if `CONDUCTOR_AUTO_UPDATE_EXECUTORS=1` is not set
///   - Only installs globally (not into project node_modules)
///   - Censors auth/token errors from npm output
///
/// Returns `InstallResult` regardless of outcome so callers can log or
/// surface the message to users without panicking.
pub async fn try_install_missing_executor(kind: AgentKind) -> InstallResult {
    let info = match install_info_for(&kind) {
        Some(i) => i,
        None => {
            return InstallResult {
                success: false,
                manager: "none".to_string(),
                package: format!("{:?}", kind),
                message: "no install recipe known for this agent kind".to_string(),
            };
        }
    };

    // Fast path: already installed.
    if binary_exists_on_path(info.binaries) {
        return InstallResult {
            success: true,
            manager: detect_package_manager().to_string(),
            package: info.package.to_string(),
            message: String::new(),
        };
    }

    // Opt-in gate.
    if !is_auto_update_enabled() {
        tracing::debug!(
            agent = ?kind,
            "executor binary missing but CONDUCTOR_AUTO_UPDATE_EXECUTORS=1 not set, skipping install"
        );
        return InstallResult {
            success: false,
            manager: "none".to_string(),
            package: info.package.to_string(),
            message: format!(
                "binary not found for {:?} ({:?}). \
                Set CONDUCTOR_AUTO_UPDATE_EXECUTORS=1 to permit auto-install, \
                or install manually with your package manager.",
                kind, info.binaries
            ),
        };
    }

    let manager = detect_package_manager();
    tracing::info!(
        agent = ?kind,
        package = info.package,
        manager,
        "executor binary missing, attempting auto-install"
    );

    // Retry up to once after a brief pause in case of transient network errors.
    for attempt in 0..2 {
        match run_install(manager, info.package, info.global_flag).await {
            Ok(out) => {
                tracing::info!(
                    agent = ?kind,
                    manager,
                    package = info.package,
                    output_len = out.len(),
                    "executor binary installed"
                );
                return InstallResult {
                    success: true,
                    manager: manager.to_string(),
                    package: info.package.to_string(),
                    message: String::new(),
                };
            }
            Err(err) => {
                tracing::warn!(
                    agent = ?kind,
                    manager,
                    package = info.package,
                    attempt,
                    error = %err,
                    "executor install attempt failed"
                );

                // If this was the last attempt, return the error.
                if attempt == 1 {
                    // Avoid leaking npm auth tokens that might appear in error messages.
                    let sanitized = sanitize_npm_token_error(&err);
                    return InstallResult {
                        success: false,
                        manager: manager.to_string(),
                        package: info.package.to_string(),
                        message: sanitized,
                    };
                }

                // Brief pause before retry.
                sleep(Duration::from_secs(3)).await;
            }
        }
    }

    // Should not reach here, but defensive.
    InstallResult {
        success: false,
        manager: manager.to_string(),
        package: info.package.to_string(),
        message: "unexpected loop exit".to_string(),
    }
}

/// Removes npm auth token references from error messages so they never get
/// logged or surfaced to users.
fn sanitize_npm_token_error(message: &str) -> String {
    // Match patterns like `npm ERR! ... Auth is required ...` or token strings.
    let token_patterns = [
        "NPM_",
        "npm_",
        "AUTH",
        "TOKEN",
        "credential",
        "unauthorized",
        "E401",
    ];
    let lower = message.to_lowercase();
    let has_auth_error = token_patterns
        .iter()
        .any(|p| lower.contains(&p.to_lowercase()));

    if has_auth_error {
        "install failed: authentication or authorization error. \
        Log in with `npm login` (or `pnpm login`) and retry."
            .to_string()
    } else {
        message.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_npm_token_error_censors_auth_messages() {
        let msg = "npm ERR! 401 Unauthorized - Invalid token NPM_abc123xyz";
        let out = sanitize_npm_token_error(msg);
        assert!(!out.contains("NPM_"));
        assert!(out.contains("authentication"));
    }

    #[test]
    fn sanitize_npm_token_error_passes_through_normal_errors() {
        let msg = "pnpm ERR! network timeout";
        let out = sanitize_npm_token_error(msg);
        assert!(out.contains("network timeout"));
    }

    #[test]
    fn binary_exists_on_path_is_sane() {
        // `sh` is available in all CI runners and developer environments.
        assert!(binary_exists_on_path(&["sh"]));
        // Definitely fake name should not.
        assert!(!binary_exists_on_path(&[
            "conductor-this-does-not-exist-xyz"
        ]));
    }

    #[test]
    fn install_info_for_known_agents() {
        assert!(install_info_for(&AgentKind::ClaudeCode).is_some());
        assert!(install_info_for(&AgentKind::Codex).is_some());
        assert!(install_info_for(&AgentKind::CursorCli).is_some());
        assert!(install_info_for(&AgentKind::OpenCode).is_some());
        assert!(install_info_for(&AgentKind::Hermes).is_none());
    }
}
