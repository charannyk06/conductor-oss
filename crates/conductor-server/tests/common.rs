#![allow(dead_code)]

use anyhow::Result;
use async_trait::async_trait;
use axum::middleware;
use axum::Router;
use conductor_core::config::{ConductorConfig, ProjectConfig};
use conductor_core::task::Task;
use conductor_core::types::AgentKind;
use conductor_db::repo::{ProjectRepo, TaskRepo};
use conductor_db::Database;
use conductor_executors::executor::{Executor, ExecutorHandle, ExecutorOutput, SpawnOptions};
use conductor_executors::process::spawn_process;
use conductor_server::{routes, state::AppState};
use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::Arc;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

pub fn ttyd_available() -> bool {
    which::which("ttyd").is_ok()
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\"'\"'"#))
}

fn build_test_executor_script(prompt: &str, auto_complete: bool) -> String {
    let mut segments = vec!["sleep 0.1".to_string()];
    if !prompt.trim().is_empty() {
        segments.push(format!("printf 'prompt:%s\\n' {}", shell_quote(prompt)));
    }

    if auto_complete {
        segments.push("sleep 0.1".to_string());
        segments.push("exit 0".to_string());
    } else {
        segments.push(
            "while IFS= read -r line; do if [ \"$line\" = \"__needs_input__\" ]; then printf '__needs_input__\\n'; else printf 'echo:%s\\n' \"$line\"; fi; done"
                .to_string(),
        );
    }

    segments.join("; ")
}

pub struct TestExecutor {
    pub kind: AgentKind,
    pub auto_complete: bool,
}

#[async_trait]
impl Executor for TestExecutor {
    fn kind(&self) -> AgentKind {
        self.kind.clone()
    }

    fn name(&self) -> &str {
        "Test Executor"
    }

    fn binary_path(&self) -> &Path {
        Path::new("/bin/sh")
    }

    async fn is_available(&self) -> bool {
        true
    }

    async fn version(&self) -> Result<String> {
        Ok("test".to_string())
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            handle.output_rx,
            handle.input_tx,
            handle.kill_tx,
        ))
    }

    fn build_args(&self, options: &SpawnOptions) -> Vec<String> {
        vec![
            "-lc".to_string(),
            build_test_executor_script(&options.prompt, self.auto_complete),
        ]
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        if line == "__needs_input__" {
            ExecutorOutput::NeedsInput("Follow-up required".to_string())
        } else {
            ExecutorOutput::Stdout(line.to_string())
        }
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }
}

pub struct ResumeExecutor;

#[async_trait]
impl Executor for ResumeExecutor {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    fn name(&self) -> &str {
        "Resume Executor"
    }

    fn binary_path(&self) -> &Path {
        Path::new("/bin/sh")
    }

    async fn is_available(&self) -> bool {
        true
    }

    async fn version(&self) -> Result<String> {
        Ok("test".to_string())
    }

    async fn spawn(&self, options: SpawnOptions) -> Result<ExecutorHandle> {
        let args = self.build_args(&options);
        let handle = spawn_process(self.binary_path(), &args, &options.cwd, &options.env).await?;
        Ok(ExecutorHandle::new(
            handle.pid,
            self.kind(),
            handle.output_rx,
            handle.input_tx,
            handle.kill_tx,
        ))
    }

    fn build_args(&self, _options: &SpawnOptions) -> Vec<String> {
        vec![
            "-lc".to_string(),
            "printf 'ready\\n'; IFS= read -r line; printf 'echo:%s\\n' \"$line\"; sleep 0.2"
                .to_string(),
        ]
    }

    fn parse_output(&self, line: &str) -> ExecutorOutput {
        ExecutorOutput::Stdout(line.to_string())
    }

    fn supports_direct_terminal_ui(&self) -> bool {
        true
    }
}

pub struct TestHarness {
    pub root: PathBuf,
    pub repo: PathBuf,
    pub board_path: PathBuf,
    pub state: Arc<AppState>,
    pub seed_task_id: String,
}

