use anyhow::{anyhow, Context, Result};
use conductor_core::config::ProjectConfig;
use glob::Pattern;
use std::fs::{self, create_dir_all, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use super::{AppState, DevServerLaunch, SessionRecord};

const SETUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(900);
const WORKSPACE_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

pub(crate) struct PreparedWorkspace {
    pub repo_path: PathBuf,
    pub root_path: PathBuf,
    pub working_directory: PathBuf,
    pub uses_worktree: bool,
}

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
    ) -> Result<PreparedWorkspace> {
        let repo_path = self.resolve_project_path(project);
        let git_dir = repo_path.join(".git");
        if !use_worktree || !git_dir.exists() {
            return Ok(PreparedWorkspace {
                working_directory: resolve_default_working_directory(
                    &repo_path,
                    project.default_working_directory.as_deref(),
                ),
                repo_path: repo_path.clone(),
                root_path: repo_path,
                uses_worktree: false,
            });
        }

        let worktree_path = self.resolve_worktree_path(project_id, session_id);
        if worktree_path.exists() {
            return Ok(PreparedWorkspace {
                working_directory: resolve_default_working_directory(
                    &worktree_path,
                    project.default_working_directory.as_deref(),
                ),
                repo_path: repo_path.clone(),
                root_path: worktree_path,
                uses_worktree: true,
            });
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

        let output = add_command.output().await.with_context(|| {
            format!(
                "Failed to run `git worktree add` for branch '{session_branch}' in project '{project_id}'"
            )
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exit status {}", output.status)
            };

            return Err(anyhow!(
                "Failed to create worktree for branch '{}' in project '{}': {}",
                session_branch,
                project_id,
                detail
            ));
        }

        Ok(PreparedWorkspace {
            working_directory: resolve_default_working_directory(
                &worktree_path,
                project.default_working_directory.as_deref(),
            ),
            repo_path,
            root_path: worktree_path,
            uses_worktree: true,
        })
    }

    pub(crate) async fn initialize_workspace(
        &self,
        project: &ProjectConfig,
        workspace: &PreparedWorkspace,
    ) -> Result<()> {
        if workspace.uses_worktree {
            copy_configured_files(
                &workspace.repo_path,
                &workspace.root_path,
                &project.copy_files,
            )?;

            if project.run_setup_in_parallel {
                spawn_background_workspace_commands(
                    &project.setup_script,
                    workspace.root_path.clone(),
                    "setup",
                    SETUP_COMMAND_TIMEOUT,
                );
            } else {
                run_workspace_commands(
                    &project.setup_script,
                    &workspace.root_path,
                    "setup",
                    SETUP_COMMAND_TIMEOUT,
                )
                .await?;
            }
        }

        ensure_working_directory_exists(
            &workspace.root_path,
            &workspace.working_directory,
            project.default_working_directory.as_deref(),
        )?;

        Ok(())
    }

    pub(crate) async fn ensure_dev_server(
        &self,
        project_id: &str,
        project: &ProjectConfig,
    ) -> Result<DevServerLaunch> {
        let script = join_script_lines(&project.dev_server_script);
        let preview_url = project.resolved_dev_server_url();
        let preview_port = project.dev_server_port;
        let Some(script) = script else {
            return Ok(DevServerLaunch {
                log_path: None,
                preview_url,
                preview_port,
            });
        };

        let mut dev_servers = self.dev_servers.lock().await;
        if let Some(existing) = dev_servers.get(project_id) {
            if is_process_alive(existing.pid) {
                return Ok(DevServerLaunch {
                    log_path: Some(existing.log_path.clone()),
                    preview_url,
                    preview_port,
                });
            }
        }

        let log_dir = self
            .workspace_path
            .join(".conductor")
            .join("rust-backend")
            .join("dev-servers");
        create_dir_all(&log_dir)?;
        let log_path = log_dir.join(format!("{}.log", sanitize_token(project_id)));
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let stderr = stdout.try_clone()?;

        let mut command = Command::new("sh");
        command
            .arg("-lc")
            .arg(script)
            .current_dir(resolve_dev_server_cwd(
                &self.resolve_project_path(project),
                project,
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .kill_on_drop(false);
        if let Some(url) = preview_url.as_deref() {
            command.env("CONDUCTOR_PREVIEW_URL", url);
        }
        if let Some(port) = preview_port {
            let port_text = port.to_string();
            command.env("PORT", &port_text);
            command.env("CONDUCTOR_PREVIEW_PORT", &port_text);
        }
        if let Some(host) = project
            .dev_server_host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())
        {
            command.env("HOST", host);
            command.env(
                "CONDUCTOR_PREVIEW_HOST",
                normalized_dev_server_host(project),
            );
        }

        let child = command.spawn().context("Failed to start dev server")?;
        let pid = child
            .id()
            .with_context(|| format!("Failed to capture pid for dev server in {project_id}"))?;
        drop(child);

        let log_path = log_path.to_string_lossy().to_string();
        dev_servers.insert(
            project_id.to_string(),
            super::DevServerRecord {
                pid,
                log_path: log_path.clone(),
            },
        );

        Ok(DevServerLaunch {
            log_path: Some(log_path),
            preview_url,
            preview_port,
        })
    }

    pub(crate) async fn archive_workspace(
        &self,
        session_id: &str,
        session: &SessionRecord,
        project: &ProjectConfig,
    ) -> Result<()> {
        let workspace_root = session
            .metadata
            .get("worktree")
            .cloned()
            .or_else(|| session.workspace_path.clone())
            .map(PathBuf::from);
        let Some(workspace_root) = workspace_root else {
            return Ok(());
        };
        if !workspace_root.exists() {
            return Ok(());
        }

        let project_root = self.resolve_project_path(project);
        if workspace_root == project_root {
            return Ok(());
        }
        let cleanup_script = project.cleanup_script.clone();
        let archive_script = project.archive_script.clone();
        let session_id = session_id.to_string();
        tokio::spawn(async move {
            run_workspace_commands_best_effort(
                &cleanup_script,
                &workspace_root,
                "cleanup",
                WORKSPACE_COMMAND_TIMEOUT,
            )
            .await;
            run_workspace_commands_best_effort(
                &archive_script,
                &workspace_root,
                "archive",
                WORKSPACE_COMMAND_TIMEOUT,
            )
            .await;

            if let Err(err) = remove_worktree(&project_root, &workspace_root)
                .await
                .or_else(|_| remove_directory(&workspace_root))
                .with_context(|| {
                    format!(
                        "Failed to remove archived workspace for session {session_id} at {}",
                        workspace_root.display()
                    )
                })
            {
                tracing::warn!(session_id, error = %err, "Failed to archive workspace");
            }
        });

        Ok(())
    }

    pub(crate) async fn cleanup_unpersisted_workspace(
        &self,
        workspace: &PreparedWorkspace,
    ) -> Result<()> {
        if !workspace.uses_worktree {
            return Ok(());
        }

        remove_worktree(&workspace.repo_path, &workspace.root_path)
            .await
            .or_else(|_| remove_directory(&workspace.root_path))
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

fn ensure_working_directory_exists(
    workspace_root: &Path,
    working_directory: &Path,
    configured_subdir: Option<&str>,
) -> Result<()> {
    if working_directory.is_dir() {
        return Ok(());
    }

    if let Some(relative) = configured_subdir
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Err(anyhow!(
            "defaultWorkingDirectory '{}' does not exist in workspace '{}'",
            relative,
            workspace_root.display()
        ));
    }

    Err(anyhow!(
        "Workspace '{}' is unavailable",
        workspace_root.display()
    ))
}

fn join_script_lines(lines: &[String]) -> Option<String> {
    let scripts = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if scripts.is_empty() {
        None
    } else {
        Some(scripts.join("\n"))
    }
}

fn resolve_dev_server_cwd(project_root: &Path, project: &ProjectConfig) -> PathBuf {
    let cwd = project
        .dev_server_cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match cwd {
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                project_root.join(path)
            }
        }
        None => project_root.to_path_buf(),
    }
}

