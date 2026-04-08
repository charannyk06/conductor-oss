# Terminal Performance Overhaul: Kill ttyd Middleman

## Goal
Make the terminal lightning fast. Remove the ttyd binary dependency entirely. Use direct PTY streaming through Rust.

## Current Architecture (SLOW)
Browser iframe -> Next.js proxy -> Rust backend proxy -> ttyd process -> PTY
3 process hops, HTML shim injection, 60s token refreshes, broadcast drops.

## Target Architecture (FAST)
Browser iframe -> Rust WS endpoint -> PTY (direct, no ttyd)
2 hops max. Static HTML in the iframe. Direct PTY ownership.

## What Changes

### 1. Replace ttyd_launcher.rs with direct PTY launcher
File: crates/conductor-server/src/state/detached/ttyd_launcher.rs

Current: spawns ttyd binary, connects upstream WS to it, proxies through.
New: spawn the agent binary directly inside a PTY owned by Rust. Use portable-pty (already a dep). No ttyd binary at all.

The key functions to rewrite:
- spawn_ttyd_runtime() -> spawn the agent directly in a PTY using spawn_process_with_pty_size_and_env_removals() from conductor_executors::process
- restore_ttyd_runtime() -> check PID alive, mark completed if not
- Remove: resolve_ttyd_binary(), ttyd_missing_error(), wait_for_ttyd_startup(), run_ttyd_session_owner(), run_ttyd_session_owner_with_retry(), reserve_ttyd_port(), build_ttyd_shell_args(), build_agent_launch_command(), resolve_interactive_shell()

### 2. Create static terminal HTML endpoint
Serve a static HTML page with xterm.js that connects to the backend WS directly.
The HTML includes xterm.js CDN, xterm-addon-fit, and implements the ttyd binary protocol.

### 3. Remove shim injection from terminal.rs
Remove ALL shim constants and injection functions.

### 4. Token TTL from 60 to 600 seconds.

### 5. Frontend simplification
Remove burst resize timers, token postMessage dance, simplify to single debounced resize.

## KEY: spawn_process_with_pty_size_and_env_removals() in conductor-executors/src/process.rs ALREADY does what we need. USE IT.
