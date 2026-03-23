# Conductor Skills Marketplace and Session Skills Tab, PRD v1

**Date:** Mar 22, 2026  
**Status:** Planning, ready for phased implementation  
**Primary goal:** Add a Skills experience to Conductor that lets users discover, install, detect, and activate agent-specific skills from the dashboard, with a session-level Skills tab placed next to Preview.

---

## 1. Executive Summary

Conductor already has:
- a dashboard with session detail views
- paired-device execution via the bridge
- an Agents surface with known-agent metadata
- bridge-aware APIs that can run work on the selected machine

What is missing is a first-class way to manage **skills** for coding agents.

This PRD proposes two connected UX surfaces:

1. **Session Skills Tab**, placed next to **Preview** in the session detail view  
   This is the operational surface. Users use it to install a skill if needed, or activate an already-installed skill for the current session.

2. **Skills Marketplace management surface**, inside dashboard settings or agent management  
   This is the discovery and lifecycle surface. Users browse the catalog, inspect compatibility, review installed skills, uninstall, and update.

The key product behavior is:
- If the user clicks a skill for the current session and it is **already installed**, Conductor should **activate** it for the current session immediately.
- If the user clicks a skill and it is **not installed**, Conductor should **install it on the paired device for the selected agent**, then **activate it for the current session automatically**.
- The UI must **detect previously installed skills** and show correct state.

This PRD is written for a coding agent. It is intentionally explicit, phase-oriented, and split into merge-safe slices.

---

## 2. Product Problem

Today Conductor lets users choose agents, models, workspaces, and sessions, but it does not provide a native concept of reusable **skills**.

That creates several problems:
- users cannot discover task-specific capabilities in-product
- users cannot see which skills are already installed for a given agent or machine
- there is no safe, unified install flow for skills on the paired device
- users cannot activate skill context for a session without manual file or prompt work
- agent-specific skill ecosystems are invisible and fragmented

We want Conductor to become the place where a user can:
- see available skills
- install a skill to the right machine and agent
- see if it is already installed
- activate it for a session in one click

---

## 3. Product Decision Summary

### 3.1 Session placement
Add a new **Skills** tab in `SessionDetail`, immediately next to **Preview**.

Target order:
- Overview
- Terminal
- Preview
- Skills

Rationale:
- Preview and Skills are both session-contextual surfaces
- skills are most useful when tied to the active session, device, agent, and workspace
- users should not have to leave the current session to use a skill

### 3.2 Installation behavior
Clicking a skill should not just open docs or show commands. Conductor should handle the install path through its own backend.

Behavior:
- **Already installed**: activate skill for current session
- **Not installed**: install skill on paired device, then activate for current session

Do **not** make the user copy raw shell commands into the session terminal as the primary flow.

### 3.3 Installed-state detection
Yes, Conductor must detect previously installed skills.

At minimum the UI needs these states:
- Available
- Installed
- Active in this session
- Update available
- Unsupported for selected agent
- Broken install or needs repair

### 3.4 Safety posture for v1
Start curated, not open-ended.

V1 supports:
- curated catalog entries only
- no arbitrary postinstall scripts
- no public marketplace publishing
- no user-generated executable packages
- install on paired machine only
- install through agent adapter contracts only

---

## 4. Goals

### 4.1 Primary goals
- Add a **Skills** tab next to **Preview** in session detail
- Add a curated **Skills Marketplace** concept to Conductor
- Detect installed skills for the selected device and coding agent
- Let users install a skill to the paired machine from the dashboard
- Let users activate a skill for the current session
- Make install and activation feel like a single flow
- Support phased implementation with low merge conflict risk

### 4.2 Secondary goals
- Show compatibility by coding agent
- Track install scope, user or workspace
- Support reinstall and uninstall
- Support repair for missing or drifted installs
- Make room for future updates and versioning

---

## 5. Non-Goals for v1

Do not build these in v1:
- public skill publishing
- ratings, likes, reviews, comments
- arbitrary shell hook execution
- arbitrary external package installation without curation
- cross-user team skill sharing
- mobile-first UX
- install inside the visible terminal pane as the canonical implementation path
- multi-agent skill activation in one session at the same time

---

## 6. User Stories

### 6.1 Session user story
As a user viewing an active session, I want to open a Skills tab next to Preview, choose a skill, and have Conductor either install it if needed or activate it immediately for the current session.

### 6.2 Discovery user story
As a user exploring Conductor capabilities, I want a marketplace-like catalog of skills with compatibility, install state, and install scope, so I can understand what exists and what will work with my selected agent.

