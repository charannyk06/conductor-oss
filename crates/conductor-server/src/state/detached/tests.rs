use super::control::*;
use super::frame::*;
use super::helpers::*;
use super::types::*;
use crate::state::AppState;
use chrono::Utc;
use conductor_core::types::AgentKind;
use conductor_executors::executor::ExecutorInput;
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

use crate::state::SessionRecord;

#[test]
fn detached_stream_frame_decoder_handles_partial_frames() {
    let payload = b"hello";
    let frame = {
        let mut bytes = Vec::new();
        bytes.push(DetachedPtyStreamFrameKind::Data as u8);
        bytes.extend_from_slice(&7_u64.to_be_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    };

    let mut decoder = DetachedPtyStreamFrameDecoder::default();
    let first = decoder
        .push(&frame[..4])
        .expect("partial header should parse");
    assert!(first.is_empty());
    let second = decoder
        .push(&frame[4..9])
        .expect("remaining header should parse");
    assert!(second.is_empty());
    let final_frames = decoder
        .push(&frame[9..])
        .expect("payload should complete the frame");
    assert_eq!(
        final_frames,
        vec![DetachedPtyStreamFrame {
            kind: DetachedPtyStreamFrameKind::Data,
            offset: 7,
            payload: payload.to_vec(),
        }]
    );
}

#[test]
fn coalesce_detached_input_commands_merges_adjacent_raw_chunks() {
    let commands = coalesce_detached_input_commands(vec![
        ExecutorInput::Raw("he".to_string()),
        ExecutorInput::Raw("llo".to_string()),
        ExecutorInput::Raw("!".to_string()),
    ]);

    assert_eq!(commands.len(), 1);
    match &commands[0] {
        DetachedPtyHostCommand::Raw { data } => assert_eq!(data, "hello!"),
        other => panic!("expected merged raw command, got {other:?}"),
    }
}

#[test]
fn coalesce_detached_input_commands_preserves_text_boundaries() {
    let commands = coalesce_detached_input_commands(vec![
        ExecutorInput::Raw("abc".to_string()),
        ExecutorInput::Text("prompt".to_string()),
        ExecutorInput::Raw("xyz".to_string()),
    ]);

    assert_eq!(commands.len(), 3);
    match &commands[0] {
        DetachedPtyHostCommand::Raw { data } => assert_eq!(data, "abc"),
        other => panic!("expected leading raw command, got {other:?}"),
    }
    match &commands[1] {
        DetachedPtyHostCommand::Text { text } => assert_eq!(text, "prompt"),
        other => panic!("expected text command boundary, got {other:?}"),
    }
    match &commands[2] {
        DetachedPtyHostCommand::Raw { data } => assert_eq!(data, "xyz"),
        other => panic!("expected trailing raw command, got {other:?}"),
    }
}

#[test]
fn prepare_detached_runtime_env_sets_term_and_colorterm() {
    let mut env = HashMap::new();
    prepare_detached_runtime_env(AgentKind::QwenCode, true, &mut env);
    assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
    assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
    // Should not inject NO_COLOR anymore
    assert!(!env.contains_key("NO_COLOR"));
}

#[test]
fn prepare_detached_runtime_env_preserves_existing_term() {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "screen-256color".to_string());
    prepare_detached_runtime_env(AgentKind::Codex, true, &mut env);
    // Should not overwrite user-provided TERM
    assert_eq!(env.get("TERM").map(String::as_str), Some("screen-256color"));
    // But should still set COLORTERM
    assert_eq!(env.get("COLORTERM").map(String::as_str), Some("truecolor"));
}

