use conductor_executors::agents::{
    AmpExecutor, CcrExecutor, ClaudeCodeExecutor, CodexExecutor, CopilotExecutor, CursorExecutor,
    DroidExecutor, GeminiExecutor, HermesExecutor, LettaExecutor, OpenCodeExecutor, PiExecutor,
    QwenCodeExecutor,
};
use conductor_executors::executor::{Executor, ExecutorOutput, SpawnOptions};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

fn options(prompt: &str) -> SpawnOptions {
    SpawnOptions {
        cwd: PathBuf::from("/tmp/demo"),
        prompt: prompt.to_string(),
        model: Some("gpt-5".to_string()),
        reasoning_effort: Some("high".to_string()),
        skip_permissions: false,
        extra_args: vec![
            "--safe-extra".to_string(),
            "--YOLO".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ],
        env: HashMap::new(),
        branch: None,
        timeout: None,
        interactive: false,
        structured_output: false,
        resume_target: None,
    }
}

fn assert_contains(args: &[String], expected: &[&str]) {
    for item in expected {
        assert!(
            args.iter().any(|arg| arg == item),
            "missing `{item}` in {args:?}"
        );
    }
}

fn assert_filters_blocked_flags(args: &[String]) {
    assert!(args.iter().any(|arg| arg == "--safe-extra"));
    assert!(!args.iter().any(|arg| arg.eq_ignore_ascii_case("--yolo")));
    assert!(!args
        .iter()
        .any(|arg| { arg.eq_ignore_ascii_case("--dangerously-skip-permissions") }));
}

fn assert_has_pair(args: &[String], flag: &str, value: &str) {
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value),
        "missing `{flag} {value}` in {args:?}"
    );
}

fn assert_no_flag(args: &[String], flag: &str) {
    assert!(
        !args.iter().any(|arg| arg == flag),
        "unexpected `{flag}` in {args:?}"
    );
}

