use anyhow::Result;
use chrono::Utc;
use conductor_core::config::ProjectConfig;
use conductor_core::support::resolve_project_path;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::task;

use crate::routes::boards::{split_task_text, BoardTaskRecord};
use crate::state::AppState;

const MAX_BRIEF_BYTES: usize = 16 * 1024;
const MAX_ATTACHMENT_SNIPPET_BYTES: usize = 6 * 1024;
const MAX_ATTACHMENT_SNIPPETS: usize = 3;
const MAX_COMMENT_COUNT: usize = 5;

#[derive(Debug, Clone)]
pub(crate) struct TaskBriefPaths {
    pub repo_absolute: PathBuf,
    pub repo_display: String,
    pub vault_absolute: Option<PathBuf>,
    pub vault_display: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct TaskContextBundle {
    pub prompt: String,
    pub attachments: Vec<String>,
    pub repo_brief_path: String,
}

pub(crate) async fn ensure_task_brief(
    state: &Arc<AppState>,
    project_id: &str,
    project: &ProjectConfig,
    task: &BoardTaskRecord,
) -> Result<TaskBriefPaths> {
    let config = state.config.read().await.clone();
    let workspace_path = state.workspace_path.clone();
    let project_id = project_id.to_string();
    let project = project.clone();
    let task = task.clone();
    let markdown_editor = config.preferences.markdown_editor;
    let markdown_editor_path = config.preferences.markdown_editor_path;

    task::spawn_blocking(move || {
        ensure_task_brief_sync(
            &workspace_path,
            &project_id,
            &project,
            &task,
            &markdown_editor,
            &markdown_editor_path,
        )
    })
    .await?
}

fn ensure_task_brief_sync(
    workspace_path: &Path,
    project_id: &str,
    project: &ProjectConfig,
    task: &BoardTaskRecord,
    markdown_editor: &str,
    markdown_editor_path: &str,
) -> Result<TaskBriefPaths> {
    let task_ref = task_ref_for_storage(task);
    let paths = resolve_task_brief_paths(
        workspace_path,
        project_id,
        project,
        &task_ref,
        markdown_editor,
        markdown_editor_path,
    );
    let (title, description) = split_task_text(&task.text);
    let template = render_task_brief(
        project_id,
        &task.id,
        &task_ref,
        &title,
        description.as_deref(),
        task.notes.as_deref(),
        &task.attachments,
        task.attempt_ref.as_deref(),
    );

    if let Some(parent) = paths.repo_absolute.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Some(vault_path) = paths.vault_absolute.as_ref() {
        if let Some(parent) = vault_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let repo_exists = paths.repo_absolute.exists();
    let vault_exists = paths
        .vault_absolute
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);

    match (repo_exists, vault_exists) {
        (false, false) => {
            std::fs::write(&paths.repo_absolute, &template)?;
            if let Some(vault_path) = paths.vault_absolute.as_ref() {
                std::fs::write(vault_path, &template)?;
            }
        }
        (true, false) => {
            if let Some(vault_path) = paths.vault_absolute.as_ref() {
                copy_if_changed(&paths.repo_absolute, vault_path)?;
            }
        }
        (false, true) => {
            if let Some(vault_path) = paths.vault_absolute.as_ref() {
                copy_if_changed(vault_path, &paths.repo_absolute)?;
            }
        }
        (true, true) => {
            if let Some(vault_path) = paths.vault_absolute.as_ref() {
                sync_newer_brief(&paths.repo_absolute, vault_path)?;
            }
        }
    }

    Ok(paths)
}

pub(crate) async fn compile_task_context(
    state: &Arc<AppState>,
    project_id: &str,
    project: &ProjectConfig,
    task: &BoardTaskRecord,
) -> Result<TaskContextBundle> {
    let brief_paths = ensure_task_brief(state, project_id, project, task).await?;
    let config = state.config.read().await.clone();
    let (title, description) = split_task_text(&task.text);
    let comments_by_task = state.task_comments(project_id).await;
    let comments = comments_by_task
        .get(&task.id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .rev()
        .take(MAX_COMMENT_COUNT)
        .collect::<Vec<_>>();
    let previous_run_summary = if let Some(attempt_ref) = task.attempt_ref.as_deref() {
        state
            .get_session(attempt_ref)
            .await
            .and_then(|session| session.summary)
    } else {
        None
    };

    let mut attachments = task.attachments.clone();
    if !attachments.contains(&brief_paths.repo_display) {
        attachments.push(brief_paths.repo_display.clone());
    }

    let mut prompt = String::new();
    prompt.push_str("You are executing a Conductor board task.\n\n");
    prompt.push_str(&format!("Task: {title}\n"));
    if let Some(task_ref) = task
        .task_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str(&format!("Task reference: {task_ref}\n"));
    }
    prompt.push_str(&format!("Task id: {}\n", task.id));
    if let Some(agent) = task
        .agent
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str(&format!("Assigned agent: {agent}\n"));
    }
    if let Some(priority) = task
        .priority
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str(&format!("Priority: {priority}\n"));
    }
    if let Some(task_type) = task
        .task_type
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str(&format!("Type: {task_type}\n"));
    }
    if let Some(description) = description
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str(&format!("Description: {description}\n"));
    }
    prompt.push_str(&format!("Project: {project_id}\n"));

    if let Some(notes) = task
        .notes
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        prompt.push_str("\nBoard notes:\n");
        prompt.push_str(notes.trim());
        prompt.push('\n');
    }

    if let Ok(brief_body) = read_text_preview(&brief_paths.repo_absolute, MAX_BRIEF_BYTES) {
        if !brief_body.trim().is_empty() {
            prompt.push_str(&format!(
                "\nTask brief ({})\n---\n{}\n---\n",
                brief_paths.repo_display,
                brief_body.trim()
            ));
        }
    }

    if !comments.is_empty() {
        prompt.push_str("\nRecent board comments:\n");
        for comment in comments.into_iter().rev() {
            prompt.push_str(&format!(
                "- {} ({}) {}\n",
                comment.author,
                comment.timestamp,
                comment.body.trim()
            ));
        }
    }

    if let Some(summary) = previous_run_summary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        prompt.push_str("\nLatest run summary:\n");
        prompt.push_str(summary);
        prompt.push('\n');
    }

    let attachment_allowed_roots = attachment_allowed_roots(
        state,
        project_id,
        project,
        &config.preferences.markdown_editor,
        &config.preferences.markdown_editor_path,
    );
    let attachment_sections =
        attachment_context_sections(state, &attachments, &attachment_allowed_roots);
    if !attachment_sections.is_empty() {
        prompt.push_str("\nAttached context:\n");
        for section in attachment_sections {
            prompt.push_str(&section);
            if !section.ends_with('\n') {
                prompt.push('\n');
            }
        }
    }

    prompt.push_str(
        "\nUse the board brief and context as the source of truth. Keep implementation updates aligned with this task rather than treating it like a generic PR ticket.\n",
    );

    Ok(TaskContextBundle {
        prompt,
        attachments,
        repo_brief_path: brief_paths.repo_display,
    })
}

