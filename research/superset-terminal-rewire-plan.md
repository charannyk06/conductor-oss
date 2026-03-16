# Conductor Terminal Rewire Plan

## Goal

Make Conductor feel terminal-first in the same way Superset does:

- terminals are the primary session surface, not a secondary dashboard widget
- PTY ownership survives UI restarts and reconnects cleanly
- output replay and restore are deterministic
- control and stream traffic never block each other
- agent sessions behave like durable terminals with fast attach, resume, and recovery

This document is the rewrite spec for getting there from the current Conductor architecture.

## Sources Reviewed

- Superset repo: https://github.com/superset-sh/superset
- Superset daemon write-up: https://superset.sh/blog/terminal-daemon-deep-dive
- Superset split-socket plan:
  `apps/desktop/plans/done/20260106-1800-terminal-host-control-stream-sockets.md`
- Superset headless emulator:
  `apps/desktop/src/main/lib/terminal-host/headless-emulator.ts`
- Superset terminal host session:
  `apps/desktop/src/main/terminal-host/session.ts`

## Current-State Review

Conductor already has several Superset-aligned primitives:

- detached runtime prewarm and restore hooks in
  `crates/conductor-server/src/state/detached`
- separate stream and control websocket routes in
  `crates/conductor-server/src/routes/terminal.rs`
- dashboard-side connection/bootstrap negotiation in
  `packages/web/src/app/api/sessions/[id]/terminal`
- a workspace-scoped terminal daemon in
  `packages/cli/src/terminal-daemon.ts`
- live terminal snapshot/state restore coverage in Rust tests

The problem is that these pieces still read like an adaptation layer, not a single architecture. Conductor has most of the mechanics, but the ownership boundaries are still blurry and the product surface is still session-dashboard-first rather than terminal-first.

## Findings

### High

1. `SessionTerminal` is still a product boundary, transport boundary, and UI boundary at the same time.
   Evidence: `packages/web/src/components/sessions/SessionTerminal.tsx:97`
   Impact: terminal rendering, connection policy, resume UX, attachment UX, viewport restore, helper bars, and reconnect behavior are still orchestrated from one large client component. That blocks a true terminal-first shell because pane management, fast attach, and persistent multi-terminal layouts will keep accumulating into the same file.

2. Terminal connection brokerage lives in the Next.js proxy layer instead of in the runtime authority.
   Evidence: `packages/web/src/app/api/sessions/[id]/terminal/shared.ts:239`
   Impact: backend URL inference, remote/local path selection, token fetch, auth downgrades, and fallback policy are encoded in the dashboard server. Superset’s stronger model is that the runtime owns the contract and the UI only consumes a normalized attach plan. Conductor currently has runtime truth split across Rust, Next, and the CLI daemon.

3. Conductor still has two control planes for terminal lifecycle.
   Evidence: `crates/conductor-server/src/state/detached/mod.rs:33`, `packages/cli/src/terminal-daemon.ts:11`
   Impact: the Rust backend restores and manages detached sessions, while the Node daemon is separately responsible for spawning PTY hosts for dashboard bootstrapping. That division is workable but not clean. For a terminal-first product, a single authority should own session runtime state, recovery semantics, and attach metadata.

### Medium

4. The workspace terminal daemon protocol is too narrow to be the long-term runtime contract.
   Evidence: `packages/cli/src/terminal-daemon.ts:11`, `packages/cli/src/terminal-daemon.ts:66`
   Impact: protocol version `1` only covers daemon liveness and `spawn_host`. It is a launcher/host broker, not a terminal session protocol. Superset’s daemon becomes the real terminal runtime boundary. Conductor still relies on Rust route behavior plus ad hoc daemon state files for the full story.

5. Terminal route responsibilities are too broad inside one server module.
   Evidence: `crates/conductor-server/src/routes/terminal.rs:97`
   Impact: auth, token minting, snapshot construction, binary frame encoding, live stream handling, control socket handling, resize, and proxy headers are all implemented in one route module. This makes future changes to attach semantics or remote terminal policy riskier than they need to be.

6. The transport abstraction is improved, but the browser client still carries too much recovery policy.
   Evidence: `packages/web/src/components/sessions/terminal/useTerminalTransport.ts:30`
   Impact: reconnect semantics, fallback choice, stream/control downgrade policy, and renderer recovery are still encoded in React hook logic. The UI should receive a runtime attach plan and mostly execute it, not determine transport strategy itself.

## Target Architecture

The rewrite should converge on five layers.

### 1. Terminal Supervisor

Owner: Rust backend

Responsibilities:

- source of truth for terminal session lifecycle
- maps Conductor session IDs to runtime sessions
- owns attach tokens, auth scope, transport selection, and restore metadata
- persists terminal metadata in SQLite and runtime files
- exposes one normalized bootstrap/attach contract to all clients

This replaces the current split between route-level policy, detached runtime restore, and dashboard-specific connection negotiation.

### 2. Workspace Runtime Daemon

Owner: per-workspace background process

Responsibilities:

- stays alive across dashboard restarts
- owns active PTY hosts for that workspace
- manages stream sockets, control sockets, and backpressure
- keeps runtime-local state files for quick recovery

This should remain process-isolated like Superset’s daemon, but its protocol needs to become the real runtime surface, not only a spawn helper.

### 3. Session Host

