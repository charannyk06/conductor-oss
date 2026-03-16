//! Spawn and manage ttyd processes for raw PTY WebSocket streaming.

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};

/// Find the ttyd binary on the system.
pub fn find_ttyd() -> Result<std::path::PathBuf> {
    for path in [
        "/opt/homebrew/bin/ttyd",
        "/usr/local/bin/ttyd",
        "/usr/bin/ttyd",
    ] {
        let p = std::path::PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }
    which::which("ttyd").map_err(|_| anyhow!("ttyd not found in PATH"))
}

pub struct TtydSession {
    pub ws_url: String,
    pub http_url: String,
    pub port: u16,
    child: Child,
}

impl TtydSession {
    /// Spawn ttyd wrapping the given command in a working directory.
    pub async fn spawn(
        command: &[String],
        cwd: &Path,
        env: &HashMap<String, String>,
    ) -> Result<Self> {
        let ttyd = find_ttyd()?;
        let port = allocate_port()?;

        let mut cmd = Command::new(&ttyd);
        cmd.arg("-W")                          // writable
           .arg("-p").arg(port.to_string())     // port
           .arg("-t").arg("fontSize=14")
           .arg("-t").arg("fontFamily=JetBrains Mono,monospace")
           .arg("-T").arg("xterm-256color")
           .arg("-w").arg(cwd)                  // working dir
           .arg("--")
           .args(command);

        for (k, v) in env {
            cmd.env(k, v);
        }
        // Ensure PTY gets full terminal capabilities
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        let child = cmd.spawn().context("Failed to spawn ttyd")?;

        // Give ttyd a moment to bind the port
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

        Ok(Self {
            ws_url: format!("ws://127.0.0.1:{}/ws", port),
            http_url: format!("http://127.0.0.1:{}", port),
            port,
            child,
        })
    }

    pub async fn kill(&mut self) -> Result<()> {
        self.child.kill().await.context("Failed to kill ttyd")
    }
}

fn allocate_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}
