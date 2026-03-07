use conductor_core::config::ConductorConfig;
use conductor_core::event::EventBus;
use conductor_core::types::AgentKind;
use conductor_db::Database;
use conductor_executors::executor::Executor;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Shared application state for the HTTP server.
pub struct AppState {
    pub config: ConductorConfig,
    pub db: Database,
    pub event_bus: EventBus,
    pub executors: RwLock<HashMap<AgentKind, Arc<dyn Executor>>>,
}

impl AppState {
    pub fn new(config: ConductorConfig, db: Database, event_bus: EventBus) -> Self {
        Self {
            config,
            db,
            event_bus,
            executors: RwLock::new(HashMap::new()),
        }
    }

    /// Initialize executor discovery.
    pub async fn discover_executors(&self) {
        let discovered = conductor_executors::discover_executors().await;
        let mut executors = self.executors.write().await;
        *executors = discovered;
    }
}
