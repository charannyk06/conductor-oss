use anyhow::Result;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub const BASE_AGENT_PROMPT: &str = r#"You are an AI coding agent managed by Conductor (co).

## CRITICAL: Fully Autonomous Operation
- You are running UNATTENDED. There is NO human watching your terminal.
- NEVER ask the user for input, confirmation, or choices. Make your own decisions.
- NEVER present multiple-choice menus, selection prompts, or "which option do you prefer?" questions.
- If you encounter a decision point (e.g. which tool to install, which approach to take), choose the most reasonable option yourself and proceed.
- If a tool asks for confirmation (y/n), always answer "yes" automatically.
- If you need to install dependencies, install them without asking.
- If you encounter an error, debug and fix it yourself -- do not wait for human input.
- Skip all optional interactive prompts and use defaults.

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If CI fails, the orchestrator will send you the failures -- fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments -- address each one, push fixes, and reply to the comments.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused -- one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Keep the PR title conventional-commit friendly, but write the PR description for humans.
- Include a `## User-Facing Release Notes` section with 1-3 plain-English bullets focused on what users can now do, what got easier, or what was fixed.
- Do not copy commit prefixes, labels, file names, package names, or internal implementation details into `## User-Facing Release Notes`.
- If the change is internal-only, explicitly write `N/A - internal maintenance only` in that section.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.

## MANDATORY: Push and Create PR Before Exiting
- You MUST push your branch and create a pull request before you finish.
- Run: git push -u origin <your-branch> && gh pr create --fill
- If `gh pr create --fill` does not produce the required PR template sections, immediately update the PR body so the final PR includes `Summary`, `User-Facing Release Notes`, `Type of Change`, and `Testing`.
- If gh pr create fails, try: gh pr create --title "feat: <description>" --body "Automated PR from Conductor session"
- Do NOT exit without pushing. If you committed changes but did not push, you have NOT finished.
- The orchestrator considers a task complete ONLY when a PR exists.
- After creating the PR, EXIT immediately. Do NOT check CI, do NOT check reviews, do NOT continue working.
- The orchestrator handles CI monitoring and review routing automatically — that is NOT your job.
- Type /exit or simply stop after the PR is created."#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptBuildConfig {
    pub project: PromptProjectConfig,
    pub project_id: String,
    pub issue_id: Option<String>,
    pub issue_context: Option<String>,
    pub user_prompt: Option<String>,
    pub attachments: Vec<PromptAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptProjectConfig {
    pub path: PathBuf,
    pub name: Option<String>,
    pub repo: Option<String>,
    pub default_branch: String,
    pub tracker: Option<PromptTrackerConfig>,
    pub reactions: BTreeMap<String, PromptReactionConfig>,
    pub agent_rules: Option<String>,
    pub agent_rules_file: Option<String>,
}

impl Default for PromptProjectConfig {
    fn default() -> Self {
        Self {
            path: PathBuf::new(),
            name: None,
            repo: None,
            default_branch: "main".to_string(),
            tracker: None,
            reactions: BTreeMap::new(),
            agent_rules: None,
            agent_rules_file: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptTrackerConfig {
    pub plugin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PromptReactionConfig {
    pub auto: bool,
    pub action: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptAttachmentKind {
    Image,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptAttachment {
    pub path: PathBuf,
    pub reference: Option<String>,
    pub kind: PromptAttachmentKind,
}

pub fn build_prompt(config: &PromptBuildConfig) -> Result<Option<String>> {
    let has_issue = config
        .issue_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let user_rules = read_user_rules(&config.project)?;
    let has_rules = user_rules
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_user_prompt = config
        .user_prompt
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let has_attachments = !config.attachments.is_empty();

    if !has_issue && !has_rules && !has_user_prompt && !has_attachments {
        return Ok(None);
    }

    let mut sections = vec![BASE_AGENT_PROMPT.to_string(), build_config_layer(config)];

    if let Some(user_rules) = user_rules.filter(|value| !value.trim().is_empty()) {
        sections.push(format!("## Project Rules\n{user_rules}"));
    }

    if let Some(user_prompt) = config
        .user_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("## Additional Instructions\n{user_prompt}"));
    }

    if has_attachments {
        sections.push(build_attachment_layer(&config.attachments));
    }

    Ok(Some(sections.join("\n\n")))
}

fn build_config_layer(config: &PromptBuildConfig) -> String {
    let mut lines = Vec::new();

    lines.push("## Project Context".to_string());
    lines.push(format!(
        "- Project: {}",
        config
            .project
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(config.project_id.as_str())
    ));

    if let Some(repo) = config
        .project
        .repo
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("- Repository: {repo}"));
    }

    let default_branch = config.project.default_branch.trim();
    if !default_branch.is_empty() {
        lines.push(format!("- Default branch: {default_branch}"));
    }

    if let Some(plugin) = config
        .project
        .tracker
        .as_ref()
        .map(|tracker| tracker.plugin.trim())
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("- Tracker: {plugin}"));
    }

