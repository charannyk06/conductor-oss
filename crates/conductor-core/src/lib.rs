pub mod board;
pub mod config;
pub mod dispatcher;
pub mod error;
pub mod event;
pub mod paths;
pub mod project;
pub mod scaffold;
pub mod session;
pub mod support;
pub mod task;
pub mod types;
pub mod workspace;

pub use board::Board;
pub use config::ConductorConfig;
pub use dispatcher::{Dispatcher, DispatcherConfig, SpawnLimiter};
pub use event::{Event, EventBus};
pub use project::Project;
pub use scaffold::{
    build_conductor_board, build_conductor_yaml, build_project_config, resolve_scaffold_project,
    scaffold_workspace, ConductorYamlScaffoldConfig, ResolvedScaffoldProject, ScaffoldAccessConfig,
    ScaffoldNotificationPreferences, ScaffoldPreferencesConfig, ScaffoldProjectConfig,
    ScaffoldTrustedHeadersConfig, ScaffoldWorkspaceOptions, ScaffoldWorkspaceResult,
};
pub use session::{Session, SessionState};
pub use support::{
    resolve_project_path, startup_config_sync, sync_project_local_config,
    sync_support_files_for_directory, sync_workspace_support_files, ConfigSyncResult,
    GENERATED_MARKER_KEY,
};
pub use task::{Task, TaskState};
pub use workspace::Workspace;