pub(crate) fn resolve_task_brief_paths(
    workspace_path: &Path,
    project_id: &str,
    project: &ProjectConfig,
    task_ref: &str,
    markdown_editor: &str,
    markdown_editor_path: &str,
) -> TaskBriefPaths {
    let project_root = resolve_project_path(workspace_path, &project.path);
    let sanitized_ref = sanitize_task_ref_component(task_ref);
    let file_name = format!("{sanitized_ref}.md");
    let repo_absolute = task_brief_root(&project_root).join(&file_name);
    let repo_display = display_path(workspace_path, &repo_absolute);

    let vault_root = resolve_markdown_root(workspace_path, markdown_editor, markdown_editor_path);
    let vault_absolute =
        vault_root.map(|root| task_brief_vault_root(&root, project_id).join(&file_name));
    let vault_display = vault_absolute
        .as_ref()
        .map(|path| display_path(workspace_path, path));

    TaskBriefPaths {
        repo_absolute,
        repo_display,
        vault_absolute,
        vault_display,
    }
}

pub(crate) fn task_brief_root(project_root: &Path) -> PathBuf {
    project_root.join(".conductor").join("tasks")
}

fn task_brief_vault_root(vault_root: &Path, project_id: &str) -> PathBuf {
    vault_root.join("Conductor").join(project_id).join("tasks")
}

fn task_ref_for_storage(task: &BoardTaskRecord) -> String {
    let candidate = task
        .task_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(task.id.as_str());
    sanitize_task_ref_component(candidate)
}

