//! Finding the DevTools WebSocket of the user's own running Chrome.
//!
//! Chrome 144+ lets a local program attach to the running browser once the
//! user turns on remote debugging at `chrome://inspect/#remote-debugging`.
//! Chrome then writes a `DevToolsActivePort` file in its profile directory
//! naming the port and WebSocket path, and asks the user to approve each new
//! connection.

use std::path::{Path, PathBuf};
use url::Url;

use super::BrowserError;

/// Overrides discovery with an explicit endpoint: either the HTTP address of
/// a Chrome started with `--remote-debugging-port` or a `ws://` URL.
pub const BROWSER_URL_ENV: &str = "CONDUCTOR_BROWSER_URL";

const ACTIVE_PORT_FILE: &str = "DevToolsActivePort";

/// Resolve the WebSocket URL to connect to.
pub async fn resolve_endpoint() -> Result<String, BrowserError> {
    if let Some(configured) = std::env::var(BROWSER_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return resolve_configured(&configured).await;
    }
    default_profile_dirs()
        .iter()
        .find_map(|dir| read_active_port(dir))
        .ok_or(BrowserError::NotEnabled)
}

async fn resolve_configured(configured: &str) -> Result<String, BrowserError> {
    let url = Url::parse(configured)
        .map_err(|err| BrowserError::Connect(format!("{BROWSER_URL_ENV} is not a URL: {err}")))?;
    require_loopback(&url)?;
    match url.scheme() {
        "ws" => Ok(configured.to_string()),
        "http" => {
            let version_url = url
                .join("/json/version")
                .map_err(|err| BrowserError::Connect(err.to_string()))?;
            let version: serde_json::Value = reqwest::Client::new()
                .get(version_url)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
                .map_err(|err| BrowserError::Connect(err.to_string()))?
                .json()
                .await
                .map_err(|err| BrowserError::Connect(err.to_string()))?;
            let ws_url = version
                .get("webSocketDebuggerUrl")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    BrowserError::Connect("Chrome did not report a debugger URL".to_string())
                })?;
            require_loopback(
                &Url::parse(ws_url).map_err(|err| BrowserError::Connect(err.to_string()))?,
            )?;
            Ok(ws_url.to_string())
        }
        other => Err(BrowserError::Connect(format!(
            "{BROWSER_URL_ENV} must start with http:// or ws://, not {other}://"
        ))),
    }
}

/// The browser being driven is the user's own; never attach to another host.
fn require_loopback(url: &Url) -> Result<(), BrowserError> {
    if super::is_loopback_host(url.host_str().unwrap_or_default()) {
        Ok(())
    } else {
        Err(BrowserError::Connect(
            "the browser endpoint must be on this machine (localhost)".to_string(),
        ))
    }
}

/// Read `DevToolsActivePort` from a Chrome profile directory: the port on the
/// first line and the WebSocket path on the second.
pub fn read_active_port(profile_dir: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(profile_dir.join(ACTIVE_PORT_FILE)).ok()?;
    let mut lines = contents.lines().map(str::trim);
    let port: u16 = lines.next()?.parse().ok()?;
    let path = lines.next().filter(|path| path.starts_with('/'))?;
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

fn default_profile_dirs() -> Vec<PathBuf> {
    let mut dirs_found = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        let support = home.join("Library").join("Application Support");
        dirs_found.push(support.join("Google").join("Chrome"));
        dirs_found.push(support.join("Chromium"));
    }
    #[cfg(target_os = "windows")]
    if let Some(local) = dirs::data_local_dir() {
        dirs_found.push(local.join("Google").join("Chrome").join("User Data"));
        dirs_found.push(local.join("Chromium").join("User Data"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(config) = dirs::config_dir() {
        dirs_found.push(config.join("google-chrome"));
        dirs_found.push(config.join("chromium"));
    }
    dirs_found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_port_and_path_from_active_port_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(ACTIVE_PORT_FILE),
            "9222\n/devtools/browser/abc-123\n",
        )
        .unwrap();
        assert_eq!(
            read_active_port(dir.path()).as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/abc-123")
        );
    }

    #[test]
    fn rejects_missing_or_malformed_active_port_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_active_port(dir.path()), None);
        for contents in [
            "",
            "9222\n",
            "not-a-port\n/devtools/browser/x\n",
            "9222\nevil.test/x\n",
        ] {
            std::fs::write(dir.path().join(ACTIVE_PORT_FILE), contents).unwrap();
            assert_eq!(read_active_port(dir.path()), None, "{contents:?}");
        }
    }

    #[tokio::test]
    async fn configured_endpoint_must_be_local() {
        assert!(matches!(
            resolve_configured("ws://example.com:9222/devtools/browser/x").await,
            Err(BrowserError::Connect(_))
        ));
        assert!(matches!(
            resolve_configured("https://127.0.0.1:9222").await,
            Err(BrowserError::Connect(_))
        ));
        assert_eq!(
            resolve_configured("ws://127.0.0.1:9222/devtools/browser/x")
                .await
                .unwrap(),
            "ws://127.0.0.1:9222/devtools/browser/x"
        );
    }
}
