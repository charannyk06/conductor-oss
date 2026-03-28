use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;

use crate::state::AppState;
use conductor_core::types::AgentKind;

// ---------------------------------------------------------------------------
// Known agents registry — must match packages/web/src/lib/knownAgents.ts
// ---------------------------------------------------------------------------

struct KnownAgentInfo {
    name: &'static str,
    label: &'static str,
    description: &'static str,
    homepage: &'static str,
    icon_url: &'static str,
    install_hint: &'static str,
    install_url: &'static str,
    setup_url: &'static str,
}

static KNOWN_AGENTS: &[KnownAgentInfo] = &[
    KnownAgentInfo {
        name: "codex",
        label: "Codex",
        description: "OpenAI Codex CLI",
        homepage: "https://github.com/openai/codex",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
        install_hint: "npm install -g @openai/codex",
        install_url: "https://github.com/openai/codex",
        setup_url: "https://chatgpt.com/codex",
    },
    KnownAgentInfo {
        name: "gemini",
        label: "Gemini",
        description: "Google Gemini CLI",
        homepage: "https://ai.google.dev/gemini-api/docs",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
        install_hint: "npm install -g @google/gemini-cli",
        install_url: "https://ai.google.dev/gemini-api/docs",
        setup_url: "https://aistudio.google.com/",
    },
    KnownAgentInfo {
        name: "qwen-code",
        label: "Qwen Code",
        description: "Qwen Code CLI",
        homepage: "https://qwenlm.github.io/announcements/",
        icon_url: "",
        install_hint: "npm install -g @qwen-code/qwen-code@latest",
        install_url: "https://qwenlm.github.io/announcements/",
        setup_url: "https://chat.qwen.ai/",
    },
    KnownAgentInfo {
        name: "droid",
        label: "Droid",
        description: "Factory Droid CLI",
        homepage: "https://github.com/Factory-AI/factory",
        icon_url: "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
        install_hint: "npm install -g @factory/cli",
        install_url: "https://github.com/Factory-AI/factory",
        setup_url: "",
    },
    KnownAgentInfo {
        name: "claude-code",
        label: "Claude Code",
        description: "Claude Code CLI",
        homepage: "https://www.anthropic.com/claude",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        install_hint: "npm install -g @anthropic-ai/claude-code",
        install_url: "https://www.anthropic.com/claude-code",
        setup_url: "https://claude.ai/",
    },
    KnownAgentInfo {
        name: "amp",
        label: "Amp",
        description: "Amp Code CLI",
        homepage: "https://www.ampcode.com",
        icon_url: "https://ampcode.com/amp-mark-color.svg",
        install_hint: "npm install -g @sourcegraph/amp",
        install_url: "https://www.ampcode.com",
        setup_url: "",
    },
    KnownAgentInfo {
        name: "opencode",
        label: "OpenCode",
        description: "OpenCode CLI",
        homepage: "https://opencode.ai",
        icon_url: "",
        install_hint: "npm install -g opencode-ai",
        install_url: "https://opencode.ai",
        setup_url: "",
    },
    KnownAgentInfo {
        name: "github-copilot",
        label: "GitHub Copilot",
        description: "GitHub Copilot CLI",
        homepage: "https://docs.github.com/copilot/how-tos/copilot-cli",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
        install_hint: "npm install -g @github/copilot",
        install_url: "https://docs.github.com/copilot/how-tos/copilot-cli",
        setup_url: "https://github.com/settings/copilot",
    },
    KnownAgentInfo {
        name: "cursor-cli",
        label: "Cursor Agent",
        description: "Cursor Agent CLI",
        homepage: "https://www.cursor.com",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
        install_hint: "npm install -g cursor-agent",
        install_url: "https://www.cursor.com",
        setup_url: "",
    },
    KnownAgentInfo {
        name: "ccr",
        label: "CCR",
        description: "Claude Code Router",
        homepage: "https://www.npmjs.com/package/@musistudio/claude-code-router",
        icon_url: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        install_hint: "npm install -g @musistudio/claude-code-router",
        install_url: "https://www.npmjs.com/package/@musistudio/claude-code-router",
        setup_url: "",
    },
];

fn normalize_agent_name(name: &str) -> String {
    name.trim().to_lowercase().replace(['_', ' '], "-")
}

#[allow(dead_code)]
fn known_agent_order(name: &str) -> usize {
    let normalized = normalize_agent_name(name);
    KNOWN_AGENTS
        .iter()
        .position(|a| normalize_agent_name(a.name) == normalized)
        .unwrap_or(usize::MAX)
}

fn or_null(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/agents", get(list_agents))
}

// ---------------------------------------------------------------------------
// Handler — merges known agents with installed executors
// ---------------------------------------------------------------------------

async fn list_agents(State(state): State<Arc<AppState>>) -> Json<Value> {
    let executor_entries: Vec<(AgentKind, PathBuf)> = {
        let executors = state.executors.read().await;
        executors
            .iter()
            .map(|(kind, executor)| (kind.clone(), executor.binary_path().to_path_buf()))
            .collect()
    };

    let mut installed_map: HashMap<String, (AgentKind, PathBuf)> = HashMap::new();
    for (kind, binary_path) in &executor_entries {
        installed_map.insert(
            normalize_agent_name(&kind.to_string()),
            (kind.clone(), binary_path.clone()),
        );
    }

    let mut agents: Vec<Value> = Vec::with_capacity(KNOWN_AGENTS.len() + 2);
    let mut seen = HashSet::new();

    // Iterate known agents in order
    for known in KNOWN_AGENTS {
        let normalized = normalize_agent_name(known.name);
        seen.insert(normalized.clone());

        let (installed, configured, ready, catalog, binary) = if let Some((_kind, binary_path)) =
            installed_map.get(&normalized)
        {
            let catalog = build_runtime_model_catalog_for_name(known.name, Some(binary_path)).await;
            (
                true,
                true,
                true,
                catalog,
                json!(binary_path.display().to_string()),
            )
        } else {
            let catalog = build_runtime_model_catalog_for_name(known.name, None).await;
            (false, false, false, catalog, Value::Null)
        };

        agents.push(json!({
            "name": known.name,
            "label": known.label,
            "description": known.description,
            "installed": installed,
            "configured": configured,
            "ready": ready,
            "homepage": or_null(known.homepage),
            "iconUrl": or_null(known.icon_url),
            "installHint": or_null(known.install_hint),
            "installUrl": or_null(known.install_url),
            "setupUrl": or_null(known.setup_url),
            "version": Value::Null,
            "binary": binary,
            "runtimeModelCatalog": catalog,
        }));
    }

    // Append any installed agents not in KNOWN_AGENTS (e.g. custom agents)
    for (kind, binary_path) in &executor_entries {
        let normalized = normalize_agent_name(&kind.to_string());
        if seen.contains(&normalized) {
            continue;
        }
        let (description, homepage, icon_url) = agent_metadata(kind);
        let catalog =
            build_runtime_model_catalog_for_name(&kind.to_string(), Some(binary_path)).await;

        agents.push(json!({
            "name": kind.to_string(),
            "label": Value::Null,
            "description": description,
            "installed": true,
            "configured": true,
            "ready": true,
            "homepage": if homepage.is_empty() { Value::Null } else { json!(homepage) },
            "iconUrl": if icon_url.is_empty() { Value::Null } else { json!(icon_url) },
            "installHint": Value::Null,
            "installUrl": Value::Null,
            "setupUrl": Value::Null,
            "version": Value::Null,
            "binary": binary_path.display().to_string(),
            "runtimeModelCatalog": catalog,
        }));
    }

    Json(json!({ "agents": agents }))
}

