//! Posting a bot's finished turn back to where the request came from, and turning inbound
//! GitHub comments into bot requests.

use anyhow::{anyhow, bail, Context, Result};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::state::bots::{
    default_bot, find_prefixed_bot, select_bot_for_text, BotReplyTarget, BotSendError,
};
use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;

pub(crate) const SLACK_BOT_TOKEN_ENV: &str = "CONDUCTOR_SLACK_BOT_TOKEN";
pub(crate) const SLACK_SIGNING_SECRET_ENV: &str = "CONDUCTOR_SLACK_SIGNING_SECRET";
pub(crate) const SLACK_ALLOWED_USERS_ENV: &str = "CONDUCTOR_SLACK_ALLOWED_USERS";
/// Hidden marker on every GitHub comment a bot posts, so a bot never answers itself.
pub(crate) const GITHUB_REPLY_MARKER: &str = "<!-- conductor-bot-reply -->";
const SLACK_SIGNATURE_MAX_SKEW_SECONDS: i64 = 60 * 5;
const BUSY_REPLY: &str =
    "I'm in the middle of another task right now. Mention me again in a few minutes.";

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_valid_repository(repository: &str) -> bool {
    let mut parts = repository.split('/');
    let valid_part = |part: Option<&str>| {
        part.map(|value| {
            !value.is_empty()
                && !value.starts_with('-')
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        })
        .unwrap_or(false)
    };
    valid_part(parts.next()) && valid_part(parts.next()) && parts.next().is_none()
}

async fn post_github_comment(repository: &str, issue_number: u64, body: &str) -> Result<()> {
    if !is_valid_repository(repository) {
        bail!("Refusing to comment on malformed repository `{repository}`");
    }
    let mut child = Command::new("gh")
        .args([
            "issue",
            "comment",
            &issue_number.to_string(),
            "--repo",
            repository,
            "--body-file",
            "-",
        ])
        .env("GH_PAGER", "cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("Failed to run `gh`; install the GitHub CLI and run `gh auth login`")?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(body.as_bytes()).await?;
    }
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        bail!(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(())
}

async fn post_slack_message(channel: &str, thread_ts: Option<&str>, text: &str) -> Result<()> {
    let token = env_value(SLACK_BOT_TOKEN_ENV)
        .with_context(|| format!("{SLACK_BOT_TOKEN_ENV} is not set"))?;
    let mut payload = json!({ "channel": channel, "text": text });
    if let Some(thread_ts) = thread_ts {
        payload["thread_ts"] = json!(thread_ts);
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?
        .post("https://slack.com/api/chat.postMessage")
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await?
        .json::<Value>()
        .await?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!(
            "Slack rejected the message: {}",
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        );
    }
    Ok(())
}

pub(crate) async fn deliver_bot_reply(
    target: &BotReplyTarget,
    bot_name: &str,
    text: &str,
) -> Result<()> {
    match target {
        BotReplyTarget::Github {
            repository,
            issue_number,
        } => {
            let body = format!("**{bot_name}** · Conductor bot\n\n{text}\n\n{GITHUB_REPLY_MARKER}");
            post_github_comment(repository, *issue_number, &body).await
        }
        BotReplyTarget::Slack { channel, thread_ts } => {
            post_slack_message(
                channel,
                thread_ts.as_deref(),
                &format!("*{bot_name}*\n{text}"),
            )
            .await
        }
    }
}

/// `owner/name` extracted from a project's configured repo (URL, SSH remote, or slug).
pub(crate) fn repository_slug(repo: &str) -> Option<String> {
    let trimmed = repo.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let tail = trimmed
        .rsplit_once("github.com/")
        .or_else(|| trimmed.rsplit_once("github.com:"))
        .map(|(_, tail)| tail)
        .unwrap_or(trimmed);
    let mut parts = tail.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?;
    let name = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let slug = format!("{owner}/{name}").to_ascii_lowercase();
    is_valid_repository(&slug).then_some(slug)
}

/// A GitHub `issue_comment` payload reduced to what a bot needs.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct GithubMention {
    pub comment_id: String,
    pub repository: String,
    pub issue_number: u64,
    pub issue_title: String,
    pub is_pull_request: bool,
    pub author: String,
    pub body: String,
    pub url: String,
}