    if let Some(issue_id) = config
        .issue_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(String::new());
        lines.push("## Task".to_string());
        lines.push(format!("Work on issue: {issue_id}"));
        lines.push(format!(
            "Create a branch named so that it auto-links to the issue tracker (e.g. feat/{issue_id})."
        ));
    }

    if let Some(issue_context) = config
        .issue_context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(String::new());
        lines.push("## Issue Details".to_string());
        lines.push(issue_context.to_string());
    }

    let reaction_hints: Vec<String> = config
        .project
        .reactions
        .iter()
        .filter(|(_, reaction)| reaction.auto && reaction.action == "send-to-agent")
        .map(|(event, _)| format!("- {event}: auto-handled (you'll receive instructions)"))
        .collect();
    if !reaction_hints.is_empty() {
        lines.push(String::new());
        lines.push("## Automated Reactions".to_string());
        lines.push("The orchestrator will automatically handle these events:".to_string());
        lines.extend(reaction_hints);
    }

    lines.join("\n")
}

fn read_user_rules(project: &PromptProjectConfig) -> Result<Option<String>> {
    let mut parts = Vec::new();
    let mut visited = HashSet::new();

    if let Some(rules) = project
        .agent_rules
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expanded = expand_rules_text(rules, &project.path, None, &mut visited)?;
        if !expanded.trim().is_empty() {
            parts.push(expanded);
        }
    }

    if let Some(rules_file) = project
        .agent_rules_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let rules_path = resolve_rules_path(&project.path, None, rules_file);
        if let Some(expanded) = read_rules_file(&project.path, &rules_path, &mut visited)? {
            if !expanded.trim().is_empty() {
                parts.push(expanded);
            }
        }
    }

    if parts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(parts.join("\n\n")))
    }
}

fn expand_rules_text(
    content: &str,
    project_root: &Path,
    source_path: Option<&Path>,
    visited: &mut HashSet<PathBuf>,
) -> Result<String> {
    let mut lines = Vec::new();

    for line in content.lines() {
        if let Some(import_target) = parse_rules_import(line) {
            let import_path = resolve_rules_path(project_root, source_path, import_target);
            if let Some(imported) = read_rules_file(project_root, &import_path, visited)? {
                if !imported.trim().is_empty() {
                    lines.push(imported);
                }
            }
        } else {
            lines.push(line.to_string());
        }
    }

    Ok(lines.join("\n").trim().to_string())
}

