use anyhow::{Context, Result};
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::executor::{Executor, ExecutorHandle, ExecutorInput, ExecutorOutput, SpawnOptions};

/// OpenClaw executor that connects to an OpenClaw gateway via WebSocket
/// and streams chat events back as ExecutorOutput.
pub struct OpenClawExecutor {
    gateway_url: String,
}

impl OpenClawExecutor {
    pub fn discover() -> Option<Self> {
        let gateway_url = std::env::var("OPENCLAW_GATEWAY_URL")
            .unwrap_or_else(|_| "ws://127.0.0.1:18789".to_string());
        Some(Self { gateway_url })
    }

    async fn connect_gateway(
        &self,
    ) -> Result<(
        mpsc::Sender<ExecutorInput>,
        mpsc::Receiver<ExecutorOutput>,
        oneshot::Sender<()>,
    )> {
        let url = format!("{}/ws", self.gateway_url.trim_end_matches('/'));

        let mut request = url
            .parse::<tokio_tungstenite::tungstenite::http::Uri>()
            .context("Invalid WebSocket URL")?;
        let host = request.host().unwrap_or("127.0.0.1");
        let _port = request.port_u16().unwrap_or(18789);

        let (ws_stream, _) = connect_async(&url)
            .await
            .with_context(|| format!("Failed to connect to OpenClaw gateway at {url}"))?;

        let (mut ws_write, mut ws_read) = ws_stream.split();
        let (output_tx, output_rx) = mpsc::channel::<ExecutorOutput>(1024);
        let (input_tx, mut input_rx) = mpsc::channel::<ExecutorInput>(64);
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

        // WebSocket reader: convert OpenClaw chat events to ExecutorOutput
        let output_tx_clone = output_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = ws_read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(event) = serde_json::from_str::<Value>(&text) {
                                    let outputs = convert_ws_event(&event);
                                    for output in outputs {
                                        if output_tx_clone.send(output).await.is_err() {
                                            return;
                                        }
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let _ = output_tx_clone.send(ExecutorOutput::Completed { exit_code: 0 }).await;
                                return;
                            }
                            _ => {}
                        }
                    }
                    _ = &mut kill_rx => {
                        return;
                    }
                }
            }
        });

        // WebSocket writer: forward input to OpenClaw
        tokio::spawn(async move {
            while let Some(input) = input_rx.recv().await {
                match input {
                    ExecutorInput::Text(text) => {
                        let chat_send = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": format!("conductor-{}", uuid::Uuid::new_v4()),
                            "method": "chat.send",
                            "params": {
                                "message": text,
                            }
                        });
                        let _ = ws_write
                            .send(Message::Text(chat_send.to_string().into()))
                            .await;
                    }
                    ExecutorInput::Raw(raw) => {
                        let _ = ws_write.send(Message::Text(raw.into())).await;
                    }
                }
            }
        });

        Ok((input_tx, output_rx, kill_tx))
    }
}

fn convert_ws_event(event: &Value) -> Vec<ExecutorOutput> {
    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let method = event.get("method").and_then(|v| v.as_str()).unwrap_or("");

    match (method, event_type) {
        // Chat delta events from OpenClaw
        ("chat", "delta") => {
            let data = event.get("data");
            if let Some(text) = data.and_then(|d| d.get("text")).and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    return vec![ExecutorOutput::Stdout(text.to_string())];
                }
            }
            // Tool call start
            if let Some(tool_name) = data
                .and_then(|d| d.get("toolName"))
                .and_then(|v| v.as_str())
            {
                return vec![ExecutorOutput::StructuredStatus {
                    text: format!("Tool call: {tool_name}"),
                    metadata: HashMap::from([
                        (
                            "kind".to_string(),
                            Value::String("tool_call_start".to_string()),
                        ),
                        ("toolName".to_string(), Value::String(tool_name.to_string())),
                    ]),
                }];
            }
            // Tool result
            if let Some(result_text) = data
                .and_then(|d| d.get("resultText"))
                .and_then(|v| v.as_str())
            {
                return vec![ExecutorOutput::StructuredStatus {
                    text: result_text.to_string(),
                    metadata: HashMap::from([(
                        "kind".to_string(),
                        Value::String("tool_result".to_string()),
                    )]),
                }];
            }
            // Reasoning / thinking
            if let Some(reasoning) = data
                .and_then(|d| d.get("reasoning"))
                .and_then(|v| v.as_str())
            {
                if !reasoning.is_empty() {
                    return vec![ExecutorOutput::StructuredStatus {
                        text: format!("Thinking: {reasoning}"),
                        metadata: HashMap::from([(
                            "kind".to_string(),
                            Value::String("reasoning".to_string()),
                        )]),
                    }];
                }
            }
            vec![]
        }

        // Chat completed
        ("chat", "completed") => {
            vec![ExecutorOutput::Completed { exit_code: 0 }]
        }

        // Chat error
        ("chat", "error") => {
            let error = event
                .get("data")
                .and_then(|d| d.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown OpenClaw error");
            vec![ExecutorOutput::Failed {
                error: error.to_string(),
                exit_code: Some(1),
            }]
        }

        _ => vec![],
    }
}

#[async_trait]
impl Executor for OpenClawExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenClaw
    }

    fn name(&self) -> &str {
        "OpenClaw"
    }

    fn binary_path(&self) -> &Path {
        Path::new("openclaw")
    }

    async fn is_available(&self) -> bool {
        // Check if the gateway URL is reachable
        let url = format!("{}/api/health", self.gateway_url.trim_end_matches('/'));
        match reqwest::get(&url).await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    async fn version(&self) -> Result<String> {
        Ok("openclaw-gateway".to_string())
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let (input_tx, output_rx, kill_tx) = self.connect_gateway().await?;

        // Send the initial prompt as the first chat message
        let _ = input_tx.send(ExecutorInput::Text(options.prompt)).await;

        Ok(ExecutorHandle::new(
            0, // no PID for WebSocket
            AgentKind::OpenClaw,
            output_rx,
            input_tx,
            kill_tx,
        ))
    }

    fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
        vec![] // OpenClaw doesn't use CLI args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        // OpenClaw output is already structured via WS events,
        // but handle plain text lines as fallback
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            let outputs = convert_ws_event(&event);
            if outputs.len() == 1 {
                return outputs.into_iter().next().unwrap();
            }
            if !outputs.is_empty() {
                return ExecutorOutput::Composite(outputs);
            }
        }
        ExecutorOutput::Stdout(line.to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        false // OpenClaw runs over WebSocket, not PTY
    }
}
