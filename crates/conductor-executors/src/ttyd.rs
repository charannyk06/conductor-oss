use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

const DEFAULT_TTYD_PORT: u16 = 7681;

#[derive(Debug, Clone)]
pub struct TtydConfig {
    pub port: u16,
    pub writable: bool,
    pub credential: Option<String>,
    pub ssl: bool,
    pub ssl_cert: Option<PathBuf>,
    pub ssl_key: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
    pub terminal_type: String,
    pub max_clients: u32,
}

impl Default for TtydConfig {
    fn default() -> Self {
        Self {
            port: 0,
            writable: true,
            credential: None,
            ssl: false,
            ssl_cert: None,
            ssl_key: None,
            cols: 120,
            rows: 32,
            terminal_type: "xterm-256color".to_string(),
            max_clients: 0,
        }
    }
}

pub struct TtydProcess {
    pub session_id: String,
    pub ws_url: String,
    pub http_url: String,
    config: TtydConfig,
    child: Option<Child>,
    output_tx: Option<mpsc::Sender<String>>,
}

impl TtydProcess {
    pub async fn new(
        session_id: String,
        command: &[String],
        cwd: &std::path::Path,
        env: &HashMap<String, String>,
        config: TtydConfig,
    ) -> Result<Self> {
        let ttyd_path = find_ttyd().context("ttyd not found")?;

        let port = if config.port == 0 {
            find_available_port().await?
        } else {
            config.port
        };

        let ws_url = format!("ws://127.0.0.1:{}/", port);
        let http_url = format!("http://127.0.0.1:{}", port);

        let mut cmd = Command::new(&ttyd_path);
        cmd.arg("-p").arg(port.to_string());

        if config.writable {
            cmd.arg("-W");
        }

        if let Some(ref cred) = config.credential {
            cmd.arg("-c").arg(cred);
        }

        if config.ssl {
            cmd.arg("-S");
            if let Some(ref cert) = config.ssl_cert {
                cmd.arg("-C").arg(cert);
            }
            if let Some(ref key) = config.ssl_key {
                cmd.arg("-K").arg(key);
            }
        }

        cmd.arg("-t").arg(format!("cols={}", config.cols));
        cmd.arg("-t").arg(format!("rows={}", config.rows));
        cmd.arg("-T").arg(&config.terminal_type);

        if config.max_clients > 0 {
            cmd.arg("-m").arg(config.max_clients.to_string());
        }

        cmd.arg("-w").arg(cwd);

        for (key, value) in env {
            cmd.env(key, value);
        }

        cmd.arg("--");
        cmd.args(command);

        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().context("Failed to spawn ttyd")?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (output_tx, _output_rx) = mpsc::channel::<String>(100);

        if let Some(stdout) = stdout {
            let tx = output_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(line).await;
                }
            });
        }

        if let Some(stderr) = stderr {
            let tx = output_tx.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = tx.send(format!("[stderr] {}", line)).await;
                }
            });
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(anyhow!("ttyd exited with status: {}", status));
            }
        }

        Ok(Self {
            session_id,
            ws_url,
            http_url,
            config,
            child: Some(child),
            output_tx: Some(output_tx),
        })
    }

    pub async fn kill(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            child.kill().await?;
        }
        Ok(())
    }

    pub fn subscribe_output(&self) -> Option<mpsc::Sender<String>> {
        self.output_tx.clone()
    }
}

pub fn find_ttyd() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("TTYD_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    let possible_paths = vec![
        PathBuf::from("/usr/local/bin/ttyd"),
        PathBuf::from("/opt/homebrew/bin/ttyd"),
        PathBuf::from("/usr/bin/ttyd"),
        PathBuf::from("/opt/homebrew/Cellar/ttyd/1.7.7/bin/ttyd"),
    ];

    for path in &possible_paths {
        if path.exists() {
            return Ok(path.clone());
        }
    }

    which::which("ttyd").map_err(|_| anyhow!("ttyd not found in PATH"))
}

async fn find_available_port() -> Result<u16> {
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_ttyd() {
        let result = find_ttyd();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_spawn_ttyd_with_shell() {
        let config = TtydConfig::default();
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), std::env::var("HOME").unwrap());

        let result = TtydProcess::new(
            "test-session".to_string(),
            &["bash".to_string(), "-c".to_string(), "echo hello".to_string()],
            std::path::Path::new("."),
            &env,
            config,
        ).await;

        if let Ok(mut process) = result {
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
            let _ = process.kill().await;
        }
    }
}