fn normalized_dev_server_host(project: &ProjectConfig) -> String {
    let host = project
        .dev_server_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    if host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        host.to_string()
    }
}

fn sanitize_token(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    sanitized.trim_matches('-').to_string()
}

pub(crate) fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return false;
        }
        let pid = pid as libc::pid_t;
        // SAFETY: libc::kill with signal 0 only checks process existence.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        if pid == 0 {
            return false;
        }

        // SAFETY: OpenProcess/GetExitCodeProcess only inspect an explicit pid.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }

            let mut exit_code = 0u32;
            let result = GetExitCodeProcess(handle, &mut exit_code);
            CloseHandle(handle);
            result != 0 && exit_code == STILL_ACTIVE as u32
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

pub(crate) fn terminate_process(pid: u32) -> bool {
    #[cfg(unix)]
    {
        if pid == 0 || pid > i32::MAX as u32 {
            return false;
        }
        if !is_process_alive(pid) {
            return true;
        }

        let pid = pid as libc::pid_t;
        let host_pgid = unsafe { libc::getpgrp() };
        let pgid = unsafe { libc::getpgid(pid) };
        let target_pgid = (pgid > 0 && pgid != host_pgid).then_some(pgid);

        if let Some(pgid) = target_pgid {
            let _ = unsafe { libc::kill(-pgid, libc::SIGTERM) };
        }
        // SAFETY: libc::kill sends a termination signal to an explicit pid.
        let terminated = unsafe { libc::kill(pid, libc::SIGTERM) };
        if terminated != 0 {
            let error = std::io::Error::last_os_error().raw_os_error();
            if error != Some(libc::ESRCH) {
                return false;
            }
            return true;
        }

        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
            if !is_process_alive(pid as u32) {
                return true;
            }
        }

        if let Some(pgid) = target_pgid {
            let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
        }
        // SAFETY: SIGKILL is the final fallback after a bounded SIGTERM wait.
        let killed = unsafe { libc::kill(pid, libc::SIGKILL) };
        killed == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_TERMINATE,
        };
        const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;

        if pid == 0 {
            return false;
        }
        if !is_process_alive(pid) {
            return true;
        }

        // SAFETY: OpenProcess/TerminateProcess target a specific pid and handle is closed before returning.
        unsafe {
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if handle.is_null() {
                return false;
            }

            let terminated = TerminateProcess(handle, 1);
            let wait_result = if terminated != 0 {
                WaitForSingleObject(handle, 2_000)
            } else {
                1
            };
            CloseHandle(handle);

            wait_result == WAIT_OBJECT_0 || !is_process_alive(pid)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

fn copy_configured_files(
    repo_path: &Path,
    worktree_path: &Path,
    patterns: &[String],
) -> Result<()> {
    if patterns.is_empty() {
        return Ok(());
    }

    let matches = resolve_copy_file_matches(repo_path, patterns)?;
    for relative in matches {
        let source = repo_path.join(&relative);
        let target = worktree_path.join(&relative);
        if !target.starts_with(worktree_path) {
            return Err(anyhow!(
                "copyFiles target '{}' resolves outside workspace",
                relative
            ));
        }

        let metadata = fs::metadata(&source)
            .with_context(|| format!("Failed to read copyFiles source {}", source.display()))?;
        if metadata.is_dir() {
            copy_directory_recursive(&source, &target)?;
            continue;
        }

        if let Some(parent) = target.parent() {
            create_dir_all(parent)?;
        }
        fs::copy(&source, &target).with_context(|| {
            format!(
                "Failed to copy configured file {} to {}",
                source.display(),
                target.display()
            )
        })?;
    }

    Ok(())
}

fn resolve_copy_file_matches(repo_path: &Path, patterns: &[String]) -> Result<Vec<String>> {
    let all_files = collect_repo_files(repo_path)?;
    let mut matches = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for raw_pattern in patterns {
        let pattern = assert_safe_relative_path(raw_pattern, "copyFiles pattern")?;
        let has_glob = pattern.contains('*') || pattern.contains('?');
        if !has_glob {
            let source = repo_path.join(&pattern);
            if !source.exists() {
                continue;
            }
            let relative = normalize_relative_path(
                source
                    .strip_prefix(repo_path)
                    .unwrap_or_else(|_| Path::new(&pattern)),
            );
            if seen.insert(relative.clone()) {
                matches.push(relative);
            }
            continue;
        }

        let matcher = Pattern::new(&pattern)
            .with_context(|| format!("Invalid copyFiles glob pattern '{}'", raw_pattern.trim()))?;
        for file in &all_files {
            if matcher.matches(file) && seen.insert(file.clone()) {
                matches.push(file.clone());
            }
        }
    }

    Ok(matches)
}

fn collect_repo_files(repo_path: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    let mut stack = vec![repo_path.to_path_buf()];

    while let Some(current) = stack.pop() {
        let relative = normalize_relative_path(
            current
                .strip_prefix(repo_path)
                .unwrap_or_else(|_| Path::new("")),
        );
        if relative == ".git" || relative.starts_with(".git/") {
            continue;
        }

        let entries = fs::read_dir(&current)
            .with_context(|| format!("Failed to read directory {}", current.display()))?;
        for entry in entries {
            let entry = entry?;
            let next = entry.path();
            let relative = normalize_relative_path(
                next.strip_prefix(repo_path)
                    .unwrap_or_else(|_| Path::new("")),
            );
            if relative == ".git" || relative.starts_with(".git/") {
                continue;
            }
            if entry.file_type()?.is_dir() {
                stack.push(next);
            } else {
                files.push(relative);
            }
        }
    }

    Ok(files)
}

fn copy_directory_recursive(source: &Path, target: &Path) -> Result<()> {
    create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                create_dir_all(parent)?;
            }
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn assert_safe_relative_path(raw: &str, label: &str) -> Result<String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(anyhow!("{label} cannot be empty"));
    }
    if normalized.starts_with('/') {
        return Err(anyhow!("{label} must be relative: '{raw}'"));
    }
    if normalized.split('/').any(|segment| segment == "..") {
        return Err(anyhow!("{label} cannot contain '..': '{raw}'"));
    }
    Ok(normalized
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string())
}

