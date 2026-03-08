use anyhow::Result;
use async_trait::async_trait;
use conductor_core::types::AgentKind;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::executor::{Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use crate::process::spawn_process;

pub struct AmpExecutor {
    binary: PathBuf,
}

impl AmpExecutor {
    pub fn new(binary: PathBuf) -> Self { Self { binary } }

    pub fn discover() -> Option<Self> {
        which::which("amp").ok().map(Self::new)
    }
}

#[async_trait]
impl Executor for AmpExecutor {
    fn kind(&self) -> AgentKind { AgentKind::Amp }
    fn name(&self) -> &str { "Amp" }
    fn binary_path(&self) -> &Path { &self.binary }

    async fn is_available(&self) -> bool { self.binary.exists() }

    async fn version(&self) -> Result<String> {
        let output = Command::new(&self.binary).arg("--version").output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = spawn_process(&self.binary, &args, &options.cwd, &options.env).await?;
        Ok(ExecutorHandle::new(handle.pid, self.kind(), handle.output_rx, handle.input_tx, handle.kill_tx))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        let mut args = vec!["--non-interactive".to_string()];
        if let Some(model) = &options.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        args.extend(options.extra_args.clone());
        args.push(options.prompt.clone());
        args
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        ExecutorOutput::Stdout(line.to_string())
    }
}
