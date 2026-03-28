# OpenClaw Dispatcher Front Door

## Product goal

OpenClaw is the top-level orchestrator chat surface.
Conductor remains the board, task lifecycle, and ttyd terminal execution engine.

Final UX:
- talk to OpenClaw anywhere
- OpenClaw routes into the right Conductor project dispatcher
- dispatcher manages tasks and board
- task handoff opens real Conductor terminal sessions
- OpenClaw keeps the user updated in chat

## Hard rules

- Regular sessions are terminal-first only, backed by web ttyd PTY
- Dispatcher is the only orchestration surface
- ACP is not a user-facing Conductor product surface
- Board remains the visible execution graph
- OpenClaw owns heartbeat, long-term memory, short-term chat continuity, and proactive messaging

## Conductor responsibilities

- persistent project dispatcher thread
- dispatcher send/feed/interrupt APIs
- explicit dispatcher task lifecycle APIs
  - create task
  - update task
  - handoff task
- board projection of lifecycle state
- launch and observe coding sessions

## OpenClaw responsibilities

- channel and thread ingress
- memory and heartbeat
- project binding to dispatcher thread
- routing user messages to Conductor dispatcher
- streaming or chunked updates back to chat
- notifications for task creation, blocker, handoff, completion

## Required implementation work

### Conductor cleanup
- remove remaining user-facing ACP chat concepts outside dispatcher
- keep dashboard terminal-first for regular sessions
- make dispatcher APIs stable and explicit
- make task lifecycle projection reliable

### OpenClaw integration contract
- bind OpenClaw session/thread to projectId + dispatcher thread id + optional bridge id
- support:
  - GET dispatcher
  - GET dispatcher feed
  - GET dispatcher feed stream
  - POST dispatcher send
  - POST dispatcher interrupt
  - POST dispatcher task create
  - PATCH dispatcher task update
  - POST dispatcher task handoff

### Event model to return to chat
- dispatcher text chunks
- task created
- task updated
- task handed off
- blocker detected
- coding session launched

## Delivery plan

1. Audit and remove stale dispatcher/chat-first UI paths in Conductor
2. Harden dispatcher task lifecycle and board projection
3. Add clean integration contract docs and tests
4. Implement OpenClaw-side dispatcher adapter
5. Add thread-to-project dispatcher binding
6. Add heartbeat-backed status updates and memory summaries
7. Functional smoke test end to end
