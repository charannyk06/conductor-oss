use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::process::Command;

use crate::state::AppState;

type ApiResponse = (StatusCode, Json<Value>);

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoListItem {
    name_with_owner: Option<String>,
    url: Option<String>,
    ssh_url: Option<String>,
    is_private: Option<bool>,
    default_branch_ref: Option<GhDefaultBranch>,
}

#[derive(Debug, Deserialize)]
struct GhDefaultBranch {
    name: Option<String>,
}

async fn list_github_repositories(Query(query): Query<RepoQuery>) -> ApiResponse {
    if let Err(err) = assert_gh_authenticated().await {
        return error(StatusCode::BAD_REQUEST, err.to_string());
    }

    let output = match Command::new("gh")
        .args([
            "repo",
            "list",
            "--limit",
            "200",
            "--json",
            "nameWithOwner,url,sshUrl,isPrivate,defaultBranchRef",
        ])
        .env("GH_PAGER", "cat")
        .output()
        .await
    {
        Ok(output) => output,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    if !output.status.success() {
        return error(StatusCode::BAD_REQUEST, String::from_utf8_lossy(&output.stderr).to_string());
    }

    let mut repos = match serde_json::from_slice::<Vec<GhRepoListItem>>(&output.stdout) {
        Ok(items) => items
            .into_iter()
            .filter_map(|item| {
                let full_name = item.name_with_owner?;
                let name = full_name.split('/').next_back().unwrap_or(&full_name).to_string();
                let https_url = item.url.clone().map(|value| format!("{value}.git")).unwrap_or_else(|| format!("https://github.com/{full_name}.git"));
                let ssh_url = item.ssh_url.unwrap_or_else(|| format!("git@github.com:{full_name}.git"));
                Some(json!({
                    "name": name,
                    "fullName": full_name,
                    "httpsUrl": https_url,
                    "sshUrl": ssh_url,
                    "defaultBranch": item.default_branch_ref.and_then(|value| value.name).unwrap_or_else(|| "main".to_string()),
                    "private": item.is_private.unwrap_or(false),
                }))
            })
            .collect::<Vec<_>>(),
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };

    if let Some(query_value) = query.q.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let query_value = query_value.to_lowercase();
        repos.retain(|repo| {
            repo["fullName"].as_str().unwrap_or_default().to_lowercase().contains(&query_value)
                || repo["name"].as_str().unwrap_or_default().to_lowercase().contains(&query_value)
                || repo["defaultBranch"].as_str().unwrap_or_default().to_lowercase().contains(&query_value)
        });
    }

    repos.sort_by(|left, right| left["fullName"].as_str().unwrap_or_default().cmp(right["fullName"].as_str().unwrap_or_default()));
    ok(json!({ "repos": repos }))
}

async fn assert_gh_authenticated() -> anyhow::Result<()> {
    let output = Command::new("gh")
        .args(["auth", "status"])
        .env("GH_PAGER", "cat")
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!("GitHub CLI is not authenticated. Run `gh auth login` first.");
    }
    Ok(())
}
