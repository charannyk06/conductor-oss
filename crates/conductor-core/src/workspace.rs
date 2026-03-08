use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::config::ConductorConfig;
use crate::project::Project;
use crate::types::AgentKind;

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
                .map(|(id, project_config)| {
                    let name = project_config.name.clone().unwrap_or_else(|| id.clone());
                    let path = resolve_project_path(root, &project_config.path);
                    let mut project = Project::new(id.clone(), name, path.clone());
                    project.board_path = project_config.board_dir.clone().map(|board_dir| {
                        root.join("projects").join(board_dir).join("CONDUCTOR.md")
                    });
                    project.default_executor =
                        project_config.agent.as_deref().map(AgentKind::parse);
                    project.setup_script = join_script(&project_config.setup_script);
                    project.cleanup_script = join_script(&project_config.cleanup_script);
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

fn resolve_project_path(root: &Path, configured: &str) -> PathBuf {
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn join_script(lines: &[String]) -> Option<String> {
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_project_path_absolute() {
        let root = Path::new("/workspace");
        let result = resolve_project_path(root, "/opt/project");
        assert_eq!(result, PathBuf::from("/opt/project"));
    }

    #[test]
    fn test_resolve_project_path_relative() {
        let root = Path::new("/workspace");
        let result = resolve_project_path(root, "projects/my-app");
        assert_eq!(result, PathBuf::from("/workspace/projects/my-app"));
    }

    #[test]
    fn test_join_script_empty() {
        assert!(join_script(&[]).is_none());
    }

    #[test]
    fn test_join_script_multiple() {
        let lines = vec!["echo hello".to_string(), "echo world".to_string()];
        let result = join_script(&lines);
        assert_eq!(result, Some("echo hello\necho world".to_string()));
    }

    #[test]
    fn test_agent_kind_parse_via_workspace() {
        assert_eq!(AgentKind::parse("claude-code"), AgentKind::ClaudeCode);
        assert_eq!(AgentKind::parse("gemini"), AgentKind::Gemini);
        assert_eq!(
            AgentKind::parse("custom-agent"),
            AgentKind::Custom("custom-agent".to_string())
        );
    }
}
