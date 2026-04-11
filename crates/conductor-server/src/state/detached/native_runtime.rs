use anyhow::Result;
use conductor_executors::executor::{Executor, SpawnOptions};
use std::collections::HashMap;
use std::sync::Arc;

use crate::state::AppState;

use super::types::{DIRECT_RUNTIME_MODE, RUNTIME_MODE_METADATA_KEY};
use super::RuntimeLaunch;

pub(crate) async fn spawn_native_runtime(
    _state: &Arc<AppState>,
    executor: Arc<dyn Executor>,
    _session_id: &str,
    mut options: SpawnOptions,
) -> Result<RuntimeLaunch> {
    options.interactive = executor.supports_direct_terminal_ui();
    options.structured_output = false;

    let handle = executor.spawn(options).await?;
    let streams_terminal_bytes = handle.terminal_rx.is_some();

    let mut metadata = HashMap::new();
    metadata.insert(
        RUNTIME_MODE_METADATA_KEY.to_string(),
        DIRECT_RUNTIME_MODE.to_string(),
    );
    metadata.insert("terminalTransport".to_string(), "native-pty".to_string());

    Ok(RuntimeLaunch {
        handle,
        metadata,
        streams_terminal_bytes,
    })
}