Owner: one per live terminal session

Responsibilities:

- PTY subprocess ownership
- headless terminal emulator ownership
- deterministic snapshot and transcript generation
- input queueing, resize queueing, and output batching
- exit/error signaling

This is where Superset’s headless xterm model matters most. Conductor should keep leaning into restore snapshots as first-class runtime state rather than falling back to log-tail reconstruction whenever possible.

### 4. Attach Broker API

Owner: Rust backend

Single normalized contract:

- `GET /terminal/bootstrap`
- returns:
  - session status
  - attach plan
  - stream endpoint
  - control endpoint
  - auth material
  - snapshot metadata
  - replay sequence boundary
  - restore mode

The browser should not assemble this from multiple route-local decisions.

### 5. Terminal Workspace UI

Owner: Next.js web app

Responsibilities:

- pane and tab composition
- xterm instance lifecycle
- focus management
- search, links, clipboard, and file affordances
- status chrome for reconnecting, restored, read-only, or needs-input states

This UI should become a terminal workspace shell, not only a session detail panel.

## Product Shape Changes

The runtime rewire only matters if the product shape also changes.

### Terminal-First Session Surface

- opening a session should land directly in terminal view
- session metadata should be secondary chrome around the terminal
- review/status/history should become side panels or drawers

### Multi-Terminal Workspace

- support multiple open session terminals at once
- allow pinned terminals per project/worktree
- add terminal tabs or split panes
- keep warm terminals mounted for fast switching

### Recovery UX

- explicit restored state with clear affordance to continue or restart
- visible distinction between live, replaying, cold-restored, and read-only
- terminal should never appear blank while state is recoverable

### Agent Interaction UX

- needs-input, stuck, and done should be terminal-native states
- follow-up composer should feel like terminal continuation, not separate app messaging
- attachments and helper actions should inject through the same terminal control path

## Rewrite Phases

### Phase 1: Unify Runtime Contract

- move terminal connection negotiation out of Next route logic into Rust
- make bootstrap the canonical attach contract
- reduce dashboard terminal routes to thin proxy wrappers
- version the runtime attach contract explicitly

Deliverable:
- one backend-owned attach plan used by web and future native clients

### Phase 2: Promote the Daemon

- expand the workspace daemon protocol beyond `spawn_host`
- give the daemon explicit control and stream roles
- make runtime liveness, session mapping, and host state daemon-native
- define mismatch and restart semantics explicitly

Deliverable:
- daemon is the stable runtime boundary, not just a host launcher

### Phase 3: Make Headless State Primary

- require headless terminal state for every live session
- snapshot from the emulator first, logs second
- store sequence boundaries, modes, cwd, dimensions, and restore reason
- treat replay correctness as a contract with tests

Deliverable:
- attach always starts from an authoritative snapshot boundary

### Phase 4: Break Up the Web Client

- split `SessionTerminal` into:
  - terminal shell container
  - transport client
  - xterm runtime adapter
  - session composer rail
  - terminal chrome
- add a layout store for terminal tabs/splits
- keep terminal-specific cache/state outside the page component

Deliverable:
- terminal UI becomes composable enough for multi-pane workspace UX

### Phase 5: Reframe the Product Around Terminal

- make terminal the default session page
- move overview details into side panels
- add workspace terminal tabs and warm attach behavior
- reserve dashboard cards/lists for navigation and monitoring, not primary interaction

Deliverable:
- Conductor feels like a terminal-native agent orchestrator

## Concrete Code Moves

### Backend

- extract `routes/terminal.rs` into:
  - `terminal/bootstrap.rs`
  - `terminal/stream.rs`
  - `terminal/control.rs`
  - `terminal/auth.rs`
  - `terminal/snapshot.rs`
- add a `TerminalSupervisor` state module under `crates/conductor-server/src/state`
- make detached runtime restore and terminal route state depend on the same supervisor API

### CLI Runtime

- evolve `packages/cli/src/terminal-daemon.ts` into a proper runtime daemon protocol
- add explicit client roles and session attach/detach lifecycle
- persist richer runtime metadata than spawn state alone

### Web

- replace route-local connection negotiation in
  `packages/web/src/app/api/sessions/[id]/terminal/shared.ts`
  with a thin backend bootstrap call
- turn `SessionTerminal.tsx` into a small shell that composes focused modules
- add a terminal layout store for tabbed/split sessions

## Acceptance Criteria

The rewire is complete when all of the following are true:

- UI restart does not kill live session terminals
- attach always begins from a deterministic snapshot boundary
- control traffic is never blocked by output streaming
- browser terminal policy is described by one backend bootstrap response
- terminal is the primary session interaction surface
- multiple session terminals can stay warm and switch instantly
- restored sessions clearly differentiate live replay vs cold restore

## Recommended Execution Order

1. Ship the backend-owned bootstrap contract.
2. Promote the workspace daemon into the real runtime contract.
3. Refactor the web terminal into a terminal shell plus layout primitives.
4. Move the session page to terminal-first UX.
5. Add multi-terminal workspace layouts.

## What Not To Do

- do not rewrite around tmux
- do not keep transport policy split permanently across Rust, Next, and the daemon
- do not add more terminal behavior to `SessionTerminal.tsx`
- do not make the dashboard proxy the long-term terminal authority
- do not treat log-tail replay as equal to emulator-backed restore
