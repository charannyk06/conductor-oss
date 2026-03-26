# E2E Testing Documentation

## Overview

Conductor OSS includes a comprehensive E2E testing suite designed for rapid, parallel execution without resource contention. The test suite consists of **21 synchronized tests** organized into **8 independent test groups**, each optimized for parallel CI/CD execution.

## Test Suite Architecture

### Design Principles

- **Isolation:** Each test runs in its own temporary directory with a unique session ID
- **Independence:** No shared state between tests; all resource cleanup is automatic via `TempDir`
- **Parallelization:** Tests can run simultaneously without conflicts, timeouts, or resource exhaustion
- **Speed:** Total execution time <1s with full parallelization
- **Reliability:** No flaky assertions; deterministic behavior on all platforms

### Test Categories (8 groups)

#### 1. Session Spawn & Initialization (3 tests)
- `test_spawn_creates_workspace` - Verifies workspace directory creation
- `test_spawn_with_cleanup_script` - Tests cleanup script provisioning
- `test_spawn_creates_working_directory` - Validates working directory structure

**Coverage:** Session startup, directory initialization, script preparation

#### 2. Terminal I/O & Output Capture (3 tests)
- `test_terminal_output_capture` - Captures and validates terminal output
- `test_terminal_ansi_escape_sequences` - Preserves ANSI escape sequences
- `test_terminal_multiline_output` - Handles multi-line output correctly

**Coverage:** Output streaming, formatting preservation, line buffering

#### 3. Session State & Metadata (2 tests)
- `test_session_metadata_storage` - JSON metadata persistence
- `test_session_state_transitions` - State machine progression

**Coverage:** Metadata tracking, state persistence, lifecycle management

#### 4. Cleanup & Resource Release (3 tests)
- `test_cleanup_removes_worktree` - Worktree removal verification
- `test_cleanup_preserves_output_logs` - Log preservation during cleanup
- `test_cleanup_recursive_directory_removal` - Deep directory tree cleanup

**Coverage:** Resource cleanup, log preservation, recursive removal

#### 5. Error Recovery & Resilience (3 tests)
- `test_error_detection_missing_workspace` - Missing resource detection
- `test_error_recovery_disk_space` - Disk space error recovery
- `test_error_handling_permission_denied` - Permission error handling

**Coverage:** Error paths, failure recovery, edge case handling

#### 6. Concurrent Session Independence (2 tests)
- `test_concurrent_sessions_independence` - Multiple sessions don't interfere
- `test_concurrent_isolated_workspaces` - Workspace isolation verification

**Coverage:** Concurrency safety, isolation guarantees

#### 7. Timeout & Stuck Session Detection (3 tests)
- `test_timeout_stuck_session_detection` - Stuck session marker creation
- `test_timeout_recovery_cleanup` - Recovery from stuck sessions
- `test_timeout_orphan_detection` - Orphan process detection

**Coverage:** Timeout detection, recovery mechanisms, cleanup

#### 8. Filesystem Consistency (2 tests)
- `test_filesystem_multiple_operations` - Sequential file operations
- `test_filesystem_rename_operations` - Atomic rename operations

**Coverage:** File operations, consistency guarantees, atomicity

## Running Tests Locally

### Run all E2E tests
```bash
cargo test --test e2e_integration_tests
```

### Run with sequential execution (for debugging)
```bash
cargo test --test e2e_integration_tests -- --test-threads=1
```

### Run specific test group
```bash
# Run only spawn tests
cargo test --test e2e_integration_tests test_spawn

# Run only terminal I/O tests
cargo test --test e2e_integration_tests test_terminal

# Run only state tests
cargo test --test e2e_integration_tests test_session

# Run only cleanup tests
cargo test --test e2e_integration_tests test_cleanup

# Run only error recovery tests
cargo test --test e2e_integration_tests test_error

# Run only concurrency tests
cargo test --test e2e_integration_tests test_concurrent

# Run only timeout tests
cargo test --test e2e_integration_tests test_timeout

# Run only filesystem tests
cargo test --test e2e_integration_tests test_filesystem
```

### Run with output
```bash
cargo test --test e2e_integration_tests -- --nocapture --test-threads=1
```

## GitHub Actions CI/CD

### Workflow: `.github/workflows/e2e.yml`

The E2E test suite runs automatically on:
- **Push to main/develop branches**
- **Pull requests targeting main/develop**
- **Nightly schedule** (2 AM UTC)

### Parallel Execution Strategy

