use super::*;

#[test]
fn sanitized_extra_args_filters_blocked_flags_case_insensitively() {
    let options = SpawnOptions {
        cwd: PathBuf::from("/tmp/demo"),
        prompt: "test".to_string(),
        model: None,
        reasoning_effort: None,
        skip_permissions: false,
        extra_args: vec![
            "--safe".to_string(),
            "--YOLO".to_string(),
            "--Dangerously-Skip-Permissions".to_string(),
            "--another-safe".to_string(),
        ],
        env: HashMap::new(),
        branch: None,
        timeout: None,
        interactive: false,
        structured_output: false,
        resume_target: None,
    };

    assert_eq!(
        options.sanitized_extra_args(),
        vec!["--safe".to_string(), "--another-safe".to_string()]
    );
}

#[test]
fn sanitize_terminal_text_removes_csi_osc_and_control_characters() {
    let input = "\u{001b}]0;tab-title\u{0007}\u{001b}[31mhello\r\nwo\u{0008}rld\t";

    assert_eq!(sanitize_terminal_text(input), "hello\nworld\t");
}

#[test]
fn flatten_parsed_output_recursively_flattens_nested_composites() {
    let flattened = flatten_parsed_output(ExecutorOutput::Composite(vec![
        ExecutorOutput::Stdout("first".to_string()),
        ExecutorOutput::Composite(vec![
            ExecutorOutput::Stdout(String::new()),
            ExecutorOutput::StructuredStatus {
                text: "Thinking".to_string(),
                metadata: HashMap::new(),
            },
            ExecutorOutput::Composite(vec![ExecutorOutput::Stdout("second".to_string())]),
        ]),
        ExecutorOutput::Stderr("problem".to_string()),
    ]));

    assert_eq!(flattened.len(), 4);
    assert!(matches!(flattened[0], ExecutorOutput::Stdout(ref text) if text == "first"));
    assert!(matches!(
        flattened[1],
        ExecutorOutput::StructuredStatus { ref text, .. } if text == "Thinking"
    ));
    assert!(matches!(flattened[2], ExecutorOutput::Stdout(ref text) if text == "second"));
    assert!(matches!(flattened[3], ExecutorOutput::Stderr(ref text) if text == "problem"));
}
