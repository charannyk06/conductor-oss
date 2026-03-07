use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::types::{EntityId, Timestamp};

/// Events emitted by the conductor system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum Event {
    // Task events
    TaskCreated { task_id: EntityId, project_id: String, title: String },
    TaskStateChanged { task_id: EntityId, old_state: String, new_state: String },
    TaskCompleted { task_id: EntityId, project_id: String },

    // Session events
    SessionSpawned { session_id: EntityId, task_id: EntityId, executor: String },
    SessionActive { session_id: EntityId },
    SessionOutput { session_id: EntityId, line: String },
    SessionNeedsInput { session_id: EntityId, prompt: String },
    SessionErrored { session_id: EntityId, error: String },
    SessionTerminated { session_id: EntityId, exit_code: Option<i32> },
    SessionRestored { session_id: EntityId },

    // Project events
    BoardChanged { project_id: String, path: String },
    ConfigChanged { path: String },

    // System events
    SystemStarted,
    SystemShutdown,
    HealthCheck { grade: String, details: String },
}

impl Event {
    pub fn timestamp(&self) -> Timestamp {
        chrono::Utc::now()
    }
}

/// Event bus for publishing and subscribing to system events.
#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<Arc<Event>>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Publish an event to all subscribers.
    pub fn publish(&self, event: Event) {
        // Ignore send errors (no subscribers).
        let _ = self.sender.send(Arc::new(event));
    }

    /// Subscribe to all events.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.sender.subscribe()
    }

    /// Get the number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_event_bus_publish_subscribe() {
        let bus = EventBus::new(16);
        let mut rx = bus.subscribe();

        bus.publish(Event::SystemStarted);

        let event = rx.recv().await.unwrap();
        assert!(matches!(*event, Event::SystemStarted));
    }

    #[tokio::test]
    async fn test_event_bus_multiple_subscribers() {
        let bus = EventBus::new(16);
        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();

        bus.publish(Event::SystemShutdown);

        assert!(matches!(*rx1.recv().await.unwrap(), Event::SystemShutdown));
        assert!(matches!(*rx2.recv().await.unwrap(), Event::SystemShutdown));
    }
}
