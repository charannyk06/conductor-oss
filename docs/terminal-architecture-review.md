# Terminal Architecture Review

## Verdict

Yes, the terminal architecture is good enough to keep and harden.

No, the pre-Apr 9 implementation was not yet robust enough.

The right move is:
- keep the iframe surface
- keep ttyd as the PTY web runtime
- keep the backend ttyd facade and bridge relay model
- change the ownership and identity rules around terminal lifecycle

That means the architecture wins or loses on **identity preservation**, not on whether the iframe exists.

## What should remain

### 1. Browser iframe shell
- ttyd already owns xterm, fit, keyboard, clipboard, and PTY rendering well enough
- replacing it would create a large new surface area with little immediate product value

### 2. Backend ttyd facade
- the backend already provides auth, HTML injection hooks, websocket facade, snapshots, and policy control
- this is the right place to own token minting, headers, cookies, and terminal access checks

### 3. Relay bridge model for remote devices
- for paired-device terminals, the relay is still the right boundary
- browser does not need direct access to the device backend
- the relay remains the trust and routing boundary between dashboard and paired device

## What had to change

### Problem 1. UI visibility was treated like terminal death
Hidden tabs and switched sessions were still hitting browser hidden-state behavior or being unmounted too aggressively.

Fixes already landed:
- `bd84ecb` preserve live session surfaces across tab switches
- `1d06921` preserve session surfaces while switching
- `fa3ebf6` keep session terminals stable while inactive

### Problem 2. Token refresh and reconnect looked like terminal replacement
The browser and ttyd auth path could re-resolve connection state too aggressively.

Fix already landed:
- `6638ee9` preserve ttyd identity across reconnects

### Problem 3. Bridge relay ownership was wrong
The relay treated browser disconnect like terminal death. Passive lifecycle events could also mint a fresh relay terminal too eagerly.

Fixes already landed:
- `505b5d1` preserve bridge terminal identity on passive recovery
- relay reattach grace and stable terminal reuse in `conductor-relay`

## Architecture rules going forward

These are the invariants the terminal stack must preserve.

### Rule 1. Terminal identity is separate from auth token identity
- rotating auth must not imply a new terminal
- passive refresh should re-sync auth, not replace the surface

### Rule 2. Terminal identity is separate from React visibility
- inactive session surfaces stay mounted
- hidden terminals do not thrash because status changed elsewhere

### Rule 3. Browser disconnect is not terminal death
- relay-backed terminals get a browser reattach grace window
- during that grace window, the bridge-side proxy stays alive
- browser reconnect should reuse the same terminal identity when possible

### Rule 4. New relay terminals are created only when needed
- passive visibility return should not mint a new relay terminal
- websocket close or error is the correct trigger for active recovery

### Rule 5. Structural changes, not token changes, decide reloads
- URL shape change, session change, or explicit replacement can reload
- token-only changes should stay on the existing surface

## What was implemented in the relay

The relay now:
- stores terminal sessions with explicit `terminal_id` and `session_id`
- reuses an existing detached terminal for the same `user_id + device_id + session_id`
- keeps the bridge-side terminal alive briefly after browser disconnect
- cleans up only if the browser does not reattach within the grace window
- closes the bridge-side proxy only after that grace window expires

## Why this architecture is better

This keeps the current product shape, but fixes the wrong ownership boundaries.

The terminal should feel like a durable object:
- UI can hide and show it
- auth can rotate
- the browser can briefly disconnect
- the network can flap

None of those should imply a new terminal unless the transport actually died.

## What is still not done

This does not yet prove the system is the fastest or unbreakable.

Remaining work:
- live browser soak tests across tab switch, session switch, reload, and sleep/wake
- benchmark time-to-first-prompt and reconnect latency for local and bridge sessions
- instrumentation for iframe reload count, reconnect count, and relay terminal reuse rate
- per-agent startup optimization, Codex, Claude Code, Qwen, OpenCode
- hot session pooling if product data shows startup latency is still the main bottleneck

## Bottom line

The core architecture is worth keeping.

The mistake was not the iframe. The mistake was letting terminal identity leak across UI state, token refresh, and relay ownership boundaries.

That is now the design bar:
- same session should feel like the same terminal
- passive lifecycle events should not create new terminals
- only real transport failure should force explicit recovery
