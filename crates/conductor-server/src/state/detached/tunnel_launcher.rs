//! Cloudflare Quick Tunnel integration for terminal sessions.
//!
//! Spawns `cloudflared tunnel --url http://localhost:PORT` for each ttyd
//! session, giving each one a unique public HTTPS URL. The frontend can
//! load ttyd directly through the tunnel, bypassing the backend proxy
//! chain entirely. This eliminates iframe resize issues and removes the
//! need for Puppeteer-based preview screenshots.

use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::io::BufReader;
use tokio::process::{Child, Command};

use super::types::{TTYD_TUNNEL_URL_METADATA_KEY, TUNNEL_PID_METADATA_KEY};
use crate::state::AppState;

/// Maximum time to wait for cloudflared to print the tunnel URL.
const TUNNEL_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Resolve the cloudflared binary path.
pub fn resolve_cloudflared_binary() -> Option<std::path::PathBuf> {
    if let Ok(env_path) = std::env::var("CONDUCTOR_CLOUDFLARED_BINARY") {
        let p = std::path::PathBuf::from(env_path.trim());
        if p.is_file() {
            return Some(p);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let candidates = [
            std::path::PathBuf::from("/opt/homebrew/bin/cloudflared"),
            std::path::PathBuf::from("/usr/local/bin/cloudflared"),
        ];
        for c in &candidates {
            if c.is_file() {
                return Some(c.clone());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = [
            std::path::PathBuf::from("/usr/bin/cloudflared"),
            std::path::PathBuf::from("/usr/local/bin/cloudflared"),
        ];
        for c in &candidates {
            if c.is_file() {
                return Some(c.clone());
            }
        }
    }

    which::which("cloudflared").ok()
}

/// Spawn a cloudflared quick tunnel pointing at the given local port.
/// Returns (child_process, public_https_url).
pub async fn spawn_tunnel(port: u16) -> Result<(Child, String)> {
    let binary = resolve_cloudflared_binary()
        .context("cloudflared binary not found. Install it or set CONDUCTOR_CLOUDFLARED_BINARY")?;

    let local_url = format!("http://localhost:{port}");

    let mut child = Command::new(&binary)
        .arg("tunnel")
        .arg("--url")
        .arg(&local_url)
        .arg("--no-autoupdate")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Failed to spawn cloudflared")?;

    let stderr = child
        .stderr
        .take()
        .context("cloudflared stderr not captured")?;
    let reader = BufReader::new(stderr);
    use tokio::io::AsyncBufReadExt;
    let mut lines = reader.lines();

    let tunnel_url = match tokio::time::timeout(TUNNEL_STARTUP_TIMEOUT, async {
        while let Ok(Some(line)) = lines.next_line().await {
            // cloudflared prints: "https://xxx-yyy-zzz.trycloudflare.com"
            // in a line like: "|  https://random-words.trycloudflare.com  |"
            if let Some(url) = extract_tunnel_url(&line) {
                return Ok(url);
            }
        }
        Err(anyhow::anyhow!(
            "cloudflared exited before printing tunnel URL"
        ))
    })
    .await
    {
        Ok(Ok(url)) => url,
        Ok(Err(err)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(err).context("cloudflared failed to produce a tunnel URL");
        }
        Err(err) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(err).context("Timed out waiting for cloudflared tunnel URL");
        }
    };

    tracing::info!(port, %tunnel_url, "Cloudflare tunnel established");
    Ok((child, tunnel_url))
}

/// Extract a trycloudflare.com URL from a cloudflared log line.
fn extract_tunnel_url(line: &str) -> Option<String> {
    // Look for https://xxx.trycloudflare.com pattern
    let line_lower = line.to_lowercase();
    if !line_lower.contains("trycloudflare.com") {
        return None;
    }

    // Find the https:// prefix
    let start = line_lower.find("https://")?;
    let remainder = &line[start..];

    // Find end of URL (space, pipe, quote, or end of line)
    let url_end = remainder
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
        .unwrap_or(remainder.len());

    Some(remainder[..url_end].to_string())
}

/// Kill the cloudflared child process and clean up session metadata.
pub async fn kill_tunnel(state: &Arc<AppState>, session_id: &str) {
    let pid_str = {
        let sessions = state.sessions.read().await;
        sessions
            .get(session_id)
            .and_then(|s| s.metadata.get(TUNNEL_PID_METADATA_KEY).cloned())
    };

    if let Some(pid_str) = pid_str {
        if let Ok(pid) = pid_str.parse::<u32>() {
            if pid > 0 {
                #[cfg(unix)]
                unsafe {
                    // Send SIGTERM to the cloudflared process
                    libc::kill(pid as i32, libc::SIGTERM);
                    tracing::info!(session_id, pid, "Sent SIGTERM to cloudflared tunnel");
                }
            } else {
                tracing::warn!(session_id, "Ignoring invalid cloudflared PID 0");
            }
        }
    }

    // Remove tunnel metadata from session
    {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session.metadata.remove(TTYD_TUNNEL_URL_METADATA_KEY);
            session.metadata.remove(TUNNEL_PID_METADATA_KEY);
        }
    }
}

/// Start a tunnel for an existing ttyd session and store the URL in metadata.
/// Returns the tunnel URL on success, or the error if tunnel setup failed.
#[allow(dead_code)]
pub async fn start_tunnel_for_session(
    state: &Arc<AppState>,
    session_id: &str,
    ttyd_port: u16,
) -> Result<String> {
    let (mut child, tunnel_url) = spawn_tunnel(ttyd_port).await?;
    let tunnel_pid = child
        .id()
        .filter(|pid| *pid > 0)
        .context("cloudflared exited before exposing a non-zero PID")?;

    // Store tunnel URL and PID in session metadata
    {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get_mut(session_id) {
            session
                .metadata
                .insert(TTYD_TUNNEL_URL_METADATA_KEY.to_string(), tunnel_url.clone());
            session
                .metadata
                .insert(TUNNEL_PID_METADATA_KEY.to_string(), tunnel_pid.to_string());
        }
    }

    // Spawn a background task to reap the cloudflared process when it exits
    // (prevents zombie processes). The tunnel child is intentionally not killed
    // here; it lives until the session ends and kill_tunnel() is called.
    let sid = session_id.to_string();
    let st = state.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        tracing::info!(session_id = %sid, "cloudflared tunnel process exited");
        // Clean up metadata since tunnel is gone
        {
            let mut sessions = st.sessions.write().await;
            if let Some(session) = sessions.get_mut(&sid) {
                session.metadata.remove(TTYD_TUNNEL_URL_METADATA_KEY);
                session.metadata.remove(TUNNEL_PID_METADATA_KEY);
            }
        }
    });

    Ok(tunnel_url)
}

