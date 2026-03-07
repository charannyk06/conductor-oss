pub mod discovery;
pub mod executor;
pub mod process;

pub mod agents;

pub use discovery::discover_executors;
pub use executor::{Executor, ExecutorHandle, SpawnOptions};
