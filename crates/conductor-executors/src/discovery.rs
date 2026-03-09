use conductor_core::types::AgentKind;
use std::collections::HashMap;
use std::sync::Arc;

use crate::agents::*;
use crate::executor::Executor;

/// Discover all available agent executors on the system.
pub async fn discover_executors() -> HashMap<AgentKind, Arc<dyn Executor>> {
    let mut executors: HashMap<AgentKind, Arc<dyn Executor>> = HashMap::new();

    // Macro to reduce boilerplate.
    macro_rules! try_discover {
        ($executor:expr, $kind:expr) => {
            if let Some(exec) = $executor {
                if exec.is_available().await {
                    tracing::info!("Discovered {}", exec.name());
                    executors.insert($kind, Arc::new(exec));
                }
            }
        };
    }

    try_discover!(ClaudeCodeExecutor::discover(), AgentKind::ClaudeCode);
    try_discover!(CodexExecutor::discover(), AgentKind::Codex);
    try_discover!(GeminiExecutor::discover(), AgentKind::Gemini);
    try_discover!(AmpExecutor::discover(), AgentKind::Amp);
    try_discover!(CursorExecutor::discover(), AgentKind::CursorCli);
    try_discover!(OpenCodeExecutor::discover(), AgentKind::OpenCode);
    try_discover!(DroidExecutor::discover(), AgentKind::Droid);
    try_discover!(QwenCodeExecutor::discover(), AgentKind::QwenCode);
    try_discover!(CcrExecutor::discover(), AgentKind::Ccr);
    try_discover!(CopilotExecutor::discover(), AgentKind::GithubCopilot);

    if executors.is_empty() {
        tracing::warn!("No agent executors found. Install at least one CLI: claude, codex, gemini, amp, cursor, opencode, droid, qwen, ccr, copilot");
    } else {
        tracing::info!(
            "Found {} executor(s): {}",
            executors.len(),
            executors
                .keys()
                .map(|k| k.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    executors
}
