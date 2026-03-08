use anyhow::{anyhow, Result};
use conductor_core::config::ProjectConfig;
use std::fs::create_dir_all;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

use super::AppState;

/// Validate a git ref name to prevent argument injection.
/// Rejects names starting with `-` and allows only safe characters.
fn is_safe_git_ref(name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
}

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
        session_id: &str,
        project: &ProjectConfig,
        use_worktree: bool,
        branch: Option<&str>,
        base_branch: Option<&str>,
    ) -> Result<PathBuf> {
        let repo_path = self.resolve_project_path(project);
        let git_dir = repo_path.join(".git");
        if !use_worktree || !git_dir.exists() {
            return Ok(resolve_default_working_directory(
                &repo_path,
                project.default_working_directory.as_deref(),
            ));
        }

        let worktree_path = self.resolve_worktree_path(project_id, session_id);
        if worktree_path.exists() {
            return Ok(resolve_default_working_directory(
                &worktree_path,
                project.default_working_directory.as_deref(),
            ));
        }
        if let Some(parent) = worktree_path.parent() {
            create_dir_all(parent)?;
        }

        let session_branch = branch.unwrap_or("session");
        let base_ref = base_branch
            .or(Some(project.default_branch.as_str()))
            .unwrap_or("HEAD");

        if !is_safe_git_ref(session_branch) {
            return Err(anyhow!("Invalid branch name: '{session_branch}'"));
        }
        if !is_safe_git_ref(base_ref) {
            return Err(anyhow!("Invalid base branch name: '{base_ref}'"));
        }

        let branch_exists =
            git_ref_exists(&repo_path, &format!("refs/heads/{session_branch}")).await;
        let start_ref = if branch_exists {
            session_branch.to_string()
        } else {
            resolve_branch_start_ref(&repo_path, base_ref)
                .await
                .unwrap_or_else(|| base_ref.to_string())
        };

        let mut add_command = Command::new("git");
        add_command.args([
            "-C",
            repo_path.to_string_lossy().as_ref(),
            "worktree",
            "add",
        ]);
        if !branch_exists {
            add_command.args(["-b", session_branch]);
        }
        add_command.arg(worktree_path.to_string_lossy().as_ref());
        add_command.arg(&start_ref);
        add_command.stdout(Stdio::null()).stderr(Stdio::null());

        let add_result = add_command.status().await;

        if add_result.is_err() || !add_result.unwrap().success() {
            return Err(anyhow!(
                "Failed to create worktree for branch '{}' in project '{}'",
                session_branch,
                project_id
            ));
        }

        Ok(resolve_default_working_directory(
            &worktree_path,
            project.default_working_directory.as_deref(),
        ))
    }
}

async fn resolve_branch_start_ref(repo_path: &Path, branch: &str) -> Option<String> {
    if git_ref_exists(repo_path, &format!("refs/heads/{branch}")).await {
        return Some(branch.to_string());
    }

    let origin_ref = format!("refs/remotes/origin/{branch}");
    if git_ref_exists(repo_path, &origin_ref).await {
        return Some(origin_ref);
    }

    let output = Command::new("git")
        .args([
            "-C",
            repo_path.to_string_lossy().as_ref(),
            "for-each-ref",
            "--format=%(refname)",
            &format!("refs/remotes/*/{branch}"),
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let refs = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    select_remote_tracking_ref(branch, &refs)
}

async fn git_ref_exists(repo_path: &Path, ref_name: &str) -> bool {
    Command::new("git")
        .args([
            "-C",
            repo_path.to_string_lossy().as_ref(),
            "show-ref",
            "--verify",
            "--quiet",
            ref_name,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

fn select_remote_tracking_ref(branch: &str, refs: &[String]) -> Option<String> {
    let preferred = format!("refs/remotes/origin/{branch}");
    if refs.iter().any(|value| value == &preferred) {
        return Some(preferred);
    }

    refs.iter()
        .find(|value| value.rsplit('/').next().is_some_and(|name| name != "HEAD"))
        .cloned()
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
    let Some(path) = relative else {
        return root.to_path_buf();
    };
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." {
        return root.to_path_buf();
    }
    root.join(trimmed)
}

#[cfg(test)]
mod tests {
    use super::select_remote_tracking_ref;

    #[test]
    fn select_remote_tracking_ref_prefers_origin() {
        let refs = vec![
            "refs/remotes/upstream/feature/review".to_string(),
            "refs/remotes/origin/feature/review".to_string(),
        ];

        assert_eq!(
            select_remote_tracking_ref("feature/review", &refs),
            Some("refs/remotes/origin/feature/review".to_string())
        );
    }

    #[test]
    fn select_remote_tracking_ref_falls_back_to_first_remote_match() {
        let refs = vec![
            "refs/remotes/upstream/feature/review".to_string(),
            "refs/remotes/upstream/HEAD".to_string(),
        ];

        assert_eq!(
            select_remote_tracking_ref("feature/review", &refs),
            Some("refs/remotes/upstream/feature/review".to_string())
        );
    }
}