#[test]
fn headless_build_args_include_expected_flags_and_safe_extra_args() {
    let mut amp_options = options("amp prompt");
    amp_options.model = Some("rush".to_string());
    let amp = AmpExecutor::new(PathBuf::from("/usr/bin/amp")).build_args(&amp_options);
    assert_contains(
        &amp,
        &[
            "-x",
            "--stream-json",
            "--stream-json-thinking",
            "--mode",
            "rush",
            "amp prompt",
        ],
    );
    assert_filters_blocked_flags(&amp);

    let hermes =
        HermesExecutor::new(PathBuf::from("/usr/bin/hermes")).build_args(&options("hermes"));
    assert_contains(
        &hermes,
        &[
            "chat",
            "--toolsets",
            "terminal",
            "-Q",
            "-q",
            "--model",
            "gpt-5",
            "hermes",
        ],
    );
    assert_filters_blocked_flags(&hermes);

    let mut ccr_options = options("ccr prompt");
    ccr_options.model = Some("sonnet".to_string());
    ccr_options.reasoning_effort = Some("xhigh".to_string());
    let ccr = CcrExecutor::new(PathBuf::from("/usr/bin/ccr")).build_args(&ccr_options);
    assert_contains(
        &ccr,
        &[
            "code",
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "claude-sonnet-4-6",
            "--effort",
            "max",
            "ccr prompt",
        ],
    );
    assert_filters_blocked_flags(&ccr);

    let mut claude_options = options("claude");
    claude_options.model = Some("sonnet".to_string());
    claude_options.reasoning_effort = Some("xhigh".to_string());
    let claude =
        ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude")).build_args(&claude_options);
    assert_contains(
        &claude,
        &[
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "claude-sonnet-4-6",
            "--effort",
            "max",
            "claude",
        ],
    );
    assert_filters_blocked_flags(&claude);

    let codex = CodexExecutor::new(PathBuf::from("/usr/bin/codex")).build_args(&options("codex"));
    assert_contains(
        &codex,
        &[
            "exec",
            "--color",
            "never",
            "--json",
            "--model",
            "gpt-5",
            "-c",
            "model_reasoning_effort=\"high\"",
            "codex",
        ],
    );
    assert_filters_blocked_flags(&codex);

    let copilot =
        CopilotExecutor::new(PathBuf::from("/usr/bin/copilot")).build_args(&options("copilot"));
    assert_contains(
        &copilot,
        &[
            "-p",
            "copilot",
            "--output-format",
            "json",
            "--stream",
            "on",
            "--allow-all-tools",
            "--model",
            "gpt-5.2",
            "--reasoning-effort",
            "high",
        ],
    );
    assert_filters_blocked_flags(&copilot);

    let cursor =
        CursorExecutor::new(PathBuf::from("/usr/bin/cursor")).build_args(&options("cursor"));
    assert_contains(
        &cursor,
        &[
            "agent",
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "gpt-5",
            "cursor",
        ],
    );
    assert_filters_blocked_flags(&cursor);

    let droid = DroidExecutor::new(PathBuf::from("/usr/bin/droid")).build_args(&options("droid"));
    assert_contains(
        &droid,
        &[
            "exec",
            "--output-format",
            "json",
            "--model",
            "gpt-5.4-fast",
            "--reasoning-effort",
            "high",
            "droid",
        ],
    );
    assert_filters_blocked_flags(&droid);

    let mut gemini_options = options("gemini");
    gemini_options.model = Some("gemini-3.1-pro-preview".to_string());
    let gemini = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini")).build_args(&gemini_options);
    assert_contains(
        &gemini,
        &[
            "--model",
            "gemini-3.1-pro-preview",
            "--output-format",
            "stream-json",
            "--prompt",
            "gemini",
        ],
    );
    assert_filters_blocked_flags(&gemini);

    let mut opencode_options = options("opencode");
    opencode_options.reasoning_effort = Some("xhigh".to_string());
    let opencode =
        OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode")).build_args(&opencode_options);
    assert_contains(
        &opencode,
        &[
            "run",
            "--format",
            "json",
            "--thinking",
            "--variant",
            "max",
            "opencode",
        ],
    );
    assert_filters_blocked_flags(&opencode);

    let letta = LettaExecutor::new(PathBuf::from("/usr/bin/letta")).build_args(&options("letta"));
    assert_contains(&letta, &["--model", "gpt-5", "-p", "letta", "--safe-extra"]);
    assert_filters_blocked_flags(&letta);

    let mut pi_options = options("pi prompt");
    pi_options.model = Some("openai/gpt-5.4".to_string());
    pi_options.structured_output = true;
    let pi = PiExecutor::new(PathBuf::from("/usr/bin/pi")).build_args(&pi_options);
    assert_contains(
        &pi,
        &[
            "--mode",
            "json",
            "--model",
            "openai/gpt-5.4",
            "--thinking",
            "high",
            "pi prompt",
        ],
    );
    assert_filters_blocked_flags(&pi);

    let mut qwen_options = options("qwen");
    qwen_options.model = Some("qwen-max".to_string());
    let qwen = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen")).build_args(&qwen_options);
    assert_contains(
        &qwen,
        &[
            "--model",
            "qwen-max",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--prompt",
            "qwen",
        ],
    );
    assert_filters_blocked_flags(&qwen);
}