#[tokio::test]
async fn detached_runtime_metadata_can_be_recovered_from_daemon_session_spec() {
    let root = std::env::temp_dir().join(format!(
        "conductor-detached-daemon-metadata-{}",
        Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let spec_path = root.join("host-spec.json");
    let ready_path = root.join("host.ready.json");
    let control_socket_path = root.join("host.ctrl.sock");
    let stream_socket_path = root.join("host.stream.sock");
    let log_path = root.join("host.log");
    let checkpoint_path = root.join("host.checkpoint.json");
    let exit_path = root.join("host.exit");

    let spec = DetachedPtyHostSpec {
        protocol_version: DETACHED_PTY_PROTOCOL_VERSION,
        token: "daemon-token".to_string(),
        binary: PathBuf::from("/bin/sh"),
        args: vec!["-lc".to_string(), "echo hi".to_string()],
        cwd: root.clone(),
        env: HashMap::new(),
        cols: 120,
        rows: 32,
        control_socket_path: control_socket_path.clone(),
        stream_socket_path: stream_socket_path.clone(),
        log_path: log_path.clone(),
        checkpoint_path: checkpoint_path.clone(),
        exit_path: exit_path.clone(),
        ready_path: ready_path.clone(),
        stream_flush_interval_ms: detached_stream_flush_interval_ms(),
        stream_max_batch_bytes: detached_stream_max_batch_bytes(),
        isolation_mode: None,
    };
    tokio::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap())
        .await
        .unwrap();

    let daemon_session = TerminalDaemonSessionInfo {
        session_id: "session-1".to_string(),
        spec_path: spec_path.clone(),
        ready_path,
        host_pid: Some(4242),
        child_pid: Some(4343),
        protocol_version: Some(DETACHED_PTY_PROTOCOL_VERSION),
        cols: Some(120),
        rows: Some(32),
        control_socket_path: Some(control_socket_path.clone()),
        stream_socket_path: Some(stream_socket_path.clone()),
        control_token: Some("daemon-token".to_string()),
        log_path: Some(log_path.clone()),
        checkpoint_path: Some(checkpoint_path.clone()),
        exit_path: Some(exit_path.clone()),
        status: "ready".to_string(),
        started_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        error: None,
    };

    let metadata = detached_runtime_metadata_from_daemon_session(&daemon_session)
        .await
        .unwrap()
        .expect("daemon session spec should reconstruct runtime metadata");

    assert_eq!(metadata.protocol_version, DETACHED_PTY_PROTOCOL_VERSION);
    assert_eq!(metadata.host_pid, 4242);
    assert_eq!(metadata.control_socket_path, control_socket_path);
    assert_eq!(metadata.stream_socket_path, Some(stream_socket_path));
    assert_eq!(metadata.control_token, "daemon-token");
    assert_eq!(metadata.log_path, log_path);
    assert_eq!(metadata.exit_path, exit_path);

    let _ = tokio::fs::remove_dir_all(&root).await;
}

#[tokio::test]
async fn detached_runtime_log_path_prefers_daemon_session_spec_over_session_metadata() {
    let root = std::env::temp_dir().join(format!(
        "conductor-detached-daemon-log-path-{}",
        Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&root).await.unwrap();
    let spec_path = root.join("host-spec.json");
    let ready_path = root.join("host.ready.json");
    let daemon_log_path = root.join("host.log");
    let daemon_checkpoint_path = root.join("host.checkpoint.json");
    let session_log_path = root.join("session.log");

    let spec = DetachedPtyHostSpec {
        protocol_version: DETACHED_PTY_PROTOCOL_VERSION,
        token: "daemon-token".to_string(),
        binary: PathBuf::from("/bin/sh"),
        args: vec!["-lc".to_string(), "echo hi".to_string()],
        cwd: root.clone(),
        env: HashMap::new(),
        cols: 120,
        rows: 32,
        control_socket_path: root.join("host.ctrl.sock"),
        stream_socket_path: root.join("host.stream.sock"),
        log_path: daemon_log_path.clone(),
        checkpoint_path: daemon_checkpoint_path.clone(),
        exit_path: root.join("host.exit"),
        ready_path: ready_path.clone(),
        stream_flush_interval_ms: detached_stream_flush_interval_ms(),
        stream_max_batch_bytes: detached_stream_max_batch_bytes(),
        isolation_mode: None,
    };
    tokio::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap())
        .await
        .unwrap();

    let daemon_session = TerminalDaemonSessionInfo {
        session_id: "session-1".to_string(),
        spec_path: spec_path.clone(),
        ready_path,
        host_pid: Some(4242),
        child_pid: Some(4343),
        protocol_version: Some(DETACHED_PTY_PROTOCOL_VERSION),
        cols: Some(120),
        rows: Some(32),
        control_socket_path: Some(root.join("host.ctrl.sock")),
        stream_socket_path: Some(root.join("host.stream.sock")),
        control_token: Some("daemon-token".to_string()),
        log_path: Some(daemon_log_path.clone()),
        checkpoint_path: Some(daemon_checkpoint_path.clone()),
        exit_path: Some(root.join("host.exit")),
        status: "ready".to_string(),
        started_at: Utc::now().to_rfc3339(),
        updated_at: Utc::now().to_rfc3339(),
        error: None,
    };

    let mut session = SessionRecord::builder(
        "session-1".to_string(),
        "project-1".to_string(),
        "codex".to_string(),
        "prompt".to_string(),
    )
    .build();
    session.metadata.insert(
        DETACHED_LOG_PATH_METADATA_KEY.to_string(),
        session_log_path.display().to_string(),
    );

    let resolved = resolve_detached_runtime_log_path(&session, Some(&daemon_session))
        .await
        .unwrap();

    assert_eq!(resolved, Some(daemon_log_path));

    let _ = tokio::fs::remove_dir_all(&root).await;
}

#[tokio::test]
async fn detached_runtime_log_path_falls_back_to_session_metadata() {
    let session_log_path =
        std::env::temp_dir().join(format!("conductor-detached-session-log-{}", Uuid::new_v4()));
    let mut session = SessionRecord::builder(
        "session-1".to_string(),
        "project-1".to_string(),
        "codex".to_string(),
        "prompt".to_string(),
    )
    .build();
    session.metadata.insert(
        DETACHED_LOG_PATH_METADATA_KEY.to_string(),
        session_log_path.display().to_string(),
    );

    let resolved = resolve_detached_runtime_log_path(&session, None)
        .await
        .unwrap();

    assert_eq!(resolved, Some(session_log_path));
}

#[tokio::test]
async fn detached_output_offset_reads_metadata() {
    let mut session = SessionRecord::new(
        "session-1".to_string(),
        "demo".to_string(),
        None,
        None,
        None,
        "codex".to_string(),
        None,
        None,
        "Prompt".to_string(),
        None,
    );
    session.metadata.insert(
        DETACHED_OUTPUT_OFFSET_METADATA_KEY.to_string(),
        "12".to_string(),
    );
    let empty = SessionRecord::new(
        "session-2".to_string(),
        "demo".to_string(),
        None,
        None,
        None,
        "codex".to_string(),
        None,
        None,
        "Prompt".to_string(),
        None,
    );

    assert_eq!(AppState::detached_output_offset(&session), 12);
    assert_eq!(AppState::detached_output_offset(&empty), 0);
}

#[tokio::test]
async fn ping_detached_runtime_returns_none_for_missing_unix_socket() {
    let metadata = DetachedRuntimeMetadata {
        protocol_version: DETACHED_PTY_PROTOCOL_VERSION,
        host_pid: 0,
        control_socket_path: PathBuf::from(format!(
            "/tmp/co-detached-{}-missing-ctrl.sock",
            Uuid::new_v4().simple()
        )),
        stream_socket_path: Some(PathBuf::from(format!(
            "/tmp/co-detached-{}-missing-stream.sock",
            Uuid::new_v4().simple()
        ))),
        control_token: Uuid::new_v4().to_string(),
        log_path: PathBuf::from(format!(
            "/tmp/co-detached-{}-missing.log",
            Uuid::new_v4().simple()
        )),
        exit_path: PathBuf::from(format!(
            "/tmp/co-detached-{}-missing.exit",
            Uuid::new_v4().simple()
        )),
    };

    assert!(ping_detached_runtime(&metadata)
        .await
        .expect("missing detached runtime socket should not error")
        .is_none());
}

#[test]
fn detached_protocol_version_rejects_unknown_versions() {
    let error = ensure_detached_protocol_version(DETACHED_PTY_PROTOCOL_VERSION + 1)
        .expect_err("unsupported protocol version should fail");
    assert!(error
        .to_string()
        .contains("Unsupported detached PTY protocol version"));
}
