use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

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

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/github/repos", get(list_github_repositories))
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

async fn fetch_accessible_github_repositories() -> anyhow::Result<Vec<Value>> {
    let mut repos = Vec::new();
    let mut cursor: Option<String> = None;

    while repos.len() < 200 {
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
}