/// Get the tunnel URL for a session, if one is active.
#[allow(dead_code)]
pub async fn get_tunnel_url(state: &Arc<AppState>, session_id: &str) -> Option<String> {
    let sessions = state.sessions.read().await;
    sessions
        .get(session_id)
        .and_then(|s| s.metadata.get(TTYD_TUNNEL_URL_METADATA_KEY).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tunnel_url_infobox() {
        let line = "|  https://random-words-try.trycloudflare.com  |";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://random-words-try.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn test_extract_tunnel_url_log_line() {
        let line = "2026-04-06 INF +--------------------------------------------------------------------------------------------+";
        assert_eq!(extract_tunnel_url(line), None);
    }

    #[test]
    fn test_extract_tunnel_url_with_pipe() {
        let line = "|  https://foo-bar-baz.trycloudflare.com  |";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://foo-bar-baz.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn test_extract_tunnel_url_mid_line() {
        let line =
            "Your quick Tunnel has been created! Visit it at https://abc-def.trycloudflare.com now";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://abc-def.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn test_extract_tunnel_url_no_match() {
        let line = "2026-04-06 INF Registered tunnel connection";
        assert_eq!(extract_tunnel_url(line), None);
    }

    #[test]
    fn test_extract_tunnel_url_with_quotes() {
        let line = r#"url="https://some-tunnel.trycloudflare.com""#;
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://some-tunnel.trycloudflare.com".to_string())
        );
    }
}