// ---------------------------------------------------------------------------
// Agent metadata (moved from config.rs)
// ---------------------------------------------------------------------------

fn agent_metadata(kind: &AgentKind) -> (&'static str, &'static str, &'static str) {
    match kind {
        AgentKind::ClaudeCode => (
            "Claude Code CLI",
            "https://www.anthropic.com/claude",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        ),
        AgentKind::Codex => (
            "OpenAI Codex CLI",
            "https://github.com/openai/codex",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
        ),
        AgentKind::Gemini => (
            "Google Gemini CLI",
            "https://ai.google.dev/gemini-api/docs",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
        ),
        AgentKind::Amp => (
            "Amp Code CLI",
            "https://www.ampcode.com",
            "https://ampcode.com/amp-mark-color.svg",
        ),
        AgentKind::CursorCli => (
            "Cursor Agent CLI",
            "https://www.cursor.com",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
        ),
        AgentKind::OpenCode => ("OpenCode CLI", "https://opencode.ai", ""),
        AgentKind::Droid => (
            "Factory Droid CLI",
            "https://github.com/Factory-AI/factory",
            "https://raw.githubusercontent.com/Factory-AI/factory/main/docs/images/droid_logo_cli.png",
        ),
        AgentKind::QwenCode => (
            "Qwen Code CLI",
            "https://qwenlm.github.io/announcements/",
            "",
        ),
        AgentKind::Ccr => (
            "Claude Code Router",
            "https://www.npmjs.com/package/@musistudio/claude-code-router",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
        ),
        AgentKind::GithubCopilot => (
            "GitHub Copilot CLI",
            "https://docs.github.com/copilot/how-tos/copilot-cli",
            "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
        ),
        AgentKind::Custom(_) => ("Custom agent", "", ""),
    }
}

// ---------------------------------------------------------------------------
// Runtime model catalog dispatch
// ---------------------------------------------------------------------------

async fn build_runtime_model_catalog_for_name(name: &str, binary_path: Option<&Path>) -> Value {
    let normalized = normalize_agent_name(name);
    match normalized.as_str() {
        "claude-code" | "claude" => {
            if let Some(bp) = binary_path {
                build_claude_runtime_model_catalog(bp)
                    .await
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        "codex" => build_codex_runtime_model_catalog()
            .await
            .unwrap_or(Value::Null),
        "gemini" => build_gemini_runtime_model_catalog()
            .await
            .unwrap_or(Value::Null),
        "amp" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_amp_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        "cursor-cli" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_cursor_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        "droid" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_droid_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        "opencode" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_opencode_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        "github-copilot" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_copilot_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        "qwen-code" => build_qwen_runtime_model_catalog()
            .await
            .unwrap_or(Value::Null),
        "ccr" => {
            let bp = binary_path.map(Path::to_path_buf);
            build_ccr_runtime_model_catalog(bp.as_deref())
                .await
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn user_home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn read_json_file(path: PathBuf) -> Option<Value> {
    let contents = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn read_text_file(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

async fn read_command_output(commands: &[&str], args: &[&str]) -> Option<String> {
    for cmd in commands {
        let result = tokio::time::timeout(
            Duration::from_millis(3_000),
            Command::new(cmd).args(args).output(),
        )
        .await
        .ok()
        .and_then(Result::ok);

        if let Some(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}").trim().to_string();
            if !combined.is_empty() {
                return Some(combined);
            }
        }
    }
    None
}

async fn read_command_help(commands: &[&str]) -> Option<String> {
    for cmd in commands {
        let result = tokio::time::timeout(
            Duration::from_millis(1_500),
            Command::new(cmd).arg("--help").output(),
        )
        .await
        .ok()
        .and_then(Result::ok);

        if let Some(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}").trim().to_string();
            if !combined.is_empty() {
                return Some(combined);
            }
        }
    }
    None
}

async fn read_command_output_invocations(
    invocations: &[(String, Vec<String>)],
    timeout_ms: u64,
) -> Option<String> {
    for (command, args) in invocations {
        let result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            Command::new(command).args(args).output(),
        )
        .await
        .ok()
        .and_then(Result::ok);

        if let Some(output) = result {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}").trim().to_string();
            if !combined.is_empty() {
                return Some(combined);
            }
        }
    }
    None
}

fn extract_quoted_choices_from_help(help: &str, option_name: &str) -> Vec<String> {
    let escaped = regex::escape(option_name);
    let matcher = Regex::new(&format!(r#"{escaped}[\s\S]*?\(choices:\s*([^)]+)\)"#)).ok();
    let quoted = Regex::new(r#""([^"]+)""#).ok();
    let (Some(matcher), Some(quoted)) = (matcher, quoted) else {
        return Vec::new();
    };
    let Some(choice_block) = matcher
        .captures(help)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str())
    else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    quoted
        .captures_iter(choice_block)
        .filter_map(|capture| {
            capture
                .get(1)
                .map(|value| value.as_str().trim().to_string())
        })
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn preferred_choice(values: &[String], preferred: &[&str]) -> Option<String> {
    preferred.iter().find_map(|candidate| {
        values
            .iter()
            .find(|value| value.eq_ignore_ascii_case(candidate))
            .cloned()
    })
}

fn is_cursor_wrapper_binary(path: &Path) -> bool {
    path.file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cursor"))
}

fn parse_cursor_models_output(output: &str) -> (Vec<Value>, Option<String>) {
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    let mut current_model = None;
    let mut default_model = None;

    for raw_line in output.lines() {
        let Some((raw_id, raw_label)) = raw_line.split_once(" - ") else {
            continue;
        };

        let id = raw_id.trim();
        if id.is_empty() || id.eq_ignore_ascii_case("available models") || id.contains(' ') {
            continue;
        }

        let mut label = raw_label.trim().to_string();
        let mut is_current = false;
        let mut is_default = false;

        loop {
            let trimmed = label.trim_end();
            if let Some(stripped) = trimmed.strip_suffix("(current)") {
                is_current = true;
                label = stripped.trim_end().to_string();
                continue;
            }
            if let Some(stripped) = trimmed.strip_suffix("(default)") {
                is_default = true;
                label = stripped.trim_end().to_string();
                continue;
            }
            break;
        }

        if !seen.insert(id.to_string()) {
            continue;
        }

        let resolved_label = if label.trim().is_empty() {
            format_generic_model_label(id)
        } else {
            label.trim().to_string()
        };
        models.push(model_option(
            id,
            &resolved_label,
            &format!("Model exposed by the local Cursor Agent CLI ({id})."),
            &["default"],
        ));

        if is_current {
            current_model = Some(id.to_string());
        }
        if is_default {
            default_model = Some(id.to_string());
        }
    }

    let selected_model = current_model.or(default_model).or_else(|| {
        models
            .first()
            .and_then(|model| model["id"].as_str().map(str::to_string))
    });

    (models, selected_model)
}

/// Scan a directory for files matching the given extension, up to max_depth.
/// Returns file contents sorted by modification time (newest first), limited to max_files.
fn collect_recent_file_contents(
    root: &Path,
    extensions: &[&str],
    max_depth: usize,
    max_files: usize,
) -> Vec<String> {
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    collect_files_recursive(root, extensions, 0, max_depth, &mut files, 64);
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
        .into_iter()
        .take(max_files)
        .filter_map(|(path, _)| std::fs::read_to_string(path).ok())
        .collect()
}

fn collect_files_recursive(
    dir: &Path,
    extensions: &[&str],
    depth: usize,
    max_depth: usize,
    results: &mut Vec<(PathBuf, std::time::SystemTime)>,
    max_dirs: usize,
) {
    if depth > max_depth || results.len() > max_dirs * 3 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, extensions, depth + 1, max_depth, results, max_dirs);
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                        results.push((path, mtime));
                    }
                }
            }
        }
    }
}

