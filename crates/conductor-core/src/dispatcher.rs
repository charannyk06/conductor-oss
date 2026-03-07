//! Task dispatcher: watches for ready tasks and assigns them to agents.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

use crate::board::Board;
use crate::event::EventBus;
use crate::types::AgentKind;

/// Configuration for the dispatcher.
#[derive(Debug, Clone)]
pub struct DispatcherConfig {
    /// Maximum global concurrent sessions.
    pub max_global_sessions: usize,
    /// Maximum sessions per project.
    pub max_project_sessions: usize,
    /// Default agent to use when not specified.
    pub default_agent: AgentKind,
    /// Auto-dispatch: automatically spawn agents for Ready tasks.
    pub auto_dispatch: bool,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            max_global_sessions: 5,
            max_project_sessions: 2,
            default_agent: AgentKind::ClaudeCode,
            auto_dispatch: true,
        }
    }
}

#[derive(Debug, Default)]
struct LimiterState {
    global_active: usize,
    project_active: HashMap<String, usize>,
}

/// Tracks active sessions for concurrency limiting.
#[derive(Debug, Clone)]
pub struct SpawnLimiter {
    state: Arc<Mutex<LimiterState>>,
    config: DispatcherConfig,
}

impl SpawnLimiter {
    pub fn new(config: DispatcherConfig) -> Self {
        Self {
            state: Arc::new(Mutex::new(LimiterState::default())),
            config,
        }
    }

    /// Check if we can spawn a new session globally and for this project.
    /// NOTE: This is a non-reserving check. Use `acquire()` for atomic check-and-reserve.
    #[cfg(test)]
    pub(crate) async fn can_spawn(&self, project_id: &str) -> bool {
        let state = self.state.lock().await;
        let project = state.project_active.get(project_id).copied().unwrap_or(0);
        state.global_active < self.config.max_global_sessions
            && project < self.config.max_project_sessions
    }

    /// Atomically check limits and reserve a slot for a new session.
    pub async fn acquire(&self, project_id: &str) -> bool {
        let mut state = self.state.lock().await;
        let project = state.project_active.get(project_id).copied().unwrap_or(0);
        if state.global_active >= self.config.max_global_sessions
            || project >= self.config.max_project_sessions
        {
            return false;
        }
        state.global_active += 1;
        *state.project_active.entry(project_id.to_string()).or_insert(0) += 1;
        true
    }

    /// Release a session slot.
    pub async fn release(&self, project_id: &str) {
        let mut state = self.state.lock().await;
        state.global_active = state.global_active.saturating_sub(1);
        if let Some(count) = state.project_active.get_mut(project_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.project_active.remove(project_id);
            }
        }
    }

    /// Get current global active count.
    pub async fn global_count(&self) -> usize {
        self.state.lock().await.global_active
    }

    /// Get active count for a project.
    pub async fn project_count(&self, project_id: &str) -> usize {
        self.state
            .lock()
            .await
            .project_active
            .get(project_id)
            .copied()
            .unwrap_or(0)
    }
}

/// A dispatch request queued for execution.
#[derive(Debug, Clone)]
pub struct DispatchRequest {
    pub project_id: String,
    pub card_title: String,
    pub prompt: String,
    pub agent: AgentKind,
    pub model: Option<String>,
    pub branch: Option<String>,
}

/// The dispatcher picks up tasks from board changes and spawns agents.
pub struct Dispatcher {
    pub config: DispatcherConfig,
    pub limiter: SpawnLimiter,
    pub event_bus: EventBus,
    queue: Arc<RwLock<Vec<DispatchRequest>>>,
}

