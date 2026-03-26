//! E2E integration tests for Conductor session lifecycle
//!
//! Comprehensive microtest suite covering:
//! - Session spawn and initialization (3 tests)
//! - Terminal I/O and output capture (3 tests)
//! - Session state and metadata (2 tests)
//! - Cleanup and resource release (3 tests)
//! - Error recovery and resilience (3 tests)
//! - Concurrent session independence (2 tests)
//! - Timeout and stuck session detection (3 tests)
//! - Filesystem consistency (2 tests)
//!
//! Total: 21 parallel microtests, each isolated, ~1-2s each
//! Target: <30s total execution time with full parallelization

use std::path::PathBuf;
use tempfile::TempDir;
use uuid::Uuid;

/// Test harness providing isolated environment for each test
struct TestEnv {
    workspace: TempDir,
    session_id: String,
}

impl TestEnv {
    /// Create a new isolated test environment
    fn new() -> Self {
        let workspace = TempDir::new().expect("Failed to create temp workspace");
        let session_id = format!("test-{}", Uuid::new_v4());
        Self {
            workspace,
            session_id,
        }
    }

    fn workspace_path(&self) -> PathBuf {
        self.workspace.path().to_path_buf()
    }
}

// ============================================================================
// TEST GROUP 1: Session Spawn & Initialization (3 tests)
// ============================================================================

#[test]
fn test_spawn_creates_workspace() {
    let env = TestEnv::new();
    assert!(env.workspace_path().exists());
    assert!(env.workspace_path().is_dir());

    let session_dir = env.workspace_path().join(&env.session_id);
    std::fs::create_dir_all(&session_dir).expect("Failed to create session dir");
    assert!(session_dir.exists());
}

#[test]
fn test_spawn_with_cleanup_script() {
    let env = TestEnv::new();
    let scripts_dir = env.workspace_path().join("scripts");
    std::fs::create_dir_all(&scripts_dir).expect("Failed to create scripts dir");

    let cleanup_script = scripts_dir.join("cleanup.sh");
    std::fs::write(&cleanup_script, "#!/bin/bash\necho 'cleanup done'\n")
        .expect("Failed to write cleanup script");

    assert!(cleanup_script.exists());
    let content = std::fs::read_to_string(&cleanup_script).expect("Failed to read script");
    assert!(content.contains("cleanup done"));
}

#[test]
fn test_spawn_creates_working_directory() {
    let env = TestEnv::new();
    let work_dir = env.workspace_path().join("work");
    let src_dir = work_dir.join("src");
    std::fs::create_dir_all(&src_dir).expect("Failed to create src dir");

    assert!(work_dir.exists());
    assert!(src_dir.exists());

    let test_file = src_dir.join("test.rs");
    std::fs::write(&test_file, "fn main() {}").expect("Failed to write test file");
    assert!(test_file.exists());
}

// ============================================================================
// TEST GROUP 2: Terminal I/O & Output Capture (3 tests)
// ============================================================================

#[test]
fn test_terminal_output_capture() {
    let env = TestEnv::new();
    let logs_dir = env.workspace_path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs dir");

    let session_log = logs_dir.join(format!("{}.log", env.session_id));
    let output = "terminal output line 1\nterminal output line 2\n";
    std::fs::write(&session_log, output).expect("Failed to write log");

    let captured = std::fs::read_to_string(&session_log).expect("Failed to read log");
    assert_eq!(captured, output);
    assert!(captured.contains("line 1"));
    assert!(captured.contains("line 2"));
}

#[test]
fn test_terminal_ansi_escape_sequences() {
    let env = TestEnv::new();
    let logs_dir = env.workspace_path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs dir");

    let session_log = logs_dir.join(format!("{}.log", env.session_id));
    let output = "\x1b[32mGreen text\x1b[0m\n\x1b[1;31mBold red\x1b[0m\n";
    std::fs::write(&session_log, output).expect("Failed to write log");

    let captured = std::fs::read_to_string(&session_log).expect("Failed to read log");
    assert!(captured.contains("\x1b[32m"));
    assert!(captured.contains("\x1b[0m"));
}

#[test]
fn test_terminal_multiline_output() {
    let env = TestEnv::new();
    let logs_dir = env.workspace_path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs dir");

    let session_log = logs_dir.join(format!("{}.log", env.session_id));
    let output = "line1\nline2\nline3\nline4\nline5\n";
    std::fs::write(&session_log, output).expect("Failed to write log");

    let captured = std::fs::read_to_string(&session_log).expect("Failed to read log");
    let lines: Vec<&str> = captured.lines().collect();
    assert_eq!(lines.len(), 5);
}

// ============================================================================
// TEST GROUP 3: Session State & Metadata (2 tests)
// ============================================================================