fn sanitize_task_ref_component(value: &str) -> String {
    let mut sanitized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .chars()
        .fold(String::new(), |mut acc, ch| {
            if ch == '-' && acc.ends_with('-') {
                return acc;
            }
            acc.push(ch);
            acc
        });
    sanitized = sanitized.trim_matches('-').to_string();

    if sanitized.is_empty() {
        "task".to_string()
    } else {
        sanitized
    }
}

#[allow(clippy::too_many_arguments)]
fn render_task_brief(
    project_id: &str,
    task_id: &str,
    task_ref: &str,
    title: &str,
    description: Option<&str>,
    notes: Option<&str>,
    attachments: &[String],
    attempt_ref: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("taskRef: {task_ref}\n"));
    out.push_str(&format!("taskId: {task_id}\n"));
    out.push_str(&format!("projectId: {project_id}\n"));
    out.push_str(&format!("updatedAt: {}\n", Utc::now().to_rfc3339()));
    out.push_str("---\n\n");
    out.push_str(&format!("# {task_ref} {title}\n\n"));

    out.push_str("## Objective\n");
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        out.push_str(description.trim());
        out.push_str("\n\n");
    } else {
        out.push_str("- Describe the intended outcome here.\n\n");
    }

    out.push_str("## Board Notes\n");
    if let Some(notes) = notes.filter(|value| !value.trim().is_empty()) {
        out.push_str(notes.trim());
        out.push_str("\n\n");
    } else {
        out.push_str("- Add task-specific guidance, constraints, and edge cases.\n\n");
    }

    out.push_str("## Attachments\n");
    if attachments.is_empty() {
        out.push_str("- Add linked files, screenshots, and references.\n\n");
    } else {
        for attachment in attachments {
            out.push_str(&format!("- {attachment}\n"));
        }
        out.push('\n');
    }

    out.push_str("## Dependencies\n- \n\n");
    out.push_str("## Acceptance Criteria\n- \n\n");
    out.push_str(&format!(
        "## Subtasks\n- Create child pages in `{task_ref}/` when this task needs executable subtasks.\n\n"
    ));
    out.push_str("## Run History\n");
    if let Some(attempt_ref) = attempt_ref.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!("- Latest attempt: {attempt_ref}\n"));
    } else {
        out.push_str("- No runs yet.\n");
    }

    out
}

fn sync_newer_brief(repo_path: &Path, vault_path: &Path) -> Result<()> {
    let repo_modified = std::fs::metadata(repo_path).and_then(|meta| meta.modified())?;
    let vault_modified = std::fs::metadata(vault_path).and_then(|meta| meta.modified())?;

    if repo_modified >= vault_modified {
        copy_if_changed(repo_path, vault_path)?;
    } else {
        copy_if_changed(vault_path, repo_path)?;
    }

    Ok(())
}

fn copy_if_changed(source: &Path, destination: &Path) -> Result<()> {
    let source_content = std::fs::read(source)?;
    let destination_content = std::fs::read(destination).ok();
    if destination_content.as_deref() != Some(source_content.as_slice()) {
        std::fs::write(destination, source_content)?;
    }
    Ok(())
}

fn read_text_preview(path: &Path, limit: usize) -> Result<String> {
    let bytes = std::fs::read(path)?;
    let truncated = &bytes[..bytes.len().min(limit)];
    Ok(String::from_utf8_lossy(truncated).to_string())
}

fn attachment_context_sections(
    state: &AppState,
    attachments: &[String],
    allowed_roots: &[PathBuf],
) -> Vec<String> {
    let mut sections = Vec::new();
    let mut seen = HashSet::new();
    let mut snippets = 0usize;

    for attachment in attachments {
        let trimmed = attachment.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }

        let Some(absolute) = resolve_attachment_path(&state.workspace_path, trimmed) else {
            sections.push(format!("- Missing attachment: {trimmed}"));
            continue;
        };

        if !path_is_within_roots(&absolute, allowed_roots) {
            sections.push(format!("- File attachment: {trimmed}"));
            continue;
        }

        if is_image(&absolute) {
            sections.push(format!("- Image attachment: {trimmed}"));
            continue;
        }

        if snippets >= MAX_ATTACHMENT_SNIPPETS || !looks_text_like(&absolute) {
            sections.push(format!("- File attachment: {trimmed}"));
            continue;
        }

        match read_text_preview(&absolute, MAX_ATTACHMENT_SNIPPET_BYTES) {
            Ok(snippet) => {
                snippets += 1;
                sections.push(format!("File: {trimmed}\n```text\n{}\n```", snippet.trim()));
            }
            Err(_) => {
                sections.push(format!("- File attachment: {trimmed}"));
            }
        }
    }

    sections
}

