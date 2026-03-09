use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PRInfo {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub owner: String,
    pub repo: String,
    pub branch: String,
    pub base_branch: String,
    pub is_draft: bool,
}

impl PRInfo {
    pub fn repo_slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CIStatus {
    Pending,
    Passing,
    Failing,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    ChangesRequested,
    Pending,
    None,
}

pub async fn detect_pr(repo: &str, branch: &str) -> Result<Option<PRInfo>> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Ok(None);
    }

    let (owner, repo_name) = parse_repo_slug(repo)?;
    let output = gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--json",
        "number,url,title,headRefName,baseRefName,isDraft",
        "--limit",
        "1",
    ])
    .await?;

    parse_detect_pr_output(&output, owner, repo_name)
}

pub async fn check_ci_status(pr: &PRInfo) -> Result<CIStatus> {
    let output = gh([
        "pr",
        "checks",
        &pr.number.to_string(),
        "--repo",
        &pr.repo_slug(),
        "--json",
        "name,state,link",
    ])
    .await;

    match output {
        Ok(raw) => {
            let checks: Vec<RawCiCheck> = serde_json::from_str(&raw)
                .context("Failed to parse gh output for check_ci_status")?;
            Ok(summarize_ci_checks(&checks))
        }
        Err(err) if is_rate_limited(&err) => Ok(CIStatus::Pending),
        Err(err) => Err(err),
    }
}

pub async fn check_review_status(pr: &PRInfo) -> Result<ReviewStatus> {
    let output = gh([
        "pr",
        "view",
        &pr.number.to_string(),
        "--repo",
        &pr.repo_slug(),
        "--json",
        "reviewDecision",
    ])
    .await?;

    let payload: RawReviewDecision = serde_json::from_str(&output)
        .context("Failed to parse gh output for check_review_status")?;
    Ok(map_review_decision(payload.review_decision.as_deref()))
}

