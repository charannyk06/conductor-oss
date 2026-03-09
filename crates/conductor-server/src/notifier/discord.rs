use anyhow::{bail, Context, Result};
use reqwest::Client;
use serde::Serialize;

use crate::notifier::{NotificationEvent, NotificationPriority};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordNotifierConfig {
    pub webhook_url: String,
}

#[derive(Debug, Clone)]
pub struct DiscordNotifier {
    client: Client,
    webhook_url: String,
}

impl DiscordNotifier {
    pub fn new(config: DiscordNotifierConfig) -> Result<Self> {
        let webhook_url = config.webhook_url.trim().to_string();
        if webhook_url.is_empty() {
            bail!("Discord webhook URL cannot be empty");
        }

        Ok(Self {
            client: Client::new(),
            webhook_url,
        })
    }

    pub async fn notify(&self, event: &NotificationEvent) -> Result<()> {
        let payload = DiscordWebhookMessage {
            content: None,
            embeds: vec![format_embed(event)],
        };

        let response = self
            .client
            .post(&self.webhook_url)
            .json(&payload)
            .send()
            .await
            .context("Failed to deliver Discord webhook request")?;

        if response.status().is_success() {
            return Ok(());
        }

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        bail!("Discord webhook returned {status}: {body}");
    }
}

#[derive(Debug, Serialize)]
struct DiscordWebhookMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    embeds: Vec<DiscordEmbed>,
}

#[derive(Debug, Serialize)]
struct DiscordEmbed {
    title: String,
    description: String,
    color: u32,
    fields: Vec<DiscordField>,
    timestamp: String,
    footer: DiscordFooter,
}

#[derive(Debug, Serialize)]
struct DiscordField {
    name: String,
    value: String,
    inline: bool,
}

#[derive(Debug, Serialize)]
struct DiscordFooter {
    text: String,
}

fn format_embed(event: &NotificationEvent) -> DiscordEmbed {
    let mut fields = vec![
        DiscordField {
            name: "Session".to_string(),
            value: format!("`{}`", event.session_id),
            inline: true,
        },
        DiscordField {
            name: "Project".to_string(),
            value: format!("`{}`", event.project_id),
            inline: true,
        },
        DiscordField {
            name: "Event".to_string(),
            value: format!("`{}`", event.event_type),
            inline: true,
        },
    ];

    if let Some(url) = event.data.get("url").and_then(|value| value.as_str()) {
        fields.push(DiscordField {
            name: "URL".to_string(),
            value: url.to_string(),
            inline: false,
        });
    }

    if let Some(branch) = event.data.get("branch").and_then(|value| value.as_str()) {
        fields.push(DiscordField {
            name: "Branch".to_string(),
            value: format!("`{branch}`"),
            inline: true,
        });
    }

    DiscordEmbed {
        title: format!(
            "{} {}",
            event_emoji(&event.event_type),
            humanize_event_type(&event.event_type)
        ),
        description: event.message.clone(),
        color: priority_color(event.priority),
        fields,
        timestamp: event.timestamp.to_rfc3339(),
        footer: DiscordFooter {
            text: format!("Conductor | {}", event.priority.as_str()),
        },
    }
}

fn humanize_event_type(value: &str) -> String {
    value
        .split('.')
        .filter(|segment| !segment.is_empty())
        .map(title_case)
        .collect::<Vec<_>>()
        .join(" ")
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => {
            let mut text = first.to_uppercase().collect::<String>();
            text.push_str(chars.as_str());
            text
        }
        None => String::new(),
    }
}

fn event_emoji(event_type: &str) -> &'static str {
    if event_type.starts_with("session.spawned") {
        "🚀"
    } else if event_type.starts_with("session.working") {
        "⚙️"
    } else if event_type.starts_with("session.exited") {
        "🏁"
    } else if event_type.starts_with("session.killed") {
        "💀"
    } else if event_type.starts_with("session.stuck") {
        "🪫"
    } else if event_type.starts_with("session.needs_input") {
        "⏳"
    } else if event_type.starts_with("session.errored") {
        "💥"
    } else if event_type.starts_with("pr.created") {
        "📬"
    } else if event_type.starts_with("pr.merged") {
        "🎉"
    } else if event_type.starts_with("pr.closed") {
        "🚫"
    } else if event_type.starts_with("ci.passing") {
        "✅"
    } else if event_type.starts_with("ci.failing") {
        "❌"
    } else if event_type.starts_with("ci.fix_sent") {
        "🔧"
    } else if event_type.starts_with("review.approved") {
        "👍"
    } else if event_type.starts_with("review.changes_requested") {
        "📝"
    } else if event_type.starts_with("review.pending") {
        "👀"
    } else if event_type.starts_with("merge.ready") {
        "🟢"
    } else if event_type.starts_with("merge.completed") {
        "🏆"
    } else if event_type.starts_with("merge.conflicts") {
        "⚠️"
    } else if event_type.starts_with("reaction.") {
        "⚡"
    } else if event_type.starts_with("summary.") {
        "📊"
    } else {
        "📢"
    }
}

fn priority_color(priority: NotificationPriority) -> u32 {
    match priority {
        NotificationPriority::Urgent => 0xff0000,
        NotificationPriority::Action => 0xff8c00,
        NotificationPriority::Warning => 0xffd700,
        NotificationPriority::Info => 0x5865f2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifier::{NotificationEvent, NotificationPriority};
    use serde_json::json;

    #[test]
    fn notifier_requires_non_empty_webhook_url() {
        assert!(DiscordNotifier::new(DiscordNotifierConfig {
            webhook_url: "   ".to_string()
        })
        .is_err());
    }

    #[test]
    fn emoji_mapping_matches_typescript_categories() {
        assert_eq!(event_emoji("ci.passing"), "✅");
        assert_eq!(event_emoji("merge.conflicts"), "⚠️");
        assert_eq!(event_emoji("unknown.event"), "📢");
    }

    #[test]
    fn embed_includes_standard_fields_and_optional_metadata() {
        let mut event = NotificationEvent::new(
            "session-1",
            "demo",
            "pr.created",
            NotificationPriority::Action,
            "PR opened",
        );
        event.data.insert(
            "url".to_string(),
            json!("https://github.com/acme/widgets/pull/42"),
        );
        event
            .data
            .insert("branch".to_string(), json!("session/demo"));

        let embed = format_embed(&event);

        assert_eq!(embed.title, "📬 Pr Created");
        assert_eq!(embed.color, 0xff8c00);
        assert_eq!(embed.fields.len(), 5);
        assert_eq!(embed.footer.text, "Conductor | action");
    }
}
