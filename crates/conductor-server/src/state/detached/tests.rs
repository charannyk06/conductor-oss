use super::types::*;
use super::frame::*;
use super::control::*;
use super::helpers::*;
use super::stream::*;
use crate::state::AppState;
use anyhow::{anyhow, Result};
use conductor_core::types::AgentKind;
use conductor_executors::executor::ExecutorInput;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use uuid::Uuid;

use super::pty_host::run_detached_pty_host;
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
    fn prepare_detached_runtime_env_disables_qwen_gradient_theme() {
        let mut env = HashMap::new();
        prepare_detached_runtime_env(AgentKind::QwenCode, true, &mut env);
        assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("1"));
    }

    #[test]
    fn prepare_detached_runtime_env_preserves_non_qwen_agents() {
        let mut env = HashMap::new();
        prepare_detached_runtime_env(AgentKind::Codex, true, &mut env);
        assert!(!env.contains_key("NO_COLOR"));
    }

    #[tokio::test]
    async fn detached_pty_host_streams_replays_and_persists_output() {
        let root = std::env::temp_dir().join(format!(
            "conductor-detached-pty-host-test-{}",
            Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let spec_path = root.join("host-spec.json");
        let log_path = root.join("host.log");
        let exit_path = root.join("host.exit");
        let ready_path = root.join("host.ready.json");
        let control_socket_path = PathBuf::from(format!(
            "/tmp/co-detached-{}-ctrl.sock",
            Uuid::new_v4().simple()
        ));
        let stream_socket_path = PathBuf::from(format!(
            "/tmp/co-detached-{}-stream.sock",
            Uuid::new_v4().simple()
        ));
        let token = Uuid::new_v4().to_string();
        let spec = DetachedPtyHostSpec {
            protocol_version: DETACHED_PTY_PROTOCOL_VERSION,
            token: token.clone(),
            binary: PathBuf::from("/bin/sh"),
            args: vec!["-lc".to_string(), "cat".to_string()],
            cwd: root.clone(),
            env: HashMap::new(),
            cols: 120,
            rows: 32,
            control_socket_path: control_socket_path.clone(),
            stream_socket_path: stream_socket_path.clone(),
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
            ready_path: ready_path.clone(),
            stream_flush_interval_ms: detached_stream_flush_interval_ms(),
            stream_max_batch_bytes: detached_stream_max_batch_bytes(),
            isolation_mode: None,
        };
        tokio::fs::write(&spec_path, serde_json::to_vec(&spec).unwrap())
            .await
            .unwrap();

        let host_task = tokio::spawn(run_detached_pty_host(spec_path.clone()));
        let ready = match wait_for_detached_ready(&ready_path, DETACHED_READY_TIMEOUT).await {
            Ok(ready) => ready,
            Err(error) => {
                if host_task.is_finished() {
                    let joined = host_task.await.unwrap();
                    if joined
                        .as_ref()
                        .err()
                        .map(|err| {
                            err.chain().any(|cause| {
                                let message = cause.to_string();
                                message.contains("Operation not permitted")
                                    || message.contains("path must be shorter than SUN_LEN")
                            })
                        })
                        .unwrap_or(false)
                    {
                        return;
                    }
                    panic!("host failed before readiness: {joined:?}");
                }
                panic!("host should report readiness: {error}");
            }
        };
        let metadata = DetachedRuntimeMetadata {
            protocol_version: ready.protocol_version,
            host_pid: ready.host_pid,
            control_socket_path,
            stream_socket_path: Some(stream_socket_path),
            control_token: token,
            log_path: log_path.clone(),
            exit_path: exit_path.clone(),
        };

        let mut control = connect_detached_runtime_control(&metadata)
            .await
            .expect("control should connect");
        let ping = send_detached_runtime_request_over_connection(
            &mut control,
            &metadata,
            DetachedPtyHostCommand::Ping,
        )
        .await
        .expect("ping should succeed");
        assert!(ping.ok);
        assert_eq!(ping.child_pid, Some(ready.child_pid));

        let mut stream = connect_detached_runtime_stream(&metadata, 0)
            .await
            .expect("stream should connect");

        send_detached_runtime_request_over_connection(
            &mut control,
            &metadata,
            DetachedPtyHostCommand::Text {
                text: "hello from host".to_string(),
            },
        )
        .await
        .expect("text should be accepted");

        let mut decoder = DetachedPtyStreamFrameDecoder::default();
        let first = read_next_stream_frame(&mut stream, &mut decoder)
            .await
            .expect("first frame should arrive");
        assert_eq!(first.kind, DetachedPtyStreamFrameKind::Data);
        assert!(String::from_utf8_lossy(&first.payload).contains("hello from host"));

        let first_end = first.offset + first.payload.len() as u64;
        drop(stream);

        send_detached_runtime_request_over_connection(
            &mut control,
            &metadata,
            DetachedPtyHostCommand::Text {
                text: "replayed line".to_string(),
            },
        )
        .await
        .expect("text should be accepted while detached");

        let mut replay_stream = connect_detached_runtime_stream(&metadata, first_end)
            .await
            .expect("replay stream should connect");
        let mut replay_decoder = DetachedPtyStreamFrameDecoder::default();
        let replayed = read_next_stream_frame(&mut replay_stream, &mut replay_decoder)
            .await
            .expect("replayed frame should arrive");
        assert_eq!(replayed.kind, DetachedPtyStreamFrameKind::Data);
        assert!(String::from_utf8_lossy(&replayed.payload).contains("replayed line"));

        let log_contents = wait_for_detached_log_contains(
            "detached host output",
            &log_path,
            &["hello from host", "replayed line"],
        )
        .await;
        assert!(log_contents.contains("hello from host"));
        assert!(log_contents.contains("replayed line"));

        send_detached_runtime_request_over_connection(
            &mut control,
            &metadata,
            DetachedPtyHostCommand::Resize {
                cols: 132,
                rows: 40,
            },
        )
        .await
        .expect("resize should be accepted");

        send_detached_runtime_request_over_connection(
            &mut control,
            &metadata,
            DetachedPtyHostCommand::Kill,
        )
        .await
        .expect("kill should be accepted");

        let exit_frame = loop {
            let frame = read_next_stream_frame(&mut replay_stream, &mut replay_decoder)
                .await
                .expect("stream frame should arrive after kill");
            if frame.kind == DetachedPtyStreamFrameKind::Exit {
                break frame;
            }
        };
        assert_ne!(
            decode_detached_exit_payload(&exit_frame.payload).expect("exit payload should decode"),
            i32::MIN
        );

        let exit_code = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(code) = read_detached_exit_code(&exit_path).await.unwrap() {
                    return code;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("host should write an exit code");
        assert_ne!(exit_code, i32::MIN);

        host_task
            .await
            .expect("host task should join")
            .expect("host should exit cleanly");

        let _ = tokio::fs::remove_dir_all(&root).await;
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

    async fn read_next_stream_frame(
        stream: &mut UnixStream,
        decoder: &mut DetachedPtyStreamFrameDecoder,
    ) -> Result<DetachedPtyStreamFrame> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    return Err(anyhow!("detached PTY stream closed"));
                }
                let mut frames = decoder.push(&buffer[..read])?;
                if !frames.is_empty() {
                    return Ok(frames.remove(0));
                }
            }
        })
        .await
        .map_err(|_| anyhow!("timed out waiting for detached PTY stream frame"))?
    }

    async fn wait_for_detached_log_contains(
        label: &str,
        path: &std::path::Path,
        needles: &[&str],
    ) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match tokio::fs::read_to_string(path).await {
                    Ok(content)
                        if !content.trim().is_empty()
                            && needles.iter().all(|needle| content.contains(needle)) =>
                    {
                        return content
                    }
                    _ => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {label}"))
    }