impl TestHarness {
    pub async fn new(label: &str, runtime_mode: &str) -> Self {
        let root = std::env::temp_dir().join(format!("{label}-{}", Uuid::new_v4()));
        let repo = root.join("repo");
        let board_path = repo.join("CONDUCTOR.md");

        seed_git_repo(&repo);
        fs::write(
            &board_path,
            [
                "## Inbox",
                "",
                "- [ ] Seed board task | id:board-seed | project:demo | taskRef:DEM-001",
                "",
                "## Ready to Dispatch",
                "",
                "## Dispatching",
                "",
                "## Done",
                "",
            ]
            .join("\n"),
        )
        .unwrap();

        let project = ProjectConfig {
            path: repo.to_string_lossy().to_string(),
            agent: Some("codex".to_string()),
            runtime: Some(runtime_mode.to_string()),
            default_branch: "main".to_string(),
            ..ProjectConfig::default()
        };
        let state = build_state(&root, project, "demo").await;

        ProjectRepo::upsert(
            state.db.pool(),
            "demo",
            "Demo Project",
            &repo.to_string_lossy(),
            Some("repo/CONDUCTOR.md"),
            Some("codex"),
            2,
        )
        .await
        .unwrap();
        let task = Task::new("demo".to_string(), "Seed db task".to_string());
        let seed_task_id = task.id.to_string();
        TaskRepo::create(state.db.pool(), &task).await.unwrap();

        Self {
            root,
            repo,
            board_path,
            state,
            seed_task_id,
        }
    }

    pub fn app(&self) -> Router {
        build_app(self.state.clone())
    }
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub async fn build_state(
    root: &Path,
    mut project: ProjectConfig,
    project_id: &str,
) -> Arc<AppState> {
    if project.runtime.is_none() {
        project.runtime = Some("ttyd".to_string());
    }

    let config = ConductorConfig {
        workspace: root.to_path_buf(),
        preferences: conductor_core::config::PreferencesConfig {
            coding_agent: "codex".to_string(),
            ..conductor_core::config::PreferencesConfig::default()
        },
        projects: BTreeMap::from([(project_id.to_string(), project)]),
        ..ConductorConfig::default()
    };

    let db = Database::in_memory().await.unwrap();
    let state = AppState::new(root.join("conductor.yaml"), config, db).await;
    state.executors.write().await.insert(
        AgentKind::Codex,
        Arc::new(TestExecutor {
            kind: AgentKind::Codex,
            auto_complete: false,
        }),
    );
    state.executors.write().await.insert(
        AgentKind::ClaudeCode,
        Arc::new(TestExecutor {
            kind: AgentKind::ClaudeCode,
            auto_complete: false,
        }),
    );
    state.publish_snapshot().await;
    state
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .merge(routes::app_update::router())
        .merge(routes::config::router())
        .merge(routes::errors::router())
        .merge(routes::events::router())
        .merge(routes::health::router())
        .merge(routes::sessions::router())
        .merge(routes::session_workspace::router())
        .merge(routes::repositories::router())
        .merge(routes::workspaces::router())
        .merge(routes::filesystem::router())
        .merge(routes::context_files::router())
        .merge(routes::boards::router())
        .merge(routes::dispatcher::router())
        .merge(routes::github::router())
        .merge(routes::attachments::router())
        .merge(routes::notifications::router())
        .merge(routes::projects::router())
        .merge(routes::tasks::router())
        .merge(routes::terminal::router())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            routes::middleware::require_auth_when_remote,
        ))
        .with_state(state)
}

pub async fn wait_for_condition<T, F, Fut>(label: &str, check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    wait_for_condition_with_timeout(label, Duration::from_secs(10), check).await
}

pub async fn wait_for_condition_with_timeout<T, F, Fut>(
    label: &str,
    duration: Duration,
    mut check: F,
) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    timeout(duration, async move {
        loop {
            if let Some(value) = check().await {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
}

pub fn spawn_request(prompt: &str) -> conductor_server::state::SpawnRequest {
    conductor_server::state::SpawnRequest {
        project_id: "demo".to_string(),
        bridge_id: None,
        prompt: prompt.to_string(),
        issue_id: None,
        agent: Some("codex".to_string()),
        use_worktree: Some(true),
        permission_mode: None,
        model: None,
        reasoning_effort: None,
        branch: None,
        base_branch: None,
        task_id: None,
        task_ref: None,
        attempt_id: None,
        parent_task_id: None,
        retry_of_session_id: None,
        profile: None,
        session_kind: None,
        brief_path: None,
        attachments: Vec::new(),
        source: "integration_test".to_string(),
    }
}

pub fn seed_git_repo(repo: &Path) {
    fs::create_dir_all(repo).unwrap();
    run_git(repo, &["init", "-b", "main"]);
    run_git(repo, &["config", "user.email", "test@example.com"]);
    run_git(repo, &["config", "user.name", "Conductor Tests"]);
    fs::write(repo.join("README.md"), "seed\n").unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-m", "seed"]);
}

pub fn run_git(repo: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .expect("git command should run");
    assert!(
        status.success(),
        "git command failed: git -C {} {:?}",
        repo.display(),
        args
    );
}

#[cfg(unix)]
pub fn mark_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(not(unix))]
pub fn mark_executable(_path: &Path) {}
