# Conductor WebMCP Challenge Spec

## Verdict

Enter Conductor OSS in the 2026 WebMCP Challenge as a meaningfully extended existing product. The new work starts after the August 25, 2026 opening and will be isolated in `feat/webmcp-challenge` until reviewed.

## Product concept

Conductor becomes a shared control surface for a person and a browser agent. The agent receives structured tools for reading workspace state, identifying sessions that need attention, opening the right session, starting bounded work, and sending feedback. The human stays in the visible Conductor dashboard and retains approval over state changes.

## Why this is the strongest fit

- Conductor is already a public, Apache-2.0 agent orchestration product.
- WebMCP removes fragile dashboard clicking from a complex developer workflow.
- The browser agent and coding agents have distinct roles, which makes the collaboration original and easy to demonstrate.
- Existing Conductor API guards remain the authority for real mutations.
- A public synthetic demo lets judges test the tools without access to a private machine or repository.

## Scope

### Public challenge route

Create a public `/webmcp` route that:

- looks and behaves like a focused Conductor workspace
- uses clearly labeled synthetic sessions and diffs
- registers browser native WebMCP tools on `document.modelContext`
- updates the visible UI when tools run
- exposes a tool inspector and sample prompts
- works as a normal interactive web page when WebMCP is unavailable
- never claims a real coding agent ran

### Real dashboard integration

Mount a WebMCP bridge in the real dashboard that:

- lists configured projects and sessions through the existing guarded APIs
- inspects a session and its diff
- opens a selected session in the dashboard
- starts a session only when the tool input contains explicit confirmation
- sends feedback only when the tool input contains explicit confirmation
- preserves bridge scope and backend access controls
- returns bounded, structured, prompt-injection-safe summaries

## Tool contract

Public demo and real dashboard should share stable tool names where practical:

1. `conductor_get_workspace_overview`
2. `conductor_list_sessions`
3. `conductor_inspect_session`
4. `conductor_focus_session`
5. `conductor_start_agent`
6. `conductor_send_feedback`

Read-only tools set `readOnlyHint: true`. Tool output containing project, prompt, branch, or diff text sets `untrustedContentHint: true`. Mutating tools require `confirmed: true` and state the side effect in their descriptions.

## Security constraints

- Prefer the current experimental `document.modelContext` API and support the earlier native `navigator.modelContext` surface for challenge-browser compatibility. No legacy MCP server or extension transport dependency.
- Register tools with an `AbortController` and unregister them on unmount.
- Do not expose terminal keystroke, arbitrary path, arbitrary URL, secret, environment, or deletion tools.
- Keep tool results concise and explicitly mark user or repository text as untrusted data.
- Reuse Conductor action guards, authentication, and bridge scoping. Do not add a bypass route.
- The public demo is in-memory only and resets on reload.

## Acceptance criteria

- Six or more WebMCP tools register on supported Chrome builds.
- The public route remains fully usable without WebMCP support.
- At least one read-only and one mutating tool visibly updates the demo.
- Real dashboard tools call existing guarded API routes and preserve bridge scope.
- Mutating real tools reject calls without explicit confirmation.
- Registration cleanup, tool schemas, confirmation gates, and demo reducers have automated tests.
- Web package tests, typecheck, and production build pass.
- The route is deployed to a public HTTPS URL.
- A public repository contains all submission code.
- A demo video shows discovery, invocation, visible UI updates, and the human approval boundary.

## Delivery

- Branch: `feat/webmcp-challenge`
- Repository: https://github.com/charannyk06/conductor-oss
- Production product: https://app.conductross.com/
- Submission owner: AUTMA LLC
- Deadline: September 3, 2026 at 1:00 p.m. PT
