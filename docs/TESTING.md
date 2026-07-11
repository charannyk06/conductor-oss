# E2E testing

Conductor's dedicated server E2E target is
`crates/conductor-server/tests/e2e_integration_tests.rs`. It currently exercises
three real HTTP/runtime paths:

- Prometheus metrics serialization
- Failed-spawn persistence and error-health reporting
- A live `ttyd` session from spawn through input, output, and kill

The surrounding server integration tests cover boards, project notes, session
state, spawn context, and terminal validation in their own test targets. The
workspace unit suite supplies the lower-level lifecycle, parser, persistence,
and security-boundary coverage.

## Run locally

From the repository root:

```bash
cargo test --workspace
```

To run only the dedicated E2E target exactly as CI does:

```bash
cd crates/conductor-server
cargo test --test e2e_integration_tests -- --test-threads=1
```

Add `--nocapture` after `--` when diagnosing a failure:

```bash
cargo test --test e2e_integration_tests -- --test-threads=1 --nocapture
```

## CI behavior

`.github/workflows/e2e.yml` runs the complete target without name filters on:

- Pull requests targeting `main`
- Pushes to `main`
- The nightly 02:00 UTC schedule

The job deliberately runs one test target instead of a matrix of name filters.
This makes a renamed or removed test visible in the reported test count rather
than allowing an empty filtered job to pass.

## Test-process cleanup

Production `ttyd` processes are detached so they can survive a backend restart.
Test harnesses explicitly enable child kill-on-drop before spawning sessions.
That distinction prevents authenticated test listeners from surviving Tokio
runtime teardown without weakening production session restoration.

When adding an integration test:

1. Use the shared `tests/common.rs` harness for isolated state and cleanup.
2. Assert the externally observable behavior, not only an implementation detail.
3. Kill or archive live sessions before the test returns when the behavior under
   test includes explicit lifecycle cleanup.
4. Run the full target and confirm the printed test count increased.
