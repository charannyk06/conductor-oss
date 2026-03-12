use conductor_executors::executor::ExecutorInput;
use conductor_executors::process::PtyDimensions;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot, Notify, RwLock};

use super::types::{
    LiveSessionHandle, TerminalCaptureState, TerminalPersistenceState, TerminalRestoreSnapshot,
    TerminalStateStore, TerminalStreamEvent,
};

#[derive(Default)]
pub(crate) struct TerminalHostRegistry {
    hosts: RwLock<HashMap<String, Arc<LiveSessionHandle>>>,
    flush_notify: Notify,
}

impl TerminalHostRegistry {
    pub(crate) fn new_stream(&self) -> broadcast::Sender<TerminalStreamEvent> {
        let (sender, _) = broadcast::channel(2048);
        sender
    }

    pub(crate) async fn contains(&self, session_id: &str) -> bool {
        self.hosts.read().await.contains_key(session_id)
    }

    pub(crate) async fn get(&self, session_id: &str) -> Option<Arc<LiveSessionHandle>> {
        let handle = self.peek(session_id).await;
        if let Some(handle) = handle.as_ref() {
            Self::touch(handle).await;
        }
        handle
    }

    pub(crate) async fn peek(&self, session_id: &str) -> Option<Arc<LiveSessionHandle>> {
        self.hosts.read().await.get(session_id).cloned()
    }

    pub(crate) async fn attached_session_ids(&self) -> Vec<String> {
        let hosts = self
            .hosts
            .read()
            .await
            .iter()
            .map(|(session_id, handle)| (session_id.clone(), handle.clone()))
            .collect::<Vec<_>>();
        let mut attached = Vec::with_capacity(hosts.len());
        for (session_id, handle) in hosts {
            if handle.input_tx.read().await.is_some() {
                attached.push(session_id);
            }
        }
        attached
    }

    pub(crate) async fn remove(&self, session_id: &str) -> Option<Arc<LiveSessionHandle>> {
        self.hosts.write().await.remove(session_id)
    }

    pub(crate) async fn remove_if_same(
        &self,
        session_id: &str,
        expected: &Arc<LiveSessionHandle>,
    ) -> bool {
        let mut hosts = self.hosts.write().await;
        match hosts.get(session_id) {
            Some(current) if Arc::ptr_eq(current, expected) => {
                hosts.remove(session_id);
                true
            }
            _ => false,
        }
    }

    pub(crate) async fn ensure_host(
        &self,
        session_id: &str,
        persisted_snapshot: Option<&TerminalRestoreSnapshot>,
    ) -> Arc<LiveSessionHandle> {
        if let Some(handle) = self.hosts.read().await.get(session_id).cloned() {
            Self::touch(&handle).await;
            return handle;
        }

        let mut hosts = self.hosts.write().await;
        if let Some(handle) = hosts.get(session_id).cloned() {
            drop(hosts);
            Self::touch(&handle).await;
            return handle;
        }

        let mut terminal_store = TerminalStateStore::new();
        let mut terminal_persistence = TerminalPersistenceState::default();
        if let Some(snapshot) = persisted_snapshot {
            terminal_store.hydrate_from_snapshot(snapshot);
            terminal_persistence.last_persisted_sequence = snapshot.sequence;
            terminal_persistence.last_persisted_at = Some(Instant::now());
        }

        let handle = Arc::new(LiveSessionHandle {
            input_tx: RwLock::new(None),
            resize_tx: RwLock::new(None),
            terminal_tx: self.new_stream(),
            terminal_store: Arc::new(std::sync::Mutex::new(terminal_store)),
            terminal_persistence: tokio::sync::Mutex::new(terminal_persistence),
            terminal_capture: tokio::sync::Mutex::new(TerminalCaptureState::default()),
            kill_tx: tokio::sync::Mutex::new(None),
        });
        hosts.insert(session_id.to_string(), handle.clone());
        handle
    }

    pub(crate) async fn attach_runtime(
        &self,
        handle: &Arc<LiveSessionHandle>,
        input_tx: mpsc::Sender<ExecutorInput>,
        resize_tx: Option<mpsc::Sender<PtyDimensions>>,
        kill_tx: oneshot::Sender<()>,
    ) {
        *handle.input_tx.write().await = Some(input_tx);
        *handle.resize_tx.write().await = resize_tx;
        *handle.kill_tx.lock().await = Some(kill_tx);
        let mut tracking = handle.terminal_persistence.lock().await;
        tracking.last_touched_at = Instant::now();
        tracking.last_detached_at = None;
    }

