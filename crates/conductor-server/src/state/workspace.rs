use anyhow::Result;
use conductor_core::config::ProjectConfig;
use std::fs::create_dir_all;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use super::AppState;

impl AppState {
    pub(crate) fn resolve_project_path(&self, project: &ProjectConfig) -> PathBuf {
        expand_path(&project.path, &self.workspace_path)
    }

    pub(crate) fn resolve_worktree_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.worktree_root().join(project_id).join(session_id)
    }

    pub(crate) async fn prepare_workspace(
        &self,
        project_id: &str,
        project: &ProjectConfig,
        use_worktree: bool,
        branch: Option<&str>,
        base_branch: Option<&str>,
    ) -> Result<PathBuf> {
        let repo_path = self.resolve_project_path(project);
        let git_dir = repo_path.join(".git");
        if !use_worktree || !git_dir.exists() {
            return Ok(resolve_default_working_directory(&repo_path, project.default_working_directory.as_deref()));
        }

        let worktree_path = self.resolve_worktree_path(project_id, branch.unwrap_or("default"));
        if worktree_path.exists() {
            return Ok(resolve_default_working_directory(&worktree_path, project.default_working_directory.as_deref()));
        }
        if let Some(parent) = worktree_path.parent() {
            create_dir_all(parent)?;
        }

        let session_branch = branch.unwrap_or("session");
        let base_ref = base_branch
            .or_else(|| Some(project.default_branch.as_str()))
            .unwrap_or("HEAD");

        let add_result = Command::new("git")
            .args([
                "-C",
                repo_path.to_string_lossy().as_ref(),
                "worktree",
                "add",
                "-b",
                session_branch,
                worktree_path.to_string_lossy().as_ref(),
                base_ref,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;

        if add_result.is_err() || !add_result.unwrap().success() {
            return Ok(resolve_default_working_directory(&repo_path, project.default_working_directory.as_deref()));
        }

        Ok(resolve_default_working_directory(
            &worktree_path,
            project.default_working_directory.as_deref(),
        ))
    }
}

pub fn resolve_workspace_path(config_path: &Path, configured_workspace: &Path) -> PathBuf {
    let base = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let candidate = if configured_workspace.as_os_str().is_empty() {
        base
    } else if configured_workspace.is_absolute() {
        configured_workspace.to_path_buf()
    } else {
        base.join(configured_workspace)
    };

    std::fs::canonicalize(&candidate).unwrap_or(candidate)
}

pub fn expand_path(value: &str, workspace_path: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            return home.join(stripped);
        }
    }
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_path.join(candidate)
    }
}

fn resolve_default_working_directory(root: &Path, relative: Option<&str>) -> PathBuf {
    let Some(path) = relative else { return root.to_path_buf(); };
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." {
        return root.to_path_buf();
    }
    root.join(trimmed)
}
