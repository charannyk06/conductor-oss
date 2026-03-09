use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use conductor_core::config::GitHubProjectConfig;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::env;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::routes::boards::{
    build_task_text, default_heading_for_role, load_board_response, next_human_task_ref,
    normalize_role, parse_board, split_task_text, write_parsed_board, BoardTaskRecord,
    ParsedBoardColumn,
};
use crate::state::{resolve_board_file, AppState};

type ApiResponse = (StatusCode, Json<Value>);
type HmacSha256 = Hmac<Sha256>;

const GITHUB_REPOSITORY_CACHE_TTL: Duration = Duration::from_secs(120);
static GITHUB_REPOSITORY_CACHE: LazyLock<RwLock<Option<CachedGithubRepositories>>> =
    LazyLock::new(|| RwLock::new(None));

const GITHUB_REPOSITORY_QUERY: &str = r#"
query($endCursor:String) {
  viewer {
    repositories(
      first: 100
      after: $endCursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        name
        nameWithOwner
        description
        url
        sshUrl
        isPrivate
        updatedAt
        pushedAt
        viewerPermission
        owner {
          login
        }
        defaultBranchRef {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"#;

const GITHUB_OWNER_PROJECTS_QUERY: &str = r#"
query($login:String!, $endCursor:String) {
  user(login: $login) {
    projectsV2(first: 50, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        id
        number
        title
        url
        closed
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
  organization(login: $login) {
    projectsV2(first: 50, after: $endCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        id
        number
        title
        url
        closed
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
"#;

const GITHUB_PROJECT_METADATA_QUERY: &str = r#"
query($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      number
      title
      url
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
        }
      }
    }
  }
}
"#;

const GITHUB_PROJECT_SNAPSHOT_QUERY: &str = r#"
query($projectId: ID!, $endCursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      id
      number
      title
      url
      closed
      fields(first: 50) {
        nodes {
          ... on ProjectV2FieldCommon {
            id
            name
            dataType
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            dataType
            options {
              id
              name
            }
          }
        }
      }
      items(first: 50, after: $endCursor) {
        nodes {
          id
          isArchived
          type
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2FieldCommon {
                    id
                    name
                  }
                }
                name
                optionId
              }
            }
          }
          content {
            __typename
            ... on Issue {
              id
              number
              title
              body
              url
              state
            }
            ... on PullRequest {
              id
              number
              title
              body
              url
              state
            }
            ... on DraftIssue {
              id
              title
              body
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
"#;

const GITHUB_REPOSITORY_ISSUE_QUERY: &str = r#"
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
    }
  }
}
"#;

const GITHUB_ADD_PROJECT_ITEM_MUTATION: &str = r#"
mutation($projectId:ID!, $contentId:ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item {
      id
    }
  }
}
"#;

const GITHUB_ADD_PROJECT_DRAFT_MUTATION: &str = r#"
mutation($projectId:ID!, $title:String!, $body:String) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
    projectItem {
      id
      content {
        ... on DraftIssue {
          id
          title
          body
        }
      }
    }
  }
}
"#;

const GITHUB_UPDATE_DRAFT_MUTATION: &str = r#"
mutation($draftIssueId:ID!, $title:String!, $body:String) {
  updateProjectV2DraftIssue(input: { draftIssueId: $draftIssueId, title: $title, body: $body }) {
    draftIssue {
      id
    }
  }
}
"#;

const GITHUB_UPDATE_FIELD_MUTATION: &str = r#"
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}
"#;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/github/repos", get(list_github_repositories))
        .route(
            "/api/github/projects",
            get(list_github_projects).put(update_github_project_link),
        )
        .route("/api/github/webhook", post(receive_github_webhook))
        .route(
            "/api/github/projects/sync",
            axum::routing::post(sync_github_project),
        )
}

fn ok(value: Value) -> ApiResponse {
    (StatusCode::OK, Json(value))
}

fn error(status: StatusCode, message: impl Into<String>) -> ApiResponse {
    (status, Json(json!({ "error": message.into() })))
}