    pub(crate) async fn detach_runtime(&self, handle: &Arc<LiveSessionHandle>) {
        *handle.input_tx.write().await = None;
        *handle.resize_tx.write().await = None;
        let _ = handle.kill_tx.lock().await.take();
        let mut tracking = handle.terminal_persistence.lock().await;
        let now = Instant::now();
        tracking.last_touched_at = now;
        tracking.last_detached_at = Some(now);
    }

    pub(crate) async fn runtime_attached(&self, session_id: &str) -> bool {
        let Some(handle) = self.hosts.read().await.get(session_id).cloned() else {
            return false;
        };
        let attached = handle.input_tx.read().await.is_some();
        if attached {
            Self::touch(&handle).await;
        }
        attached
    }

    pub(crate) async fn dirty_hosts(&self) -> Vec<(String, Arc<LiveSessionHandle>)> {
        let hosts = self
            .hosts
            .read()
            .await
            .iter()
            .map(|(session_id, handle)| (session_id.clone(), handle.clone()))
            .collect::<Vec<_>>();
        let mut dirty = Vec::new();
        for (session_id, handle) in hosts {
            if handle.terminal_persistence.lock().await.dirty {
                dirty.push((session_id, handle));
            }
        }
        dirty
    }

    pub(crate) async fn dirty_capture_hosts(&self) -> Vec<(String, Arc<LiveSessionHandle>)> {
        let hosts = self
            .hosts
            .read()
            .await
            .iter()
            .map(|(session_id, handle)| (session_id.clone(), handle.clone()))
            .collect::<Vec<_>>();
        let mut dirty = Vec::new();
        for (session_id, handle) in hosts {
            if handle.terminal_capture.lock().await.dirty {
                dirty.push((session_id, handle));
            }
        }
        dirty
    }

    pub(crate) async fn idle_eviction_candidates(
        &self,
        idle_ttl: Duration,
    ) -> Vec<(String, Arc<LiveSessionHandle>)> {
        let hosts = self
            .hosts
            .read()
            .await
            .iter()
            .map(|(session_id, handle)| (session_id.clone(), handle.clone()))
            .collect::<Vec<_>>();
        let mut candidates = Vec::new();
        for (session_id, handle) in hosts {
            if Self::should_evict(&handle, idle_ttl).await {
                candidates.push((session_id, handle));
            }
        }
        candidates
    }

    pub(crate) fn request_flush(&self) {
        self.flush_notify.notify_one();
    }

    pub(crate) async fn wait_for_flush_request(&self) {
        self.flush_notify.notified().await;
    }

    pub(crate) async fn touch(handle: &Arc<LiveSessionHandle>) {
        let mut tracking = handle.terminal_persistence.lock().await;
        tracking.last_touched_at = Instant::now();
    }

    async fn should_evict(handle: &Arc<LiveSessionHandle>, idle_ttl: Duration) -> bool {
        if handle.input_tx.read().await.is_some() {
            return false;
        }
        if handle.terminal_tx.receiver_count() > 0 {
            return false;
        }

        let tracking = handle.terminal_persistence.lock().await;
        if tracking.dirty || tracking.last_touched_at.elapsed() < idle_ttl {
            return false;
        }
        let detached_idle = tracking
            .last_detached_at
            .map(|detached_at| detached_at.elapsed() >= idle_ttl)
            .unwrap_or(true);
        drop(tracking);

        if handle.terminal_capture.lock().await.dirty {
            return false;
        }

        detached_idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registry_tracks_attached_and_idle_hosts() {
        let registry = TerminalHostRegistry::default();
        let handle = registry.ensure_host("session-1", None).await;

        assert!(registry.attached_session_ids().await.is_empty());

        let (input_tx, _input_rx) = mpsc::channel::<ExecutorInput>(1);
        let (kill_tx, _kill_rx) = oneshot::channel();
        registry.attach_runtime(&handle, input_tx, None, kill_tx).await;

        assert_eq!(
            registry.attached_session_ids().await,
            vec!["session-1".to_string()]
        );

        registry.detach_runtime(&handle).await;
        {
            let mut tracking = handle.terminal_persistence.lock().await;
            tracking.last_touched_at = Instant::now() - Duration::from_secs(90);
            tracking.last_detached_at = Some(Instant::now() - Duration::from_secs(90));
        }

        assert!(registry.attached_session_ids().await.is_empty());
        assert_eq!(
            registry
                .idle_eviction_candidates(Duration::from_secs(30))
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn registry_reports_dirty_hosts() {
        let registry = TerminalHostRegistry::default();
        let handle = registry.ensure_host("session-1", None).await;
        handle.terminal_persistence.lock().await.dirty = true;

        let dirty = registry.dirty_hosts().await;
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].0, "session-1");
    }
}