/// Returns the mention when the comment is one a bot may act on: newly created, written by
/// someone with write-level association to the repository, and not a bot's own reply.
pub(crate) fn parse_github_mention(payload: &Value) -> Option<GithubMention> {
    if payload.get("action").and_then(Value::as_str) != Some("created") {
        return None;
    }
    let comment = payload.get("comment")?;
    let body = comment.get("body").and_then(Value::as_str)?.trim();
    if body.is_empty() || body.contains(GITHUB_REPLY_MARKER) {
        return None;
    }
    let user = comment.get("user")?;
    if user.get("type").and_then(Value::as_str) == Some("Bot") {
        return None;
    }
    let association = comment
        .get("author_association")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(association, "OWNER" | "MEMBER" | "COLLABORATOR") {
        return None;
    }
    let issue = payload.get("issue")?;
    Some(GithubMention {
        comment_id: comment.get("id").map(Value::to_string)?,
        repository: payload
            .get("repository")?
            .get("full_name")
            .and_then(Value::as_str)?
            .to_string(),
        issue_number: issue.get("number").and_then(Value::as_u64)?,
        issue_title: issue
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        is_pull_request: issue.get("pull_request").is_some(),
        author: user.get("login").and_then(Value::as_str)?.to_string(),
        body: body.to_string(),
        url: comment
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// Route a GitHub comment that mentions a bot to that bot. Returns the bot name when handled.
pub(crate) async fn handle_github_comment(
    state: &Arc<AppState>,
    payload: &Value,
) -> Option<String> {
    let mention = parse_github_mention(payload)?;
    let repository = mention.repository.to_ascii_lowercase();
    let project_ids = {
        let config = state.config.read().await;
        config
            .projects
            .iter()
            .filter(|(_, project)| {
                project.repo.as_deref().and_then(repository_slug).as_deref()
                    == Some(repository.as_str())
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    };
    if project_ids.is_empty() {
        return None;
    }
    let candidates = state
        .list_bots()
        .await
        .into_iter()
        .filter(|bot| project_ids.contains(&bot.project_id))
        .collect::<Vec<_>>();
    let bot = select_bot_for_text(&candidates, &mention.body, false)?.clone();
    if !state
        .claim_inbound_event(&format!("github:{}", mention.comment_id))
        .await
    {
        return None;
    }

    let kind = if mention.is_pull_request {
        "pull request"
    } else {
        "issue"
    };
    let message = format!(
        "GitHub {kind} {}#{} — \"{}\"\n@{} wrote:\n\n{}\n\n{}",
        mention.repository,
        mention.issue_number,
        mention.issue_title,
        mention.author,
        mention.body,
        mention.url
    );
    let target = BotReplyTarget::Github {
        repository: mention.repository.clone(),
        issue_number: mention.issue_number,
    };
    let origin = format!(
        "a GitHub comment by @{} on {} {}#{}",
        mention.author, kind, mention.repository, mention.issue_number
    );
    match state
        .send_bot_trigger(&bot.id, message, "github_mention", origin, target.clone())
        .await
    {
        Ok(_) => {}
        Err(BotSendError::Busy) => {
            if let Err(error) = deliver_bot_reply(&target, &bot.name, BUSY_REPLY).await {
                tracing::warn!(error = %error, "failed to post busy reply to GitHub");
            }
        }
        Err(BotSendError::Other(error)) => {
            tracing::warn!(bot = bot.name, error = %error, "failed to deliver GitHub mention");
            return None;
        }
    }
    Some(bot.name)
}

/// Verify Slack's `v0` request signature.
pub(crate) fn verify_slack_signature(
    body: &[u8],
    timestamp: Option<&str>,
    signature: Option<&str>,
    secret: &str,
    now_unix: i64,
) -> bool {
    let (Some(timestamp), Some(signature)) = (timestamp.map(str::trim), signature.map(str::trim))
    else {
        return false;
    };
    let Ok(sent_at) = timestamp.parse::<i64>() else {
        return false;
    };
    if (now_unix - sent_at).abs() > SLACK_SIGNATURE_MAX_SKEW_SECONDS {
        return false;
    }
    let Some(provided) = signature.strip_prefix("v0=") else {
        return false;
    };
    let Ok(provided) = hex::decode(provided) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(format!("v0:{timestamp}:").as_bytes());
    mac.update(body);
    mac.verify_slice(&provided).is_ok()
}

/// Remove Slack's `<@U123>` user tokens so only the request text remains.
pub(crate) fn strip_slack_user_mentions(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<@") {
        output.push_str(&rest[..start]);
        match rest[start..].find('>') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = &rest[start..];
                break;
            }
        }
    }
    output.push_str(rest);
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A Slack event reduced to what a bot needs.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SlackRequest {
    pub event_id: String,
    pub channel: String,
    pub thread_ts: Option<String>,
    pub user: String,
    pub text: String,
}

/// Accepts app mentions and direct messages written by a person.
pub(crate) fn parse_slack_event(payload: &Value) -> Option<SlackRequest> {
    if payload.get("type").and_then(Value::as_str) != Some("event_callback") {
        return None;
    }
    let event = payload.get("event")?;
    let event_type = event.get("type").and_then(Value::as_str)?;
    let direct_message = event_type == "message"
        && event.get("channel_type").and_then(Value::as_str) == Some("im")
        && event.get("subtype").is_none();
    if event_type != "app_mention" && !direct_message {
        return None;
    }
    if event.get("bot_id").is_some() {
        return None;
    }
    let text = strip_slack_user_mentions(event.get("text").and_then(Value::as_str)?);
    if text.is_empty() {
        return None;
    }
    let ts = event.get("ts").and_then(Value::as_str)?;
    Some(SlackRequest {
        event_id: payload
            .get("event_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:{ts}", event_type)),
        channel: event.get("channel").and_then(Value::as_str)?.to_string(),
        // Reply in the existing thread, or start one under the triggering message. Direct
        // messages stay flat.
        thread_ts: event
            .get("thread_ts")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| (!direct_message).then(|| ts.to_string())),
        user: event.get("user").and_then(Value::as_str)?.to_string(),
        text,
    })
}

fn slack_user_allowed(user: &str) -> bool {
    match env_value(SLACK_ALLOWED_USERS_ENV) {
        Some(allowed) => allowed
            .split(',')
            .map(str::trim)
            .any(|candidate| candidate == user),
        None => true,
    }
}

/// Route a verified Slack event to a bot.
pub(crate) async fn handle_slack_request(state: Arc<AppState>, request: SlackRequest) {
    if !slack_user_allowed(&request.user) {
        tracing::info!(
            user = request.user,
            "ignoring Slack request from user outside allowlist"
        );
        return;
    }
    if !state
        .claim_inbound_event(&format!("slack:{}", request.event_id))
        .await
    {
        return;
    }
    let target = BotReplyTarget::Slack {
        channel: request.channel.clone(),
        thread_ts: request.thread_ts.clone(),
    };
    let bots = state.list_bots().await;
    let channel_bots = bots
        .iter()
        .filter(|bot| bot.slack_channels.contains(&request.channel))
        .cloned()
        .collect::<Vec<_>>();
    // A bot named in the message wins; otherwise the channel's bot, then the default bot.
    let bot = select_bot_for_text(&bots, &request.text, false)
        .or_else(|| find_prefixed_bot(&bots, &request.text))
        .or_else(|| default_bot(&channel_bots).or_else(|| channel_bots.first()))
        .or_else(|| default_bot(&bots))
        .cloned();
    let Some(bot) = bot else {
        let hint = if bots.is_empty() {
            "No Conductor bots exist yet. Create one in the dashboard first."
        } else {
            "I couldn't tell which bot you meant. Start with the bot's name (for example `triage: ...`) or mark one bot as the default."
        };
        if let Err(error) = deliver_bot_reply(&target, "Conductor", hint).await {
            tracing::warn!(error = %error, "failed to post Slack hint");
        }
        return;
    };

    let message = format!(
        "Slack message from <@{}>:\n\n{}",
        request.user, request.text
    );
    let origin = format!("a Slack message in channel {}", request.channel);
    match state
        .send_bot_trigger(&bot.id, message, "slack_mention", origin, target.clone())
        .await
    {
        Ok(_) => {}
        Err(BotSendError::Busy) => {
            if let Err(error) = deliver_bot_reply(&target, &bot.name, BUSY_REPLY).await {
                tracing::warn!(error = %error, "failed to post busy reply to Slack");
            }
        }
        Err(BotSendError::Other(error)) => {
            tracing::warn!(bot = bot.name, error = %error, "failed to deliver Slack request");
            let _ = deliver_bot_reply(
                &target,
                &bot.name,
                &format!("I couldn't start on that: {}", anyhow!(error)),
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(body: &str, timestamp: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(format!("v0:{timestamp}:{body}").as_bytes());
        format!("v0={}", hex::encode(mac.finalize().into_bytes()))
    }

    #[test]
    fn slack_signature_accepts_valid_and_rejects_tampered_or_stale() {
        let body = r#"{"type":"event_callback"}"#;
        let signature = sign(body, "1700000000", "shh");
        assert!(verify_slack_signature(
            body.as_bytes(),
            Some("1700000000"),
            Some(&signature),
            "shh",
            1_700_000_010
        ));
        assert!(!verify_slack_signature(
            b"{}",
            Some("1700000000"),
            Some(&signature),
            "shh",
            1_700_000_010
        ));
        assert!(!verify_slack_signature(
            body.as_bytes(),
            Some("1700000000"),
            Some(&signature),
            "other",
            1_700_000_010
        ));
        assert!(!verify_slack_signature(
            body.as_bytes(),
            Some("1700000000"),
            Some(&signature),
            "shh",
            1_700_000_000 + 301
        ));
        assert!(!verify_slack_signature(
            body.as_bytes(),
            None,
            Some(&signature),
            "shh",
            0
        ));
    }

    #[test]
    fn slack_events_are_parsed_and_bot_messages_ignored() {
        let mention = json!({
            "type": "event_callback",
            "event_id": "Ev1",
            "event": {
                "type": "app_mention",
                "user": "U1",
                "text": "<@UBOT>   triage: what broke?",
                "ts": "111.222",
                "channel": "C1"
            }
        });
        assert_eq!(
            parse_slack_event(&mention),
            Some(SlackRequest {
                event_id: "Ev1".into(),
                channel: "C1".into(),
                thread_ts: Some("111.222".into()),
                user: "U1".into(),
                text: "triage: what broke?".into(),
            })
        );

        let direct = json!({
            "type": "event_callback",
            "event_id": "Ev2",
            "event": { "type": "message", "channel_type": "im", "user": "U1", "text": "hi", "ts": "1.2", "channel": "D1" }
        });
        assert_eq!(parse_slack_event(&direct).unwrap().thread_ts, None);

        let from_bot = json!({
            "type": "event_callback",
            "event": { "type": "message", "channel_type": "im", "bot_id": "B1", "user": "U1", "text": "hi", "ts": "1.2", "channel": "D1" }
        });
        assert!(parse_slack_event(&from_bot).is_none());

        let channel_chatter = json!({
            "type": "event_callback",
            "event": { "type": "message", "channel_type": "channel", "user": "U1", "text": "hi", "ts": "1.2", "channel": "C1" }
        });
        assert!(parse_slack_event(&channel_chatter).is_none());
    }

    #[test]
    fn github_mentions_require_write_association_and_skip_bot_replies() {
        let payload = |association: &str, body: &str, user_type: &str| {
            json!({
                "action": "created",
                "repository": { "full_name": "Acme/App" },
                "issue": { "number": 7, "title": "Crash on save", "pull_request": {} },
                "comment": {
                    "id": 99,
                    "body": body,
                    "author_association": association,
                    "html_url": "https://github.com/Acme/App/pull/7#issuecomment-99",
                    "user": { "login": "dev", "type": user_type }
                }
            })
        };
        let parsed =
            parse_github_mention(&payload("OWNER", "@conductor fix this", "User")).unwrap();
        assert_eq!(parsed.repository, "Acme/App");
        assert_eq!(parsed.issue_number, 7);
        assert!(parsed.is_pull_request);
        assert_eq!(parsed.comment_id, "99");

        assert!(parse_github_mention(&payload("NONE", "@conductor fix this", "User")).is_none());
        assert!(parse_github_mention(&payload("CONTRIBUTOR", "@conductor hi", "User")).is_none());
        assert!(parse_github_mention(&payload("OWNER", "@conductor hi", "Bot")).is_none());
        assert!(parse_github_mention(&payload(
            "OWNER",
            &format!("@conductor done\n{GITHUB_REPLY_MARKER}"),
            "User"
        ))
        .is_none());

        let mut edited = payload("OWNER", "@conductor fix this", "User");
        edited["action"] = json!("edited");
        assert!(parse_github_mention(&edited).is_none());
    }

    #[test]
    fn repository_slug_handles_common_remote_forms() {
        assert_eq!(repository_slug("Acme/App").as_deref(), Some("acme/app"));
        assert_eq!(
            repository_slug("https://github.com/Acme/App.git").as_deref(),
            Some("acme/app")
        );
        assert_eq!(
            repository_slug("git@github.com:Acme/App.git").as_deref(),
            Some("acme/app")
        );
        assert_eq!(repository_slug("https://github.com/Acme"), None);
        assert_eq!(repository_slug("--repo/evil"), None);
    }

    #[test]
    fn slack_mentions_are_stripped() {
        assert_eq!(
            strip_slack_user_mentions("<@U1> hello <@U2|bob> there"),
            "hello there"
        );
        assert_eq!(strip_slack_user_mentions("no mentions"), "no mentions");
    }
}