fn normalize_relative_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let trimmed = value.trim_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn run_workspace_commands(
    commands: &[String],
    workspace_path: &Path,
    label: &str,
    timeout: Duration,
) -> Result<()> {
    for command in commands {
        let script = command.trim();
        if script.is_empty() {
            continue;
        }
        run_shell_command(script, workspace_path, timeout)
            .await
            .with_context(|| {
                format!(
                    "{} command failed in workspace '{}'",
                    label,
                    workspace_path.display()
                )
            })?;
    }

    Ok(())
}

fn spawn_background_workspace_commands(
    commands: &[String],
    workspace_path: PathBuf,
    label: &'static str,
    timeout: Duration,
) {
    for command in commands {
        let script = command.trim().to_string();
        if script.is_empty() {
            continue;
        }
        let workspace_path = workspace_path.clone();
        tokio::spawn(async move {
            if let Err(err) = run_shell_command(&script, &workspace_path, timeout).await {
                tracing::warn!(
                    workspace = %workspace_path.display(),
                    command = %script,
                    error = %err,
                    "{} command failed",
                    label
                );
            }
        });
    }
}

async fn run_workspace_commands_best_effort(
    commands: &[String],
    workspace_path: &Path,
    label: &'static str,
    timeout: Duration,
) {
    for command in commands {
        let script = command.trim();
        if script.is_empty() {
            continue;
        }
        if let Err(err) = run_shell_command(script, workspace_path, timeout).await {
            tracing::warn!(
                workspace = %workspace_path.display(),
                command = %script,
                error = %err,
                "{} command failed",
                label
            );
        }
    }
}

