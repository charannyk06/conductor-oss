//! Git worktree management for session isolation
//! 
//! This module provides git worktree operations to isolate each session
//! in its own working directory, similar to Superset's workspace isolation.

use anyhow::{anyhow, Context, Result};
use git2::{Repository, Worktree, WorktreeAddOptions};
use std::path::{Path, PathBuf};
use tracing::{debug, info, warn};

/// Manages git worktrees for session isolation
pub struct WorktreeManager {
    /// Base directory for all worktrees (e.g., ~/.conductor/worktrees)
    base_path: PathBuf,
}

impl WorktreeManager {
    /// Create a new worktree manager
    pub fn new(base_path: impl Into<PathBuf>) -> Self {
        Self {
            base_path: base_path.into(),
        }
    }

    /// Initialize the worktree base directory
    pub fn initialize(&self) -> Result<()> {
        std::fs::create_dir_all(&self.base_path)
            .with_context(|| format!("Failed to create worktree base directory: {:?}", self.base_path))?;
        info!("Initialized worktree manager at {:?}", self.base_path);
        Ok(())
    }

    /// Create a new worktree for a session
    /// 
    /// # Arguments
    /// * `project_path` - Path to the main git repository
    /// * `session_id` - Unique session identifier
    /// * `base_branch` - Optional base branch to create from (defaults to current branch)
    /// 
    /// # Returns
    /// Path to the created worktree directory
    pub async fn create_worktree(
        &self,
        project_path: &Path,
        session_id: &str,
        base_branch: Option<&str>,
    ) -> Result<PathBuf> {
        let worktree_path = self.base_path.join(session_id);
        
        if worktree_path.exists() {
            warn!("Worktree already exists at {:?}, removing first", worktree_path);
            self.remove_worktree(&worktree_path).await?;
        }

        let branch_name = format!("conductor/{}", session_id);
        
        // Open the main repository
        let repo = Repository::open(project_path)
            .with_context(|| format!("Failed to open repository at {:?}", project_path))?;

        // Determine base commit/branch
        let base_ref = if let Some(branch) = base_branch {
            repo.find_branch(branch, git2::BranchType::Local)?
                .get()
                .peel_to_commit()?
        } else {
            repo.head()?.peel_to_commit()?
        };

        // Create the branch for this worktree
        repo.branch(&branch_name, &base_ref, false)
            .with_context(|| format!("Failed to create branch {}", branch_name))?;

        // Set up worktree options
        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&format!("refs/heads/{}", branch_name)));

        // Add the worktree
        let worktree = repo.worktree(&branch_name, &worktree_path, Some(&opts))
            .with_context(|| format!("Failed to create worktree at {:?}", worktree_path))?;

        info!(
            session_id,
            project = ?project_path,
            worktree = ?worktree_path,
            branch = branch_name,
            "Created worktree for session"
        );

        Ok(worktree_path)
    }

    /// Remove a worktree
    pub async fn remove_worktree(&self, worktree_path: &Path) -> Result<()> {
        if !worktree_path.exists() {
            debug!("Worktree does not exist: {:?}", worktree_path);
            return Ok(());
        }

        // Try to get the worktree from git first for proper cleanup
        if let Ok(repo) = Repository::discover(worktree_path) {
            if let Ok(worktree) = repo.find_worktree(
                worktree_path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
            ) {
                if let Err(e) = worktree.prune(None) {
                    warn!("Failed to prune worktree: {}", e);
                }
            }
        }

        // Remove the directory
        tokio::fs::remove_dir_all(worktree_path).await
            .with_context(|| format!("Failed to remove worktree directory: {:?}", worktree_path))?;

        info!("Removed worktree at {:?}", worktree_path);
        Ok(())
    }

    /// Get the current git status of a worktree
    pub fn get_worktree_status(&self, worktree_path: &Path) -> Result<WorktreeStatus> {
        let repo = Repository::open(worktree_path)?;
        let statuses = repo.statuses(None)?;
        
        let mut modified = 0;
        let mut added = 0;
        let mut deleted = 0;
        let mut untracked = 0;

        for entry in statuses.iter() {
            let status = entry.status();
            if status.contains(git2::Status::INDEX_NEW) || status.contains(git2::Status::WT_NEW) {
                added += 1;
            }
            if status.contains(git2::Status::INDEX_MODIFIED) || status.contains(git2::Status::WT_MODIFIED) {
                modified += 1;
            }
            if status.contains(git2::Status::INDEX_DELETED) || status.contains(git2::Status::WT_DELETED) {
                deleted += 1;
            }
            if status.contains(git2::Status::WT_NEW) {
                untracked += 1;
            }
        }

        Ok(WorktreeStatus {
            modified,
            added,
            deleted,
            untracked,
            clean: modified == 0 && added == 0 && deleted == 0 && untracked == 0,
        })
    }

    /// List all worktrees
    pub fn list_worktrees(&self) -> Result<Vec<PathBuf>> {
        let mut worktrees = Vec::new();
        
        if !self.base_path.exists() {
            return Ok(worktrees);
        }

        for entry in std::fs::read_dir(&self.base_path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                worktrees.push(entry.path());
            }
        }

        Ok(worktrees)
    }

    /// Get the base path for worktrees
    pub fn base_path(&self) -> &Path {
        &self.base_path
    }
}

