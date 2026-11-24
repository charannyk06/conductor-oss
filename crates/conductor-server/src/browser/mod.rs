//! Driving the user's own Chrome on the assistant's behalf.
//!
//! The assistant gets a small set of actions (list tabs, open a page, read it,
//! click, type, fill a saved login) over the Chrome DevTools Protocol. There
//! is deliberately no "run this JavaScript" action: saved passwords go from
//! the vault straight into the page and are never part of anything returned
//! to the model.

mod cdp;
pub mod endpoint;
mod scripts;
pub mod tools;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use thiserror::Error;
use url::Url;

use crate::vault::{CredentialSummary, Vault, VaultError};
use cdp::CdpClient;

const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const LOAD_POLL: Duration = Duration::from_millis(150);

#[derive(Debug, Error)]
pub enum BrowserError {
    #[error(
        "Chrome is not accepting connections. In Chrome 144 or later, open chrome://inspect/#remote-debugging, turn on remote debugging, and approve the connection prompt"
    )]
    NotEnabled,
    #[error("could not connect to Chrome: {0}")]
    Connect(String),
    #[error("the connection to Chrome was lost")]
    Disconnected,
    #[error("Chrome did not answer {0} in time")]
    Timeout(String),
    #[error("Chrome rejected the request: {0}")]
    Protocol(String),
    #[error("{0}")]
    Invalid(String),
    #[error("no open tab has the id \"{0}\"; list the tabs again")]
    UnknownTab(String),
    #[error("element {0} is not on the page any more; read the page again")]
    UnknownElement(u32),
    #[error(transparent)]
    Vault(#[from] VaultError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub url: String,
}