#[test]
fn interactive_launch_matrix_tracks_model_and_reasoning_parameters() {
    let mut interactive = options("launch prompt");
    interactive.interactive = true;

    let mut amp_options = interactive.clone();
    amp_options.model = Some("rush".to_string());
    let amp = AmpExecutor::new(PathBuf::from("/usr/bin/amp")).build_args(&amp_options);
    assert_has_pair(&amp, "--mode", "rush");
    assert_no_flag(&amp, "--effort");
    assert_no_flag(&amp, "--reasoning-effort");
    assert_no_flag(&amp, "--variant");

    let mut ccr_interactive = interactive.clone();
    ccr_interactive.model = Some("sonnet".to_string());
    ccr_interactive.reasoning_effort = Some("xhigh".to_string());
    let ccr = CcrExecutor::new(PathBuf::from("/usr/bin/ccr")).build_args(&ccr_interactive);
    assert_has_pair(&ccr, "--model", "claude-sonnet-4-6");
    assert_has_pair(&ccr, "--effort", "max");

    let hermes = HermesExecutor::new(PathBuf::from("/usr/bin/hermes")).build_args(&interactive);
    assert_contains(&hermes, &["--toolsets", "terminal"]);
    assert_has_pair(&hermes, "--model", "gpt-5");
    assert_no_flag(&hermes, "--effort");
    assert_no_flag(&hermes, "--reasoning-effort");
    assert_no_flag(&hermes, "-q");

    let mut claude_interactive = interactive.clone();
    claude_interactive.model = Some("sonnet".to_string());
    claude_interactive.reasoning_effort = Some("xhigh".to_string());
    let claude =
        ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude")).build_args(&claude_interactive);
    assert_has_pair(&claude, "--model", "claude-sonnet-4-6");
    assert_has_pair(&claude, "--effort", "max");

    let codex = CodexExecutor::new(PathBuf::from("/usr/bin/codex")).build_args(&interactive);
    assert_has_pair(&codex, "--model", "gpt-5");
    assert!(codex
        .iter()
        .any(|arg| arg == "model_reasoning_effort=\"high\""));

    let copilot = CopilotExecutor::new(PathBuf::from("/usr/bin/copilot")).build_args(&interactive);
    assert_has_pair(&copilot, "--model", "gpt-5.2");
    assert_no_flag(&copilot, "--effort");
    assert_has_pair(&copilot, "--reasoning-effort", "high");

    let cursor =
        CursorExecutor::new(PathBuf::from("/usr/bin/cursor-agent")).build_args(&interactive);
    assert_has_pair(&cursor, "--model", "gpt-5");
    assert_no_flag(&cursor, "--effort");
    assert_no_flag(&cursor, "--reasoning-effort");
    assert_no_flag(&cursor, "--variant");

    let droid = DroidExecutor::new(PathBuf::from("/usr/bin/droid")).build_args(&interactive);
    assert_has_pair(&droid, "--model", "gpt-5.4-fast");
    assert_has_pair(&droid, "--reasoning-effort", "high");

    let mut gemini_interactive = interactive.clone();
    gemini_interactive.model = Some("gemini-3.1-pro-preview".to_string());
    let gemini =
        GeminiExecutor::new(PathBuf::from("/usr/bin/gemini")).build_args(&gemini_interactive);
    assert_has_pair(&gemini, "--model", "gemini-3.1-pro-preview");
    assert_no_flag(&gemini, "--effort");
    assert_no_flag(&gemini, "--reasoning-effort");

    let mut opencode_options = interactive.clone();
    opencode_options.model = Some("openai/gpt-5".to_string());
    opencode_options.reasoning_effort = Some("xhigh".to_string());
    let opencode =
        OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode")).build_args(&opencode_options);
    assert_has_pair(&opencode, "--model", "openai/gpt-5");
    assert_has_pair(&opencode, "--variant", "max");

    let mut qwen_options = interactive.clone();
    qwen_options.model = Some("qwen-max".to_string());
    let qwen = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen")).build_args(&qwen_options);
    assert_has_pair(&qwen, "--model", "qwen-max");
    assert_no_flag(&qwen, "--effort");
    assert_no_flag(&qwen, "--reasoning-effort");

    let letta = LettaExecutor::new(PathBuf::from("/usr/bin/letta")).build_args(&interactive);
    assert_has_pair(&letta, "--model", "gpt-5");
    assert_no_flag(&letta, "-p");

    let mut pi_options = interactive.clone();
    pi_options.model = Some("openai/gpt-5.4".to_string());
    pi_options.reasoning_effort = Some("xhigh".to_string());
    let pi = PiExecutor::new(PathBuf::from("/usr/bin/pi")).build_args(&pi_options);
    assert_has_pair(&pi, "--model", "openai/gpt-5.4");
    assert_has_pair(&pi, "--thinking", "xhigh");
    assert_no_flag(&pi, "-p");
}

#[test]
fn cursor_wrapper_binary_uses_agent_subcommand() {
    let args = CursorExecutor::new(PathBuf::from("/usr/bin/cursor")).build_args(&options("cursor"));
    assert_eq!(args.first().map(String::as_str), Some("agent"));
    assert_has_pair(&args, "--model", "gpt-5");
}