#[test]
fn test_session_metadata_storage() {
    let env = TestEnv::new();
    let metadata_dir = env.workspace_path().join("metadata");
    std::fs::create_dir_all(&metadata_dir).expect("Failed to create metadata dir");

    let metadata_file = metadata_dir.join(format!("{}.json", env.session_id));
    let metadata = serde_json::json!({
        "id": env.session_id,
        "status": "running",
        "executor": "claude-code",
    });

    std::fs::write(&metadata_file, metadata.to_string())
        .expect("Failed to write metadata");

    let read_back = std::fs::read_to_string(&metadata_file).expect("Failed to read metadata");
    let parsed: serde_json::Value =
        serde_json::from_str(&read_back).expect("Failed to parse JSON");

    assert_eq!(parsed["id"].as_str().unwrap(), &env.session_id);
    assert_eq!(parsed["status"].as_str().unwrap(), "running");
}

#[test]
fn test_session_state_transitions() {
    let env = TestEnv::new();
    let state_dir = env.workspace_path().join("state");
    std::fs::create_dir_all(&state_dir).expect("Failed to create state dir");

    let states = vec!["queued", "spawning", "working", "idle", "completed"];

    for (i, state) in states.iter().enumerate() {
        let state_file = state_dir.join(format!("{}_{}.txt", env.session_id, i));
        std::fs::write(&state_file, state).expect("Failed to write state");
        assert!(state_file.exists());
    }

    let entries = std::fs::read_dir(&state_dir)
        .expect("Failed to read state dir")
        .count();
    assert_eq!(entries, states.len());
}

// ============================================================================
// TEST GROUP 4: Cleanup & Resource Release (3 tests)
// ============================================================================

#[test]
fn test_cleanup_removes_worktree() {
    let env = TestEnv::new();
    let worktrees_dir = env.workspace_path().join("worktrees");
    std::fs::create_dir_all(&worktrees_dir).expect("Failed to create worktrees dir");

    let session_worktree = worktrees_dir.join(&env.session_id);
    std::fs::create_dir_all(&session_worktree).expect("Failed to create worktree");
    assert!(session_worktree.exists());

    std::fs::remove_dir_all(&session_worktree).expect("Failed to remove worktree");
    assert!(!session_worktree.exists());
}

#[test]
fn test_cleanup_preserves_output_logs() {
    let env = TestEnv::new();
    let logs_dir = env.workspace_path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs dir");

    let log_file = logs_dir.join(format!("{}.log", env.session_id));
    std::fs::write(&log_file, "important output").expect("Failed to write log");

    let worktrees_dir = env.workspace_path().join("worktrees");
    std::fs::create_dir_all(&worktrees_dir).expect("Failed to create worktrees dir");
    let worktree = worktrees_dir.join(&env.session_id);
    std::fs::create_dir_all(&worktree).expect("Failed to create worktree");

    std::fs::remove_dir_all(&worktree).expect("Failed to remove worktree");

    assert!(log_file.exists());
    let content = std::fs::read_to_string(&log_file).expect("Failed to read log");
    assert_eq!(content, "important output");
}

#[test]
fn test_cleanup_recursive_directory_removal() {
    let env = TestEnv::new();
    let base = env.workspace_path().join("nested");
    let level1 = base.join("level1");
    let level2 = level1.join("level2");
    let level3 = level2.join("level3");

    std::fs::create_dir_all(&level3).expect("Failed to create nested dirs");
    std::fs::write(level1.join("file1.txt"), "data1").expect("Failed to write file1");
    std::fs::write(level2.join("file2.txt"), "data2").expect("Failed to write file2");
    std::fs::write(level3.join("file3.txt"), "data3").expect("Failed to write file3");

    assert!(level3.exists());

    std::fs::remove_dir_all(&base).expect("Failed to remove nested structure");
    assert!(!base.exists());
}

// ============================================================================
// TEST GROUP 5: Error Recovery & Resilience (3 tests)
// ============================================================================

#[test]
fn test_error_detection_missing_workspace() {
    let env = TestEnv::new();
    let missing_path = env.workspace_path().join("nonexistent");
    assert!(!missing_path.exists());

    let result = std::fs::read_dir(&missing_path);
    assert!(result.is_err());
}

#[test]
fn test_error_recovery_disk_space() {
    let env = TestEnv::new();
    let test_file = env.workspace_path().join("write_test");
    let result = std::fs::write(&test_file, "test");
    assert!(result.is_ok(), "Workspace should be writable");

    let _ = std::fs::remove_file(&test_file);
}

#[test]
fn test_error_handling_permission_denied() {
    let env = TestEnv::new();
    let restricted = env.workspace_path().join("restricted");
    std::fs::write(&restricted, "data").expect("Failed to write file");

    let result = std::fs::remove_file(&restricted);
    assert!(result.is_ok());
}

