use anyhow::{bail, Result};
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
    if !executor.supports_direct_terminal_ui() {
        bail!("executor does not support native PTY sessions");
    }
    options.interactive = true;
    options.structured_output = false;

    let handle = executor.spawn(options).await?;
    let streams_terminal_bytes = handle.terminal_rx.is_some();
    if !streams_terminal_bytes {
        bail!("executor started native runtime without a terminal byte stream");
    }

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