### 6.3 Recovery user story
As a user returning to a device later, I want Conductor to detect previously installed skills automatically so I do not reinstall blindly or guess what is available.

### 6.4 Safety user story
As a user, I want installs to happen through Conductor-managed flows on the paired device so I do not run random scripts manually.

---

## 7. Core Concepts

### 7.1 Catalog skill
A curated skill entry published in a Conductor-managed registry.

### 7.2 Installed skill
A skill that exists on a specific device for a specific agent and scope.

### 7.3 Active skill
An installed skill that is attached to the current session.

### 7.4 Skill scope
- `session`: active for one session only
- `workspace`: installed for one workspace or repo
- `user`: installed for all sessions for that agent on the device

### 7.5 Agent adapter
Agent-specific install and activation logic. Not every coding agent will use the same skill directory or activation method.

---

## 8. UX Overview

## 8.1 Session Skills tab
Add a new tab to `packages/web/src/components/sessions/SessionDetail.tsx`.

### Session tab header context
Show the current execution context clearly:
- Device: `Mac`, `Windows Laptop`, etc.
- Agent: `Codex`, `Claude Code`, etc.
- Workspace: current repo or worktree path
- Scope selector: Session, Workspace, User

### Main content sections
1. **Search and filters**
   - search input
   - category filter
   - verified only toggle
   - installed only toggle
   - compatible only toggle

2. **Skill cards**
   Each card shows:
   - icon
   - title
   - one-line description
   - compatibility badges
   - installed badge
   - active badge
   - update available badge if applicable

3. **Primary action per card**
   - `Install and use`
   - `Use in this session`
   - `Installed`
   - `Update`
   - `Repair`
   - `Unsupported`

4. **Details drawer or side panel**
   - long description
   - version
   - screenshots or examples, future-ready
   - supported agents
   - install scope selector
   - docs link
   - install logs if current action is running

## 8.2 Marketplace management surface
Add a global marketplace management surface later under Agents or Settings.

Purpose:
- browse all skills outside the current session
- manage installed skills
- uninstall or reinstall
- review version state
- inspect support matrix

This can start as a dialog or dashboard subsection, not necessarily a separate route in v1.

---

## 9. Exact UX Behavior

### 9.1 When user clicks a skill card

#### Case A, skill already installed and healthy
- Conductor does not reinstall
- skill becomes active for current session
- card updates to show `Active now`
- optional session event is added: `Skill Repo Reviewer activated for this session`

#### Case B, skill not installed
- Conductor starts an install job on the paired device
- progress is visible in the Skills tab
- on success, Conductor auto-activates the skill for the current session
- card updates to `Installed` plus `Active now`

#### Case C, no paired device
- disable install and activation actions
- show clear empty state: `Pair a device to install and use skills`

#### Case D, unsupported agent
- disable action
- show supported-agent badges and `Unsupported for selected agent`

#### Case E, broken install
- show `Repair`
- repair runs adapter verification and reinstall path if needed

### 9.2 Session state versus install state
These must be separate.

A skill can be:
- installed but not active
- active in this session
- installed globally but not for this workspace
- installed on Mac but not on Windows

Do not collapse these into one boolean.

---

## 10. Data Model

## 10.1 Catalog entry
Suggested JSON and Rust shape:

```json
{
  "id": "repo-reviewer",
  "name": "Repo Reviewer",
  "summary": "Code review checklist and repo inspection prompts",
  "description": "Longer description",
  "author": "Conductor",
  "homepage": "https://...",
  "docsUrl": "https://...",
  "iconUrl": "https://...",
  "categories": ["code-review", "engineering"],
  "compatibleAgents": ["codex", "claude-code"],
  "installMode": "files",
  "source": {
    "kind": "zip",
    "url": "https://.../repo-reviewer.zip",
    "checksumSha256": "..."
  },
  "verified": true,
  "defaultScope": "workspace",
  "latestVersion": "1.0.0"
}
```

Rust structs to introduce:
- `SkillCatalogEntry`
- `SkillSource`
- `SkillInstallMode`
- `SkillCompatibility`
- `SkillScope`

## 10.2 Installed skill record
Stored per device and agent.

Fields:
- `skillId`
- `agent`
- `deviceId`
- `scope`
- `workspacePath`, nullable for user scope
- `installedVersion`
- `installedAt`
- `installPath`
- `status`, installed, broken, pending, uninstalling
- `lastVerifiedAt`
- `activeSessions`, optional derived field

Rust struct:
- `InstalledSkillRecord`

## 10.3 Session skill state
Session-local activation state.