async fn run_shell_command(script: &str, workspace_path: &Path, timeout: Duration) -> Result<()> {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(script)
        .current_dir(workspace_path)
        .stdin(Stdio::null());

    let output = tokio::time::timeout(timeout, command.output())
        .await
        .with_context(|| format!("Command timed out after {}s", timeout.as_secs()))??;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", output.status)
    };

    Err(anyhow!("`{script}` failed: {detail}"))
}

async fn remove_worktree(repo_path: &Path, workspace_path: &Path) -> Result<()> {
    let status = Command::new("git")
        .args([
            "-C",
            repo_path.to_string_lossy().as_ref(),
            "worktree",
            "remove",
            "--force",
            workspace_path.to_string_lossy().as_ref(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await?;
    if status.success() {
        let _ = Command::new("git")
            .args([
                "-C",
                repo_path.to_string_lossy().as_ref(),
                "worktree",
                "prune",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        return Ok(());
    }

    Err(anyhow!(
        "git worktree remove failed for {}",
        workspace_path.display()
    ))
}

fn remove_directory(workspace_path: &Path) -> Result<()> {
    if workspace_path.exists() {
        fs::remove_dir_all(workspace_path)
            .with_context(|| format!("Failed to remove {}", workspace_path.display()))?;
    }
    Ok(())
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
