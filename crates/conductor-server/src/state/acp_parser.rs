//! Parser state detection for ACP dispatcher sessions.
//!
//! Detects when agent output indicates auth-required or interactive-terminal
//! states that need user intervention.

use super::SessionRecord;

pub(crate) const PARSER_STATE_KEY: &str = "parserState";
pub(crate) const PARSER_STATE_MESSAGE_KEY: &str = "parserStateMessage";
pub(crate) const PARSER_STATE_COMMAND_KEY: &str = "parserStateCommand";

pub(crate) fn clear_parser_state(session: &mut SessionRecord) -> bool {
    let mut dirty = false;
    dirty |= session.metadata.remove(PARSER_STATE_KEY).is_some();
    dirty |= session.metadata.remove(PARSER_STATE_MESSAGE_KEY).is_some();
    dirty |= session.metadata.remove(PARSER_STATE_COMMAND_KEY).is_some();
    dirty
}

pub(crate) fn set_parser_state(
    session: &mut SessionRecord,
    kind: &str,
    message: &str,
    command: Option<String>,
) -> bool {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return clear_parser_state(session);
    }

    let mut changed = false;
    changed |= session
        .metadata
        .insert(PARSER_STATE_KEY.to_string(), kind.to_string())
        .is_some_and(|value| value != kind);
    changed |= session
        .metadata
        .insert(PARSER_STATE_MESSAGE_KEY.to_string(), trimmed.to_string())
        .is_some_and(|value| value != trimmed);

    if let Some(value) = command.filter(|value| !value.trim().is_empty()) {
        changed |= session
            .metadata
            .insert(PARSER_STATE_COMMAND_KEY.to_string(), value.to_string())
            .is_some_and(|current| current != value);
    } else {
        changed |= session.metadata.remove(PARSER_STATE_COMMAND_KEY).is_some();
    }

    changed
}

pub(crate) fn parser_state_signature(
    session: &SessionRecord,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        session.metadata.get(PARSER_STATE_KEY).cloned(),
        session.metadata.get(PARSER_STATE_MESSAGE_KEY).cloned(),
        session.metadata.get(PARSER_STATE_COMMAND_KEY).cloned(),
    )
}

fn auth_command_hint(agent: &str, text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    for candidate in [
        "gh auth login",
        "copilot login",
        "claude login",
        "cursor-agent login",
        "gemini auth login",
        "codex login",
        "amp login",
        "opencode auth login",
        "qwen auth login",
    ] {
        if lower.contains(candidate) {
            return Some(candidate.to_string());
        }
    }

    match agent.trim().to_lowercase().as_str() {
        "github-copilot" => Some("copilot login".to_string()),
        "claude-code" | "ccr" => Some("claude login".to_string()),
        "cursor-cli" => Some("cursor-agent login".to_string()),
        "gemini" => Some("gemini auth login".to_string()),
        "codex" => Some("codex login".to_string()),
        "amp" => Some("amp login".to_string()),
        "droid" => Some("export FACTORY_API_KEY=...".to_string()),
        "opencode" => Some("opencode auth login".to_string()),
        "qwen-code" => Some("qwen auth login".to_string()),
        _ => None,
    }
}

pub(crate) fn detect_parser_state(session: &mut SessionRecord, text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lower = trimmed.to_lowercase();
    let is_auth = lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("login required")
        || lower.contains("auth login")
        || lower.contains("device code")
        || lower.contains("oauth")
        || (lower.contains("sign in") && lower.contains("browser"))
        || lower.contains("open this url to authenticate");
    if is_auth {
        set_parser_state(
            session,
            "auth_required",
            trimmed,
            auth_command_hint(&session.agent, trimmed),
        );
        return true;
    }

    let is_interactive = lower.contains("stdin is not a terminal")
        || lower.contains("stdin is not a tty")
        || lower.contains("not a terminal")
        || lower.contains("terminal interaction")
        || lower.contains("interactive mode")
        || lower.contains("select an option")
        || lower.contains("use arrow keys")
        || lower.contains("press enter to continue")
        || (lower.contains("interactive") && lower.contains("terminal"));
    if is_interactive {
        set_parser_state(session, "interactive_required", trimmed, None);
        return true;
    }

    false
}