Fields:
- `sessionId`
- `skillId`
- `agent`
- `deviceId`
- `activationScope`
- `activatedAt`
- `deactivatedAt`, nullable

---

## 11. API Contract

All APIs should be bridge-aware and operate on the selected paired device.

### 11.1 Read APIs
- `GET /api/skills/catalog`
- `GET /api/skills/installed?deviceId=...&agent=...&workspacePath=...`
- `GET /api/skills/session-active?sessionId=...`
- `GET /api/skills/install-status?jobId=...`

### 11.2 Mutating APIs
- `POST /api/skills/install`
- `POST /api/skills/uninstall`
- `POST /api/skills/activate`
- `POST /api/skills/deactivate`
- `POST /api/skills/repair`

### 11.3 Install request shape
```json
{
  "skillId": "repo-reviewer",
  "agent": "codex",
  "deviceId": "device-123",
  "scope": "workspace",
  "workspacePath": "/path/to/repo",
  "activateForSessionId": "session-456"
}
```

### 11.4 Install response shape
```json
{
  "ok": true,
  "jobId": "skill-install-123",
  "status": "queued"
}
```

### 11.5 Activation request shape
```json
{
  "sessionId": "session-456",
  "skillId": "repo-reviewer",
  "agent": "codex",
  "deviceId": "device-123"
}
```

---

## 12. Backend Architecture

## 12.1 New route family
Add a new route module in server:
- `crates/conductor-server/src/routes/skills.rs`

This module should own:
- catalog read
- installed-skill read
- install job creation
- uninstall job creation
- activation state handling
- repair job creation

## 12.2 Bridge requirement
Skill installation happens on the paired device, not on the browser host.

Flow:
1. dashboard calls server API
2. server validates session, device, agent, scope
3. server sends install request through bridge-aware execution path
4. paired device runs adapter-specific install
5. result stored and returned
6. session activation updated if requested

## 12.3 Job model
Install and uninstall should be jobs, not blocking inline requests.

Need:
- `queued`
- `running`
- `succeeded`
- `failed`
- progress log or progress events

The web UI should poll job state initially. Streaming can come later.

---

## 13. Agent Adapter Contract

Do not hardcode one universal install directory.

Create an adapter layer with a trait or equivalent interface.

### 13.1 Required adapter methods
- `supports_skills()`
- `supported_scopes()`
- `install_skill()`
- `uninstall_skill()`
- `verify_skill()`
- `list_installed_skills()`
- `activate_skill_for_session()`
- `deactivate_skill_for_session()`

### 13.2 v1 supported agents
- `codex`, required
- `claude-code`, optional phase 5

For unsupported agents, catalog entries should remain visible but disabled when incompatible.

### 13.3 Adapter behavior contract
Each adapter must define:
- install location
- file layout
- how activation works for a session
- how verification works
- whether workspace scope is supported
- whether user scope is supported

---

## 14. Catalog and Package Rules

## 14.1 Catalog source
Use a curated registry in v1.

Recommended implementation:
- versioned JSON catalog checked into Conductor repo or fetched from a trusted hosted source
- checksum required for downloadable payloads

## 14.2 Package rules
Each skill package contains:
- `skill.json`
- prompt or content files
- optional templates
- optional metadata assets

Do not allow arbitrary executable install hooks in v1.

## 14.3 Verification
Every install must validate:
- supported agent
- supported scope
- source checksum if remote archive
- expected file layout after unpacking

---

## 15. Session Integration

The current session surface is the most important UX.

## 15.1 `SessionDetail` changes
In:
- `packages/web/src/components/sessions/SessionDetail.tsx`

Add:
- new tab key: `skills`
- new dynamic import for `SessionSkills`
- new tab trigger next to Preview
- URL state support, `?tab=skills`

## 15.2 New `SessionSkills` component
Create:
- `packages/web/src/components/sessions/SessionSkills.tsx`

Responsibilities:
- read current session context
- resolve active device and agent
- fetch catalog and installed state
- render skill cards
- show install status
- trigger install and activation
- show empty states and errors

## 15.3 New hooks
Create:
- `packages/web/src/hooks/useSkillsCatalog.ts`
- `packages/web/src/hooks/useInstalledSkills.ts`
- `packages/web/src/hooks/useSessionSkills.ts`
- `packages/web/src/hooks/useSkillInstallJob.ts`

These should be thin and composable.

---

## 16. UX States

Every card must support these states:
- `available`
- `installing`
- `installed`
- `active`
- `unsupported`
- `broken`
- `update-available`

Every page must support these empty states:
- no paired device
- no compatible agent
- no skills found
- install job failed
- session missing workspace context