#[derive(Debug, Deserialize)]
struct RepoQuery {
    q: Option<String>,
    refresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectsQuery {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateGitHubProjectLinkBody {
    project_id: String,
    link: Option<GitHubProjectLinkBody>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectLinkBody {
    id: String,
    owner_login: Option<String>,
    number: Option<u32>,
    title: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubProjectSyncBody {
    project_id: String,
    direction: String,
}

#[derive(Clone, Debug)]
struct CachedGithubRepositories {
    fetched_at: Instant,
    repos: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct GraphQlResponse {
    data: GraphQlData,
}

#[derive(Debug, Deserialize)]
struct GraphQlData {
    viewer: GraphQlViewer,
}

#[derive(Debug, Deserialize)]
struct GraphQlViewer {
    repositories: GraphQlRepositoryConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphQlRepositoryConnection {
    nodes: Vec<GhRepoListItem>,
    page_info: GraphQlPageInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphQlPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoListItem {
    name: Option<String>,
    name_with_owner: Option<String>,
    description: Option<String>,
    url: Option<String>,
    ssh_url: Option<String>,
    is_private: Option<bool>,
    updated_at: Option<String>,
    pushed_at: Option<String>,
    viewer_permission: Option<String>,
    owner: Option<GhOwner>,
    default_branch_ref: Option<GhDefaultBranch>,
}

#[derive(Debug, Deserialize)]
struct GhOwner {
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhDefaultBranch {
    name: Option<String>,
}

#[derive(Debug, Clone)]
struct GitHubProjectOption {
    id: String,
    number: Option<u32>,
    title: String,
    url: Option<String>,
    closed: bool,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct GitHubProjectStatusOption {
    id: String,
    name: String,
}

#[derive(Debug, Clone)]
struct GitHubProjectStatusField {
    id: String,
    name: String,
    options: Vec<GitHubProjectStatusOption>,
}

#[derive(Debug, Clone)]
struct GitHubProjectItem {
    item_id: String,
    draft_issue_id: Option<String>,
    issue_id: Option<String>,
    content_kind: String,
    title: String,
    body: Option<String>,
    status_name: Option<String>,
    state: Option<String>,
    is_archived: bool,
}

#[derive(Debug, Clone)]
struct GitHubProjectSnapshot {
    config: GitHubProjectConfig,
    status_field: Option<GitHubProjectStatusField>,
    items: Vec<GitHubProjectItem>,
}

const GITHUB_WEBHOOK_SECRET_ENV: &str = "CONDUCTOR_GITHUB_WEBHOOK_SECRET";
const GITHUB_WEBHOOK_SECRET_FALLBACK_ENV: &str = "GITHUB_WEBHOOK_SECRET";

async fn list_github_repositories(Query(query): Query<RepoQuery>) -> ApiResponse {
    if let Err(err) = assert_gh_authenticated().await {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }

    let force_refresh = query.refresh.unwrap_or(false);
    let mut repos = match load_accessible_github_repositories(force_refresh).await {
        Ok(items) => items,
        Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
    };

    if let Some(query_value) = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let query_value = query_value.to_lowercase();
        repos.retain(|repo| {
            repo["fullName"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&query_value)
                || repo["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query_value)
                || repo["ownerLogin"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query_value)
                || repo["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query_value)
                || repo["defaultBranch"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&query_value)
        });
    }

    repos.sort_by(|left, right| {
        right["updatedAt"]
            .as_str()
            .unwrap_or_default()
            .cmp(left["updatedAt"].as_str().unwrap_or_default())
            .then_with(|| {
                left["fullName"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right["fullName"].as_str().unwrap_or_default())
            })
    });

    ok(json!({ "repos": repos }))
}

async fn list_github_projects(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GitHubProjectsQuery>,
) -> ApiResponse {
    if let Err(err) = assert_gh_authenticated().await {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }

    let (repository, owner_login, linked_project) =
        match resolve_project_repo_context(&state, &query.project_id).await {
            Ok(context) => context,
            Err((status, message)) => return error(status, message),
        };

    let projects = match fetch_owner_projects(&owner_login).await {
        Ok(items) => items,
        Err(err) => return error(StatusCode::BAD_REQUEST, err.to_string()),
    };

    ok(json!({
        "projectId": query.project_id,
        "repository": repository,
        "ownerLogin": owner_login,
        "linkedProject": linked_project,
        "projects": projects.into_iter().map(project_option_to_value).collect::<Vec<_>>(),
    }))
}

async fn update_github_project_link(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateGitHubProjectLinkBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId is required");
    }

    if let Err(err) = assert_gh_authenticated().await {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }

    let next_link = if let Some(link) = body.link {
        let project_id = link.id.trim();
        if project_id.is_empty() {
            return error(StatusCode::BAD_REQUEST, "GitHub project id is required");
        }

        let mut next = GitHubProjectConfig {
            id: Some(project_id.to_string()),
            owner_login: link
                .owner_login
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            number: link.number,
            title: link
                .title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            url: link
                .url
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            status_field_id: None,
            status_field_name: None,
        };

        if let Err(err) = enrich_github_project_link(&mut next).await {
            return error(StatusCode::BAD_REQUEST, err.to_string());
        }
        Some(next)
    } else {
        None
    };

    {
        let mut config = state.config.write().await;
        let Some(project) = config.projects.get_mut(&body.project_id) else {
            return error(
                StatusCode::NOT_FOUND,
                format!("Unknown project: {}", body.project_id),
            );
        };
        project.github_project = next_link.clone();
    }

    if let Err(err) = state.save_config().await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    state
        .push_board_activity(
            &body.project_id,
            "github-sync",
            if next_link.is_some() {
                "linked project"
            } else {
                "unlinked project"
            },
            next_link
                .as_ref()
                .and_then(|value| value.title.clone())
                .unwrap_or_else(|| "GitHub Project connection updated".to_string()),
        )
        .await;
    state.publish_snapshot().await;

    ok(json!({
        "projectId": body.project_id,
        "githubProject": next_link,
    }))
}

async fn sync_github_project(
    State(state): State<Arc<AppState>>,
    Json(body): Json<GitHubProjectSyncBody>,
) -> ApiResponse {
    if body.project_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "projectId is required");
    }

    if let Err(err) = assert_gh_authenticated().await {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }

    let direction = body.direction.trim().to_lowercase();
    match direction.as_str() {
        "pull" => {
            let summary = match pull_github_project_into_board(&state, &body.project_id).await {
                Ok(value) => value,
                Err((status, message)) => return error(status, message),
            };
            let board = match load_board_response(&state, &body.project_id).await {
                Ok(payload) => payload,
                Err((status, message)) => return error(status, message),
            };
            ok(json!({
                "direction": "pull",
                "summary": summary,
                "board": board,
            }))
        }
        "push" => {
            let summary = match push_board_into_github_project(&state, &body.project_id).await {
                Ok(value) => value,
                Err((status, message)) => return error(status, message),
            };
            let board = match load_board_response(&state, &body.project_id).await {
                Ok(payload) => payload,
                Err((status, message)) => return error(status, message),
            };
            ok(json!({
                "direction": "push",
                "summary": summary,
                "board": board,
            }))
        }
        _ => error(
            StatusCode::BAD_REQUEST,
            "direction must be `pull` or `push`",
        ),
    }
}

async fn receive_github_webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResponse {
    let event = headers
        .get("x-github-event")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();

    if event.is_empty() {
        return error(StatusCode::BAD_REQUEST, "Missing X-GitHub-Event header");
    }

    let Some(secret) = github_webhook_secret() else {
        tracing::warn!("Received GitHub webhook but no webhook secret is configured; rejecting. Set CONDUCTOR_GITHUB_WEBHOOK_SECRET to enable webhook processing.");
        return error(
            StatusCode::FORBIDDEN,
            "Webhook secret not configured. Set CONDUCTOR_GITHUB_WEBHOOK_SECRET on the server.",
        );
    };
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|value| value.to_str().ok());
    if !verify_github_webhook_signature(&body, signature, &secret) {
        return error(StatusCode::UNAUTHORIZED, "Invalid GitHub webhook signature");
    }

    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(err) => {
            return error(
                StatusCode::BAD_REQUEST,
                format!("Invalid JSON payload: {err}"),
            )
        }
    };
    let action = payload
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let repository = repository_full_name_from_payload(&payload);

    if event == "ping" {
        return ok(json!({ "ok": true, "event": "ping" }));
    }

    if !is_sync_relevant_github_event(&event) {
        return ok(json!({
            "ok": true,
            "skipped": true,
            "event": event,
            "action": action,
            "reason": "Webhook event does not trigger board sync",
        }));
    }

    let project_ids = matched_projects_for_webhook(&state, &payload).await;
    if project_ids.is_empty() {
        return ok(json!({
            "ok": true,
            "skipped": true,
            "event": event,
            "action": action,
            "reason": "No linked Conductor project matched this webhook payload",
        }));
    }

    let mut synced = Vec::new();
    let mut failed = Vec::new();
    for project_id in project_ids {
        match pull_github_project_into_board(&state, &project_id).await {
            Ok(summary) => {
                state
                    .record_webhook_delivery(
                        &project_id,
                        event.clone(),
                        action.to_string(),
                        "synced",
                        format!(
                            "Applied GitHub webhook sync{}",
                            repository
                                .as_ref()
                                .map(|value| format!(" for {value}"))
                                .unwrap_or_default()
                        ),
                        repository.clone(),
                    )
                    .await;
                state
                    .push_board_activity(
                        &project_id,
                        "github-webhook",
                        format!("received {event}/{action}"),
                        format!(
                            "Auto-synced from GitHub webhook{}",
                            repository
                                .as_ref()
                                .map(|value| format!(" for {value}"))
                                .unwrap_or_default()
                        ),
                    )
                    .await;
                synced.push(json!({
                    "projectId": project_id,
                    "summary": summary,
                }));
            }
            Err((status, message)) => {
                state
                    .record_webhook_delivery(
                        &project_id,
                        event.clone(),
                        action.to_string(),
                        "failed",
                        message.clone(),
                        repository.clone(),
                    )
                    .await;
                failed.push(json!({
                    "projectId": project_id,
                    "status": status.as_u16(),
                    "error": message,
                }));
            }
        }
    }

    ok(json!({
        "ok": failed.is_empty(),
        "event": event,
        "action": action,
        "synced": synced,
        "failed": failed,
    }))
}

async fn load_accessible_github_repositories(force_refresh: bool) -> anyhow::Result<Vec<Value>> {
    if !force_refresh {
        if let Some(cached) = GITHUB_REPOSITORY_CACHE
            .read()
            .await
            .as_ref()
            .filter(|cache| cache.fetched_at.elapsed() < GITHUB_REPOSITORY_CACHE_TTL)
            .cloned()
        {
            return Ok(cached.repos);
        }
    }

    let repos = fetch_accessible_github_repositories().await?;
    let mut cache = GITHUB_REPOSITORY_CACHE.write().await;
    *cache = Some(CachedGithubRepositories {
        fetched_at: Instant::now(),
        repos: repos.clone(),
    });
    Ok(repos)
}

const MAX_PAGINATION_PAGES: usize = 20;

async fn fetch_accessible_github_repositories() -> anyhow::Result<Vec<Value>> {
    let mut repos = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages_fetched = 0_usize;

    while repos.len() < 200 && pages_fetched < MAX_PAGINATION_PAGES {
        pages_fetched += 1;
        let output = run_github_repository_query(cursor.as_deref()).await?;
        let response = serde_json::from_slice::<GraphQlResponse>(&output.stdout)?;

        repos.extend(
            response
                .data
                .viewer
                .repositories
                .nodes
                .into_iter()
                .filter_map(normalize_repository_item),
        );

        if !response.data.viewer.repositories.page_info.has_next_page {
            break;
        }

        cursor = response.data.viewer.repositories.page_info.end_cursor;
        if cursor.is_none() {
            break;
        }
    }

    repos.truncate(200);
    Ok(repos)
}

async fn run_github_repository_query(cursor: Option<&str>) -> anyhow::Result<std::process::Output> {
    let mut command = Command::new("gh");
    command
        .args([
            "api",
            "graphql",
            "-f",
            &format!("query={GITHUB_REPOSITORY_QUERY}"),
        ])
        .env("GH_PAGER", "cat");

    if let Some(cursor) = cursor {
        command.args(["-F", &format!("endCursor={cursor}")]);
    }

    let output = command.output().await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(output)
}

fn normalize_repository_item(item: GhRepoListItem) -> Option<Value> {
    let full_name = item.name_with_owner?;
    let name = item
        .name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            full_name
                .split('/')
                .next_back()
                .unwrap_or(&full_name)
                .to_string()
        });
    let https_url = item
        .url
        .clone()
        .map(|value| format!("{value}.git"))
        .unwrap_or_else(|| format!("https://github.com/{full_name}.git"));
    let ssh_url = item
        .ssh_url
        .unwrap_or_else(|| format!("git@github.com:{full_name}.git"));

    Some(json!({
        "name": name,
        "fullName": full_name,
        "httpsUrl": https_url,
        "sshUrl": ssh_url,
        "defaultBranch": item.default_branch_ref.and_then(|value| value.name).unwrap_or_else(|| "main".to_string()),
        "private": item.is_private.unwrap_or(false),
        "description": item.description,
        "updatedAt": item.updated_at.or(item.pushed_at),
        "ownerLogin": item.owner.and_then(|owner| owner.login).unwrap_or_default(),
        "permission": item.viewer_permission.unwrap_or_else(|| "READ".to_string()),
    }))
}

async fn fetch_owner_projects(owner_login: &str) -> anyhow::Result<Vec<GitHubProjectOption>> {
    let mut projects = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages_fetched = 0_usize;

    while projects.len() < 200 && pages_fetched < MAX_PAGINATION_PAGES {
        pages_fetched += 1;
        let mut optional_vars = Vec::new();
        if let Some(value) = cursor.as_ref() {
            optional_vars.push(("endCursor", value.clone()));
        }
        let response = run_github_graphql(
            GITHUB_OWNER_PROJECTS_QUERY,
            &[("login", owner_login.to_string())],
            &optional_vars,
        )
        .await?;

        let data = response
            .get("data")
            .ok_or_else(|| anyhow::anyhow!("GitHub did not return project data"))?;
        let connection = data
            .get("user")
            .and_then(|value| value.get("projectsV2"))
            .or_else(|| data.get("organization").and_then(|value| value.get("projectsV2")))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "No GitHub Projects were found for owner `{owner_login}` or your token cannot access them."
                )
            })?;

        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for node in nodes {
            let Some(id) = node
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            projects.push(GitHubProjectOption {
                id: id.to_string(),
                number: node
                    .get("number")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok()),
                title: node
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Untitled Project")
                    .to_string(),
                url: node
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
                closed: node.get("closed").and_then(Value::as_bool).unwrap_or(false),
                updated_at: node
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
            });
        }