/// Extract unique regex capture group 1 matches from file contents.
fn extract_regex_matches_from_contents(contents: &[String], pattern: &Regex) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut matches = Vec::new();
    for content in contents {
        for cap in pattern.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let value = m.as_str().trim().to_string();
                if !value.is_empty() && seen.insert(value.clone()) {
                    matches.push(value);
                }
            }
        }
    }
    matches
}

fn format_reasoning_label(effort: &str) -> String {
    let normalized = effort.trim().to_lowercase();
    if normalized == "xhigh" {
        return "Extra High".to_string();
    }
    normalized
        .split(['_', ' ', '-'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn reasoning_description(effort: &str) -> &'static str {
    match effort.trim().to_lowercase().as_str() {
        "minimal" => "Minimal deliberate reasoning for the fastest supported responses.",
        "low" => "Fast responses with lighter reasoning.",
        "medium" => "Balanced speed and reasoning depth for everyday tasks.",
        "high" => "Deeper reasoning for more complex tasks.",
        "max" => "Maximum deliberate reasoning supported by the local CLI.",
        "off" | "none" => "Disable explicit reasoning and use the model's fastest path.",
        "xhigh" => "Maximum reasoning depth for the hardest tasks.",
        _ => "Reasoning effort supported by the local CLI.",
    }
}

fn reasoning_option(effort: &str) -> Value {
    let normalized = effort.trim().to_lowercase();
    json!({
        "id": normalized,
        "label": format_reasoning_label(&normalized),
        "description": reasoning_description(&normalized),
    })
}

fn model_option(id: &str, label: &str, description: &str, access: &[&str]) -> Value {
    json!({
        "id": id,
        "label": label,
        "description": description,
        "access": access,
    })
}

fn default_access_catalog(
    agent: &str,
    models: Vec<Value>,
    default_model: Option<&str>,
    placeholder: Option<&str>,
    reasoning_options: Vec<Value>,
    default_reasoning: Option<&str>,
) -> Option<Value> {
    let resolved_default = default_model
        .or_else(|| models.first().and_then(|m| m["id"].as_str()))
        .map(String::from);
    let resolved_placeholder = placeholder
        .map(String::from)
        .or_else(|| resolved_default.clone())
        .unwrap_or_default();

    let mut catalog = json!({
        "agent": agent,
        "customModelPlaceholder": resolved_placeholder,
        "defaultModelByAccess": {},
        "modelsByAccess": {},
    });

    if let Some(def) = &resolved_default {
        catalog["defaultModelByAccess"]["default"] = json!(def);
    }
    if !models.is_empty() {
        catalog["modelsByAccess"]["default"] = json!(models);
    }
    if !reasoning_options.is_empty() {
        catalog["reasoningOptionsByAccess"] = json!({ "default": reasoning_options });
    }
    if let Some(def) = default_reasoning {
        catalog["defaultReasoningByAccess"] = json!({ "default": def });
    }

    Some(catalog)
}

fn format_generic_model_label(raw: &str) -> String {
    raw.trim()
        .split(['/', ':', '_', '-'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            let lower = part.to_lowercase();
            if lower == "gpt" {
                return "GPT".to_string();
            }
            if lower == "api" {
                return "API".to_string();
            }
            if part.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return part.to_string();
            }
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Claude Code catalog (moved from config.rs)
// ---------------------------------------------------------------------------

fn format_claude_model_label(model: &str) -> String {
    let normalized = model.trim().to_lowercase();
    if normalized == "opus" {
        return "Claude Opus".to_string();
    }
    if normalized == "sonnet" {
        return "Claude Sonnet".to_string();
    }
    if normalized == "haiku" {
        return "Claude Haiku".to_string();
    }

    let parts = normalized.split('-').collect::<Vec<_>>();
    if parts.len() >= 4 && parts[0] == "claude" {
        let family = parts[1];
        if ["sonnet", "opus", "haiku"].contains(&family) {
            return format!(
                "Claude {} {}.{}",
                family[..1].to_uppercase() + &family[1..],
                parts[2],
                parts[3]
            );
        }
    }

    normalized
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn claude_access_for_model(model: &str) -> Vec<&'static str> {
    let normalized = model.trim().to_lowercase();
    if normalized == "opus" || normalized.contains("claude-opus") {
        return vec!["max", "api"];
    }
    if normalized == "haiku" || normalized.contains("claude-haiku") {
        return vec!["pro", "max", "api"];
    }
    vec!["pro", "max", "api"]
}

fn claude_model_option(model: &str, description: &str) -> Value {
    json!({
        "id": model,
        "label": format_claude_model_label(model),
        "description": description,
        "access": claude_access_for_model(model),
    })
}

fn collect_claude_stats_models(stats: &Value) -> Vec<String> {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let entries = stats
        .get("dailyModelTokens")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for entry in entries.into_iter().rev() {
        let Some(tokens_by_model) = entry.get("tokensByModel").and_then(Value::as_object) else {
            continue;
        };
        for model in tokens_by_model.keys() {
            let normalized = model.trim();
            if !normalized.starts_with("claude-") || !seen.insert(normalized.to_string()) {
                continue;
            }
            ordered.push(normalized.to_string());
        }
    }

    ordered
}

async fn detect_claude_reasoning_options(binary_path: &Path) -> Vec<Value> {
    let output = tokio::time::timeout(
        Duration::from_millis(1_500),
        Command::new(binary_path).arg("--help").output(),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let combined = output
        .map(|result| {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);
            format!("{stdout}\n{stderr}")
        })
        .unwrap_or_default();

    let Some(line) = combined.lines().find(|line| line.contains("--effort")) else {
        return Vec::new();
    };
    let Some(start) = line.find('(') else {
        return Vec::new();
    };
    let Some(end) = line[start + 1..].find(')') else {
        return Vec::new();
    };

    line[start + 1..start + 1 + end]
        .split(',')
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .map(|effort| reasoning_option(&effort))
        .collect()
}

fn resolve_claude_configured_model(
    configured_model: Option<&str>,
    available_models: &[String],
    family: &str,
) -> Option<String> {
    let normalized = configured_model?.trim().to_lowercase();
    if available_models.contains(&normalized) {
        return Some(normalized);
    }
    if normalized == family {
        return available_models
            .iter()
            .find(|model| model.to_lowercase().contains(&format!("claude-{family}")))
            .cloned();
    }
    None
}

async fn build_claude_runtime_model_catalog(binary_path: &Path) -> Option<Value> {
    let home_dir = user_home_dir()?;
    let settings = read_json_file(home_dir.join(".claude").join("settings.json"));
    let stats = read_json_file(home_dir.join(".claude").join("stats-cache.json"));
    let reasoning_options = detect_claude_reasoning_options(binary_path).await;
    let discovered_models = collect_claude_stats_models(stats.as_ref().unwrap_or(&Value::Null));
    let configured_model = settings
        .as_ref()
        .and_then(|s| s.get("model"))
        .and_then(Value::as_str)
        .map(|v| v.trim().to_lowercase());

    let all_models = if discovered_models.is_empty() {
        vec![configured_model
            .clone()
            .unwrap_or_else(|| "sonnet".to_string())]
    } else {
        discovered_models.clone()
    };

    let pro_models: Vec<_> = all_models
        .iter()
        .filter(|m| claude_access_for_model(m).contains(&"pro"))
        .cloned()
        .collect();
    let max_models: Vec<_> = all_models
        .iter()
        .filter(|m| claude_access_for_model(m).contains(&"max"))
        .cloned()
        .collect();
    let api_models: Vec<_> = all_models
        .iter()
        .filter(|m| claude_access_for_model(m).contains(&"api"))
        .cloned()
        .collect();

    let pro_default =
        resolve_claude_configured_model(configured_model.as_deref(), &pro_models, "sonnet")
            .or_else(|| pro_models.first().cloned());
    let max_default =
        resolve_claude_configured_model(configured_model.as_deref(), &max_models, "opus")
            .or_else(|| {
                max_models
                    .iter()
                    .find(|m| m.contains("claude-opus"))
                    .cloned()
            })
            .or_else(|| max_models.first().cloned());
    let api_default =
        resolve_claude_configured_model(configured_model.as_deref(), &api_models, "sonnet")
            .or_else(|| api_models.first().cloned());

    let default_reasoning = settings
        .as_ref()
        .and_then(|s| s.get("alwaysThinkingEnabled"))
        .and_then(Value::as_bool)
        .map(|enabled| if enabled { "high" } else { "medium" })
        .unwrap_or("medium");

    Some(json!({
        "agent": "claude-code",
        "customModelPlaceholder": configured_model.clone().unwrap_or_else(|| all_models[0].clone()),
        "defaultModelByAccess": {
            "pro": pro_default,
            "max": max_default,
            "api": api_default,
        },
        "modelsByAccess": {
            "pro": pro_models.iter().map(|m| claude_model_option(m, &format!("Model discovered from the local Claude Code installation ({m})."))).collect::<Vec<_>>(),
            "max": max_models.iter().map(|m| claude_model_option(m, &format!("Model discovered from the local Claude Code installation ({m})."))).collect::<Vec<_>>(),
            "api": api_models.iter().map(|m| claude_model_option(m, &format!("Model discovered from the local Claude Code installation ({m})."))).collect::<Vec<_>>(),
        },
        "defaultReasoningByAccess": {
            "pro": default_reasoning,
            "max": default_reasoning,
            "api": default_reasoning,
        },
        "reasoningOptionsByAccess": if reasoning_options.is_empty() {
            Value::Null
        } else {
            json!({
                "pro": reasoning_options,
                "max": reasoning_options,
                "api": reasoning_options,
            })
        },
    }))
}

// ---------------------------------------------------------------------------
// Codex catalog — reads ~/.codex/models_cache.json + ~/.codex/config.toml
// ---------------------------------------------------------------------------

fn format_codex_model_label(raw: &str) -> String {
    raw.trim()
        .split('-')
        .filter(|p| !p.is_empty())
        .map(|part| {
            let lower = part.to_lowercase();
            match lower.as_str() {
                "gpt" => "GPT".to_string(),
                "codex" => "Codex".to_string(),
                "spark" => "Spark".to_string(),
                "mini" => "Mini".to_string(),
                "max" => "Max".to_string(),
                _ => {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

async fn build_codex_runtime_model_catalog() -> Option<Value> {
    let home = user_home_dir()?;
    let cache_path = home.join(".codex").join("models_cache.json");
    let cache = read_json_file(cache_path)?;

    // Read configured model/reasoning from config.toml
    let config_path = home.join(".codex").join("config.toml");
    let config_contents = read_text_file(&config_path).unwrap_or_default();
    let configured_model = Regex::new(r#"(?m)^\s*model\s*=\s*"([^"]+)"\s*$"#)
        .ok()
        .and_then(|re| re.captures(&config_contents))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string());
    let _configured_reasoning = Regex::new(r#"(?m)^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$"#)
        .ok()
        .and_then(|re| re.captures(&config_contents))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_lowercase());

    let models = cache.get("models").and_then(Value::as_array)?;

    // Filter to listed models, sorted by priority
    let mut listed: Vec<(usize, &Value)> = models
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .collect();
    listed.sort_by(|a, b| {
        let ap =
            a.1.get("priority")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MAX);
        let bp =
            b.1.get("priority")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MAX);
        ap.partial_cmp(&bp)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });

    if listed.is_empty() {
        return None;
    }

    let mut chatgpt_models = Vec::new();
    let mut api_models = Vec::new();
    let mut reasoning_by_model: HashMap<String, Vec<Value>> = HashMap::new();
    let mut default_reasoning_by_model: HashMap<String, String> = HashMap::new();

    for (_, entry) in &listed {
        let slug = entry
            .get("slug")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if slug.is_empty() {
            continue;
        }
        let display = entry
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(slug);
        let label = format_codex_model_label(display);
        let desc = entry
            .get("description")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("Model exposed by the local Codex installation ({slug})."));

        let api_supported = entry
            .get("supported_in_api")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let chatgpt_opt = model_option(slug, &label, &desc, &["chatgpt"]);
        let api_opt = model_option(slug, &label, &desc, &["chatgpt", "api"]);

        chatgpt_models.push(chatgpt_opt);
        if api_supported {
            api_models.push(api_opt);
        }

        // Reasoning options per model
        if let Some(levels) = entry
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
        {
            let options: Vec<Value> = levels
                .iter()
                .filter_map(|l| {
                    let effort = l
                        .get("effort")
                        .and_then(Value::as_str)?
                        .trim()
                        .to_lowercase();
                    let desc = l.get("description").and_then(Value::as_str);
                    Some(json!({
                        "id": effort,
                        "label": format_reasoning_label(&effort),
                        "description": desc.unwrap_or(reasoning_description(&effort)),
                    }))
                })
                .collect();
            if !options.is_empty() {
                reasoning_by_model.insert(slug.to_string(), options);
            }
            if let Some(default) = entry.get("default_reasoning_level").and_then(Value::as_str) {
                let normalized = default.trim().to_lowercase();
                if !normalized.is_empty() {
                    default_reasoning_by_model.insert(slug.to_string(), normalized);
                }
            }
        }
    }

    let chatgpt_default = configured_model
        .as_deref()
        .filter(|m| chatgpt_models.iter().any(|cm| cm["id"].as_str() == Some(m)))
        .or_else(|| chatgpt_models.first().and_then(|m| m["id"].as_str()))
        .map(String::from);
    let api_default = configured_model
        .as_deref()
        .filter(|m| api_models.iter().any(|am| am["id"].as_str() == Some(m)))
        .or_else(|| api_models.first().and_then(|m| m["id"].as_str()))
        .map(String::from);

    let placeholder = configured_model
        .as_deref()
        .or_else(|| chatgpt_models.first().and_then(|m| m["id"].as_str()))
        .unwrap_or("")
        .to_string();

    let mut catalog = json!({
        "agent": "codex",
        "customModelPlaceholder": placeholder,
        "defaultModelByAccess": {},
        "modelsByAccess": {
            "chatgpt": chatgpt_models,
            "api": api_models,
        },
    });

    if let Some(def) = &chatgpt_default {
        catalog["defaultModelByAccess"]["chatgpt"] = json!(def);
    }
    if let Some(def) = &api_default {
        catalog["defaultModelByAccess"]["api"] = json!(def);
    }
    if !reasoning_by_model.is_empty() {
        catalog["reasoningOptionsByModel"] = json!(reasoning_by_model);
    }
    if !default_reasoning_by_model.is_empty() {
        catalog["defaultReasoningByModel"] = json!(default_reasoning_by_model);
    }

    // Default reasoning by access
    let mut default_reasoning_by_access = serde_json::Map::new();
    if let Some(chatgpt_def_model) = &chatgpt_default {
        if let Some(def_reasoning) = default_reasoning_by_model.get(chatgpt_def_model) {
            default_reasoning_by_access.insert("chatgpt".to_string(), json!(def_reasoning));
        }
    }
    if let Some(api_def_model) = &api_default {
        if let Some(def_reasoning) = default_reasoning_by_model.get(api_def_model) {
            default_reasoning_by_access.insert("api".to_string(), json!(def_reasoning));
        }
    }
    if !default_reasoning_by_access.is_empty() {
        catalog["defaultReasoningByAccess"] = Value::Object(default_reasoning_by_access);
    }

    Some(catalog)
}

// ---------------------------------------------------------------------------
// Gemini catalog — reads ~/.gemini/settings.json + scans for model names
// ---------------------------------------------------------------------------

fn format_gemini_model_label(model: &str) -> String {
    model
        .trim()
        .split(['-', '_'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            if part.chars().all(|c| c.is_ascii_digit() || c == '.') {
                return part.to_string();
            }
            {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn build_gemini_runtime_model_catalog() -> Option<Value> {
    let home = user_home_dir()?;
    let gemini_dir = home.join(".gemini");

    // Try to discover models from local files
    let contents = collect_recent_file_contents(&gemini_dir, &["json", "jsonl"], 4, 12);
    let pattern = Regex::new(r#""(?:model|modelVersion)"\s*:\s*"([^"]+)""#).ok()?;
    let discovered = extract_regex_matches_from_contents(&contents, &pattern);

    if discovered.is_empty() {
        return None;
    }

    let runtime_models: Vec<Value> = discovered
        .iter()
        .map(|m| {
            let desc = format!("Model discovered from the local Gemini CLI installation ({m}).");
            model_option(m, &format_gemini_model_label(m), &desc, &["oauth", "api"])
        })
        .collect();

    let default_model = runtime_models.first().and_then(|m| m["id"].as_str());

    let mut catalog = json!({
        "agent": "gemini",
        "customModelPlaceholder": default_model.unwrap_or(""),
        "defaultModelByAccess": {},
        "modelsByAccess": {
            "oauth": runtime_models,
            "api": runtime_models,
        },
        "defaultReasoningByAccess": {},
    });

    if let Some(def) = default_model {
        catalog["defaultModelByAccess"]["oauth"] = json!(def);
        catalog["defaultModelByAccess"]["api"] = json!(def);
    }

    Some(catalog)
}

// ---------------------------------------------------------------------------
// Amp catalog — probes amp help, parses modes
// ---------------------------------------------------------------------------

fn parse_amp_modes_from_help(help: &str) -> Vec<String> {
    let Ok(matcher) = Regex::new(r"Set the agent mode \(([^)]+)\)") else {
        return Vec::new();
    };
    let Some(mode_block) = matcher
        .captures(help)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str())
    else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    mode_block
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

async fn build_amp_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let invocations: Vec<(String, Vec<String>)> = if let Some(bp) = binary_path {
        vec![
            (
                bp.display().to_string(),
                vec![
                    "threads".to_string(),
                    "new".to_string(),
                    "--help".to_string(),
                ],
            ),
            (bp.display().to_string(), vec!["--help".to_string()]),
        ]
    } else {
        vec![
            (
                "amp".to_string(),
                vec![
                    "threads".to_string(),
                    "new".to_string(),
                    "--help".to_string(),
                ],
            ),
            ("amp".to_string(), vec!["--help".to_string()]),
        ]
    };
    let help = read_command_output_invocations(&invocations, 3_000).await?;
    let modes = parse_amp_modes_from_help(&help);

    if modes.is_empty() {
        return None;
    }

    let models: Vec<Value> = modes
        .iter()
        .map(|mode| {
            let label = format!("Amp {}{}", mode[..1].to_uppercase(), &mode[1..]);
            model_option(
                mode,
                &label,
                &format!("Amp mode exposed by the local CLI ({mode})."),
                &["default"],
            )
        })
        .collect();

    let default_mode = preferred_choice(&modes, &["smart"]);

    default_access_catalog(
        "amp",
        models,
        default_mode.as_deref(),
        default_mode.as_deref(),
        vec![],
        None,
    )
}

// ---------------------------------------------------------------------------
// Cursor catalog — reads the local Cursor Agent model list
// ---------------------------------------------------------------------------

fn read_cursor_cli_config_model() -> Option<(String, String)> {
    let home = user_home_dir()?;
    let config = read_json_file(home.join(".cursor/cli-config.json"))?;
    let model = config.get("model")?;
    let id = model
        .get("modelId")
        .or_else(|| model.get("displayModelId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let label = model
        .get("displayNameShort")
        .or_else(|| model.get("displayName"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format_generic_model_label(&id));
    Some((id, label))
}

async fn read_cursor_models_output(binary_path: Option<&Path>) -> Option<String> {
    let invocations: Vec<(String, Vec<String>)> = if let Some(bp) = binary_path {
        let command = bp.display().to_string();
        if is_cursor_wrapper_binary(bp) {
            vec![(command, vec!["agent".to_string(), "models".to_string()])]
        } else {
            vec![(command, vec!["models".to_string()])]
        }
    } else {
        vec![
            ("cursor-agent".to_string(), vec!["models".to_string()]),
            ("cursor-cli".to_string(), vec!["models".to_string()]),
            (
                "cursor".to_string(),
                vec!["agent".to_string(), "models".to_string()],
            ),
        ]
    };
    read_command_output_invocations(&invocations, 3_000).await
}

async fn build_cursor_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let output = read_cursor_models_output(binary_path).await;
    let (mut models, mut default_model) = output
        .as_deref()
        .map(parse_cursor_models_output)
        .unwrap_or_default();

    let mut seen: HashSet<String> = models
        .iter()
        .filter_map(|value| value.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();

    if let Some((config_model_id, config_label)) = read_cursor_cli_config_model() {
        if seen.insert(config_model_id.clone()) {
            models.push(model_option(
                &config_model_id,
                &config_label,
                &format!("Model configured in the local Cursor CLI settings ({config_model_id})."),
                &["default"],
            ));
        }
        if default_model.is_none() {
            default_model = Some(config_model_id);
        }
    }

    if models.is_empty() {
        return None;
    }

    default_access_catalog(
        "cursor-cli",
        models,
        default_model.as_deref(),
        default_model.as_deref(),
        vec![],
        None,
    )
}

// ---------------------------------------------------------------------------
// Droid catalog — runs droid exec --help, parses models + reasoning
// ---------------------------------------------------------------------------

fn build_droid_reasoning_details(output: &str) -> HashMap<String, (Vec<Value>, Option<String>)> {
    let detail_section = output.split("Model details:").nth(1).unwrap_or("");
    let mut details = HashMap::new();

    let detail_re = Regex::new(
        r"^- (.+?): supports reasoning:\s+(Yes|No);\s+supported:\s+\[([^\]]*)\];\s+default:\s+([^\s]+)",
    )
    .ok();
    let Some(detail_re) = detail_re else {
        return details;
    };

    for raw_line in detail_section.lines() {
        let line = raw_line.trim();
        if !line.starts_with("- ") {
            continue;
        }
        let Some(captures) = detail_re.captures(line) else {
            continue;
        };
        let Some(label) = captures
            .get(1)
            .map(|value| value.as_str().trim().to_string())
        else {
            continue;
        };
        let supported = captures
            .get(3)
            .map(|value| value.as_str())
            .unwrap_or("")
            .split(',')
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty())
            .map(|value| reasoning_option(&value))
            .collect::<Vec<_>>();
        let default_reasoning = captures
            .get(4)
            .map(|value| value.as_str().trim().to_lowercase())
            .filter(|value| !value.is_empty());
        details.insert(label, (supported, default_reasoning));
    }

    details
}

async fn build_droid_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let commands: Vec<String> = if let Some(bp) = binary_path {
        vec![bp.display().to_string()]
    } else {
        vec!["droid".to_string()]
    };
    let cmd_refs: Vec<&str> = commands.iter().map(String::as_str).collect();

    let output = read_command_output(&cmd_refs, &["exec", "--help"]).await?;
    let detail_map = build_droid_reasoning_details(&output);

    // Parse "Available Models:" section for model IDs and labels.
    let model_re = Regex::new(r"^\s*([^\s]+)\s+(.+)$").ok()?;
    let in_models_section = output
        .lines()
        .skip_while(|l| !l.contains("Available Models"))
        .skip(1)
        .take_while(|l| !l.trim().is_empty() && !l.contains("Model details"));
    let mut models = Vec::new();
    let mut default_model = None;
    let mut reasoning_options_by_model = serde_json::Map::new();
    let mut default_reasoning_by_model = serde_json::Map::new();

    for line in in_models_section {
        if let Some(caps) = model_re.captures(line) {
            let id = caps.get(1)?.as_str().trim().to_string();
            let raw_label = caps.get(2)?.as_str().trim();
            if raw_label.is_empty() {
                continue;
            }
            let is_default = raw_label.contains("(default)");
            let clean_label = raw_label.replace("(default)", "").trim().to_string();
            if is_default {
                default_model = Some(id.clone());
            }
            if let Some((reasoning_options, default_reasoning)) = detail_map.get(&clean_label) {
                if !reasoning_options.is_empty() {
                    reasoning_options_by_model.insert(id.clone(), json!(reasoning_options));
                }
                if let Some(default_reasoning) = default_reasoning {
                    default_reasoning_by_model.insert(id.clone(), json!(default_reasoning));
                }
            }
            models.push(model_option(
                &id,
                &clean_label,
                &format!(
                    "{} available through the local Droid CLI ({id}).",
                    clean_label
                ),
                &["default"],
            ));
        }
    }

    if models.is_empty() {
        return None;
    }

    let resolved_default = default_model.clone().or_else(|| {
        models
            .first()
            .and_then(|m| m["id"].as_str())
            .map(str::to_string)
    });
    let mut catalog = default_access_catalog(
        "droid",
        models,
        resolved_default.as_deref(),
        resolved_default.as_deref(),
        vec![],
        None,
    )?;

    if !reasoning_options_by_model.is_empty() {
        catalog["reasoningOptionsByModel"] = Value::Object(reasoning_options_by_model);
    }
    if !default_reasoning_by_model.is_empty() {
        catalog["defaultReasoningByModel"] = Value::Object(default_reasoning_by_model);
    }

    Some(catalog)
}

// ---------------------------------------------------------------------------
// OpenCode catalog — runs opencode models --verbose, parses output
// ---------------------------------------------------------------------------

fn parse_opencode_verbose_models(output: &str) -> Vec<(String, Map<String, Value>)> {
    let lines: Vec<&str> = output.lines().collect();
    let mut entries = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let key = lines[index].trim();
        if key.is_empty() || !key.contains('/') {
            index += 1;
            continue;
        }

        let mut next = index + 1;
        while next < lines.len() && lines[next].trim().is_empty() {
            next += 1;
        }

        if next >= lines.len() || !lines[next].trim_start().starts_with('{') {
            index += 1;
            continue;
        }

        let mut buffer = String::new();
        let mut parsed = None;
        let mut end = next;
        while end < lines.len() {
            if !buffer.is_empty() {
                buffer.push('\n');
            }
            buffer.push_str(lines[end]);
            if let Ok(Value::Object(value)) = serde_json::from_str::<Value>(&buffer) {
                parsed = Some(value);
                break;
            }
            end += 1;
        }

        if let Some(value) = parsed {
            entries.push((key.to_string(), value));
            index = end + 1;
        } else {
            index += 1;
        }
    }

    entries
}

fn opencode_reasoning_variant_ids(variants: Option<&Map<String, Value>>) -> Vec<String> {
    let present: HashSet<String> = variants
        .into_iter()
        .flat_map(Map::keys)
        .map(|key| key.trim().to_ascii_lowercase())
        .filter(|key| {
            matches!(
                key.as_str(),
                "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "off" | "none"
            )
        })
        .collect();

    [
        "minimal", "low", "medium", "high", "max", "xhigh", "off", "none",
    ]
    .into_iter()
    .filter(|key| present.contains(*key))
    .map(str::to_string)
    .collect()
}

async fn build_opencode_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let commands: Vec<String> = if let Some(bp) = binary_path {
        vec![bp.display().to_string()]
    } else {
        vec![
            "opencode".to_string(),
            "open-code".to_string(),
            "open_code".to_string(),
        ]
    };
    let cmd_refs: Vec<&str> = commands.iter().map(String::as_str).collect();

    let output = read_command_output(&cmd_refs, &["models", "--verbose"]).await?;
    let entries = parse_opencode_verbose_models(&output);

    let mut models = Vec::new();
    let mut reasoning_options_by_model = Map::new();
    let mut default_reasoning_by_model = Map::new();

    for (key, data) in entries {
        let name = data
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format_generic_model_label(&key));
        models.push(model_option(
            &key,
            &name,
            &format!("Model exposed by the local OpenCode CLI ({key})."),
            &["default"],
        ));

        let reasoning_ids =
            opencode_reasoning_variant_ids(data.get("variants").and_then(Value::as_object));
        if reasoning_ids.is_empty() {
            continue;
        }

        reasoning_options_by_model.insert(
            key.clone(),
            json!(reasoning_ids
                .iter()
                .map(|value| reasoning_option(value))
                .collect::<Vec<_>>()),
        );
        if let Some(default_reasoning) = preferred_choice(&reasoning_ids, &["medium", "high"])
            .or_else(|| reasoning_ids.first().cloned())
        {
            default_reasoning_by_model.insert(key, json!(default_reasoning));
        }
    }

    if models.is_empty() {
        // Fallback: just check CLI exists via help
        let help = read_command_help(&cmd_refs).await;
        help.as_ref()?;
        return default_access_catalog("opencode", vec![], None, Some(""), vec![], None);
    }

    let default_model = models
        .first()
        .and_then(|m| m["id"].as_str())
        .map(str::to_string);
    let mut catalog = default_access_catalog(
        "opencode",
        models,
        default_model.as_deref(),
        default_model.as_deref(),
        vec![],
        None,
    )?;

    if !reasoning_options_by_model.is_empty() {
        catalog["reasoningOptionsByModel"] = Value::Object(reasoning_options_by_model);
    }
    if !default_reasoning_by_model.is_empty() {
        catalog["defaultReasoningByModel"] = Value::Object(default_reasoning_by_model);
    }

    Some(catalog)
}

// ---------------------------------------------------------------------------
// Copilot catalog — runs --help for model choices, reads config
// ---------------------------------------------------------------------------

fn read_copilot_config_model() -> Option<String> {
    let home = user_home_dir()?;
    read_json_file(home.join(".copilot/config.json"))?
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn collect_copilot_session_observations(contents: &[String]) -> (Vec<String>, Option<String>) {
    let mut seen_models = HashSet::new();
    let mut models = Vec::new();
    let mut reasoning = None;

    for content in contents {
        for line in content
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            let data = value.get("data").unwrap_or(&Value::Null);
            for candidate in ["newModel", "currentModel", "model"] {
                let Some(model_id) = data
                    .get(candidate)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model_id| !model_id.is_empty())
                else {
                    continue;
                };
                if seen_models.insert(model_id.to_string()) {
                    models.push(model_id.to_string());
                }
            }

            if reasoning.is_none() {
                reasoning = data
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_ascii_lowercase());
            }
        }
    }

    (models, reasoning)
}

async fn build_copilot_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let commands: Vec<String> = if let Some(bp) = binary_path {
        vec![bp.display().to_string()]
    } else {
        vec![
            "copilot".to_string(),
            "github-copilot".to_string(),
            "gh-copilot".to_string(),
        ]
    };
    let cmd_refs: Vec<&str> = commands.iter().map(String::as_str).collect();

    let help = read_command_help(&cmd_refs).await?;
    let config_model = read_copilot_config_model();

    let mut seen = HashSet::new();
    let mut model_ids = Vec::new();
    for model_id in extract_quoted_choices_from_help(&help, "--model <model>") {
        if seen.insert(model_id.clone()) {
            model_ids.push(model_id);
        }
    }

    if let Some(config_model_id) = config_model.clone() {
        if seen.insert(config_model_id.clone()) {
            model_ids.push(config_model_id);
        }
    }

    let session_contents = user_home_dir()
        .map(|home| {
            collect_recent_file_contents(&home.join(".copilot/session-state"), &["jsonl"], 3, 16)
        })
        .unwrap_or_default();
    let (observed_models, observed_reasoning) =
        collect_copilot_session_observations(&session_contents);
    for model_id in observed_models {
        if seen.insert(model_id.clone()) {
            model_ids.push(model_id);
        }
    }

    let reasoning_ids =
        extract_quoted_choices_from_help(&help, "--effort, --reasoning-effort <level>");
    let reasoning_options: Vec<Value> = reasoning_ids
        .iter()
        .map(|reasoning_id| reasoning_option(reasoning_id))
        .collect();

    if model_ids.is_empty() {
        return None;
    }

    let models: Vec<Value> = model_ids
        .iter()
        .map(|id| {
            let label = format_generic_model_label(id);
            model_option(
                id,
                &label,
                &format!("Model exposed by the local GitHub Copilot CLI ({id})."),
                &["default"],
            )
        })
        .collect();

    let default_model = config_model
        .filter(|value| model_ids.iter().any(|candidate| candidate == value))
        .or_else(|| {
            models
                .first()
                .and_then(|m| m["id"].as_str())
                .map(str::to_string)
        });
    let default_reasoning = observed_reasoning
        .as_deref()
        .filter(|value| reasoning_ids.iter().any(|candidate| candidate == value));
    default_access_catalog(
        "github-copilot",
        models,
        default_model.as_deref(),
        default_model.as_deref(),
        reasoning_options,
        default_reasoning,
    )
}

// ---------------------------------------------------------------------------
// Qwen catalog — scans ~/.qwen for model references
// ---------------------------------------------------------------------------

async fn build_qwen_runtime_model_catalog() -> Option<Value> {
    let home = user_home_dir()?;
    let qwen_dir = home.join(".qwen");

    let contents = collect_recent_file_contents(&qwen_dir, &["json", "jsonl"], 5, 12);
    let pattern = Regex::new(r#""(?:model|modelVersion)"\s*:\s*"([^"]+)""#).ok()?;
    let discovered = extract_regex_matches_from_contents(&contents, &pattern);

    if discovered.is_empty() {
        return None;
    }

    let models: Vec<Value> = discovered
        .iter()
        .map(|m| {
            model_option(
                m,
                &format_generic_model_label(m),
                &format!("Model discovered from the local Qwen Code installation ({m})."),
                &["oauth", "api"],
            )
        })
        .collect();

    let default_model = models
        .first()
        .and_then(|m| m["id"].as_str())
        .map(str::to_string);
    Some(json!({
        "agent": "qwen-code",
        "customModelPlaceholder": default_model.clone().unwrap_or_default(),
        "defaultModelByAccess": {
            "oauth": default_model.clone(),
            "api": default_model.clone(),
        },
        "modelsByAccess": {
            "oauth": models.clone(),
            "api": models,
        },
        "defaultReasoningByAccess": {},
    }))
}

// ---------------------------------------------------------------------------
// CCR catalog — checks ccr exists, then delegates to Claude catalog
// ---------------------------------------------------------------------------

async fn build_ccr_runtime_model_catalog(binary_path: Option<&Path>) -> Option<Value> {
    let commands: Vec<String> = if let Some(bp) = binary_path {
        vec![bp.display().to_string()]
    } else {
        vec!["ccr".to_string()]
    };
    let cmd_refs: Vec<&str> = commands.iter().map(String::as_str).collect();

    // Verify CCR is installed
    let output = read_command_output(&cmd_refs, &["version"]).await;
    output.as_ref()?;

    // Try to find Claude binary to build its catalog
    let claude_binary = which_command(&["claude", "claude-code", "cc"]).await;
    let claude_catalog = if let Some(bp) = claude_binary {
        build_claude_runtime_model_catalog(&bp).await
    } else {
        None
    };

    let claude = claude_catalog?;

    // Collapse Claude's multi-tier models into a flat "default" list
    let mut all_models = Vec::new();
    let mut seen = HashSet::new();

    for tier in &["pro", "max", "api"] {
        if let Some(models) = claude
            .get("modelsByAccess")
            .and_then(|m| m.get(tier))
            .and_then(Value::as_array)
        {
            for model in models {
                if let Some(id) = model.get("id").and_then(Value::as_str) {
                    if seen.insert(id.to_string()) {
                        let mut m = model.clone();
                        m["access"] = json!(["default"]);
                        all_models.push(m);
                    }
                }
            }
        }
    }

    let default_model = all_models.first().and_then(|m| m["id"].as_str());
    let reasoning = claude
        .get("reasoningOptionsByAccess")
        .and_then(|r| r.get("pro"))
        .cloned()
        .and_then(|v| if v.is_array() { Some(v) } else { None });
    let default_reasoning = claude
        .get("defaultReasoningByAccess")
        .and_then(|r| r.get("pro"))
        .and_then(Value::as_str);

    let mut catalog = json!({
        "agent": "ccr",
        "customModelPlaceholder": default_model.unwrap_or(""),
        "defaultModelByAccess": {},
        "modelsByAccess": {},
    });

    if let Some(def) = default_model {
        catalog["defaultModelByAccess"]["default"] = json!(def);
    }
    if !all_models.is_empty() {
        catalog["modelsByAccess"]["default"] = json!(all_models);
    }
    if let Some(opts) = reasoning {
        // Remap reasoning options access to "default"
        let remapped: Vec<Value> = opts.as_array().cloned().unwrap_or_default();
        if !remapped.is_empty() {
            catalog["reasoningOptionsByAccess"] = json!({ "default": remapped });
        }
    }
    if let Some(def) = default_reasoning {
        catalog["defaultReasoningByAccess"] = json!({ "default": def });
    }

    Some(catalog)
}

/// Find the first available command binary from a list of names.
async fn which_command(names: &[&str]) -> Option<PathBuf> {
    for name in names {
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            Command::new("which").arg(name).output(),
        )
        .await
        .ok()
        .and_then(Result::ok);

        if let Some(output) = result {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_agent_name_lowercases_and_replaces_separators() {
        assert_eq!(normalize_agent_name("Claude_Code"), "claude-code");
        assert_eq!(normalize_agent_name("  Qwen Code  "), "qwen-code");
        assert_eq!(normalize_agent_name("github-copilot"), "github-copilot");
    }

    #[test]
    fn known_agent_order_returns_correct_indices() {
        assert_eq!(known_agent_order("codex"), 0);
        assert_eq!(known_agent_order("claude-code"), 4);
        assert_eq!(known_agent_order("ccr"), 9);
        assert_eq!(known_agent_order("unknown"), usize::MAX);
    }

    #[test]
    fn or_null_returns_null_for_empty_strings() {
        assert_eq!(or_null(""), Value::Null);
        assert_eq!(or_null("https://example.com"), json!("https://example.com"));
    }

    #[test]
    fn format_codex_model_label_formats_correctly() {
        assert_eq!(format_codex_model_label("gpt-4o-mini"), "GPT-4o-Mini");
        assert_eq!(format_codex_model_label("gpt-5.4-mini"), "GPT-5.4-Mini");
        assert_eq!(format_codex_model_label("codex-mini"), "Codex-Mini");
    }

    #[test]
    fn format_gemini_model_label_capitalizes_parts() {
        assert_eq!(
            format_gemini_model_label("gemini-3.1-pro-preview"),
            "Gemini 3.1 Pro Preview"
        );
    }

    #[test]
    fn claude_access_for_model_categorizes_correctly() {
        assert_eq!(
            claude_access_for_model("claude-opus-4-6"),
            vec!["max", "api"]
        );
        assert_eq!(claude_access_for_model("opus"), vec!["max", "api"]);
        assert_eq!(
            claude_access_for_model("claude-haiku-4-5"),
            vec!["pro", "max", "api"]
        );
        assert_eq!(
            claude_access_for_model("claude-sonnet-4-6"),
            vec!["pro", "max", "api"]
        );
    }

    #[test]
    fn extract_quoted_choices_from_help_reads_model_choices() {
        let help = r#"
          --model <model>  Select a model (choices: "auto", "gpt-5", "claude-sonnet")
        "#;
        assert_eq!(
            extract_quoted_choices_from_help(help, "--model <model>"),
            vec![
                "auto".to_string(),
                "gpt-5".to_string(),
                "claude-sonnet".to_string(),
            ]
        );
    }

    #[test]
    fn parse_amp_modes_from_help_reads_large_mode() {
        let help = r#"
          -m, --mode <value>
              Set the agent mode (deep, free, large, rush, smart) — controls the model
        "#;
        assert_eq!(
            parse_amp_modes_from_help(help),
            vec![
                "deep".to_string(),
                "free".to_string(),
                "large".to_string(),
                "rush".to_string(),
                "smart".to_string(),
            ]
        );
    }

    #[test]
    fn parse_cursor_models_output_prefers_current_selection() {
        let output = r#"
Loading models…
Available models

auto - Auto
gpt-5.4-medium - GPT-5.4 1M
gpt-5.4-xhigh - GPT-5.4 1M Extra High (current)
claude-4.6-opus-max-thinking - Opus 4.6 1M Max Thinking (default)
"#;

        let (models, default_model) = parse_cursor_models_output(output);
        assert_eq!(
            models
                .iter()
                .filter_map(|value| value.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec![
                "auto",
                "gpt-5.4-medium",
                "gpt-5.4-xhigh",
                "claude-4.6-opus-max-thinking",
            ]
        );
        assert_eq!(default_model.as_deref(), Some("gpt-5.4-xhigh"));
    }

    #[test]
    fn parse_opencode_verbose_models_collects_reasoning_variants() {
        let output = r#"
opencode/gpt-5-nano
{
  "name": "GPT-5 Nano",
  "variants": {
    "minimal": {},
    "medium": {},
    "high": {}
  }
}
"#;

        let entries = parse_opencode_verbose_models(output);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "opencode/gpt-5-nano");
        assert_eq!(
            opencode_reasoning_variant_ids(entries[0].1.get("variants").and_then(Value::as_object)),
            vec![
                "minimal".to_string(),
                "medium".to_string(),
                "high".to_string(),
            ]
        );
    }

    #[test]
    fn collect_copilot_session_observations_reads_models_and_reasoning() {
        let contents = vec![r#"
{"type":"session.model_change","data":{"newModel":"claude-haiku-4.5","reasoningEffort":"xhigh"}}
{"type":"tool.execution_complete","data":{"model":"gpt-5.4"}}
{"type":"session.shutdown","data":{"currentModel":"claude-sonnet-4.6"}}
"#
        .to_string()];

        let (models, reasoning) = collect_copilot_session_observations(&contents);
        assert_eq!(
            models,
            vec![
                "claude-haiku-4.5".to_string(),
                "gpt-5.4".to_string(),
                "claude-sonnet-4.6".to_string(),
            ]
        );
        assert_eq!(reasoning.as_deref(), Some("xhigh"));
    }

    #[test]
    fn build_droid_reasoning_details_reads_supported_levels() {
        let output = r#"
Available Models:
model-a Alpha (default)

Model details:
- Alpha: supports reasoning: Yes; supported: [low, high]; default: high
"#;
        let details = build_droid_reasoning_details(output);
        let (options, default_reasoning) = details.get("Alpha").expect("details for Alpha");
        assert_eq!(
            options
                .iter()
                .filter_map(|value| value.get("id").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["low", "high"]
        );
        assert_eq!(default_reasoning.as_deref(), Some("high"));
    }
}