fn parse_rules_import(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("@file:") {
        let rest = rest.trim();
        return (!rest.is_empty()).then_some(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("@file ") {
        let rest = rest.trim();
        return (!rest.is_empty()).then_some(rest);
    }
    if let Some(rest) = trimmed.strip_prefix('@') {
        let rest = rest.trim();
        return (!rest.is_empty()).then_some(rest);
    }
    None
}

fn resolve_rules_path(
    project_root: &Path,
    source_path: Option<&Path>,
    import_path: &str,
) -> PathBuf {
    let sanitized = import_path.trim().trim_matches('"').trim_matches('\'');
    let candidate = PathBuf::from(sanitized);
    if candidate.is_absolute() {
        return candidate;
    }

    if let Some(parent) = source_path.and_then(Path::parent) {
        let relative_to_source = parent.join(&candidate);
        if relative_to_source.exists() {
            return relative_to_source;
        }
    }

    project_root.join(candidate)
}

fn read_rules_file(
    project_root: &Path,
    path: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<Option<String>> {
    let canonical = match fs::canonicalize(path) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if !visited.insert(canonical.clone()) {
        return Ok(None);
    }

    let result = match fs::read_to_string(&canonical) {
        Ok(content) => {
            let expanded = expand_rules_text(&content, project_root, Some(&canonical), visited)?;
            if expanded.trim().is_empty() {
                None
            } else {
                Some(expanded)
            }
        }
        Err(_) => None,
    };

    visited.remove(&canonical);
    Ok(result)
}

fn build_attachment_layer(attachments: &[PromptAttachment]) -> String {
    let mut lines = vec![
        "## Reference Attachments".to_string(),
        "The following files were attached to this task as reference material.".to_string(),
        "Read them using the Read tool to understand the visual design or context.".to_string(),
    ];

    let images: Vec<&PromptAttachment> = attachments
        .iter()
        .filter(|attachment| attachment.kind == PromptAttachmentKind::Image)
        .collect();
    let files: Vec<&PromptAttachment> = attachments
        .iter()
        .filter(|attachment| attachment.kind == PromptAttachmentKind::File)
        .collect();

    if !images.is_empty() {
        lines.push(String::new());
        lines.push("### Images (screenshots / mockups / designs)".to_string());
        for attachment in images {
            lines.push(format!(
                "- `{}` — {}",
                attachment.path.display(),
                attachment_name(attachment)
            ));
        }
        lines.push(String::new());
        lines.push("Use the Read tool to view each image file. These are visual references — match your implementation to what you see.".to_string());
    }

    if !files.is_empty() {
        lines.push(String::new());
        lines.push("### Reference Files".to_string());
        for attachment in files {
            lines.push(format!(
                "- `{}` — {}",
                attachment.path.display(),
                attachment_name(attachment)
            ));
        }
    }

    lines.join("\n")
}

fn attachment_name(attachment: &PromptAttachment) -> String {
    attachment
        .path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .or_else(|| attachment.reference.clone())
        .unwrap_or_else(|| attachment.path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "conductor-prompt-tests-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn sample_project(root: &Path) -> PromptProjectConfig {
        PromptProjectConfig {
            path: root.to_path_buf(),
            name: Some("Example".to_string()),
            repo: Some("acme/example".to_string()),
            default_branch: "main".to_string(),
            tracker: Some(PromptTrackerConfig {
                plugin: "github".to_string(),
            }),
            reactions: BTreeMap::from([(
                "ci-failed".to_string(),
                PromptReactionConfig {
                    auto: true,
                    action: "send-to-agent".to_string(),
                },
            )]),
            agent_rules: None,
            agent_rules_file: None,
        }
    }

    #[test]
    fn build_prompt_returns_none_when_no_layers_are_present() {
        let temp_dir = TestDir::new();
        let config = PromptBuildConfig {
            project: PromptProjectConfig {
                path: temp_dir.path().to_path_buf(),
                ..PromptProjectConfig::default()
            },
            project_id: "example".to_string(),
            issue_id: None,
            issue_context: None,
            user_prompt: None,
            attachments: Vec::new(),
        };

        assert!(build_prompt(&config).unwrap().is_none());
    }

    #[test]
    fn build_prompt_includes_base_context_rules_and_attachments() {
        let temp_dir = TestDir::new();
        let rules_path = temp_dir.path().join("RULES.md");
        fs::write(&rules_path, "Follow the project style guide.").unwrap();
        let attachment_path = temp_dir.path().join("mock.png");
        fs::write(&attachment_path, "img").unwrap();

        let config = PromptBuildConfig {
            project: PromptProjectConfig {
                agent_rules: Some("Always add tests.".to_string()),
                agent_rules_file: Some("RULES.md".to_string()),
                ..sample_project(temp_dir.path())
            },
            project_id: "example".to_string(),
            issue_id: Some("INT-42".to_string()),
            issue_context: Some("The login flow regressed.".to_string()),
            user_prompt: Some("Fix the failing login flow.".to_string()),
            attachments: vec![PromptAttachment {
                path: attachment_path,
                reference: Some("![[mock.png]]".to_string()),
                kind: PromptAttachmentKind::Image,
            }],
        };

        let prompt = build_prompt(&config).unwrap().unwrap();
        assert!(prompt.contains(BASE_AGENT_PROMPT));
        assert!(prompt.contains("## Project Context"));
        assert!(prompt.contains("Project: Example"));
        assert!(prompt.contains("Repository: acme/example"));
        assert!(prompt.contains("Work on issue: INT-42"));
        assert!(prompt.contains("The login flow regressed."));
        assert!(prompt.contains("Always add tests."));
        assert!(prompt.contains("Follow the project style guide."));
        assert!(prompt.contains("## Additional Instructions\nFix the failing login flow."));
        assert!(prompt.contains("## Reference Attachments"));
        assert!(prompt.contains("mock.png"));
    }

    #[test]
    fn build_prompt_expands_nested_file_imports() {
        let temp_dir = TestDir::new();
        fs::create_dir_all(temp_dir.path().join("rules")).unwrap();
        fs::write(
            temp_dir.path().join("rules").join("root.md"),
            "Rule A\n@nested.md\nRule B",
        )
        .unwrap();
        fs::write(
            temp_dir.path().join("rules").join("nested.md"),
            "Nested 1\n@file:deep.md\nNested 2",
        )
        .unwrap();
        fs::write(temp_dir.path().join("rules").join("deep.md"), "Deep rule").unwrap();

        let config = PromptBuildConfig {
            project: PromptProjectConfig {
                agent_rules_file: Some("rules/root.md".to_string()),
                ..sample_project(temp_dir.path())
            },
            project_id: "example".to_string(),
            issue_id: Some("INT-77".to_string()),
            issue_context: None,
            user_prompt: None,
            attachments: Vec::new(),
        };

        let prompt = build_prompt(&config).unwrap().unwrap();
        assert!(prompt.contains("Rule A"));
        assert!(prompt.contains("Nested 1"));
        assert!(prompt.contains("Deep rule"));
        assert!(prompt.contains("Nested 2"));
        assert!(prompt.contains("Rule B"));
    }

    #[test]
    fn build_prompt_skips_missing_rule_files() {
        let temp_dir = TestDir::new();
        let config = PromptBuildConfig {
            project: PromptProjectConfig {
                agent_rules: Some("@missing.md".to_string()),
                agent_rules_file: Some("RULES.md".to_string()),
                ..sample_project(temp_dir.path())
            },
            project_id: "example".to_string(),
            issue_id: Some("INT-88".to_string()),
            issue_context: None,
            user_prompt: None,
            attachments: Vec::new(),
        };

        let prompt = build_prompt(&config).unwrap().unwrap();
        assert!(prompt.contains("## Project Context"));
        assert!(!prompt.contains("## Project Rules"));
    }

    #[test]
    fn build_prompt_avoids_recursive_import_cycles() {
        let temp_dir = TestDir::new();
        fs::write(temp_dir.path().join("a.md"), "@b.md\nRule A").unwrap();
        fs::write(temp_dir.path().join("b.md"), "@a.md\nRule B").unwrap();

        let config = PromptBuildConfig {
            project: PromptProjectConfig {
                agent_rules_file: Some("a.md".to_string()),
                ..sample_project(temp_dir.path())
            },
            project_id: "example".to_string(),
            issue_id: Some("INT-99".to_string()),
            issue_context: None,
            user_prompt: None,
            attachments: Vec::new(),
        };

        let prompt = build_prompt(&config).unwrap().unwrap();
        assert_eq!(prompt.matches("Rule A").count(), 1);
        assert_eq!(prompt.matches("Rule B").count(), 1);
    }
}