---

## 17. Telemetry and Logging

Minimum event trail to support supportability:
- skill install started
- skill install succeeded
- skill install failed
- skill uninstall succeeded
- skill activation succeeded
- skill activation failed
- repair started
- repair succeeded or failed

Do not block v1 on full analytics. Internal logs are enough.

---

## 18. Security Requirements

Required:
- curated catalog only
- checksum validation for archives
- install only on paired device
- role check before install or uninstall
- no arbitrary postinstall shell hooks in v1
- install path must stay inside adapter-approved directories
- uninstall must only remove adapter-owned files

Not required in v1:
- sandboxing every file write in a separate VM
- public trust network or signing chain

---

## 19. Merge-Safe Implementation Plan

This section is deliberately written for a coding agent that needs isolated, low-conflict phases.

## Phase 0, planning and type scaffolding

### Goal
Introduce shared types without changing the UI yet.

### Files owned by this phase
Backend:
- `crates/conductor-server/src/routes/skills.rs`, new
- `crates/conductor-server/src/routes/mod.rs` or equivalent router registration file
- `crates/conductor-core/src/...`, only if shared types truly belong there

Web:
- `packages/web/src/app/api/skills/...`, new proxy routes only
- `packages/web/src/lib/skills/types.ts`, new

### Deliverables
- route skeletons returning stub data
- shared TypeScript types
- Rust types for catalog and installed skill record

### Acceptance criteria
- project builds
- no visible UI yet
- `GET /api/skills/catalog` returns stub curated list
- `GET /api/skills/installed` returns empty list safely

### Merge safety
This phase must not touch session UI files.

---

## Phase 1, session tab shell

### Goal
Add the Skills tab next to Preview with static placeholder content.

### Files owned by this phase
- `packages/web/src/components/sessions/SessionDetail.tsx`
- `packages/web/src/components/sessions/SessionSkills.tsx`, new

### Deliverables
- new `skills` tab in session detail
- URL support for `?tab=skills`
- placeholder panel that shows device, agent, and workspace context

### Acceptance criteria
- Skills tab renders without breaking existing tabs
- session navigation works on refresh
- no real install behavior yet

### Merge safety
This phase should not touch backend logic and should not edit dashboard agent-management dialogs.

---

## Phase 2, catalog read and installed-state read

### Goal
Populate the Skills tab with catalog entries and installed-state badges.

### Files owned by this phase
Backend:
- `crates/conductor-server/src/routes/skills.rs`

Web:
- `packages/web/src/hooks/useSkillsCatalog.ts`, new
- `packages/web/src/hooks/useInstalledSkills.ts`, new
- `packages/web/src/components/sessions/SessionSkills.tsx`
- `packages/web/src/lib/skills/types.ts`

### Deliverables
- curated catalog in UI
- installed badge detection
- compatibility filtering against current session agent

### Acceptance criteria
- unsupported skills clearly disabled
- installed skills detected and shown
- no mutation yet

### Merge safety
Do not modify bridge install or agent install code in this phase.

---

## Phase 3, install job backend, Codex adapter only

### Goal
Install a curated skill for Codex on the paired device.

### Files owned by this phase
Backend:
- `crates/conductor-server/src/routes/skills.rs`
- `crates/conductor-server/src/skills/...`, new folder for adapters and install logic
- bridge-aware execution path files, only where absolutely necessary

Web:
- `packages/web/src/hooks/useSkillInstallJob.ts`, new
- `packages/web/src/components/sessions/SessionSkills.tsx`

### Deliverables
- install job request
- Codex adapter
- install progress and success or failure states

### Acceptance criteria
- install creates persisted installed-state record
- install runs only when paired device exists
- install fails cleanly with user-readable error if adapter rejects scope

### Merge safety
Do not add Claude adapter in this phase. Codex only.

---

## Phase 4, auto-activate for session

### Goal
If install succeeds, activate skill automatically for current session. If already installed, activate without reinstall.

### Files owned by this phase
Backend:
- `crates/conductor-server/src/routes/skills.rs`
- session-state helpers if needed

Web:
- `packages/web/src/hooks/useSessionSkills.ts`, new
- `packages/web/src/components/sessions/SessionSkills.tsx`

### Deliverables
- `Install and use`
- `Use in this session`
- active badge
- deactivate action if needed

### Acceptance criteria
- installed skill activates without reinstall
- install then auto-activate works
- active state persists on refresh for session metadata if designed that way

### Merge safety
Do not add marketplace management UI yet.

---

## Phase 5, management surface and Claude adapter

