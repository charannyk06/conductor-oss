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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        compatible_agents: &[CLAUDE_AGENT],
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
        "agents": [CLAUDE_AGENT],
        "catalogKind": "curated-claude-skills"
    }))
}

async fn get_installed_skills(Query(query): Query<InstalledSkillsQuery>) -> ApiResponse {
    let agent = query.agent.as_deref().unwrap_or(CLAUDE_AGENT).trim();
    if agent != CLAUDE_AGENT {
        return ok(json!({
            "agent": agent,
            "supported": false,
            "skills": Vec::<Value>::new(),
            "customSkills": Vec::<Value>::new(),
        }));
    }

    let workspace_path = query
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    match scan_claude_skill_installs(workspace_path.as_deref()) {
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
    if request.agent.trim() != CLAUDE_AGENT {
        return error(
            StatusCode::BAD_REQUEST,
            "This first release only supports Claude Code skills",
        );
    }
    let Some(entry) = SKILL_CATALOG
        .iter()
        .find(|entry| entry.id == request.skill_id)
    else {
        return error(StatusCode::NOT_FOUND, "Skill not found");
    };
    let install_scope = request.scope.trim();
    let target_path = match resolve_install_target(install_scope, request.workspace_path.as_deref())
    {
        Ok(path) => path,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    let install_result = match perform_skill_install(entry, &target_path).await {
        Ok(path) => path,
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
        "installedPath": install_result.to_string_lossy().to_string(),
        "sessionId": request.session_id,
    }))
}

async fn uninstall_skill(Json(request): Json<SkillInstallRequest>) -> ApiResponse {
    if request.agent.trim() != CLAUDE_AGENT {
        return error(
            StatusCode::BAD_REQUEST,
            "This first release only supports Claude Code skills",
        );
    }
    let install_scope = request.scope.trim();
    let target_path = match resolve_install_target(install_scope, request.workspace_path.as_deref())
    {
        Ok(path) => path,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    let skill_dir = target_path.join(request.skill_id.trim());
    if !skill_dir.exists() {
        return error(
            StatusCode::NOT_FOUND,
            "Skill is not installed in that scope",
        );
    }
    match fs::remove_dir_all(&skill_dir) {
        Ok(_) => ok(json!({
            "ok": true,
            "skillId": request.skill_id,
            "removedPath": skill_dir.to_string_lossy().to_string(),
        })),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn resolve_install_target(scope: &str, workspace_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => Ok(resolve_claude_user_skills_dir()),
        "workspace" => {
            let Some(raw_workspace_path) = workspace_path
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return Err("workspacePath is required for workspace scope".to_string());
            };
            Ok(PathBuf::from(raw_workspace_path)
                .join(".claude")
                .join("skills"))
        }
        _ => Err("scope must be 'user' or 'workspace'".to_string()),
    }
}

fn resolve_user_home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
        .ok_or_else(|| "Unable to resolve the current user home directory".to_string())
}

fn resolve_claude_user_skills_dir() -> PathBuf {
    resolve_user_home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".claude")
        .join("skills")
}

fn catalog_map() -> HashMap<&'static str, &'static SkillCatalogEntry> {
    SKILL_CATALOG
        .iter()
        .map(|entry| (entry.id, entry))
        .collect()
}

fn scan_claude_skill_installs(
    workspace_path: Option<&Path>,
) -> Result<(Vec<InstalledSkillStatus>, Vec<Value>), std::io::Error> {
    let user_dir = resolve_claude_user_skills_dir();
    let workspace_dir = workspace_path.map(|path| path.join(".claude").join("skills"));
    let catalog_by_id = catalog_map();
    let mut custom_names: HashSet<String> = HashSet::new();
    let mut results = Vec::with_capacity(SKILL_CATALOG.len());

    for entry in SKILL_CATALOG {
        let user_path = user_dir.join(entry.id);
        let workspace_path_for_skill = workspace_dir.as_ref().map(|path| path.join(entry.id));
        let installed_user = user_path.exists();
        let installed_workspace = workspace_path_for_skill
            .as_ref()
            .map(|path| path.exists())
            .unwrap_or(false);
        let mut install_paths = Vec::new();
        if installed_user {
            install_paths.push(user_path.to_string_lossy().to_string());
        }
        if let Some(path) = workspace_path_for_skill
            .as_ref()
            .filter(|path| path.exists())
        {
            install_paths.push(path.to_string_lossy().to_string());
        }
        results.push(InstalledSkillStatus {
            skill_id: entry.id.to_string(),
            installed_user,
            installed_workspace,
            install_paths,
        });
    }

    for base in [Some(user_dir.as_path()), workspace_dir.as_deref()] {
        if let Some(dir) = base.filter(|path| path.exists()) {
            for entry in fs::read_dir(dir)?.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if !catalog_by_id.contains_key(name.as_str()) {
                    custom_names.insert(name);
                }
            }
        }
    }

    let custom_skills = custom_names
        .into_iter()
        .map(|name| json!({ "id": name, "name": name, "source": "custom" }))
        .collect::<Vec<_>>();

    Ok((results, custom_skills))
}

async fn perform_skill_install(
    entry: &SkillCatalogEntry,
    install_root: &Path,
) -> Result<PathBuf, anyhow::Error> {
    let temp_root = std::env::temp_dir().join(format!("conductor-skill-{}", Uuid::new_v4()));
    let install_target = install_root.join(entry.id);
    fs::create_dir_all(&temp_root)?;
    fs::create_dir_all(install_root)?;
    if install_target.exists() {
        fs::remove_dir_all(&install_target)?;
    }

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

    copy_dir_recursive(&source_root, &install_target)?;
    let _ = fs::remove_dir_all(&temp_root);
    Ok(install_target)
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