        let page_info = connection.get("pageInfo").cloned().unwrap_or(Value::Null);
        let has_next_page = page_info
            .get("hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        cursor = page_info
            .get("endCursor")
            .and_then(Value::as_str)
            .map(|value| value.to_string());

        if !has_next_page || cursor.is_none() {
            break;
        }
    }

    projects.sort_by(|left, right| {
        right
            .updated_at
            .as_deref()
            .unwrap_or_default()
            .cmp(left.updated_at.as_deref().unwrap_or_default())
            .then_with(|| left.title.cmp(&right.title))
    });
    projects.truncate(200);
    Ok(projects)
}

async fn enrich_github_project_link(link: &mut GitHubProjectConfig) -> anyhow::Result<()> {
    let Some(project_id) = link.id.as_deref() else {
        anyhow::bail!("GitHub project id is required");
    };

    let response = run_github_graphql(
        GITHUB_PROJECT_METADATA_QUERY,
        &[("projectId", project_id.to_string())],
        &[],
    )
    .await?;
    let node = response
        .get("data")
        .and_then(|value| value.get("node"))
        .ok_or_else(|| anyhow::anyhow!("GitHub did not return project metadata"))?;

    if link.number.is_none() {
        link.number = node
            .get("number")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok());
    }
    if link.title.is_none() {
        link.title = node
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
    }
    if link.url.is_none() {
        link.url = node
            .get("url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }

    let status_field = detect_status_field(node.get("fields"));
    link.status_field_id = status_field.as_ref().map(|field| field.id.clone());
    link.status_field_name = status_field.map(|field| field.name);
    Ok(())
}

async fn fetch_github_project_snapshot(
    link: &GitHubProjectConfig,
) -> anyhow::Result<GitHubProjectSnapshot> {
    let Some(project_id) = link.id.as_deref() else {
        anyhow::bail!("This workspace is not linked to a GitHub Project yet.");
    };

    let mut cursor: Option<String> = None;
    let mut items = Vec::new();
    let mut merged_config = link.clone();
    let mut detected_status_field: Option<GitHubProjectStatusField> = None;
    let mut pages_fetched = 0_usize;

    loop {
        pages_fetched += 1;
        if pages_fetched > MAX_PAGINATION_PAGES {
            tracing::warn!("GitHub project snapshot pagination exceeded {MAX_PAGINATION_PAGES} pages; stopping.");
            break;
        }
        let mut optional_vars = Vec::new();
        if let Some(value) = cursor.as_ref() {
            optional_vars.push(("endCursor", value.clone()));
        }
        let response = run_github_graphql(
            GITHUB_PROJECT_SNAPSHOT_QUERY,
            &[("projectId", project_id.to_string())],
            &optional_vars,
        )
        .await?;
        let node = response
            .get("data")
            .and_then(|value| value.get("node"))
            .ok_or_else(|| anyhow::anyhow!("GitHub did not return project snapshot data"))?;

        if merged_config.number.is_none() {
            merged_config.number = node
                .get("number")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok());
        }
        if merged_config.title.is_none() {
            merged_config.title = node
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
        }
        if merged_config.url.is_none() {
            merged_config.url = node
                .get("url")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }

        if detected_status_field.is_none() {
            detected_status_field = detect_status_field(node.get("fields"));
        }

        let item_connection = node
            .get("items")
            .ok_or_else(|| anyhow::anyhow!("GitHub project items were not returned"))?;
        let nodes = item_connection
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for item in nodes {
            if let Some(parsed) = parse_project_item(&item, detected_status_field.as_ref()) {
                items.push(parsed);
            }
        }

        let page_info = item_connection
            .get("pageInfo")
            .cloned()
            .unwrap_or(Value::Null);
        let has_next_page = page_info
            .get("hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        cursor = page_info
            .get("endCursor")
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        if !has_next_page || cursor.is_none() || items.len() >= 200 {
            break;
        }
    }

    merged_config.status_field_id = detected_status_field.as_ref().map(|field| field.id.clone());
    merged_config.status_field_name = detected_status_field
        .as_ref()
        .map(|field| field.name.clone());

    Ok(GitHubProjectSnapshot {
        config: merged_config,
        status_field: detected_status_field,
        items,
    })
}

async fn pull_github_project_into_board(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<Value, (StatusCode, String)> {
    let (project_root_path, linked_project) =
        resolve_project_board_context(state, project_id).await?;
    let snapshot = fetch_github_project_snapshot(linked_project.as_ref().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Link a GitHub Project to this workspace before syncing.".to_string(),
        )
    })?)
    .await
    .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;

    if snapshot.config != linked_project.clone().unwrap_or_default() {
        persist_github_project_link(state, project_id, Some(snapshot.config.clone())).await?;
    }

    let mut board = parse_board(&project_root_path, project_id);
    let mut result_columns = board
        .columns
        .iter()
        .map(|column| ParsedBoardColumn {
            role: column.role.clone(),
            heading: column.heading.clone(),
            tasks: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut ref_board = board.clone();
    let mut items_by_github_id = HashMap::<String, usize>::new();
    let mut items_by_issue_id = HashMap::<String, usize>::new();
    for (index, item) in snapshot.items.iter().enumerate() {
        items_by_github_id.insert(item.item_id.clone(), index);
        if let Some(issue_id) = item.issue_id.as_ref() {
            items_by_issue_id.insert(issue_id.clone(), index);
        }
    }

    let mut consumed = HashSet::<usize>::new();
    let mut updated = 0_u32;
    for column in board.columns.iter_mut() {
        for task in std::mem::take(&mut column.tasks) {
            let matched_index = task
                .github_item_id
                .as_ref()
                .and_then(|value| items_by_github_id.get(value).copied())
                .or_else(|| {
                    task.issue_id
                        .as_ref()
                        .and_then(|value| items_by_issue_id.get(value).copied())
                })
                .filter(|index| !consumed.contains(index));

            if let Some(index) = matched_index {
                consumed.insert(index);
                updated += 1;
                let next_task =
                    merge_task_with_project_item(task, &snapshot.items[index], project_id);
                let target_role = github_item_to_role(&snapshot.items[index]);
                push_task_to_columns(&mut result_columns, &target_role, next_task);
            } else {
                push_task_to_columns(&mut result_columns, &column.role, task);
            }
        }
    }

    let mut created = 0_u32;
    for (index, item) in snapshot.items.iter().enumerate() {
        if consumed.contains(&index) {
            continue;
        }

        created += 1;
        let target_role = github_item_to_role(item);
        let next_task = BoardTaskRecord {
            id: Uuid::new_v4().to_string(),
            text: build_task_text(
                &item.title,
                summarize_github_body(item.body.as_deref()).as_deref(),
            ),
            checked: matches!(target_role.as_str(), "done" | "cancelled"),
            agent: None,
            project: Some(project_id.to_string()),
            task_type: if item.content_kind == "PullRequest" {
                Some("pull-request".to_string())
            } else {
                None
            },
            priority: None,
            task_ref: Some(next_human_task_ref(&ref_board, project_id)),
            attempt_ref: None,
            issue_id: item.issue_id.clone(),
            github_item_id: Some(item.item_id.clone()),
            attachments: Vec::new(),
            notes: normalize_notes(item.body.as_deref()),
        };
        push_task_to_columns(&mut result_columns, &target_role, next_task.clone());
        push_task_to_columns(&mut ref_board.columns, &target_role, next_task);
    }

    board.columns = finalize_columns(result_columns);
    write_parsed_board(&project_root_path, &board, project_id)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    state
        .push_board_activity(
            project_id,
            "github-sync",
            "pulled project",
            format!(
                "Pulled {} item(s) from {}",
                snapshot.items.len(),
                snapshot
                    .config
                    .title
                    .clone()
                    .unwrap_or_else(|| "GitHub Project".to_string())
            ),
        )
        .await;
    state.publish_snapshot().await;

    Ok(json!({
        "created": created,
        "updated": updated,
        "projectTitle": snapshot.config.title,
        "githubItems": snapshot.items.len(),
    }))
}

async fn push_board_into_github_project(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<Value, (StatusCode, String)> {
    let (board_path, linked_project) = resolve_project_board_context(state, project_id).await?;
    let linked_project = linked_project.ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "Link a GitHub Project to this workspace before syncing.".to_string(),
        )
    })?;
    let snapshot = fetch_github_project_snapshot(&linked_project)
        .await
        .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
    if snapshot.config != linked_project {
        persist_github_project_link(state, project_id, Some(snapshot.config.clone())).await?;
    }

    let (repository, owner_login, repo_name) =
        resolve_project_repo_for_sync(state, project_id).await?;
    let mut board = parse_board(&board_path, project_id);
    let status_field = snapshot.status_field.clone();
    let mut items_by_github_id = HashMap::<String, GitHubProjectItem>::new();
    let mut items_by_issue_id = HashMap::<String, GitHubProjectItem>::new();
    for item in &snapshot.items {
        items_by_github_id.insert(item.item_id.clone(), item.clone());
        if let Some(issue_id) = item.issue_id.as_ref() {
            items_by_issue_id.insert(issue_id.clone(), item.clone());
        }
    }

    let mut created = 0_u32;
    let mut updated = 0_u32;
    let mut relinked = 0_u32;

    for column in &mut board.columns {
        for task in &mut column.tasks {
            let (title, description) = split_task_text(&task.text);
            let body = build_github_body(task, description.as_deref());

            let existing_item = task
                .github_item_id
                .as_ref()
                .and_then(|value| items_by_github_id.get(value).cloned())
                .or_else(|| {
                    task.issue_id
                        .as_ref()
                        .and_then(|value| items_by_issue_id.get(value).cloned())
                });

            let synced_item = if let Some(item) = existing_item {
                if task.github_item_id.as_deref() != Some(item.item_id.as_str()) {
                    task.github_item_id = Some(item.item_id.clone());
                    relinked += 1;
                }

                if item.content_kind == "DraftIssue" {
                    if let Some(draft_issue_id) = item.draft_issue_id.as_deref() {
                        update_project_draft_issue(draft_issue_id, &title, body.as_deref())
                            .await
                            .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
                    }
                }
                updated += 1;
                item
            } else if let Some(issue_number) = parse_github_issue_number(task.issue_id.as_deref()) {
                let issue_node_id = fetch_issue_node_id(&owner_login, &repo_name, issue_number)
                    .await
                    .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
                let item_id = add_project_item_by_content(
                    snapshot.config.id.as_deref().ok_or_else(|| {
                        (
                            StatusCode::BAD_REQUEST,
                            "Linked GitHub Project is missing its node id.".to_string(),
                        )
                    })?,
                    &issue_node_id,
                )
                .await
                .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
                created += 1;
                let item = GitHubProjectItem {
                    item_id: item_id.clone(),
                    draft_issue_id: None,
                    issue_id: Some(issue_number.to_string()),
                    content_kind: "Issue".to_string(),
                    title: title.clone(),
                    body: body.clone(),
                    status_name: None,
                    state: None,
                    is_archived: false,
                };
                task.github_item_id = Some(item_id.clone());
                items_by_github_id.insert(item_id.clone(), item.clone());
                items_by_issue_id.insert(issue_number.to_string(), item.clone());
                item
            } else {
                let created_item = add_project_draft_issue(
                    snapshot.config.id.as_deref().ok_or_else(|| {
                        (
                            StatusCode::BAD_REQUEST,
                            "Linked GitHub Project is missing its node id.".to_string(),
                        )
                    })?,
                    &title,
                    body.as_deref(),
                )
                .await
                .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
                created += 1;
                task.github_item_id = Some(created_item.item_id.clone());
                items_by_github_id.insert(created_item.item_id.clone(), created_item.clone());
                created_item
            };

            if let Some(field) = status_field.as_ref() {
                if let Some(option) = resolve_status_option(field, &column.role) {
                    update_project_status(
                        snapshot.config.id.as_deref().ok_or_else(|| {
                            (
                                StatusCode::BAD_REQUEST,
                                "Linked GitHub Project is missing its node id.".to_string(),
                            )
                        })?,
                        &synced_item.item_id,
                        &field.id,
                        &option.id,
                    )
                    .await
                    .map_err(|err| (StatusCode::BAD_REQUEST, err.to_string()))?;
                }
            }
        }
    }

    write_parsed_board(&board_path, &board, project_id)
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))?;
    state
        .push_board_activity(
            project_id,
            "github-sync",
            "pushed board",
            format!(
                "Pushed board changes to {}",
                snapshot
                    .config
                    .title
                    .clone()
                    .unwrap_or_else(|| "GitHub Project".to_string())
            ),
        )
        .await;
    state.publish_snapshot().await;

    Ok(json!({
        "created": created,
        "updated": updated,
        "relinked": relinked,
        "projectTitle": snapshot.config.title,
        "repository": repository,
    }))
}