### Goal
Add a separate marketplace or management surface and second agent adapter.

### Files owned by this phase
- `packages/web/src/features/dashboard/...`, only new files or new isolated subsection
- `packages/web/src/components/agents/...`, only if needed for marketplace entry
- backend adapter files for Claude Code

### Deliverables
- installed skill management list
- uninstall
- repair
- Claude Code support

### Acceptance criteria
- uninstall works
- reinstall works
- second supported agent works without regressing Codex

### Merge safety
Keep session skills tab logic mostly stable. Add management UI in separate files.

---

## Phase 6, update detection and repair

### Goal
Detect version drift and broken installs.

### Deliverables
- update available badge
- repair action
- verify-on-open or verify-on-demand

### Acceptance criteria
- broken install does not masquerade as healthy
- repair can restore expected file layout

---

## 20. File Ownership Plan to Minimize Conflicts

This matters for multi-PR parallel work.

### Session UI files, reserved mainly for session features
- `packages/web/src/components/sessions/SessionDetail.tsx`
- `packages/web/src/components/sessions/SessionSkills.tsx`
- `packages/web/src/hooks/useSessionSkills.ts`

### Marketplace management files, reserved for dashboard-level skill management
- `packages/web/src/features/dashboard/components/SkillsMarketplace.tsx`, new
- `packages/web/src/features/dashboard/components/InstalledSkillsPanel.tsx`, new
- avoid editing `DashboardDialogs.tsx` unless absolutely required

### Backend skill domain files
- `crates/conductor-server/src/routes/skills.rs`
- `crates/conductor-server/src/skills/catalog.rs`, new
- `crates/conductor-server/src/skills/install.rs`, new
- `crates/conductor-server/src/skills/adapters/mod.rs`, new
- `crates/conductor-server/src/skills/adapters/codex.rs`, new
- `crates/conductor-server/src/skills/adapters/claude_code.rs`, new later

### Shared type files
- `packages/web/src/lib/skills/types.ts`
- `packages/web/src/lib/skills/catalog.ts`, new if needed

Prefer adding new files over expanding giant existing files.

---

## 21. Coding Agent Instructions

The coding agent should follow these rules:

1. Do not implement all phases in one PR
2. Keep each phase mergeable and testable on its own
3. Prefer new files over invasive edits to giant files
4. Do not add public publishing or arbitrary script hooks in v1
5. Do not assume all agents support the same install path
6. Implement Codex first
7. Treat installed-state and active-state as separate concepts
8. Route installation to the paired device, never to the browser host
9. Keep the session Skills tab usable even when marketplace management UI is not built yet
10. Add tests for new API behavior and critical install-state transitions

---

## 22. Open Questions

These should be answered before Phase 3 if possible:

1. Where should the curated catalog live in v1, repo file or hosted JSON?
2. Does Codex already have a stable local skill directory contract we can depend on?
3. Should session activation be persisted in server session metadata or derived at runtime?
4. For workspace scope, what exact repo path identity should be used, path string, repo root, or project id?
5. Should uninstall be available from the session tab, or only from marketplace management?
6. Do we want install logs inline in the card, or in a side panel?

---

## 23. Acceptance Criteria for the Full V1

V1 is complete when all of the following are true:
- session view has a Skills tab next to Preview
- current device, agent, and workspace context are visible in that tab
- curated catalog loads successfully
- compatible skills are filterable and installable
- installed skills are detected automatically
- clicking an already-installed skill activates it for the session without reinstall
- clicking a not-installed skill installs it and auto-activates it for the session
- no paired device blocks install with a clear message
- unsupported agents are shown correctly and cannot be installed against
- uninstall and repair are possible at least in management UI or later phase if explicitly deferred
- install logic is adapter-based, not hardcoded globally

---

## 24. Recommended First PR Sequence

If you want the safest sequence for real work, do it like this:

1. PR A, types plus stub APIs  
2. PR B, session Skills tab shell  
3. PR C, catalog plus installed detection  
4. PR D, Codex install job  
5. PR E, session activation flow  
6. PR F, management UI  
7. PR G, repair plus update detection  
8. PR H, Claude adapter

That sequence minimizes merge conflicts and keeps every PR small enough to review.

---

## 25. Final Recommendation

Build this **session-first**, not marketplace-first.

That means:
- put Skills next to Preview first
- make click-to-install-or-activate the primary interaction
- detect previously installed skills from day one
- keep catalog curated and adapter-based
- add the broader marketplace management surface after the session loop is proven

This gives Conductor the fastest path to a feature that feels magical without being sloppy.