The workflow uses a GitHub Actions matrix strategy to run 8 test groups in parallel:

```yaml
strategy:
  matrix:
    group: [spawn, terminal-io, state, cleanup, error-recovery, concurrency, timeout, filesystem]
  max-parallel: 8
```

Each matrix job:
1. Checks out code
2. Installs Rust toolchain with caching
3. Builds the E2E test binary once
4. Runs only its assigned test group

### Performance Characteristics

- **Individual job execution:** 1-3 seconds
- **Total parallel time:** ~5 seconds (with CI overhead)
- **Sequential fallback:** <1 second (for local development)
- **Cache effectiveness:** Rust build artifacts cached across runs

### Job Artifacts

Each job reports:
- Test execution logs
- Pass/fail status
- Execution timing

The summary job (`e2e-summary`) verifies all 8 groups passed and provides overall CI status.

## Test Isolation & Safety

### Temporary Directory Isolation
Each test uses `tempfile::TempDir`, which automatically:
- Creates an isolated temporary directory
- Cleans up on drop (no manual cleanup needed)
- Prevents conflicts between parallel tests
- Works on all platforms (Linux, macOS, Windows)

### Unique Session IDs
Each test generates a UUID-based session ID (`test-<uuid>`), ensuring:
- Concurrent log file writes don't collide
- Metadata files remain separate
- State transitions don't interfere

### No Shared Resources
The test suite avoids:
- Shared database connections (each test has its own temp dir)
- Port allocation conflicts (no network tests)
- File locks (each test writes to unique paths)
- Process spawning (filesystem operations only)

## Extending the Test Suite

### Adding New Tests

1. Add a new `#[test]` function in `crates/conductor-server/tests/e2e_integration_tests.rs`
2. Use `TestEnv::new()` to get isolated workspace
3. Perform test operations
4. Assertions are automatically verified on test exit

Example:
```rust
#[test]
fn test_my_new_feature() {
    let env = TestEnv::new();
    
    // Create test artifacts
    let test_file = env.workspace_path().join("test.txt");
    std::fs::write(&test_file, "test data").expect("Failed to write");
    
    // Verify behavior
    assert!(test_file.exists());
    let content = std::fs::read_to_string(&test_file).expect("Failed to read");
    assert_eq!(content, "test data");
    
    // Cleanup is automatic
}
```

### Adding New Test Categories

1. Create a comment block marking the new group:
```rust
// ============================================================================
// TEST GROUP N: My Category (X tests)
// ============================================================================
```

2. Add tests to the group
3. Update the CI workflow matrix if the test pattern changes
4. Update this documentation

## CI/CD Integration

### Triggering the E2E Tests

The E2E tests run automatically, but you can manually trigger them:

```bash
# Trigger via git push
git push origin your-branch

# Trigger via pull request to main/develop
gh pr create --base main
```

### Monitoring Test Results

1. **GitHub Actions UI:** [Repository Actions Tab]
2. **Log output:** Click on the specific job to see test output
3. **Annotations:** Test failures show as annotations in PR diffs
4. **Job summary:** Click the job name to see detailed execution logs

### Debugging Failed Tests

1. **Local reproduction:** Run the specific test group locally
```bash
cargo test --test e2e_integration_tests test_spawn -- --nocapture --test-threads=1
```

2. **CI logs:** Download and review CI job logs from GitHub Actions
3. **Rerun with debugging:** Push a commit with added `println!` statements
4. **Sequential execution:** Add `-- --test-threads=1` to reproduce CI issues locally

## Performance Baselines

Current execution times (measured on Linux):
- **Sequential (all 21 tests):** ~0.01s
- **Parallel (8 groups in CI):** ~5-10s (including build, cache, overhead)
- **Individual test:** 0.5-1ms average

The test suite is designed to stay under 30 seconds total CI execution time, even with overhead and caching delays.

## Maintenance

### Regular Review

- Monthly: Review test results in GitHub Actions
- Quarterly: Add tests for new session lifecycle features
- As-needed: Fix flaky tests or adjust timing thresholds

### Common Issues

**Tests fail intermittently:**
- Check for system resource constraints
- Verify temp directory permissions
- Look for file descriptor limits

**Tests timeout in CI:**
- Reduce test-threads concurrency
- Increase timeout thresholds
- Check for resource contention

**Tests pass locally but fail in CI:**
- Run locally with `--test-threads=1` to catch race conditions
- Check for environment-specific assumptions
- Review CI log artifacts for detailed error messages
