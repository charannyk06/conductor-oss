use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use uuid::Uuid;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

const CLAUDE_AGENT: &str = "claude-code";
const GENERIC_SKILL_AGENT: &str = "generic-open-standard";
const GENERIC_PROJECT_SKILL_ROOTS: &[&str] = &[".agents/skills"];
const GENERIC_USER_SKILL_ROOTS: &[&str] = &["~/.agents/skills"];
const ALL_SKILL_AGENTS: &[&str] = &[
    CLAUDE_AGENT,
    "codex",
    "gemini",
    "amp",
    "cursor-cli",
    "opencode",
    "droid",
    "qwen-code",
    "ccr",
    "github-copilot",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillAgentCatalogEntry {
    id: &'static str,
    name: &'static str,
    project_roots: &'static [&'static str],
    user_roots: &'static [&'static str],
}

static SKILL_AGENT_CATALOG: &[SkillAgentCatalogEntry] = &[
    SkillAgentCatalogEntry {
        id: CLAUDE_AGENT,
        name: "Claude Code",
        project_roots: &[".claude/skills", ".agents/skills"],
        user_roots: &["~/.claude/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "codex",
        name: "Codex",
        project_roots: &[".agents/skills", ".codex/skills"],
        user_roots: &["~/.agents/skills", "~/.codex/skills"],
    },
    SkillAgentCatalogEntry {
        id: "gemini",
        name: "Gemini CLI",
        project_roots: &[".gemini/skills", ".agents/skills"],
        user_roots: &["~/.gemini/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "amp",
        name: "Amp",
        project_roots: &[".agents/skills"],
        user_roots: &["~/.config/agents/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "cursor-cli",
        name: "Cursor",
        project_roots: &[".cursor/skills", ".agents/skills"],
        user_roots: &["~/.cursor/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "opencode",
        name: "OpenCode",
        project_roots: &[".opencode/skills", ".agents/skills"],
        user_roots: &["~/.config/opencode/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "droid",
        name: "Droid",
        project_roots: &[".factory/skills", ".agent/skills"],
        user_roots: &["~/.factory/skills", "~/.agent/skills"],
    },
    SkillAgentCatalogEntry {
        id: "qwen-code",
        name: "Qwen Code",
        project_roots: &[".qwen/skills", ".agents/skills"],
        user_roots: &["~/.qwen/skills", "~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "ccr",
        name: "CCR",
        project_roots: &[".agents/skills"],
        user_roots: &["~/.agents/skills"],
    },
    SkillAgentCatalogEntry {
        id: "github-copilot",
        name: "GitHub Copilot",
        project_roots: &[".github/skills", ".claude/skills", ".agents/skills"],
        user_roots: &["~/.copilot/skills", "~/.claude/skills", "~/.agents/skills"],
    },
];

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/skills/catalog", get(get_catalog))
        .route("/api/skills/installed", get(get_installed_skills))
        .route("/api/skills/session-active", get(get_active_session_skills))
        .route("/api/skills/install", post(install_skill))
        .route("/api/skills/uninstall", post(uninstall_skill))
        .route("/api/skills/activate", post(activate_skill))
        .route("/api/skills/deactivate", post(deactivate_skill))
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillCatalogEntry {
    id: &'static str,
    name: &'static str,
    summary: &'static str,
    category: &'static str,
    verified: bool,
    compatible_agents: &'static [&'static str],
    icon: &'static str,
    repo_url: &'static str,
    source_subpath: Option<&'static str>,
    package_kind: &'static str,
    docs_url: &'static str,
}

static SKILL_CATALOG: &[SkillCatalogEntry] = &[
    SkillCatalogEntry {
        id: "pdf",
        name: "PDF Processing",
        summary: "Read PDFs, extract tables, fill forms, and merge or split files.",
        category: "document",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "FileText",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/pdf"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/pdf",
    },
    SkillCatalogEntry {
        id: "docx",
        name: "DOCX",
        summary: "Create and edit Word docs with formatting, comments, and tracked changes.",
        category: "document",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "FileText",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/docx"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/docx",
    },
    SkillCatalogEntry {
        id: "pptx",
        name: "PPTX",
        summary: "Generate slide decks with layouts, charts, and speaker notes.",
        category: "document",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Presentation",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/pptx"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/pptx",
    },
    SkillCatalogEntry {
        id: "xlsx",
        name: "XLSX",
        summary: "Spreadsheet formulas, analysis, and charts from natural language.",
        category: "document",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Table2",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/xlsx"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/xlsx",
    },
    SkillCatalogEntry {
        id: "doc-coauthoring",
        name: "Doc Co-Authoring",
        summary: "Collaborative writing workflow for back-and-forth drafting.",
        category: "document",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "UsersRound",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/doc-coauthoring"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring",
    },
    SkillCatalogEntry {
        id: "frontend-design",
        name: "Frontend Design",
        summary: "Higher-quality UI design systems, typography, and layout instincts.",
        category: "design",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Palette",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/frontend-design"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
    },
    SkillCatalogEntry {
        id: "canvas-design",
        name: "Canvas Design",
        summary: "Generate posters, social graphics, and covers from prompts.",
        category: "design",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Image",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/canvas-design"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/canvas-design",
    },
    SkillCatalogEntry {
        id: "algorithmic-art",
        name: "Algorithmic Art",
        summary: "Fractal, geometric, and p5.js driven generative art workflows.",
        category: "design",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Sparkles",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/algorithmic-art"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/algorithmic-art",
    },
    SkillCatalogEntry {
        id: "theme-factory",
        name: "Theme Factory",
        summary: "Batch generate cohesive color themes from one prompt.",
        category: "design",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Palette",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/theme-factory"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/theme-factory",
    },
    SkillCatalogEntry {
        id: "web-artifacts-builder",
        name: "Web Artifacts Builder",
        summary: "Generate dashboards, calculators, and other web artifacts quickly.",
        category: "design",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "LayoutGrid",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/web-artifacts-builder"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder",
    },
    SkillCatalogEntry {
        id: "superpowers",
        name: "Superpowers",
        summary: "Battle-tested TDD, debugging, and plan-to-execute skill collection.",
        category: "engineering",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Rocket",
        repo_url: "https://github.com/obra/superpowers.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/obra/superpowers",
    },
    SkillCatalogEntry {
        id: "systematic-debugging",
        name: "Systematic Debugging",
        summary: "Root-cause-first debugging workflow from the Superpowers ecosystem.",
        category: "engineering",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Bug",
        repo_url: "https://github.com/obra/superpowers.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/obra/superpowers",
    },
    SkillCatalogEntry {
        id: "file-search",
        name: "File Search",
        summary: "Ripgrep and tree navigation patterns for codebase search.",
        category: "engineering",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Search",
        repo_url: "https://github.com/massgen/massgen.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/massgen/massgen",
    },
    SkillCatalogEntry {
        id: "context-optimization",
        name: "Context Optimization",
        summary: "Token-budget and context compression patterns for agent workflows.",
        category: "engineering",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Workflow",
        repo_url: "https://github.com/muratcankoylan/agent-skills-for-context-engineering.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/muratcankoylan/agent-skills-for-context-engineering",
    },
    SkillCatalogEntry {
        id: "skill-creator",
        name: "Skill Creator",
        summary: "Describe a workflow and generate a SKILL.md package structure.",
        category: "engineering",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Wand2",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/skill-creator"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/skill-creator",
    },
    SkillCatalogEntry {
        id: "remotion-best-practices",
        name: "Remotion Best Practices",
        summary: "Video-generation workflows, composition structure, and render guidance.",
        category: "engineering",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Video",
        repo_url: "https://github.com/remotion-dev/remotion.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/remotion-dev/remotion",
    },
    SkillCatalogEntry {
        id: "marketing-skills",
        name: "Marketing Skills",
        summary: "CRO, copywriting, SEO, email, and growth workflow collection.",
        category: "marketing",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Megaphone",
        repo_url: "https://github.com/coreyhaines31/marketingskills.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/coreyhaines31/marketingskills",
    },
    SkillCatalogEntry {
        id: "claude-seo",
        name: "Claude SEO",
        summary: "Site audits, schema validation, and SEO-focused workflows.",
        category: "marketing",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Globe",
        repo_url: "https://github.com/AgriciDaniel/claude-seo.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/AgriciDaniel/claude-seo",
    },
    SkillCatalogEntry {
        id: "brand-guidelines",
        name: "Brand Guidelines",
        summary: "Encode brand rules so they apply consistently in future work.",
        category: "marketing",
        verified: true,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "BookOpen",
        repo_url: "https://github.com/anthropics/skills.git",
        source_subpath: Some("skills/brand-guidelines"),
        package_kind: "directory",
        docs_url: "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
    },
    SkillCatalogEntry {
        id: "notebooklm-integration",
        name: "NotebookLM Integration",
        summary: "NotebookLM bridge workflows for summaries, mind maps, and flashcards.",
        category: "knowledge",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "NotebookPen",
        repo_url: "https://github.com/PleasePrompto/notebooklm-skill.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/PleasePrompto/notebooklm-skill",
    },
    SkillCatalogEntry {
        id: "obsidian-skills",
        name: "Obsidian Skills",
        summary: "Vault-native note workflows, tagging, and linking patterns.",
        category: "knowledge",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "BookOpen",
        repo_url: "https://github.com/kepano/obsidian-skills.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/kepano/obsidian-skills",
    },
    SkillCatalogEntry {
        id: "excel-mcp-server",
        name: "Excel MCP Server",
        summary: "Excel automation and MCP style spreadsheet workflows.",
        category: "knowledge",
        verified: false,
        compatible_agents: ALL_SKILL_AGENTS,
        icon: "Table2",
        repo_url: "https://github.com/haris-musa/excel-mcp-server.git",
        source_subpath: None,
        package_kind: "repository",
        docs_url: "https://github.com/haris-musa/excel-mcp-server",
    },
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkillsQuery {
    agent: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSkillsQuery {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallRequest {
    skill_id: String,
    agent: String,
    scope: String,
    workspace_path: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillSessionRequest {
    session_id: String,
    skill_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkillStatus {
    skill_id: String,
    installed_user: bool,
    installed_workspace: bool,
    install_paths: Vec<String>,
}

async fn get_catalog() -> ApiResponse {
    ok(json!({
        "skills": SKILL_CATALOG,
        "agents": SKILL_AGENT_CATALOG,
        "catalogKind": "curated-open-agent-skills"
    }))
}

async fn get_installed_skills(Query(query): Query<InstalledSkillsQuery>) -> ApiResponse {
    let agent = query.agent.as_deref().unwrap_or(GENERIC_SKILL_AGENT).trim();

    let workspace_path = query
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    match scan_skill_installs(agent, workspace_path.as_deref()) {
        Ok((skills, custom_skills)) => ok(json!({
            "agent": agent,
            "supported": true,
            "skills": skills,
            "customSkills": custom_skills,
        })),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn get_active_session_skills(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionSkillsQuery>,
) -> ApiResponse {
    let active = state.active_session_skills.lock().await;
    let skill_ids = active.get(&query.session_id).cloned().unwrap_or_default();
    ok(json!({ "sessionId": query.session_id, "skillIds": skill_ids }))
}

async fn activate_skill(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SkillSessionRequest>,
) -> ApiResponse {
    let mut active = state.active_session_skills.lock().await;
    let entry = active.entry(request.session_id.clone()).or_default();
    if !entry.iter().any(|value| value == &request.skill_id) {
        entry.push(request.skill_id.clone());
    }
    ok(json!({ "ok": true, "sessionId": request.session_id, "skillId": request.skill_id }))
}

async fn deactivate_skill(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SkillSessionRequest>,
) -> ApiResponse {
    let mut active = state.active_session_skills.lock().await;
    if let Some(entry) = active.get_mut(&request.session_id) {
        entry.retain(|value| value != &request.skill_id);
        if entry.is_empty() {
            active.remove(&request.session_id);
        }
    }
    ok(json!({ "ok": true, "sessionId": request.session_id, "skillId": request.skill_id }))
}

async fn install_skill(
    State(state): State<Arc<AppState>>,
    Json(request): Json<SkillInstallRequest>,
) -> ApiResponse {
    let Some(entry) = SKILL_CATALOG
        .iter()
        .find(|entry| entry.id == request.skill_id)
    else {
        return error(StatusCode::NOT_FOUND, "Skill not found");
    };
    let install_scope = request.scope.trim();
    let target_paths = match resolve_install_targets(
        request.agent.trim(),
        install_scope,
        request.workspace_path.as_deref(),
    ) {
        Ok(path) => path,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    let install_result = match perform_skill_install(entry, &target_paths).await {
        Ok(paths) => paths,
        Err(err) => return error(StatusCode::BAD_GATEWAY, err.to_string()),
    };

    if let Some(session_id) = request
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let mut active = state.active_session_skills.lock().await;
        let entry = active.entry(session_id.to_string()).or_default();
        if !entry.iter().any(|value| value == &request.skill_id) {
            entry.push(request.skill_id.clone());
        }
    }

    ok(json!({
        "ok": true,
        "skillId": request.skill_id,
        "scope": install_scope,
        "installedPath": install_result
            .first()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        "installedPaths": install_result
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        "sessionId": request.session_id,
    }))
}

async fn uninstall_skill(Json(request): Json<SkillInstallRequest>) -> ApiResponse {
    let install_scope = request.scope.trim();
    let target_paths = match resolve_install_targets(
        request.agent.trim(),
        install_scope,
        request.workspace_path.as_deref(),
    ) {
        Ok(path) => path,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    let removed_paths = match remove_skill_installations(&target_paths, request.skill_id.trim()) {
        Ok(paths) => paths,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    if removed_paths.is_empty() {
        return error(
            StatusCode::NOT_FOUND,
            "Skill is not installed in that scope",
        );
    }
    ok(json!({
        "ok": true,
        "skillId": request.skill_id,
        "removedPath": removed_paths
            .first()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        "removedPaths": removed_paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
    }))
}

fn resolve_user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| "Unable to resolve the current user home directory".to_string())
}

fn resolve_skill_agent_profile(agent: &str) -> Option<&'static SkillAgentCatalogEntry> {
    SKILL_AGENT_CATALOG.iter().find(|entry| entry.id == agent)
}

fn catalog_map() -> HashMap<&'static str, &'static SkillCatalogEntry> {
    SKILL_CATALOG
        .iter()
        .map(|entry| (entry.id, entry))
        .collect()
}

fn resolve_skill_root_specs(agent: &str) -> (&'static [&'static str], &'static [&'static str]) {
    resolve_skill_agent_profile(agent)
        .map(|profile| (profile.project_roots, profile.user_roots))
        .unwrap_or((GENERIC_PROJECT_SKILL_ROOTS, GENERIC_USER_SKILL_ROOTS))
}

fn resolve_skill_root_path(root: &str, workspace_path: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(stripped) = root.strip_prefix("~/") {
        return Ok(resolve_user_home_dir()?.join(stripped));
    }

    let Some(workspace_path) = workspace_path else {
        return Err("workspacePath is required for workspace scope".to_string());
    };

    Ok(workspace_path.join(root))
}

fn resolve_skill_target_paths(
    roots: &[&'static str],
    workspace_path: Option<&Path>,
) -> Result<Vec<PathBuf>, String> {
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();

    for root in roots {
        let path = resolve_skill_root_path(root, workspace_path)?;
        if seen.insert(path.clone()) {
            resolved.push(path);
        }
    }

    Ok(resolved)
}

fn resolve_install_targets(
    agent: &str,
    scope: &str,
    workspace_path: Option<&str>,
) -> Result<Vec<PathBuf>, String> {
    let (project_roots, user_roots) = resolve_skill_root_specs(agent);
    let workspace_path = workspace_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    match scope {
        "user" => resolve_skill_target_paths(user_roots, None),
        "workspace" => {
            let Some(workspace_path) = workspace_path.as_deref() else {
                return Err("workspacePath is required for workspace scope".to_string());
            };
            resolve_skill_target_paths(project_roots, Some(workspace_path))
        }
        _ => Err("scope must be 'user' or 'workspace'".to_string()),
    }
}

fn scan_skill_installs(
    agent: &str,
    workspace_path: Option<&Path>,
) -> Result<(Vec<InstalledSkillStatus>, Vec<Value>), std::io::Error> {
    let (project_roots, user_roots) = resolve_skill_root_specs(agent);
    let user_dirs = resolve_skill_target_paths(user_roots, None).map_err(std::io::Error::other)?;
    let workspace_dirs = workspace_path
        .map(|path| {
            resolve_skill_target_paths(project_roots, Some(path)).map_err(std::io::Error::other)
        })
        .transpose()?
        .unwrap_or_default();
    let catalog_by_id = catalog_map();
    let mut custom_sources: HashMap<String, String> = HashMap::new();
    let mut results = Vec::with_capacity(SKILL_CATALOG.len());

    for entry in SKILL_CATALOG {
        let user_paths = user_dirs
            .iter()
            .map(|path| path.join(entry.id))
            .collect::<Vec<_>>();
        let workspace_paths = workspace_dirs
            .iter()
            .map(|path| path.join(entry.id))
            .collect::<Vec<_>>();
        let installed_user = user_paths.iter().any(|path| path.exists());
        let installed_workspace = workspace_paths.iter().any(|path| path.exists());
        let mut install_paths = Vec::new();
        for path in user_paths.into_iter().chain(workspace_paths.into_iter()) {
            if path.exists() {
                install_paths.push(path.to_string_lossy().to_string());
            }
        }
        results.push(InstalledSkillStatus {
            skill_id: entry.id.to_string(),
            installed_user,
            installed_workspace,
            install_paths,
        });
    }

    for dir in user_dirs.iter().chain(workspace_dirs.iter()) {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(dir)?.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !catalog_by_id.contains_key(name.as_str()) {
                custom_sources
                    .entry(name)
                    .or_insert_with(|| path.to_string_lossy().to_string());
            }
        }
    }

    let mut custom_skills = custom_sources.into_iter().collect::<Vec<_>>();
    custom_skills.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let custom_skills = custom_skills
        .into_iter()
        .map(|(name, source)| json!({ "id": name, "name": name, "source": source }))
        .collect::<Vec<_>>();

    Ok((results, custom_skills))
}

async fn perform_skill_install(
    entry: &SkillCatalogEntry,
    install_roots: &[PathBuf],
) -> Result<Vec<PathBuf>, anyhow::Error> {
    let temp_root = std::env::temp_dir().join(format!("conductor-skill-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_root)?;

    let clone_status = Command::new("git")
        .args([
            "clone",
            "--depth=1",
            entry.repo_url,
            temp_root.to_string_lossy().as_ref(),
        ])
        .status()?;
    if !clone_status.success() {
        return Err(anyhow::anyhow!("Failed to clone skill repository"));
    }

    let source_root = match entry.source_subpath {
        Some(subpath) => temp_root.join(subpath),
        None => temp_root.clone(),
    };
    if !source_root.exists() {
        return Err(anyhow::anyhow!(
            "Skill source path was not found in the repository"
        ));
    }

    let mut installed_paths = Vec::new();
    for install_root in install_roots {
        fs::create_dir_all(install_root)?;
        let install_target = install_root.join(entry.id);
        if install_target.exists() {
            fs::remove_dir_all(&install_target)?;
        }
        copy_dir_recursive(&source_root, &install_target)?;
        installed_paths.push(install_target);
    }
    let _ = fs::remove_dir_all(&temp_root);
    Ok(installed_paths)
}

fn remove_skill_installations(
    install_roots: &[PathBuf],
    skill_id: &str,
) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut removed_paths = Vec::new();
    for install_root in install_roots {
        let skill_dir = install_root.join(skill_id);
        if skill_dir.exists() {
            fs::remove_dir_all(&skill_dir)?;
            removed_paths.push(skill_dir);
        }
    }
    Ok(removed_paths)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy() == ".git" {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::TEST_ENV_LOCK;

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn resolve_install_targets_for_claude_includes_shared_and_native_roots() {
        let _guard = TEST_ENV_LOCK.blocking_lock();
        let previous_home = std::env::var_os("HOME");
        let home = make_temp_dir("conductor-skills-home");
        let workspace = make_temp_dir("conductor-skills-workspace");
        std::env::set_var("HOME", &home);

        let targets = resolve_install_targets(
            CLAUDE_AGENT,
            "workspace",
            Some(workspace.to_string_lossy().as_ref()),
        )
        .expect("resolve install targets");

        let rendered = targets
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(rendered.iter().any(|path| path.ends_with(".claude/skills")));
        assert!(rendered.iter().any(|path| path.ends_with(".agents/skills")));

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn resolve_install_targets_for_unknown_agent_uses_generic_open_standard_roots() {
        let _guard = TEST_ENV_LOCK.blocking_lock();
        let previous_home = std::env::var_os("HOME");
        let home = make_temp_dir("conductor-skills-home");
        std::env::set_var("HOME", &home);

        let targets =
            resolve_install_targets("custom-agent", "user", None).expect("resolve install targets");

        let rendered = targets
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(rendered.len(), 1);
        assert!(rendered[0].ends_with(".agents/skills"));

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(home);
    }
}