async fn resolve_project_repo_context(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<(String, String, Option<GitHubProjectConfig>), (StatusCode, String)> {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(project_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Unknown project: {project_id}"),
        ));
    };
    let repository = project
        .repo
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "This workspace does not have a GitHub repository configured yet.".to_string(),
            )
        })?;
    let (owner_login, _) = parse_repo_reference(&repository).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Could not parse a GitHub owner from repository `{repository}`"),
        )
    })?;

    Ok((repository, owner_login, project.github_project.clone()))
}

async fn resolve_project_board_context(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<(std::path::PathBuf, Option<GitHubProjectConfig>), (StatusCode, String)> {
    let config = state.config.read().await.clone();
    let Some(project) = config.projects.get(project_id) else {
        return Err((
            StatusCode::NOT_FOUND,
            format!("Unknown project: {project_id}"),
        ));
    };
    let board_dir = project
        .board_dir
        .clone()
        .unwrap_or_else(|| project_id.to_string());
    let board_relative = resolve_board_file(&state.workspace_path, &board_dir, Some(&project.path));
    Ok((
        state.workspace_path.join(board_relative),
        project.github_project.clone(),
    ))
}

async fn resolve_project_repo_for_sync(
    state: &Arc<AppState>,
    project_id: &str,
) -> Result<(String, String, String), (StatusCode, String)> {
    let (repository, owner_login, _) = resolve_project_repo_context(state, project_id).await?;
    let (_, repo_name) = parse_repo_reference(&repository).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Could not parse a GitHub repository name from `{repository}`"),
        )
    })?;
    Ok((repository, owner_login, repo_name))
}

