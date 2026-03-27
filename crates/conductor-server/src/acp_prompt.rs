//! Shared ACP dispatcher prompt rewriting and approval detection for stdio ACP, HTTP routes,
//! and session send paths — single source of truth to avoid drift.

/// Casual confirmations (`go ahead`, `lgtm`, …) apply only when the **entire** message is short,
/// so long paragraphs cannot accidentally trigger approval via substring matches.
const ACP_CASUAL_PHRASE_MAX_CHARS: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpApprovalDecision {
    None,
    Approve,
    Reject,
}

pub fn acp_approval_decision(prompt: &str) -> AcpApprovalDecision {
    if matches_acp_approve_command(prompt) {
        return AcpApprovalDecision::Approve;
    }
    if matches_acp_reject_command(prompt) {
        return AcpApprovalDecision::Reject;
    }
    AcpApprovalDecision::None
}

pub fn matches_acp_approve_command(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    let normalized = trimmed.to_ascii_lowercase();

    if matches!(
        normalized.as_str(),
        "/approve" | "approve" | "approve plan" | "approved"
    ) || normalized.starts_with("/approve ")
        || normalized.starts_with("approve ")
    {
        return true;
    }

    if trimmed.chars().count() > ACP_CASUAL_PHRASE_MAX_CHARS {
        return false;
    }

    matches!(
        normalized.as_str(),
        "go ahead"
            | "go ahead."
            | "looks good"
            | "looks good."
            | "yes"
            | "yes."
            | "yep"
            | "yeah"
            | "ok"
            | "ok."
            | "okay"
            | "lgtm"
            | "lgtm."
            | "sgtm"
    )
}

pub fn matches_acp_reject_command(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    let normalized = trimmed.to_ascii_lowercase();

    if matches!(
        normalized.as_str(),
        "/reject" | "reject" | "revise" | "revise plan"
    ) || normalized.starts_with("/reject ")
        || normalized.starts_with("reject ")
        || normalized.starts_with("revise ")
    {
        return true;
    }

    if trimmed.chars().count() > ACP_CASUAL_PHRASE_MAX_CHARS {
        return false;
    }

    matches!(
        normalized.as_str(),
        "needs changes"
            | "needs changes."
            | "no"
            | "no."
            | "not yet"
            | "not yet."
            | "hold off"
            | "wait"
    )
}

pub fn rewrite_acp_dispatcher_command(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return "Review the current dispatcher state, summarize the plan status, and respond according to the ACP approval gate.".to_string();
    }
    if matches_acp_approve_command(trimmed) {
        return "The user approved the current ACP proposal. Execute only the previously proposed board mutations, create or update the agreed tasks, and report the exact task refs or titles changed.".to_string();
    }
    if matches_acp_reject_command(trimmed) {
        return "Do not mutate the board. Revise the dispatcher proposal, restate the exact intended tool calls and board/task mutations, and ask for approval again.".to_string();
    }
    if trimmed.eq_ignore_ascii_case("/board") || trimmed.eq_ignore_ascii_case("board") {
        return "Review the attached board and summarize active work, blockers, stale tasks, and the highest-priority next actions.".to_string();
    }
    if trimmed.eq_ignore_ascii_case("/memory") || trimmed.eq_ignore_ascii_case("memory") {
        return "Review ACP project memory and session memory. Summarize durable directives, current context, recent decisions, and pending heartbeat follow-ups.".to_string();
    }
    if trimmed.eq_ignore_ascii_case("/heartbeat") || trimmed.eq_ignore_ascii_case("heartbeat") {
        return "Run an ACP heartbeat review. Inspect the board, session memory, and deferred follow-ups. Propose any explicit follow-up tasks that should be created or updated so they do not get buried in chat.".to_string();
    }
    if let Some(target) = trimmed
        .strip_prefix("/handoff")
        .or_else(|| trimmed.strip_prefix("handoff"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!(
            "Prepare `{}` for implementation handoff. Make sure the task carries a proper implementation packet: objective, exact files or surfaces to inspect, relevant skills or constraints, acceptance shape, and the best-fit implementation agent.",
            target
        );
    }
    prompt.to_string()
}

pub fn acp_dispatcher_turn_prefix(approved_turn: bool) -> &'static str {
    if approved_turn {
        "ACP approval gate: the user has explicitly approved execution for this turn. You may now create or update only the board tasks and mutations that match the approved proposal. Do not expand scope beyond the approved plan."
    } else {
        "ACP approval gate: planning only. Do not create or update board tasks in this turn. First inspect context, then present the finalized plan, intended tool calls, exact board/task mutations, and recommended implementation agents. Stop and ask for explicit approval."
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_explicit_always() {
        assert!(matches_acp_approve_command("approve"));
        assert!(matches_acp_approve_command("/approve"));
        assert!(matches_acp_approve_command("approve the plan for the auth refactor"));
    }

    #[test]
    fn approve_casual_short_only() {
        assert!(matches_acp_approve_command("lgtm"));
        assert!(matches_acp_approve_command("go ahead"));
        assert!(!matches_acp_approve_command(
            "This looks good but we should also update the README and the migration guide before merging"
        ));
    }

    #[test]
    fn reject_substring_not_in_long_text() {
        assert!(matches_acp_reject_command("needs changes"));
        assert!(!matches_acp_reject_command(
            "The section on retries needs changes to match the new API, and we should add tests"
        ));
    }
}