/// Status of a worktree
#[derive(Debug, Clone, Default)]
pub struct WorktreeStatus {
    pub modified: usize,
    pub added: usize,
    pub deleted: usize,
    pub untracked: usize,
    pub clean: bool,
}

impl std::fmt::Display for WorktreeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.clean {
            write!(f, "clean")
        } else {
            let parts: Vec<String> = [
                if self.modified > 0 { Some(format!("{} modified", self.modified)) } else { None },
                if self.added > 0 { Some(format!("{} added", self.added)) } else { None },
                if self.deleted > 0 { Some(format!("{} deleted", self.deleted)) } else { None },
                if self.untracked > 0 { Some(format!("{} untracked", self.untracked)) } else { None },
            ]
            .into_iter()
            .flatten()
            .collect();
            
            write!(f, "{}", parts.join(", "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn create_test_repo() -> (TempDir, PathBuf) {
        let temp = TempDir::new().unwrap();
        let repo_path = temp.path().join("repo");
        
        // Initialize git repo
        let repo = Repository::init(&repo_path).unwrap();
        
        // Create initial commit
        let signature = git2::Signature::now("Test", "test@test.com").unwrap();
        let tree_id = {
            let mut index = repo.index().unwrap();
            index.write_tree().unwrap()
        };
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        ).unwrap();

        (temp, repo_path)
    }

    #[tokio::test]
    async fn test_create_and_remove_worktree() {
        let (_temp, repo_path) = create_test_repo().await;
        let worktree_base = TempDir::new().unwrap();
        let manager = WorktreeManager::new(worktree_base.path());
        
        manager.initialize().unwrap();
        
        // Create worktree
        let worktree_path = manager.create_worktree(&repo_path, "test-session-1", None).await.unwrap();
        assert!(worktree_path.exists());
        
        // Check status
        let status = manager.get_worktree_status(&worktree_path).unwrap();
        assert!(status.clean);
        
        // Remove worktree
        manager.remove_worktree(&worktree_path).await.unwrap();
        assert!(!worktree_path.exists());
    }

    #[tokio::test]
    async fn test_worktree_isolation() {
        let (_temp, repo_path) = create_test_repo().await;
        let worktree_base = TempDir::new().unwrap();
        let manager = WorktreeManager::new(worktree_base.path());
        
        manager.initialize().unwrap();
        
        // Create two worktrees
        let worktree1 = manager.create_worktree(&repo_path, "session-1", None).await.unwrap();
        let worktree2 = manager.create_worktree(&repo_path, "session-2", None).await.unwrap();
        
        // Create file in first worktree
        tokio::fs::write(worktree1.join("file1.txt"), "content1").await.unwrap();
        
        // Create different file in second worktree
        tokio::fs::write(worktree2.join("file2.txt"), "content2").await.unwrap();
        
        // Verify isolation
        assert!(worktree1.join("file1.txt").exists());
        assert!(!worktree1.join("file2.txt").exists());
        assert!(worktree2.join("file2.txt").exists());
        assert!(!worktree2.join("file1.txt").exists());
        
        // Check statuses
        let status1 = manager.get_worktree_status(&worktree1).unwrap();
        assert_eq!(status1.untracked, 1);
        
        let status2 = manager.get_worktree_status(&worktree2).unwrap();
        assert_eq!(status2.untracked, 1);
    }
}
