//! Drives a real Chromium through the browser tools. Skipped when no
//! Chromium binary is available; set `CONDUCTOR_TEST_CHROME` to point at one.

use conductor_server::browser::endpoint::read_active_port;
use conductor_server::browser::tools::{run, BrowserTool};
use conductor_server::browser::Browser;
use conductor_server::vault::import::{ImportSource, ImportedLogin};
use conductor_server::vault::{KeyStore, Vault};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PASSWORD: &str = "s3cret-PW!42";

const LOGIN_PAGE: &str = r#"<!doctype html><html><head><title>Test sign-in</title></head><body>
<h1>Sign in to Test Site</h1>
<form id="search"><input name="q" aria-label="Search"></form>
<form id="login">
  <label for="user">Email</label><input id="user" name="username" type="email">
  <label for="pass">Password</label><input id="pass" name="password" type="password">
  <button type="button" id="show">Show password</button>
  <button type="submit">Sign in</button>
</form>
<p id="out"></p><p id="spy"></p>
<script>
  const out = document.getElementById("out");
  // The tools must not hand their arguments to `apply`, which a page can
  // replace to read them before the fill script checks which site it is on.
  // (Once that check passes, this page is the site the password belongs to.)
  const originalApply = Function.prototype.apply;
  Function.prototype.apply = function (...args) {
    if (JSON.stringify(args).includes("s3cret")) document.getElementById("spy").textContent = "INTERCEPTED";
    return Reflect.apply(originalApply, this, args);
  };
  document.getElementById("show").onclick = () => { document.getElementById("pass").type = "text"; };
  document.getElementById("search").onsubmit = (e) => { e.preventDefault(); out.textContent = "Searched: " + e.target.q.value; };
  document.getElementById("login").onsubmit = (e) => {
    e.preventDefault();
    const ok = document.getElementById("pass").value === "s3cret-PW!42";
    out.textContent = "Signed in as " + document.getElementById("user").value + ": password " + (ok ? "correct" : "wrong");
  };
</script></body></html>"#;

fn find_chrome() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CONDUCTOR_TEST_CHROME") {
        return Some(PathBuf::from(path));
    }
    let bundled = std::fs::read_dir("/opt/pw-browsers")
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path().join("chrome-linux64").join("chrome"))
        .find(|path| path.exists());
    bundled.or_else(|| {
        ["google-chrome", "chromium", "chromium-browser"]
            .iter()
            .find_map(|name| which::which(name).ok())
    })
}

struct ChromeProcess(Child);

impl Drop for ChromeProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn serve_page(html: &'static str) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = socket.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    port
}

fn login(url: String, username: &str) -> ImportedLogin {
    ImportedLogin {
        name: "Test Site".into(),
        url,
        username: username.into(),
        password: PASSWORD.into(),
    }
}