async fn gh<I, S>(args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let args = args
        .into_iter()
        .map(|value| value.as_ref().to_os_string())
        .collect::<Vec<_>>();
    let preview = args
        .iter()
        .take(3)
        .map(|value| value.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");

    let output = Command::new("gh")
        .args(&args)
        .output()
        .await
        .with_context(|| format!("Failed to start gh {preview}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {:?}", output.status.code())
    };

    Err(anyhow!("gh {preview} failed: {message}"))
}

fn parse_repo_slug(repo: &str) -> Result<(&str, &str)> {
    let mut parts = repo.split('/').map(str::trim);
    let owner = parts.next().unwrap_or_default();
    let repo_name = parts.next().unwrap_or_default();
    if owner.is_empty() || repo_name.is_empty() || parts.next().is_some() {
        bail!("Invalid repo format \"{repo}\", expected \"owner/repo\"");
    }
    Ok((owner, repo_name))
}

fn parse_detect_pr_output(output: &str, owner: &str, repo: &str) -> Result<Option<PRInfo>> {
    let prs: Vec<RawPrListItem> =
        serde_json::from_str(output).context("Failed to parse gh output for detect_pr")?;
    let Some(pr) = prs.into_iter().next() else {
        return Ok(None);
    };

    Ok(Some(PRInfo {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        owner: owner.to_string(),
        repo: repo.to_string(),
        branch: pr.head_ref_name,
        base_branch: pr.base_ref_name,
        is_draft: pr.is_draft,
    }))
}

fn summarize_ci_checks(checks: &[RawCiCheck]) -> CIStatus {
    if checks.is_empty() {
        return CIStatus::None;
    }

    let mut has_pending = false;
    let mut has_passing = false;

    for check in checks {
        match map_ci_check_state(check.state.as_deref()) {
            MappedCiCheckState::Failed => return CIStatus::Failing,
            MappedCiCheckState::Pending | MappedCiCheckState::Running => has_pending = true,
            MappedCiCheckState::Passed => has_passing = true,
            MappedCiCheckState::Skipped => {}
        }
    }

    if has_pending {
        CIStatus::Pending
    } else if has_passing {
        CIStatus::Passing
    } else {
        CIStatus::None
    }
}

fn map_review_decision(value: Option<&str>) -> ReviewStatus {
    match value.unwrap_or_default().to_ascii_uppercase().as_str() {
        "APPROVED" => ReviewStatus::Approved,
        "CHANGES_REQUESTED" => ReviewStatus::ChangesRequested,
        "REVIEW_REQUIRED" | "PENDING" => ReviewStatus::Pending,
        _ => ReviewStatus::None,
    }
}

fn is_rate_limited(err: &anyhow::Error) -> bool {
    let lower = err.to_string().to_ascii_lowercase();
    lower.contains("rate limit") || lower.contains("secondary rate") || lower.contains("403")
}

fn map_ci_check_state(value: Option<&str>) -> MappedCiCheckState {
    match value.unwrap_or_default().to_ascii_uppercase().as_str() {
        "PENDING" | "QUEUED" => MappedCiCheckState::Pending,
        "IN_PROGRESS" => MappedCiCheckState::Running,
        "SUCCESS" => MappedCiCheckState::Passed,
        "SKIPPED" | "NEUTRAL" => MappedCiCheckState::Skipped,
        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" => MappedCiCheckState::Failed,
        _ => MappedCiCheckState::Failed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MappedCiCheckState {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrListItem {
    number: u64,
    url: String,
    title: String,
    head_ref_name: String,
    base_ref_name: String,
    is_draft: bool,
}

#[derive(Debug, Deserialize)]
struct RawCiCheck {
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReviewDecision {
    review_decision: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_repo_slug_requires_owner_and_repo() {
        let (owner, repo) = parse_repo_slug("acme/widgets").unwrap();
        assert_eq!(owner, "acme");
        assert_eq!(repo, "widgets");
        assert!(parse_repo_slug("widgets").is_err());
        assert!(parse_repo_slug("a/b/c").is_err());
    }

    #[test]
    fn detect_pr_parser_maps_first_result() {
        let output = r#"[{
            "number": 42,
            "url": "https://github.com/acme/widgets/pull/42",
            "title": "Add tracker",
            "headRefName": "session/demo",
            "baseRefName": "main",
            "isDraft": true
        }]"#;
        let pr = parse_detect_pr_output(output, "acme", "widgets")
            .unwrap()
            .expect("expected PR");

        assert_eq!(pr.number, 42);
        assert_eq!(pr.url, "https://github.com/acme/widgets/pull/42");
        assert_eq!(pr.owner, "acme");
        assert_eq!(pr.repo, "widgets");
        assert_eq!(pr.branch, "session/demo");
        assert_eq!(pr.base_branch, "main");
        assert!(pr.is_draft);
    }

    #[test]
    fn ci_summary_prioritizes_failure_then_pending_then_passing() {
        let failing = summarize_ci_checks(&[
            RawCiCheck {
                state: Some("success".to_string()),
            },
            RawCiCheck {
                state: Some("failure".to_string()),
            },
        ]);
        let pending = summarize_ci_checks(&[
            RawCiCheck {
                state: Some("queued".to_string()),
            },
            RawCiCheck {
                state: Some("success".to_string()),
            },
        ]);
        let passing = summarize_ci_checks(&[RawCiCheck {
            state: Some("success".to_string()),
        }]);
        let none = summarize_ci_checks(&[RawCiCheck {
            state: Some("skipped".to_string()),
        }]);

        assert_eq!(failing, CIStatus::Failing);
        assert_eq!(pending, CIStatus::Pending);
        assert_eq!(passing, CIStatus::Passing);
        assert_eq!(none, CIStatus::None);
    }

    #[test]
    fn review_decision_mapping_matches_github_states() {
        assert_eq!(
            map_review_decision(Some("APPROVED")),
            ReviewStatus::Approved
        );
        assert_eq!(
            map_review_decision(Some("CHANGES_REQUESTED")),
            ReviewStatus::ChangesRequested
        );
        assert_eq!(
            map_review_decision(Some("REVIEW_REQUIRED")),
            ReviewStatus::Pending
        );
        assert_eq!(map_review_decision(Some("")), ReviewStatus::None);
        assert_eq!(map_review_decision(None), ReviewStatus::None);
    }
}
