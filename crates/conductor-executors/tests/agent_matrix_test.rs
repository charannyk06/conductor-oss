use conductor_executors::agents::{
    AmpExecutor, CcrExecutor, ClaudeCodeExecutor, CodexExecutor, CopilotExecutor, CursorExecutor,
    DroidExecutor, GeminiExecutor, OpenCodeExecutor, QwenCodeExecutor,
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

    let ccr = CcrExecutor::new(PathBuf::from("/usr/bin/ccr")).build_args(&options("ccr prompt"));
    assert_contains(
        &ccr,
        &[
            "code",
            "--print",
            "--output-format",
            "stream-json",
            "--effort",
            "high",
            "ccr prompt",
        ],
    );
    assert_filters_blocked_flags(&ccr);

    let claude =
        ClaudeCodeExecutor::new(PathBuf::from("/usr/bin/claude")).build_args(&options("claude"));
    assert_contains(
        &claude,
        &[
            "--print",
            "--output-format",
            "stream-json",
            "--model",
            "gpt-5",
            "--effort",
            "high",
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
        ],
    );
    assert_filters_blocked_flags(&copilot);

    let cursor =
        CursorExecutor::new(PathBuf::from("/usr/bin/cursor")).build_args(&options("cursor"));
    assert_contains(
        &cursor,
        &[
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
            "gpt-5",
            "--reasoning-effort",
            "high",
            "droid",
        ],
    );
    assert_filters_blocked_flags(&droid);

    let gemini =
        GeminiExecutor::new(PathBuf::from("/usr/bin/gemini")).build_args(&options("gemini"));
    assert_contains(
        &gemini,
        &[
            "--model",
            "gpt-5",
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
            "--model",
            "gpt-5",
            "--variant",
            "max",
            "opencode",
        ],
    );
    assert_filters_blocked_flags(&opencode);

    let mut qwen_options = options("qwen");
    qwen_options.model = Some("qwen-max".to_string());
    let qwen = QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen")).build_args(&qwen_options);
    assert_contains(&qwen, &["--model", "qwen-max", "--prompt", "qwen"]);
    assert_filters_blocked_flags(&qwen);
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

    let qwen =
        QwenCodeExecutor::new(PathBuf::from("/usr/bin/qwen")).parse_output("plain qwen output");
    assert!(matches!(
        qwen,
        ExecutorOutput::Stdout(ref text) if text == "plain qwen output"
    ));
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