#[test]
fn parse_output_handles_representative_agent_formats() {
    let amp = AmpExecutor::new(PathBuf::from("/usr/bin/amp")).parse_output(
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Amp ready"}]}}"#,
    );
    let ExecutorOutput::Composite(amp_events) = amp else {
        panic!("expected amp composite output");
    };
    assert!(matches!(
        amp_events.first(),
        Some(ExecutorOutput::Stdout(text)) if text == "Amp ready"
    ));

    let ccr = CcrExecutor::new(PathBuf::from("/usr/bin/ccr"))
        .parse_output("API Error: 500 upstream failed");
    assert!(matches!(
        ccr,
        ExecutorOutput::Failed { ref error, exit_code: Some(1) } if error == "API Error: 500 upstream failed"
    ));

    let hermes = HermesExecutor::new(PathBuf::from("/usr/bin/hermes"))
        .parse_output("session_id: hermes-session");
    let ExecutorOutput::StructuredStatus { metadata, .. } = hermes else {
        panic!("expected hermes structured status");
    };
    assert_eq!(
        metadata.get("nativeResumeTarget").and_then(Value::as_str),
        Some("hermes-session")
    );

    let claude = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude")).parse_output(
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Claude says hi"}]}}"#,
    );
    let ExecutorOutput::Composite(claude_events) = claude else {
        panic!("expected claude composite output");
    };
    assert!(matches!(
        claude_events.first(),
        Some(ExecutorOutput::Stdout(text)) if text == "Claude says hi"
    ));

    let codex = CodexExecutor::new(PathBuf::from("/usr/bin/codex"))
        .parse_output(r#"{"type":"agent_message","message":{"content":["Codex delta"]}}"#);
    assert!(matches!(codex, ExecutorOutput::Stdout(ref text) if text == "Codex delta"));

    let copilot = CopilotExecutor::new(PathBuf::from("/usr/bin/copilot"))
        .parse_output(r#"{"type":"result","exitCode":2}"#);
    assert!(matches!(
        copilot,
        ExecutorOutput::Failed { ref error, exit_code: Some(2) } if error == "GitHub Copilot failed"
    ));

    let cursor = CursorExecutor::new(PathBuf::from("/usr/bin/cursor"))
        .parse_output("Press any key to sign in");
    let ExecutorOutput::NeedsInput(prompt) = cursor else {
        panic!("expected cursor auth prompt");
    };
    assert!(prompt.contains("cursor-agent login"));

    let droid = DroidExecutor::new(PathBuf::from("/usr/bin/droid")).parse_output(
        r#"{"type":"tool.execution_complete","name":"bash","result":{"exitCode":0}}"#,
    );
    let ExecutorOutput::StructuredStatus { text, metadata } = droid else {
        panic!("expected droid tool status");
    };
    assert_eq!(text, "Bash");
    assert_eq!(
        metadata.get("toolStatus").and_then(Value::as_str),
        Some("completed")
    );

    let gemini = GeminiExecutor::new(PathBuf::from("/usr/bin/gemini"))
        .parse_output(r#"{"type":"result","status":"error","error":"quota exceeded"}"#);
    assert!(matches!(
        gemini,
        ExecutorOutput::Failed { ref error, exit_code: Some(1) } if error == "quota exceeded"
    ));

    let opencode = OpenCodeExecutor::new(PathBuf::from("/usr/bin/opencode"))
        .parse_output(r#"{"type":"error","message":"tool crashed"}"#);
    assert!(matches!(
        opencode,
        ExecutorOutput::Failed { ref error, exit_code: Some(1) } if error == "tool crashed"
    ));

    let pi = PiExecutor::new(PathBuf::from("/usr/bin/pi")).parse_output(
        r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Pi delta"}}"#,
    );
    assert!(matches!(pi, ExecutorOutput::Stdout(ref text) if text == "Pi delta"));

    let pi_tool = PiExecutor::new(PathBuf::from("/usr/bin/pi")).parse_output(
        r#"{"type":"tool_execution_start","toolName":"bash","args":{"command":"ls -la"}}"#,
    );
    let ExecutorOutput::StructuredStatus { text, metadata } = pi_tool else {
        panic!("expected pi tool status");
    };
    assert_eq!(text, "Bash");
    assert_eq!(
        metadata.get("toolStatus").and_then(Value::as_str),
        Some("running")
    );

    let qwen = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen")).parse_output(
        r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Qwen delta"}}}"#,
    );
    let ExecutorOutput::Composite(qwen_events) = qwen else {
        panic!("expected qwen composite output");
    };
    assert!(matches!(
        qwen_events.first(),
        Some(ExecutorOutput::AssistantDelta(text)) if text == "Qwen delta"
    ));

    let letta = LettaExecutor::new(PathBuf::from("/usr/bin/letta")).parse_output("Letta line");
    assert!(matches!(letta, ExecutorOutput::Stdout(ref text) if text == "Letta line"));
}

#[test]
fn interactive_structured_output_includes_print_for_claude_family() {
    let mut interactive = options("review");
    interactive.interactive = true;
    interactive.structured_output = true;

    let claude = ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude")).build_args(&interactive);
    assert_contains(
        &claude,
        &[
            "--print",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
        ],
    );

    let ccr = CcrExecutor::new(PathBuf::from("/usr/bin/ccr")).build_args(&interactive);
    assert_contains(
        &ccr,
        &[
            "code",
            "--print",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
        ],
    );
}