async fn persist_github_project_link(
    state: &Arc<AppState>,
    project_id: &str,
    link: Option<GitHubProjectConfig>,
) -> Result<(), (StatusCode, String)> {
    {
        let mut config = state.config.write().await;
        let Some(project) = config.projects.get_mut(project_id) else {
            return Err((
                StatusCode::NOT_FOUND,
                format!("Unknown project: {project_id}"),
            ));
        };
        project.github_project = link;
    }
    state
        .save_config()
        .await
        .map_err(|err| (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()))
}

fn github_webhook_secret() -> Option<String> {
    env::var(GITHUB_WEBHOOK_SECRET_ENV)
        .ok()
        .or_else(|| env::var(GITHUB_WEBHOOK_SECRET_FALLBACK_ENV).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn verify_github_webhook_signature(body: &[u8], signature: Option<&str>, secret: &str) -> bool {
    let Some(signature) = signature.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(signature) = signature.strip_prefix("sha256=") else {
        return false;
    };

    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    let expected = hex::encode(mac.finalize().into_bytes());
    constant_time_equal(expected.as_bytes(), signature.as_bytes())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut mismatch = 0u8;
    for (lhs, rhs) in left.iter().zip(right.iter()) {
        mismatch |= lhs ^ rhs;
    }
    mismatch == 0
}

fn is_sync_relevant_github_event(event: &str) -> bool {
    matches!(
        event,
        "projects_v2_item" | "projects_v2" | "issues" | "issue_comment" | "pull_request"
    )
}

async fn matched_projects_for_webhook(state: &Arc<AppState>, payload: &Value) -> Vec<String> {
    let repo_full_name = repository_full_name_from_payload(payload);
    let repo_name = repository_name_from_payload(payload);
    let owner_login = owner_login_from_payload(payload);
    let project_node_id = github_project_id_from_payload(payload);
    let project_number = github_project_number_from_payload(payload);

    let config = state.config.read().await.clone();
    let mut matched = Vec::new();
    for (project_id, project) in &config.projects {
        let Some(linked_project) = project.github_project.as_ref() else {
            continue;
        };

        let repo_matches = project.repo.as_deref().map(|project_repo| {
            repository_matches_project(
                project_repo,
                repo_full_name.as_deref(),
                repo_name.as_deref(),
            )
        });
        let owner_matches = owner_login
            .as_deref()
            .zip(linked_project.owner_login.as_deref())
            .map(|(incoming, linked)| incoming.eq_ignore_ascii_case(linked));
        let project_id_matches = project_node_id
            .as_deref()
            .zip(linked_project.id.as_deref())
            .map(|(incoming, linked)| incoming == linked);
        let project_number_matches = project_number
            .zip(linked_project.number)
            .map(|(incoming, linked)| incoming == linked);

        if repo_matches.unwrap_or(false)
            || project_id_matches.unwrap_or(false)
            || project_number_matches.unwrap_or(false)
            || (owner_matches.unwrap_or(false)
                && project_number.is_none()
                && project_node_id.is_none())
        {
            matched.push(project_id.clone());
        }
    }

    matched.sort();
    matched.dedup();
    matched
}

fn repository_matches_project(
    project_repo: &str,
    webhook_full_name: Option<&str>,
    webhook_repo_name: Option<&str>,
) -> bool {
    let Some((owner, repo)) = parse_repo_reference(project_repo) else {
        return webhook_repo_name
            .map(|value| project_repo.eq_ignore_ascii_case(value))
            .unwrap_or(false);
    };
    let normalized_full_name = format!("{owner}/{repo}");
    webhook_full_name
        .map(|value| normalized_full_name.eq_ignore_ascii_case(value))
        .unwrap_or(false)
        || webhook_repo_name
            .map(|value| repo.eq_ignore_ascii_case(value))
            .unwrap_or(false)
}

fn repository_full_name_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("repository")
        .and_then(|value| value.get("full_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn repository_name_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("repository")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn owner_login_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("organization")
        .and_then(|value| value.get("login"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("repository")
                .and_then(|value| value.get("owner"))
                .and_then(|value| value.get("login"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn github_project_id_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("projects_v2")
        .and_then(|value| value.get("node_id").or_else(|| value.get("id")))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("project_v2")
                .and_then(|value| value.get("node_id").or_else(|| value.get("id")))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .get("project")
                .and_then(|value| value.get("node_id").or_else(|| value.get("id")))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn github_project_number_from_payload(payload: &Value) -> Option<u32> {
    payload
        .get("projects_v2")
        .and_then(|value| value.get("number"))
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .get("project_v2")
                .and_then(|value| value.get("number"))
                .and_then(Value::as_u64)
        })
        .or_else(|| {
            payload
                .get("project")
                .and_then(|value| value.get("number"))
                .and_then(Value::as_u64)
        })
        .and_then(|value| u32::try_from(value).ok())
}

fn parse_repo_reference(value: &str) -> Option<(String, String)> {
    let trimmed = value.trim().trim_end_matches(".git").trim_end_matches('/');
    let without_prefix = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
        .or_else(|| trimmed.strip_prefix("git@github.com:"))
        .unwrap_or(trimmed);
    let mut parts = without_prefix
        .split('/')
        .filter(|part| !part.trim().is_empty());
    let owner = parts.next()?.trim().to_string();
    let repo = parts.next()?.trim().to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

fn project_option_to_value(project: GitHubProjectOption) -> Value {
    json!({
        "id": project.id,
        "number": project.number,
        "title": project.title,
        "url": project.url,
        "closed": project.closed,
        "updatedAt": project.updated_at,
    })
}

fn detect_status_field(fields: Option<&Value>) -> Option<GitHubProjectStatusField> {
    let nodes = fields?.get("nodes")?.as_array()?;
    let mut candidates = nodes
        .iter()
        .filter_map(|node| {
            let data_type = node
                .get("dataType")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if !data_type.eq_ignore_ascii_case("SINGLE_SELECT") {
                return None;
            }
            let id = node.get("id")?.as_str()?.trim();
            let name = node.get("name")?.as_str()?.trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let options = node
                .get("options")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|option| {
                            let id = option.get("id")?.as_str()?.trim();
                            let name = option.get("name")?.as_str()?.trim();
                            if id.is_empty() || name.is_empty() {
                                None
                            } else {
                                Some(GitHubProjectStatusOption {
                                    id: id.to_string(),
                                    name: name.to_string(),
                                })
                            }
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(GitHubProjectStatusField {
                id: id.to_string(),
                name: name.to_string(),
                options,
            })
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        let left_score = if canonical_status_name(&left.name) == "status" {
            0
        } else {
            1
        };
        let right_score = if canonical_status_name(&right.name) == "status" {
            0
        } else {
            1
        };
        left_score
            .cmp(&right_score)
            .then_with(|| left.name.cmp(&right.name))
    });
    candidates.into_iter().next()
}

fn parse_project_item(
    value: &Value,
    status_field: Option<&GitHubProjectStatusField>,
) -> Option<GitHubProjectItem> {
    let item_id = value.get("id")?.as_str()?.trim();
    if item_id.is_empty() {
        return None;
    }
    let content = value.get("content").unwrap_or(&Value::Null);
    let content_kind = content
        .get("__typename")
        .and_then(Value::as_str)
        .unwrap_or("DraftIssue")
        .to_string();
    let title = content
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled task")
        .to_string();

    let status_name = value
        .get("fieldValues")
        .and_then(|field_values| field_values.get("nodes"))
        .and_then(Value::as_array)
        .and_then(|nodes| {
            nodes.iter().find_map(|entry| {
                let field = entry.get("field")?;
                let field_id = field.get("id").and_then(Value::as_str).unwrap_or_default();
                let field_name = field
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let matches_status = status_field
                    .map(|configured| {
                        field_id == configured.id
                            || canonical_status_name(field_name)
                                == canonical_status_name(&configured.name)
                    })
                    .unwrap_or_else(|| canonical_status_name(field_name) == "status");
                if !matches_status {
                    return None;
                }
                entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
        });

    Some(GitHubProjectItem {
        item_id: item_id.to_string(),
        draft_issue_id: if content_kind == "DraftIssue" {
            content
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        } else {
            None
        },
        issue_id: if content_kind == "Issue" {
            content
                .get("number")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
        } else {
            None
        },
        content_kind,
        title,
        body: content
            .get("body")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|value| !value.trim().is_empty()),
        status_name,
        state: content
            .get("state")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        is_archived: value
            .get("isArchived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn github_item_to_role(item: &GitHubProjectItem) -> String {
    if item.is_archived {
        return "cancelled".to_string();
    }
    if let Some(status_name) = item.status_name.as_deref() {
        return normalize_role(status_name).to_string();
    }
    if item.content_kind == "PullRequest" {
        if matches!(item.state.as_deref(), Some("MERGED") | Some("CLOSED")) {
            return "done".to_string();
        }
        return "review".to_string();
    }
    if matches!(item.state.as_deref(), Some("CLOSED")) {
        return "done".to_string();
    }
    "intake".to_string()
}

fn merge_task_with_project_item(
    mut task: BoardTaskRecord,
    item: &GitHubProjectItem,
    project_id: &str,
) -> BoardTaskRecord {
    task.text = build_task_text(
        &item.title,
        summarize_github_body(item.body.as_deref()).as_deref(),
    );
    task.checked = matches!(github_item_to_role(item).as_str(), "done" | "cancelled");
    task.issue_id = item.issue_id.clone();
    task.github_item_id = Some(item.item_id.clone());
    task.notes = normalize_notes(item.body.as_deref()).or(task.notes);
    if task
        .project
        .as_deref()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        task.project = Some(project_id.to_string());
    }
    if task.task_type.is_none() && item.content_kind == "PullRequest" {
        task.task_type = Some("pull-request".to_string());
    }
    task
}

fn truncate_utf8_safe(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn summarize_github_body(value: Option<&str>) -> Option<String> {
    let collapsed = collapse_whitespace(value?);
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.len() <= 140 {
        return Some(collapsed);
    }
    Some(format!("{}...", truncate_utf8_safe(&collapsed, 137)))
}

fn normalize_notes(value: Option<&str>) -> Option<String> {
    let collapsed = collapse_whitespace(value?);
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.len() <= 1_000 {
        return Some(collapsed);
    }
    Some(format!("{}...", truncate_utf8_safe(&collapsed, 997)))
}

fn collapse_whitespace(value: &str) -> String {
    value
        .split_whitespace()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn push_task_to_columns(columns: &mut Vec<ParsedBoardColumn>, role: &str, task: BoardTaskRecord) {
    if let Some(column) = columns.iter_mut().find(|column| column.role == role) {
        column.tasks.push(task);
        return;
    }

    columns.push(ParsedBoardColumn {
        role: role.to_string(),
        heading: default_heading_for_role(role).to_string(),
        tasks: vec![task],
    });
}

fn finalize_columns(columns: Vec<ParsedBoardColumn>) -> Vec<ParsedBoardColumn> {
    let role_rank = |role: &str| {
        [
            "intake",
            "ready",
            "dispatching",
            "inProgress",
            "needsInput",
            "blocked",
            "errored",
            "review",
            "merge",
            "done",
            "cancelled",
        ]
        .iter()
        .position(|candidate| candidate == &role)
        .unwrap_or(usize::MAX)
    };

    let mut next = columns
        .into_iter()
        .filter(|column| !column.heading.trim().is_empty())
        .collect::<Vec<_>>();
    next.sort_by(|left, right| {
        role_rank(&left.role)
            .cmp(&role_rank(&right.role))
            .then_with(|| left.heading.cmp(&right.heading))
    });
    next
}

fn build_github_body(task: &BoardTaskRecord, description: Option<&str>) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(description) = description.map(str::trim).filter(|value| !value.is_empty()) {
        sections.push(description.to_string());
    }
    if let Some(notes) = task
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(notes.to_string());
    }
    if !task.attachments.is_empty() {
        sections.push(format!(
            "Attachments:\n{}",
            task.attachments
                .iter()
                .map(|value| format!("- {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if let Some(task_ref) = task
        .task_ref
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Conductor task: {task_ref}"));
    }
    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n\n"))
    }
}

fn canonical_status_name(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_status_option<'a>(
    field: &'a GitHubProjectStatusField,
    role: &str,
) -> Option<&'a GitHubProjectStatusOption> {
    let aliases = role_status_aliases(role);
    field.options.iter().find(|option| {
        let normalized = canonical_status_name(&option.name);
        aliases
            .iter()
            .any(|alias| normalized == canonical_status_name(alias))
            || normalize_role(&option.name) == role
    })
}

fn role_status_aliases(role: &str) -> &'static [&'static str] {
    match role {
        "intake" => &["todo", "to do", "backlog", "planned", "triage"],
        "ready" => &["ready", "todo", "to do", "planned"],
        "dispatching" => &["in progress", "active", "doing"],
        "inProgress" => &["in progress", "active", "doing"],
        "needsInput" => &["needs input", "blocked", "waiting", "on hold"],
        "blocked" => &["blocked", "on hold", "waiting"],
        "errored" => &["blocked", "on hold", "todo"],
        "review" => &["in review", "review", "qa"],
        "merge" => &["merge", "ready to merge", "review", "done"],
        "done" => &["done", "complete", "completed", "shipped"],
        "cancelled" => &["cancelled", "canceled", "archived", "wont do", "won't do"],
        _ => &[],
    }
}

async fn fetch_issue_node_id(owner: &str, repo: &str, issue_number: u32) -> anyhow::Result<String> {
    let response = run_github_graphql(
        GITHUB_REPOSITORY_ISSUE_QUERY,
        &[("owner", owner.to_string()), ("repo", repo.to_string())],
        &[("number", issue_number.to_string())],
    )
    .await?;
    response
        .get("data")
        .and_then(|value| value.get("repository"))
        .and_then(|value| value.get("issue"))
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| {
            anyhow::anyhow!("GitHub issue #{issue_number} was not found in {owner}/{repo}.")
        })
}

async fn add_project_item_by_content(project_id: &str, content_id: &str) -> anyhow::Result<String> {
    let response = run_github_graphql(
        GITHUB_ADD_PROJECT_ITEM_MUTATION,
        &[
            ("projectId", project_id.to_string()),
            ("contentId", content_id.to_string()),
        ],
        &[],
    )
    .await?;
    response
        .get("data")
        .and_then(|value| value.get("addProjectV2ItemById"))
        .and_then(|value| value.get("item"))
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("GitHub did not return a project item id."))
}

async fn add_project_draft_issue(
    project_id: &str,
    title: &str,
    body: Option<&str>,
) -> anyhow::Result<GitHubProjectItem> {
    let mut optional_vars = Vec::new();
    if let Some(body) = body {
        optional_vars.push(("body", body.to_string()));
    }
    let response = run_github_graphql(
        GITHUB_ADD_PROJECT_DRAFT_MUTATION,
        &[
            ("projectId", project_id.to_string()),
            ("title", title.to_string()),
        ],
        &optional_vars,
    )
    .await?;
    let project_item = response
        .get("data")
        .and_then(|value| value.get("addProjectV2DraftIssue"))
        .and_then(|value| value.get("projectItem"))
        .ok_or_else(|| anyhow::anyhow!("GitHub did not return the created draft issue."))?;

    Ok(GitHubProjectItem {
        item_id: project_item
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow::anyhow!("GitHub did not return the created project item id."))?,
        draft_issue_id: project_item
            .get("content")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        issue_id: None,
        content_kind: "DraftIssue".to_string(),
        title: title.to_string(),
        body: body.map(ToOwned::to_owned),
        status_name: None,
        state: None,
        is_archived: false,
    })
}

async fn update_project_draft_issue(
    draft_issue_id: &str,
    title: &str,
    body: Option<&str>,
) -> anyhow::Result<()> {
    let mut optional_vars = Vec::new();
    if let Some(body) = body {
        optional_vars.push(("body", body.to_string()));
    }
    run_github_graphql(
        GITHUB_UPDATE_DRAFT_MUTATION,
        &[
            ("draftIssueId", draft_issue_id.to_string()),
            ("title", title.to_string()),
        ],
        &optional_vars,
    )
    .await?;
    Ok(())
}

async fn update_project_status(
    project_id: &str,
    item_id: &str,
    field_id: &str,
    option_id: &str,
) -> anyhow::Result<()> {
    run_github_graphql(
        GITHUB_UPDATE_FIELD_MUTATION,
        &[
            ("projectId", project_id.to_string()),
            ("itemId", item_id.to_string()),
            ("fieldId", field_id.to_string()),
        ],
        &[("optionId", option_id.to_string())],
    )
    .await?;
    Ok(())
}

fn parse_github_issue_number(value: Option<&str>) -> Option<u32> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u32>().ok())
}

async fn run_github_graphql(
    query: &str,
    required_vars: &[(&str, String)],
    optional_vars: &[(&str, String)],
) -> anyhow::Result<Value> {
    let mut command = Command::new("gh");
    command
        .args(["api", "graphql", "-f", &format!("query={query}")])
        .env("GH_PAGER", "cat");

    for (key, value) in required_vars.iter().chain(optional_vars.iter()) {
        command.args(["-F", &format!("{key}={value}")]);
    }

    let output = command.output().await?;
    if !output.status.success() {
        anyhow::bail!(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(serde_json::from_slice::<Value>(&output.stdout)?)
}

async fn assert_gh_authenticated() -> anyhow::Result<()> {
    let output = Command::new("gh")
        .args(["auth", "status"])
        .env("GH_PAGER", "cat")
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(
            "GitHub is not connected on this machine yet. Run `gh auth login` once, then try again."
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_repository_item_maps_accessible_repo_metadata() {
        let value = normalize_repository_item(GhRepoListItem {
            name: Some("conductor-oss".to_string()),
            name_with_owner: Some("charannyk06/conductor-oss".to_string()),
            description: Some("AI agent orchestration".to_string()),
            url: Some("https://github.com/charannyk06/conductor-oss".to_string()),
            ssh_url: Some("git@github.com:charannyk06/conductor-oss.git".to_string()),
            is_private: Some(false),
            updated_at: Some("2026-03-08T12:00:00Z".to_string()),
            pushed_at: None,
            viewer_permission: Some("ADMIN".to_string()),
            owner: Some(GhOwner {
                login: Some("charannyk06".to_string()),
            }),
            default_branch_ref: Some(GhDefaultBranch {
                name: Some("main".to_string()),
            }),
        })
        .expect("repo should normalize");

        assert_eq!(value["fullName"], "charannyk06/conductor-oss");
        assert_eq!(
            value["httpsUrl"],
            "https://github.com/charannyk06/conductor-oss.git"
        );
        assert_eq!(value["defaultBranch"], "main");
        assert_eq!(value["description"], "AI agent orchestration");
        assert_eq!(value["ownerLogin"], "charannyk06");
        assert_eq!(value["permission"], "ADMIN");
    }

    #[test]
    fn normalize_repository_item_falls_back_to_full_name_segments() {
        let value = normalize_repository_item(GhRepoListItem {
            name: None,
            name_with_owner: Some("octo-org/roadmap".to_string()),
            description: None,
            url: None,
            ssh_url: None,
            is_private: Some(true),
            updated_at: None,
            pushed_at: Some("2026-03-08T12:00:00Z".to_string()),
            viewer_permission: None,
            owner: Some(GhOwner {
                login: Some("octo-org".to_string()),
            }),
            default_branch_ref: None,
        })
        .expect("repo should normalize");

        assert_eq!(value["name"], "roadmap");
        assert_eq!(value["httpsUrl"], "https://github.com/octo-org/roadmap.git");
        assert_eq!(value["sshUrl"], "git@github.com:octo-org/roadmap.git");
        assert_eq!(value["defaultBranch"], "main");
        assert_eq!(value["updatedAt"], "2026-03-08T12:00:00Z");
        assert_eq!(value["permission"], "READ");
    }

    #[test]
    fn parse_repo_reference_accepts_full_urls_and_slugs() {
        assert_eq!(
            parse_repo_reference("https://github.com/openai/codex.git"),
            Some(("openai".to_string(), "codex".to_string()))
        );
        assert_eq!(
            parse_repo_reference("git@github.com:openai/codex.git"),
            Some(("openai".to_string(), "codex".to_string()))
        );
        assert_eq!(
            parse_repo_reference("openai/codex"),
            Some(("openai".to_string(), "codex".to_string()))
        );
    }

    #[test]
    fn resolve_status_option_uses_aliases() {
        let field = GitHubProjectStatusField {
            id: "field".to_string(),
            name: "Status".to_string(),
            options: vec![
                GitHubProjectStatusOption {
                    id: "todo".to_string(),
                    name: "Todo".to_string(),
                },
                GitHubProjectStatusOption {
                    id: "doing".to_string(),
                    name: "In Progress".to_string(),
                },
                GitHubProjectStatusOption {
                    id: "done".to_string(),
                    name: "Done".to_string(),
                },
            ],
        };

        assert_eq!(
            resolve_status_option(&field, "intake").map(|value| value.id.as_str()),
            Some("todo")
        );
        assert_eq!(
            resolve_status_option(&field, "inProgress").map(|value| value.id.as_str()),
            Some("doing")
        );
        assert_eq!(
            resolve_status_option(&field, "done").map(|value| value.id.as_str()),
            Some("done")
        );
    }

    #[test]
    fn verify_github_webhook_signature_accepts_valid_hmac() {
        let body = br#"{"zen":"Keep it logically awesome"}"#;
        let secret = "test-secret";
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac");
        mac.update(body);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        assert!(verify_github_webhook_signature(
            body,
            Some(&signature),
            secret
        ));
        assert!(!verify_github_webhook_signature(
            body,
            Some("sha256=deadbeef"),
            secret
        ));
    }
}
