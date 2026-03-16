pub mod discovery;
pub mod executor;
pub mod process;
pub mod prompt;

pub mod agents;
pub mod pty_subprocess;
pub mod ttyd;

pub use discovery::discover_executors;
pub use executor::{Executor, ExecutorHandle, SpawnOptions};
pub use prompt::{
    build_prompt, PromptAttachment, PromptAttachmentKind, PromptBuildConfig, PromptProjectConfig,
    PromptReactionConfig, PromptTrackerConfig, BASE_AGENT_PROMPT,
};
pub use ttyd::{find_ttyd, TtydConfig, TtydProcess};