fn element_ref(snapshot: &Value, label: &str) -> u64 {
    snapshot["elements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|element| element["label"] == label)
        .unwrap_or_else(|| panic!("no element labelled {label:?} in {snapshot}"))["ref"]
        .as_u64()
        .unwrap()
}

/// Start a headless Chromium on a throwaway profile and connect to it.
async fn launch_browser(chrome: PathBuf) -> (ChromeProcess, tempfile::TempDir, Browser) {
    let profile = tempfile::tempdir().unwrap();
    let process = ChromeProcess(
        Command::new(chrome)
            .args([
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--remote-debugging-port=0",
                "about:blank",
            ])
            .arg(format!("--user-data-dir={}", profile.path().display()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );

    // Chrome announces its endpoint the same way the user's own browser does.
    let mut ws_url = None;
    for _ in 0..200 {
        ws_url = read_active_port(profile.path());
        if ws_url.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let browser = Browser::connect(&ws_url.expect("Chrome did not start"))
        .await
        .unwrap();
    (process, profile, browser)
}

#[tokio::test]
async fn signs_in_with_a_saved_login_without_exposing_the_password() {
    let Some(chrome) = find_chrome() else {
        eprintln!("skipping: no Chromium binary found");
        return;
    };
    let (_chrome, _profile, browser) = launch_browser(chrome).await;

    let port = serve_page(LOGIN_PAGE).await;
    let site = format!("http://127.0.0.1:{port}");
    let vault_dir = tempfile::tempdir().unwrap();
    let vault = Vault::new(vault_dir.path());
    let call = |tool, arguments| run(&browser, &vault, tool, arguments);

    let tab = call(BrowserTool::Open, json!({ "url": format!("{site}/login") }))
        .await
        .unwrap();
    let tab_id = tab["id"].as_str().unwrap().to_string();
    assert_eq!(tab["title"], "Test sign-in");
    let tabs = call(BrowserTool::Tabs, json!({})).await.unwrap();
    assert!(tabs["tabs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|listed| listed["id"] == tab_id.as_str()));

    let page = call(BrowserTool::Read, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .contains("Sign in to Test Site"));

    // A login saved for another site is never offered here.
    vault
        .import(
            ImportSource::Chrome,
            vec![login("https://example.com".into(), "someone-else")],
        )
        .unwrap();
    let outcome = call(BrowserTool::FillLogin, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert_eq!(outcome["status"], "no_saved_login");

    vault
        .import(
            ImportSource::Chrome,
            vec![login(site.clone(), "ada@test.dev")],
        )
        .unwrap();
    let outcome = call(BrowserTool::FillLogin, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert_eq!(
        outcome,
        json!({ "status": "filled", "username": "ada@test.dev", "filled_username": true, "filled_password": true })
    );

    // The model sees the username but never the password, even once the page
    // turns the password field into a plain text field.
    let page = call(BrowserTool::Read, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert!(page.to_string().contains("ada@test.dev"));
    assert!(!page.to_string().contains(PASSWORD));
    let show = element_ref(&page, "Show password");
    call(BrowserTool::Click, json!({ "tab": tab_id, "ref": show }))
        .await
        .unwrap();
    let page = call(BrowserTool::Read, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert!(!page.to_string().contains(PASSWORD));

    // The fill never went through a function the page had replaced.
    assert!(!page.to_string().contains("INTERCEPTED"));

    // The page itself received the real password.
    let sign_in = element_ref(&page, "Sign in");
    call(BrowserTool::Click, json!({ "tab": tab_id, "ref": sign_in }))
        .await
        .unwrap();
    let page = call(BrowserTool::Read, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .contains("Signed in as ada@test.dev: password correct"));

    // Typing replaces existing text and can submit with Enter.
    let search = element_ref(&page, "Search");
    for text in ["first draft", "hello world"] {
        call(
            BrowserTool::Type,
            json!({ "tab": tab_id, "ref": search, "text": text, "submit": true }),
        )
        .await
        .unwrap();
    }
    let page = call(BrowserTool::Read, json!({ "tab": tab_id }))
        .await
        .unwrap();
    assert!(page["text"]
        .as_str()
        .unwrap()
        .contains("Searched: hello world"));

    // Stale refs and unsupported URLs are reported, not acted on.
    assert!(
        call(BrowserTool::Click, json!({ "tab": tab_id, "ref": 9999 }))
            .await
            .is_err()
    );
    assert!(
        call(BrowserTool::Open, json!({ "url": "file:///etc/passwd" }))
            .await
            .is_err()
    );
    assert!(call(BrowserTool::Read, json!({ "tab": "no-such-tab" }))
        .await
        .is_err());
}

/// A second site with its own sign-in form. It reports anything written into
/// its fields and anything passed through a replaced `apply` or `call`.
const OTHER_SITE_PAGE: &str = r#"<!doctype html><html><head><title>Other site</title></head><body>
<h1>Other site sign-in</h1>
<form><input id="user" name="username" type="email"><input id="pass" name="password" type="password"></form>
<p id="out">untouched</p>
<script>
  const out = document.getElementById("out");
  for (const id of ["user", "pass"]) {
    document.getElementById(id).addEventListener("input", (e) => { out.textContent = "RECEIVED " + e.target.value; });
  }
  for (const name of ["apply", "call"]) {
    const original = Function.prototype[name];
    Function.prototype[name] = function (...args) {
      let seen = "";
      try { seen = JSON.stringify(args); } catch (_) {}
      if (seen && (seen.includes("s3cret") || seen.includes("ada@test.dev"))) out.textContent = "INTERCEPTED";
      return Reflect.apply(original, this, args);
    };
  }
</script></body></html>"#;

/// A keychain for tests that can stop the next key read until told to go on.
#[derive(Clone, Default)]
struct GatedKeychain {
    key: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    #[allow(clippy::type_complexity)]
    gate: std::sync::Arc<
        std::sync::Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    >,
}

impl GatedKeychain {
    /// Make the next key read report that it has started, then wait for the
    /// returned sender before it continues.
    fn arm(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *self.gate.lock().unwrap() = Some((entered_tx, release_rx));
        (entered_rx, release_tx)
    }
}

impl KeyStore for GatedKeychain {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        if let Some((entered, release)) = self.gate.lock().unwrap().take() {
            let _ = entered.send(());
            let _ = release.recv_timeout(Duration::from_secs(20));
        }
        Ok(self.key.lock().unwrap().clone())
    }

    fn set(&self, key: &[u8]) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(key.to_vec());
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}

/// The tab leaves the vetted site after `fill_login` has checked its URL but
/// before the fill script runs. Nothing may reach the page it lands on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn login_is_not_filled_when_the_tab_moves_to_another_site_first() {
    let Some(chrome) = find_chrome() else {
        eprintln!("skipping: no Chromium binary found");
        return;
    };
    let (_chrome, _profile, browser) = launch_browser(chrome).await;
    let browser = std::sync::Arc::new(browser);

    let site = format!("http://127.0.0.1:{}", serve_page(LOGIN_PAGE).await);
    // A different port is a different origin.
    let other_site = format!("http://127.0.0.1:{}", serve_page(OTHER_SITE_PAGE).await);

    let vault_dir = tempfile::tempdir().unwrap();
    let keychain = GatedKeychain::default();
    let vault = std::sync::Arc::new(Vault::with_keychain(
        vault_dir.path(),
        Box::new(keychain.clone()),
    ));
    vault
        .import(
            ImportSource::Chrome,
            vec![login(site.clone(), "ada@test.dev")],
        )
        .unwrap();

    let tab = browser.open(&format!("{site}/login"), None).await.unwrap();

    // The fill vets the tab's URL and only then opens the vault, which reads
    // the key. Stopping it at that read pins it exactly where a real
    // navigation could slip in, with no timing involved.
    let (entered, release) = keychain.arm();
    let fill = tokio::spawn({
        let (browser, vault, tab_id) = (browser.clone(), vault.clone(), tab.id.clone());
        async move { browser.fill_login(&tab_id, &vault, None).await }
    });
    tokio::task::spawn_blocking(move || entered.recv_timeout(Duration::from_secs(20)))
        .await
        .unwrap()
        .expect("the fill should reach the vault after vetting the URL");

    let moved = browser.open(&other_site, Some(&tab.id)).await.unwrap();
    assert!(moved.url.starts_with(&other_site));
    release.send(()).unwrap();

    let error = fill
        .await
        .unwrap()
        .expect_err("the fill must refuse once the tab is on another site");
    assert!(error.to_string().contains("changed site"), "{error}");

    let page = browser.read(&tab.id).await.unwrap();
    let seen = serde_json::to_string(&page).unwrap();
    assert!(page.text.contains("untouched"), "{seen}");
    assert!(!seen.contains("RECEIVED"));
    assert!(!seen.contains("INTERCEPTED"));
    assert!(!seen.contains(PASSWORD));
}
