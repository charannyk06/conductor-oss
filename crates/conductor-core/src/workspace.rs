use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::config::ConductorConfig;
use crate::project::Project;

/// A Conductor workspace manages projects, sessions, and the overall state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub root: PathBuf,
    pub config_path: PathBuf,
    pub projects: Vec<Project>,
}

impl Workspace {
    /// Initialize a workspace from a root directory.
    pub fn from_path(root: &Path) -> Result<Self> {
        let config_path = root.join("conductor.yaml");

        let projects = if config_path.exists() {
            let config = ConductorConfig::load(&config_path)?;
            config
                .projects
                .into_iter()
                .map(|p| {
                    let mut project = Project::new(p.id.clone(), p.name, p.path);
                    project.board_path = p.board;
                    project.default_executor = p.executor;
                    project.max_sessions = p.max_sessions;
                    project.setup_script = p.setup_script;
                    project.cleanup_script = p.cleanup_script;
                    project
                })
                .collect()
        } else {
            Vec::new()
        };

        Ok(Self {
            root: root.to_path_buf(),
            config_path,
            projects,
        })
    }

    /// Find a project by ID.
    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    /// Find a project by ID (mutable).
    pub fn project_mut(&mut self, id: &str) -> Option<&mut Project> {
        self.projects.iter_mut().find(|p| p.id == id)
    }

    /// Get all project IDs.
    pub fn project_ids(&self) -> Vec<String> {
        self.projects.iter().map(|p| p.id.clone()).collect()
    }

    /// Data directory for conductor state.
    pub fn data_dir(&self) -> PathBuf {
        self.root.join(".conductor")
    }

    /// Database file path.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir().join("conductor.db")
    }
}
