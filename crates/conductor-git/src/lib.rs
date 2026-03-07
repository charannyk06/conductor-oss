use anyhow::Result;
use git2::Repository;
use std::path::Path;

/// Git operations for worktree management.
pub struct GitOps {
    repo: Repository,
}

impl GitOps {
    /// Open an existing repository.
    pub fn open(path: &Path) -> Result<Self> {
        let repo = Repository::open(path)?;
        Ok(Self { repo })
    }

    /// Get the current branch name.
    pub fn current_branch(&self) -> Result<String> {
        let head = self.repo.head()?;
        let name = head
            .shorthand()
            .unwrap_or("HEAD")
            .to_string();
        Ok(name)
    }

    /// Create a new branch from the current HEAD.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        self.repo.branch(name, &commit, false)?;
        tracing::info!("Created branch: {name}");
        Ok(())
    }

    /// Create a worktree for isolated agent work.
    pub fn create_worktree(&self, name: &str, path: &Path, branch: &str) -> Result<()> {
        // Ensure branch exists.
        let branch_ref = self
            .repo
            .find_branch(branch, git2::BranchType::Local)
            .or_else(|_| {
                // Create branch if it doesn't exist.
                let head = self.repo.head().unwrap();
                let commit = head.peel_to_commit().unwrap();
                self.repo.branch(branch, &commit, false)
            })?;

        let reference = branch_ref.into_reference();
        self.repo.worktree(name, path, Some(
            git2::WorktreeAddOptions::new().reference(Some(&reference)),
        ))?;

        tracing::info!("Created worktree: {name} at {}", path.display());
        Ok(())
    }

    /// Remove a worktree.
    pub fn remove_worktree(&self, name: &str) -> Result<()> {
        let worktree = self.repo.find_worktree(name)?;
        if worktree.is_locked().is_ok() {
            worktree.unlock()?;
        }
        worktree.prune(Some(
            git2::WorktreePruneOptions::new()
                .working_tree(true)
                .valid(true),
        ))?;
        tracing::info!("Removed worktree: {name}");
        Ok(())
    }

    /// List all worktrees.
    pub fn list_worktrees(&self) -> Result<Vec<String>> {
        let worktrees = self.repo.worktrees()?;
        Ok(worktrees.iter().filter_map(|w| w.map(String::from)).collect())
    }

    /// Check if the working directory is clean (no uncommitted changes).
    pub fn is_clean(&self) -> Result<bool> {
        let statuses = self.repo.statuses(None)?;
        Ok(statuses.is_empty())
    }

    /// Get a short diff summary.
    pub fn diff_summary(&self) -> Result<String> {
        let diff = self.repo.diff_index_to_workdir(None, None)?;
        let stats = diff.stats()?;
        Ok(format!(
            "{} files changed, {} insertions(+), {} deletions(-)",
            stats.files_changed(),
            stats.insertions(),
            stats.deletions()
        ))
    }
}
