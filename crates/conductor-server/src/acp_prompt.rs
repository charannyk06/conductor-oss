//! Shared ACP dispatcher prompt rewriting and approval detection for stdio ACP, HTTP routes,
//! and session send paths — single source of truth to avoid drift.

/// Casual confirmations (`go ahead`, `lgtm`, …) apply only when the **entire** message is short,
/// so long paragraphs cannot accidentally trigger approval via substring matches.
const ACP_CASUAL_PHRASE_MAX_CHARS: usize = 96;

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

pub fn matches_acp_plan_only_command(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    let normalized = trimmed.to_ascii_lowercase();

    if matches!(
        normalized.as_str(),
        "/plan"
            | "plan"
            | "plan only"
            | "proposal only"
            | "show the plan"
            | "show me the plan"
            | "review the plan"
            | "don't mutate the board"
            | "do not mutate the board"
            | "no board changes"
    ) || normalized.starts_with("/plan ")
    {
        return true;
    }

    if trimmed.chars().count() > ACP_CASUAL_PHRASE_MAX_CHARS {
        return false;
    }

    matches!(
        normalized.as_str(),
        "plan first" | "review first" | "proposal first"
    )
}

pub fn acp_dispatcher_turn_allows_board_mutations(prompt: &str) -> bool {
    !matches_acp_reject_command(prompt) && !matches_acp_plan_only_command(prompt)
}

pub fn rewrite_acp_dispatcher_command(prompt: &str) -> String {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return "Review the current dispatcher state, summarize the plan status, and respond according to the current ACP execution mode.".to_string();
    }
    if matches_acp_approve_command(trimmed) {
        return "If ACP is waiting on a plan-only review, the user approved the current proposal. Apply the proposed board mutations now, create or update the agreed tasks, preserve the planned task packet fields, and report the exact task refs or titles changed.".to_string();
    }
    if matches_acp_reject_command(trimmed) {
        return "Do not mutate the board. Revise the dispatcher proposal, restate the exact intended tool calls and board/task mutations, and ask for approval again.".to_string();
    }
    if matches_acp_plan_only_command(trimmed) {
        return "Plan-only turn. Inspect the repo and board, produce the finalized plan, exact board/task mutations, intended tool calls, and recommended implementation agents. Do not mutate the board in this turn.".to_string();
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
            "Prepare `{}` for implementation handoff. Make sure the task carries a full execution packet: objective, execution mode, exact files or surfaces to inspect, relevant skills, constraints, dependencies, acceptance criteria, deliverables, and the best-fit implementation agent.",
            target
        );
    }
    prompt.to_string()
}

pub fn acp_dispatcher_turn_prefix(allow_board_mutations: bool) -> &'static str {
    if allow_board_mutations {
        "ACP execution mode: inspect context first, then create or update the necessary board tasks in this same turn when the request is actionable. Use tool calls to review the repo, board, relevant files, and diffs before writing task packets. Only pause for plan-only review when the user explicitly asks for it or the requested mutation would be ambiguous or unsafe."
    } else {
        "ACP plan-only mode: inspect context first, then present the finalized plan, intended tool calls, exact board/task mutations, and recommended implementation agents. For each proposed task, include the execution packet fields you intend to write. Do not create or update board tasks in this turn."
    }
}

pub fn acp_dispatcher_preference_note(
    implementation_agent: &str,
    implementation_model: Option<&str>,
    implementation_reasoning_effort: Option<&str>,
) -> String {
    let mut notes = vec![format!(
        "ACP dispatcher preference: prefer `{implementation_agent}` for newly created implementation tasks unless the user explicitly wants another agent."
    )];
    if let Some(model) = implementation_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        notes.push(format!(
            "Default coding model: `{model}`. Persist it onto implementation tasks with `model:{model}` unless the user explicitly overrides it."
        ));
    }
    if let Some(reasoning_effort) = implementation_reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        notes.push(format!(
            "Default coding reasoning: `{reasoning_effort}`. Persist it onto implementation tasks with `reasoningEffort:{reasoning_effort}` unless the user explicitly overrides it."
        ));
    }
    notes.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_explicit_always() {
        assert!(matches_acp_approve_command("approve"));
        assert!(matches_acp_approve_command("/approve"));
        assert!(matches_acp_approve_command(
            "approve the plan for the auth refactor"
        ));
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

    #[test]
    fn plan_only_detection_requires_explicit_request() {
        assert!(matches_acp_plan_only_command("/plan"));
        assert!(matches_acp_plan_only_command("show me the plan"));
        assert!(!matches_acp_plan_only_command(
            "Create the tasks and plan the rollout for me in one turn"
        ));
    }

    #[test]
    fn dispatcher_turns_default_to_board_mutations() {
        assert!(acp_dispatcher_turn_allows_board_mutations(
            "Create clean review tasks for the current PR"
        ));
        assert!(!acp_dispatcher_turn_allows_board_mutations("/plan"));
        assert!(!acp_dispatcher_turn_allows_board_mutations("needs changes"));
    }

    #[test]
    fn preference_note_includes_model_and_reasoning_when_present() {
        let note = acp_dispatcher_preference_note("codex", Some("gpt-5.4"), Some("high"));
        assert!(note.contains("prefer `codex`"));
        assert!(note.contains("model:gpt-5.4"));
        assert!(note.contains("reasoningEffort:high"));
    }
}
