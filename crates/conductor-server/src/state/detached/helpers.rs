use conductor_core::types::AgentKind;
use std::collections::HashMap;

pub(super) fn prepare_detached_runtime_env(
    _kind: AgentKind,
    interactive: bool,
    env: &mut HashMap<String, String>,
    env_remove: &mut Vec<String>,
) {
    // Native ttyd sessions should advertise a full-color PTY while leaving the
    // agent's own palette decisions untouched.
    env.entry("TERM".to_string())
        .or_insert_with(|| "xterm-256color".to_string());
    env.entry("COLORTERM".to_string())
        .or_insert_with(|| "truecolor".to_string());

    if interactive {
        for key in ["NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE"] {
            env.remove(key);
            if !env_remove.iter().any(|entry| entry == key) {
                env_remove.push(key.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::prepare_detached_runtime_env;
    use conductor_core::types::AgentKind;
    use std::collections::HashMap;

    #[test]
    fn prepare_detached_runtime_env_removes_conflicting_interactive_color_overrides() {
        let mut env = HashMap::from([
            ("NO_COLOR".to_string(), "1".to_string()),
            ("FORCE_COLOR".to_string(), "1".to_string()),
            ("CLICOLOR_FORCE".to_string(), "1".to_string()),
        ]);
        let mut env_remove = Vec::new();
        prepare_detached_runtime_env(AgentKind::Codex, true, &mut env, &mut env_remove);
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert!(!env.contains_key("NO_COLOR"));
        assert!(!env.contains_key("FORCE_COLOR"));
        assert!(!env.contains_key("CLICOLOR_FORCE"));
        assert_eq!(
            env_remove,
            vec![
                "NO_COLOR".to_string(),
                "FORCE_COLOR".to_string(),
                "CLICOLOR_FORCE".to_string(),
            ]
        );
    }

    #[test]
    fn prepare_detached_runtime_env_preserves_noninteractive_color_overrides() {
        let mut env = HashMap::from([
            ("NO_COLOR".to_string(), "1".to_string()),
            ("FORCE_COLOR".to_string(), "1".to_string()),
            ("CLICOLOR_FORCE".to_string(), "1".to_string()),
        ]);
        let mut env_remove = Vec::new();
        prepare_detached_runtime_env(AgentKind::Codex, false, &mut env, &mut env_remove);
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
        assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("1"));
        assert_eq!(env.get("FORCE_COLOR").map(String::as_str), Some("1"));
        assert_eq!(env.get("CLICOLOR_FORCE").map(String::as_str), Some("1"));
        assert!(env_remove.is_empty());
    }

    #[test]
    fn prepare_detached_runtime_env_sets_term_and_colorterm() {
        let mut env = HashMap::new();
        let mut env_remove = Vec::new();
        prepare_detached_runtime_env(AgentKind::ClaudeCode, true, &mut env, &mut env_remove);
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
    }

    #[test]
    fn prepare_detached_runtime_env_does_not_override_existing_term() {
        let mut env = HashMap::new();
        env.insert("TERM".to_string(), "screen-256color".to_string());
        let mut env_remove = Vec::new();
        prepare_detached_runtime_env(AgentKind::ClaudeCode, true, &mut env, &mut env_remove);
        assert_eq!(env.get("TERM").map(String::as_str), Some("screen-256color"));
    }
}
