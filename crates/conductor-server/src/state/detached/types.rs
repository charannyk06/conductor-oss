pub(crate) const DIRECT_RUNTIME_MODE: &str = "direct";
/// Legacy value retained only so stale session records can still be normalized.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const TTYD_RUNTIME_MODE: &str = "ttyd";
pub(crate) const RUNTIME_MODE_METADATA_KEY: &str = "runtimeMode";
pub(crate) const DETACHED_PID_METADATA_KEY: &str = "detachedPid";
pub(crate) const DETACHED_LOG_PATH_METADATA_KEY: &str = "detachedLogPath";
/// Legacy terminal metadata keys retained so stale session cleanup and migration helpers keep compiling.
pub(crate) const TTYD_PORT_METADATA_KEY: &str = "ttydPort";
pub(crate) const TTYD_WS_URL_METADATA_KEY: &str = "ttydWsUrl";
pub(crate) const TTYD_PID_METADATA_KEY: &str = "ttydPid";