impl Dispatcher {
    pub fn new(config: DispatcherConfig, event_bus: EventBus) -> Self {
        let limiter = SpawnLimiter::new(config.clone());
        Self {
            config,
            limiter,
            event_bus,
            queue: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Process a board change: extract new Ready cards and queue them for dispatch.
    pub async fn process_board_change(&self, project_id: &str, board: &Board) {
        if !self.config.auto_dispatch {
            return;
        }

        let ready_cards = board.dispatchable_cards();
        tracing::info!(
            "Board change for {project_id}: {} dispatchable card(s)",
            ready_cards.len()
        );

        for card in ready_cards {
            let agent = card
                .tags
                .iter()
                .find_map(|tag| parse_agent_tag(tag))
                .unwrap_or(self.config.default_agent.clone());

            let model = card
                .metadata
                .get("model")
                .cloned();

            let request = DispatchRequest {
                project_id: project_id.to_string(),
                card_title: card.title.clone(),
                prompt: card.title.clone(),
                agent,
                model,
                branch: None,
            };

            self.enqueue(request).await;
        }
    }

    /// Add a dispatch request to the queue.
    pub async fn enqueue(&self, request: DispatchRequest) {
        tracing::info!(
            "Queuing dispatch: {} -> {} ({})",
            request.project_id,
            request.card_title,
            request.agent
        );
        self.queue.write().await.push(request);
    }

    /// Drain the queue and return requests that can be spawned.
    /// Holds the queue write lock for the entire operation and uses acquire()
    /// to atomically reserve slots, avoiding TOCTOU races.
    pub async fn drain_ready(&self) -> Vec<DispatchRequest> {
        let mut queue = self.queue.write().await;
        let pending = queue.drain(..).collect::<Vec<_>>();

        let mut ready = Vec::new();
        let mut remaining = Vec::new();

        for request in pending {
            if self.limiter.acquire(&request.project_id).await {
                ready.push(request);
            } else {
                remaining.push(request);
            }
        }

        if !remaining.is_empty() {
            *queue = remaining;
        }

        ready
    }

    /// Get the current queue length.
    pub async fn queue_len(&self) -> usize {
        self.queue.read().await.len()
    }
}

/// Parse agent tags like @claude, @codex, @gemini.
fn parse_agent_tag(tag: &str) -> Option<AgentKind> {
    match tag.to_lowercase().as_str() {
        "claude" | "claude-code" => Some(AgentKind::ClaudeCode),
        "codex" => Some(AgentKind::Codex),
        "gemini" => Some(AgentKind::Gemini),
        "amp" => Some(AgentKind::Amp),
        "cursor" | "cursor-cli" => Some(AgentKind::CursorCli),
        "opencode" => Some(AgentKind::OpenCode),
        "droid" => Some(AgentKind::Droid),
        "qwen" | "qwen-code" => Some(AgentKind::QwenCode),
        "ccr" => Some(AgentKind::Ccr),
        "copilot" | "github-copilot" => Some(AgentKind::GithubCopilot),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_limiter() {
        let config = DispatcherConfig {
            max_global_sessions: 3,
            max_project_sessions: 2,
            ..Default::default()
        };
        let limiter = SpawnLimiter::new(config);

        assert!(limiter.can_spawn("proj-a").await);
        assert!(limiter.acquire("proj-a").await);
        assert!(limiter.acquire("proj-a").await);
        // Project limit reached.
        assert!(!limiter.can_spawn("proj-a").await);
        // But different project is fine.
        assert!(limiter.can_spawn("proj-b").await);
        assert!(limiter.acquire("proj-b").await);
        // Global limit reached (3).
        assert!(!limiter.can_spawn("proj-c").await);

        // Release one.
        limiter.release("proj-a").await;
        assert!(limiter.can_spawn("proj-a").await);
        assert!(limiter.can_spawn("proj-c").await);
    }

    #[tokio::test]
    async fn test_dispatcher_queue() {
        let config = DispatcherConfig::default();
        let event_bus = EventBus::new(16);
        let dispatcher = Dispatcher::new(config, event_bus);

        let request = DispatchRequest {
            project_id: "test".to_string(),
            card_title: "Build auth".to_string(),
            prompt: "Build auth".to_string(),
            agent: AgentKind::ClaudeCode,
            model: None,
            branch: None,
        };

        dispatcher.enqueue(request).await;
        assert_eq!(dispatcher.queue_len().await, 1);

        let ready = dispatcher.drain_ready().await;
        assert_eq!(ready.len(), 1);
        assert_eq!(dispatcher.queue_len().await, 0);
    }

    #[test]
    fn test_parse_agent_tag() {
        assert_eq!(parse_agent_tag("claude"), Some(AgentKind::ClaudeCode));
        assert_eq!(parse_agent_tag("codex"), Some(AgentKind::Codex));
        assert_eq!(parse_agent_tag("unknown"), None);
    }
}