fn resolve_attachment_path(workspace_root: &Path, value: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(value);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        workspace_root.join(candidate)
    };
    std::fs::canonicalize(resolved).ok()
}

fn attachment_allowed_roots(
    state: &AppState,
    project_id: &str,
    project: &ProjectConfig,
    markdown_editor: &str,
    markdown_editor_path: &str,
) -> Vec<PathBuf> {
    let project_root = resolve_project_path(&state.workspace_path, &project.path);
    let attachments_root = state.workspace_path.join("attachments").join(project_id);
    let brief_root = task_brief_root(&project_root);
    let project_workspace_root = project
        .workspace
        .as_deref()
        .map(|configured| resolve_project_path(&state.workspace_path, configured));
    let markdown_root =
        resolve_markdown_root(&state.workspace_path, markdown_editor, markdown_editor_path);

    let mut roots = vec![
        state.workspace_path.clone(),
        project_root,
        attachments_root,
        brief_root,
    ];
    if let Some(root) = project_workspace_root {
        roots.push(root);
    }
    if let Some(root) = markdown_root {
        roots.push(root);
    }

    roots
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

fn path_is_within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .any(|root| path == root || path.starts_with(root))
}

fn resolve_markdown_root(
    workspace_path: &Path,
    markdown_editor: &str,
    markdown_editor_path: &str,
) -> Option<PathBuf> {
    let configured = markdown_editor_path.trim();
    if configured.is_empty() || markdown_editor.trim().eq_ignore_ascii_case("notion") {
        return None;
    }

    Some(resolve_project_path(workspace_path, configured))
}

fn display_path(workspace_root: &Path, path: &Path) -> String {
    path.strip_prefix(workspace_root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

fn looks_text_like(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "markdown"
            | "txt"
            | "mdx"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "html"
            | "css"
            | "scss"
            | "sql"
            | "sh"
            | "zsh"
    )
}

fn is_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        path_is_within_roots, resolve_attachment_path, resolve_task_brief_paths,
        sanitize_task_ref_component,
    };
    use conductor_core::config::ProjectConfig;
    use std::fs;
    use std::path::{Path, PathBuf};
    use uuid::Uuid;

    #[test]
    fn sanitize_task_ref_component_strips_path_segments_and_dot_runs() {
        assert_eq!(
            sanitize_task_ref_component("../nested\\\\task.ref"),
            "nested-task-ref"
        );
        assert_eq!(sanitize_task_ref_component(".."), "task");
    }

    #[test]
    fn resolve_task_brief_paths_uses_sanitized_file_name() {
        let workspace = Path::new("/workspace");
        let project = ProjectConfig {
            path: "repo".to_string(),
            ..ProjectConfig::default()
        };

        let paths = resolve_task_brief_paths(
            workspace,
            "demo",
            &project,
            "../nested\\\\task.ref",
            "obsidian",
            "/vault",
        );

        assert_eq!(
            paths.repo_absolute,
            Path::new("/workspace/repo/.conductor/tasks/nested-task-ref.md")
        );
        assert_eq!(
            paths.vault_absolute.as_deref(),
            Some(Path::new("/vault/Conductor/demo/tasks/nested-task-ref.md"))
        );
    }

    #[test]
    fn resolve_attachment_path_canonicalizes_workspace_relative_paths() {
        let root = temp_root();
        let workspace = root.join("workspace");
        let nested = workspace.join("docs");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("note.txt");
        fs::write(&file, "hello").unwrap();

        let resolved = resolve_attachment_path(&workspace, "docs/../docs/note.txt");
        assert_eq!(resolved, Some(fs::canonicalize(&file).unwrap()));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_is_within_roots_rejects_canonicalized_paths_outside_allowlist() {
        let root = temp_root();
        let workspace = root.join("workspace");
        let project = root.join("project");
        let outside = root.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let allowed = vec![
            fs::canonicalize(&workspace).unwrap(),
            fs::canonicalize(&project).unwrap(),
        ];
        let outside_file = outside.join("secret.txt");
        fs::write(&outside_file, "nope").unwrap();
        let canonical_outside = fs::canonicalize(&outside_file).unwrap();

        assert!(!path_is_within_roots(&canonical_outside, &allowed));

        fs::remove_dir_all(root).unwrap();
    }

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("conductor-task-context-{}", Uuid::new_v4()))
    }
}