/// What the assistant sees of a page. Password values are never included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub url: String,
    pub title: String,
    pub text: String,
    pub elements: Vec<PageElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageElement {
    /// Handle to pass to click and type; valid until the page is read again.
    #[serde(rename = "ref")]
    pub reference: u32,
    pub tag: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FillOutcome {
    /// Username and/or password were entered. Nothing was submitted.
    Filled {
        username: String,
        filled_username: bool,
        filled_password: bool,
    },
    /// Several saved logins match this site; call again with one `id`.
    ChooseCredential { candidates: Vec<CredentialSummary> },
    /// No saved login belongs to this site.
    NoSavedLogin { site: String },
    /// The page has no visible login field.
    NoLoginForm,
}

pub struct Browser {
    client: CdpClient,
    /// Target id to attached session id.
    sessions: tokio::sync::Mutex<HashMap<String, String>>,
}

impl Browser {
    pub async fn connect(ws_url: &str) -> Result<Self, BrowserError> {
        Ok(Self {
            client: CdpClient::connect(ws_url).await?,
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// Open web pages, most recently created last.
    pub async fn tabs(&self) -> Result<Vec<Tab>, BrowserError> {
        let result = self
            .client
            .call(None, "Target.getTargets", json!({}))
            .await?;
        let text = |target: &Value, key: &str| {
            target
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Ok(result
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|target| target.get("type").and_then(Value::as_str) == Some("page"))
            .map(|target| Tab {
                id: text(target, "targetId"),
                title: text(target, "title"),
                url: text(target, "url"),
            })
            .filter(|tab| is_web_url(&tab.url) || tab.url == "about:blank")
            .collect())
    }

    /// Load `url` in a new tab, or in `tab` when given.
    pub async fn open(&self, url: &str, tab: Option<&str>) -> Result<Tab, BrowserError> {
        let url = parse_web_url(url)?;
        let tab_id = match tab {
            Some(tab_id) => {
                let session = self.session(tab_id).await?;
                let navigated = self
                    .client
                    .call(Some(&session), "Page.navigate", json!({ "url": url }))
                    .await?;
                if let Some(reason) = navigated.get("errorText").and_then(Value::as_str) {
                    return Err(BrowserError::Invalid(format!(
                        "the page could not be loaded: {reason}"
                    )));
                }
                tab_id.to_string()
            }
            None => {
                let created = self
                    .client
                    .call(None, "Target.createTarget", json!({ "url": url }))
                    .await?;
                created
                    .get("targetId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BrowserError::Protocol("no target id returned".into()))?
                    .to_string()
            }
        };
        // A new tab starts on a blank document before its page commits.
        self.wait_for_load(&tab_id, tab.is_none()).await?;
        self.tab(&tab_id).await
    }

    pub async fn read(&self, tab: &str) -> Result<PageSnapshot, BrowserError> {
        let value = self.evaluate(tab, scripts::SNAPSHOT, json!([])).await?;
        serde_json::from_value(value)
            .map_err(|err| BrowserError::Protocol(format!("unreadable page snapshot: {err}")))
    }

    pub async fn click(&self, tab: &str, reference: u32) -> Result<(), BrowserError> {
        let found = self
            .evaluate(tab, scripts::CLICK, json!([reference]))
            .await?;
        if found != json!(true) {
            return Err(BrowserError::UnknownElement(reference));
        }
        // Give a navigation started by the click a moment to begin.
        tokio::time::sleep(Duration::from_millis(400)).await;
        self.wait_for_load(tab, false).await
    }

    /// Replace the content of a field with `text`, optionally pressing Enter.
    pub async fn type_text(
        &self,
        tab: &str,
        reference: u32,
        text: &str,
        submit: bool,
    ) -> Result<(), BrowserError> {
        let found = self
            .evaluate(tab, scripts::FOCUS_AND_CLEAR, json!([reference]))
            .await?;
        if found != json!(true) {
            return Err(BrowserError::UnknownElement(reference));
        }
        let session = self.session(tab).await?;
        self.client
            .call(Some(&session), "Input.insertText", json!({ "text": text }))
            .await?;
        if submit {
            for kind in ["keyDown", "keyUp"] {
                self.client
                    .call(
                        Some(&session),
                        "Input.dispatchKeyEvent",
                        json!({
                            "type": kind,
                            "key": "Enter",
                            "code": "Enter",
                            "windowsVirtualKeyCode": 13,
                            "text": if kind == "keyDown" { "\r" } else { "" },
                        }),
                    )
                    .await?;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            self.wait_for_load(tab, false).await?;
        }
        Ok(())
    }

    /// Enter a saved login into the page in `tab`. Only a login saved for the
    /// site the tab is actually showing is ever used, and nothing is submitted.
    pub async fn fill_login(
        &self,
        tab: &str,
        vault: &Vault,
        credential_id: Option<&str>,
    ) -> Result<FillOutcome, BrowserError> {
        let page_url = self.tab(tab).await?.url;
        let site = Url::parse(&page_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_default();
        if !is_secure_page(&page_url) {
            return Err(BrowserError::Invalid(
                "saved logins are only filled on https pages".to_string(),
            ));
        }

        let mut candidates: Vec<CredentialSummary> = vault
            .list()?
            .into_iter()
            .filter(|saved| credential_matches_page(&saved.url, &page_url))
            .collect();
        if let Some(id) = credential_id {
            candidates.retain(|saved| saved.id == id);
        }
        let chosen = match candidates.len() {
            0 => return Ok(FillOutcome::NoSavedLogin { site }),
            1 => candidates.remove(0),
            _ => return Ok(FillOutcome::ChooseCredential { candidates }),
        };

        let password = vault.reveal(&chosen.id)?;
        let result = self
            .evaluate(tab, scripts::FILL_LOGIN, json!([chosen.username, password]))
            .await?;
        let flag = |key: &str| result.get(key).and_then(Value::as_bool).unwrap_or(false);
        let (filled_username, filled_password) = (flag("username"), flag("password"));
        if !filled_username && !filled_password {
            return Ok(FillOutcome::NoLoginForm);
        }
        Ok(FillOutcome::Filled {
            username: chosen.username,
            filled_username,
            filled_password,
        })
    }

    async fn tab(&self, tab_id: &str) -> Result<Tab, BrowserError> {
        self.tabs()
            .await?
            .into_iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| BrowserError::UnknownTab(tab_id.to_string()))
    }

    /// The attached session for a tab, attaching on first use.
    async fn session(&self, tab_id: &str) -> Result<String, BrowserError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get(tab_id) {
            return Ok(session.clone());
        }
        let attached = self
            .client
            .call(
                None,
                "Target.attachToTarget",
                json!({ "targetId": tab_id, "flatten": true }),
            )
            .await
            .map_err(|err| match err {
                BrowserError::Protocol(_) => BrowserError::UnknownTab(tab_id.to_string()),
                other => other,
            })?;
        let session = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| BrowserError::Protocol("no session id returned".into()))?
            .to_string();
        sessions.insert(tab_id.to_string(), session.clone());
        Ok(session)
    }

    /// Call one of the fixed page scripts with JSON arguments.
    async fn evaluate(
        &self,
        tab: &str,
        function: &str,
        arguments: Value,
    ) -> Result<Value, BrowserError> {
        let session = self.session(tab).await?;
        let expression = format!("({function}).apply(null, {arguments})");
        let result = self
            .client
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            let message = details
                .get("exception")
                .and_then(|exception| exception.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("the page script failed");
            return Err(BrowserError::Protocol(
                message.lines().next().unwrap_or(message).to_string(),
            ));
        }
        Ok(result
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Wait until the tab's document has finished loading. With `leave_blank`,
    /// the initial `about:blank` document does not count as loaded.
    async fn wait_for_load(&self, tab: &str, leave_blank: bool) -> Result<(), BrowserError> {
        let deadline = tokio::time::Instant::now() + LOAD_TIMEOUT;
        loop {
            // A navigation in flight can reject the evaluation; keep polling.
            if let Ok(state) = self.evaluate(tab, scripts::READY_STATE, json!([])).await {
                let loaded = state.get("state") == Some(&json!("complete"));
                let blank = state.get("url") == Some(&json!("about:blank"));
                if loaded && !(leave_blank && blank) {
                    return Ok(());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                // A slow page is still usable; let the caller read what loaded.
                return Ok(());
            }
            tokio::time::sleep(LOAD_POLL).await;
        }
    }
}

fn is_web_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

fn parse_web_url(url: &str) -> Result<String, BrowserError> {
    let parsed = Url::parse(url.trim())
        .map_err(|_| BrowserError::Invalid(format!("\"{url}\" is not a full URL")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(BrowserError::Invalid(
            "only http and https pages can be opened".to_string(),
        ));
    }
    Ok(parsed.to_string())
}

pub(crate) fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

/// https, or plain http on this machine only.
fn is_secure_page(page_url: &str) -> bool {
    Url::parse(page_url).is_ok_and(|url| {
        url.scheme() == "https"
            || (url.scheme() == "http" && is_loopback_host(url.host_str().unwrap_or_default()))
    })
}

/// Whether a saved login belongs to the site a page is on.
///
/// Sites match when they share a registrable domain under the public suffix
/// list, so a login saved for `github.com` fills on `gist.github.com` but one
/// saved for `alice.github.io` does not fill on `mallory.github.io`. Hosts
/// without a registrable domain (IP addresses, `localhost`) must match
/// exactly, port included.
fn credential_matches_page(saved_url: &str, page_url: &str) -> bool {
    let saved_url = saved_url.trim();
    let saved = Url::parse(saved_url)
        .ok()
        .filter(|url| url.has_host())
        .or_else(|| Url::parse(&format!("https://{saved_url}")).ok());
    let (Some(saved), Ok(page)) = (saved, Url::parse(page_url)) else {
        return false;
    };
    let (Some(saved_host), Some(page_host)) = (saved.host_str(), page.host_str()) else {
        return false;
    };
    let is_ip = |host: &str| {
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok()
    };
    if is_ip(saved_host) || is_ip(page_host) {
        return saved_host == page_host
            && saved.port_or_known_default() == page.port_or_known_default();
    }
    match (psl::domain_str(saved_host), psl::domain_str(page_host)) {
        (Some(saved_domain), Some(page_domain)) => saved_domain.eq_ignore_ascii_case(page_domain),
        _ => {
            saved_host.eq_ignore_ascii_case(page_host)
                && saved.port_or_known_default() == page.port_or_known_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logins_match_only_their_own_site() {
        let matches = credential_matches_page;
        assert!(matches(
            "https://github.com/login",
            "https://github.com/session"
        ));
        assert!(matches("github.com", "https://gist.github.com/"));
        assert!(matches(
            "https://www.example.co.uk",
            "https://login.example.co.uk/a"
        ));
        assert!(matches("https://EXAMPLE.com", "https://example.com/"));

        assert!(!matches(
            "https://github.com",
            "https://github.com.evil.test/"
        ));
        assert!(!matches("https://example.com", "https://notexample.com/"));
        assert!(!matches("https://example.co.uk", "https://other.co.uk/"));
        // Shared hosting suffixes are separate sites per subdomain.
        assert!(!matches(
            "https://alice.github.io",
            "https://mallory.github.io/"
        ));
        assert!(!matches("", "https://example.com/"));
        assert!(!matches("https://example.com", "about:blank"));
    }

    #[test]
    fn hosts_without_a_domain_must_match_exactly() {
        let matches = credential_matches_page;
        assert!(matches(
            "http://127.0.0.1:8080/login",
            "http://127.0.0.1:8080/"
        ));
        assert!(!matches("http://127.0.0.1:8080", "http://127.0.0.1:9090/"));
        assert!(!matches("http://127.0.0.1:8080", "http://127.0.0.2:8080/"));
        assert!(matches("http://localhost:3000", "http://localhost:3000/x"));
        assert!(!matches("http://localhost:3000", "http://localhost:4000/x"));
    }

    #[test]
    fn only_https_or_local_pages_are_fillable() {
        assert!(is_secure_page("https://example.com/login"));
        assert!(is_secure_page("http://127.0.0.1:8080/login"));
        assert!(is_secure_page("http://localhost:3000/"));
        assert!(!is_secure_page("http://example.com/login"));
        assert!(!is_secure_page("about:blank"));
    }

    #[test]
    fn only_web_urls_can_be_opened() {
        assert_eq!(
            parse_web_url(" https://example.com ").unwrap(),
            "https://example.com/"
        );
        for rejected in [
            "file:///etc/passwd",
            "chrome://settings",
            "javascript:alert(1)",
            "example.com",
        ] {
            assert!(parse_web_url(rejected).is_err(), "{rejected}");
        }
    }
}