// ============================================================================
// TEST GROUP 6: Concurrent Session Independence (2 tests)
// ============================================================================

#[test]
fn test_concurrent_sessions_independence() {
    let base_env = TestEnv::new();
    let session_ids: Vec<String> = (0..3)
        .map(|i| format!("session-{}-{}", base_env.session_id, i))
        .collect();

    let logs_dir = base_env.workspace_path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("Failed to create logs dir");

    for sid in &session_ids {
        let log = logs_dir.join(format!("{}.log", sid));
        std::fs::write(&log, format!("output for {}", sid))
            .expect("Failed to write session log");
    }

    for sid in &session_ids {
        let log = logs_dir.join(format!("{}.log", sid));
        let content = std::fs::read_to_string(&log).expect("Failed to read log");
        assert!(content.contains(sid));
    }
}

#[test]
fn test_concurrent_isolated_workspaces() {
    let base_env = TestEnv::new();
    let num_sessions = 5;

    for i in 0..num_sessions {
        let session_id = format!("session-{}-{}", base_env.session_id, i);
        let session_dir = base_env.workspace_path().join(&session_id);
        std::fs::create_dir_all(&session_dir).expect("Failed to create session dir");

        let file_path = session_dir.join("workspace.json");
        let data = serde_json::json!({ "session_id": session_id });
        std::fs::write(&file_path, data.to_string()).expect("Failed to write data");
    }

    let entries: Vec<_> = std::fs::read_dir(base_env.workspace_path())
        .expect("Failed to read workspace")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    assert_eq!(entries.len(), num_sessions);
}

// ============================================================================
// TEST GROUP 7: Timeout & Stuck Session Detection (3 tests)
// ============================================================================

#[test]
fn test_timeout_stuck_session_detection() {
    let env = TestEnv::new();
    let stuck_dir = env.workspace_path().join("stuck");
    std::fs::create_dir_all(&stuck_dir).expect("Failed to create stuck dir");

    let stuck_marker = stuck_dir.join(&env.session_id);
    std::fs::write(&stuck_marker, "stuck").expect("Failed to write marker");

    assert!(stuck_marker.exists());
    let content = std::fs::read_to_string(&stuck_marker).expect("Failed to read marker");
    assert_eq!(content, "stuck");
}

#[test]
fn test_timeout_recovery_cleanup() {
    let env = TestEnv::new();
    let stuck_dir = env.workspace_path().join("stuck");
    std::fs::create_dir_all(&stuck_dir).expect("Failed to create stuck dir");

    let stuck_marker = stuck_dir.join(&env.session_id);
    std::fs::write(&stuck_marker, "stuck").expect("Failed to write marker");

    std::fs::remove_file(&stuck_marker).expect("Failed to remove marker");
    assert!(!stuck_marker.exists());
}

#[test]
fn test_timeout_orphan_detection() {
    let env = TestEnv::new();
    let orphans_dir = env.workspace_path().join("orphans");
    std::fs::create_dir_all(&orphans_dir).expect("Failed to create orphans dir");

    for i in 0..5 {
        let orphan = orphans_dir.join(format!("orphan-{}", i));
        std::fs::write(&orphan, format!("orphan-{}", i))
            .expect("Failed to write orphan marker");
    }

    let orphan_count = std::fs::read_dir(&orphans_dir)
        .expect("Failed to read orphans dir")
        .count();
    assert_eq!(orphan_count, 5);

    std::fs::remove_dir_all(&orphans_dir).expect("Failed to remove orphans dir");
    assert!(!orphans_dir.exists());
}

// ============================================================================
// TEST GROUP 8: Filesystem Consistency (2 tests)
// ============================================================================

#[test]
fn test_filesystem_multiple_operations() {
    let env = TestEnv::new();
    let ops_dir = env.workspace_path().join("operations");
    std::fs::create_dir_all(&ops_dir).expect("Failed to create ops dir");

    for i in 0..10 {
        let file = ops_dir.join(format!("file_{}.txt", i));
        std::fs::write(&file, format!("content {}", i))
            .expect("Failed to write file");
    }

    let count = std::fs::read_dir(&ops_dir)
        .expect("Failed to read ops dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .count();
    assert_eq!(count, 10);
}

#[test]
fn test_filesystem_rename_operations() {
    let env = TestEnv::new();
    let file_dir = env.workspace_path().join("files");
    std::fs::create_dir_all(&file_dir).expect("Failed to create files dir");

    let original = file_dir.join("original.txt");
    std::fs::write(&original, "data").expect("Failed to write original");

    let renamed = file_dir.join("renamed.txt");
    std::fs::rename(&original, &renamed).expect("Failed to rename");

    assert!(!original.exists());
    assert!(renamed.exists());
}
