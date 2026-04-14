# Obsidian and Markdown Notes Workspace Review

## Verdict

Yes, this feature fits Conductor well.

The right implementation is:
- add a first-class **Notes** workspace mode for each project
- treat Obsidian, Logseq, VS Code, and other filesystem-backed editors as local markdown sources
- save files directly inside the configured notes root
- let **Obsidian Sync** do the sync work if the vault already has it enabled
- wire note files into the existing dispatcher and session attachment pipeline instead of inventing a separate send channel

The wrong move would be trying to build a native Obsidian Sync client inside Conductor. Conductor should own file browsing, editing, and handoff. Obsidian should own vault sync.

## What already exists

### 1. Preferences already know the selected note taker and root

Current fields already exist in config and frontend state:
- `preferences.markdownEditor`
- `preferences.markdownEditorPath`
- `preferences.filesystemBrowseRoots`

Relevant files:
- `crates/conductor-core/src/config.rs`
- `crates/conductor-server/src/routes/config.rs`
- `packages/web/src/hooks/usePreferences.ts`
- `packages/web/src/features/dashboard/components/DashboardDialogs.tsx`

This is important because we do **not** need a new root setting for the first version.

### 2. Settings UI already exposes the notes root picker

The preferences dialog already lets the user choose:
- the markdown editor
- the notes root
- extra filesystem roots

Relevant file:
- `packages/web/src/features/dashboard/components/DashboardDialogs.tsx`

Current behavior:
- Notes Root is hidden only for Notion
- the placeholder already says `Obsidian vault, Logseq graph, or notes folder`

So the product language is already heading in the right direction.

### 3. Conductor already indexes note files for task context

The backend already scans markdown and related files from the notes root and project roots via the context-files route.

Relevant file:
- `crates/conductor-server/src/routes/context_files.rs`

Current behavior:
- resolves markdown root from `markdownEditorPath`
- labels Obsidian files as `vault`
- labels Logseq files as `graph`
- falls back to workspace sources for local editors
- excludes Notion from local markdown discovery
- opens files externally via the chosen editor

This means the discovery logic we need already exists. We should reuse it, not duplicate it.

### 4. Board composer already has a usable context file picker

The board view already loads context files, builds a tree, and lets users attach selected files to tasks.

Relevant file:
- `packages/web/src/components/board/WorkspaceKanban.tsx`

Current behavior:
- loads `/api/context-files?projectId=...`
- supports search
- builds a folder tree
- tracks selected context paths
- opens files externally
- sends selected file paths as task attachments

This is the best existing UI base for a notes picker.

### 5. Dispatcher backend already supports attachments

Relevant file:
- `crates/conductor-server/src/routes/dispatcher.rs`

Current behavior:
- `/api/projects/{project_id}/dispatcher/send` accepts:
  - `message`
  - `attachments`
  - `model`
  - `reasoningEffort`
- user-message attachments already render back into the dispatcher feed

This is a big win. The transport layer is already there.

### 6. Session follow-up backend already supports attachments

Relevant file:
- `crates/conductor-server/src/routes/sessions.rs`

Current behavior:
- `/api/sessions/{id}/send` accepts attachments
- `/api/sessions/{id}/actions` does **not** pass attachments for `action: "send"`

So the terminal/session side is close, but the current UI is hitting the wrong endpoint for attachment-aware follow-ups.

### 7. Session and workspace shell can absorb a new view cleanly

Relevant files:
- `packages/web/src/components/sessions/SessionDetail.tsx`
- `packages/web/src/features/dashboard/DashboardClient.tsx`

Current behavior:
- session detail already has multiple tabs
- project workspace already has view toggles for `Direct launch` and `Board view`

That means we have two valid insertion points:
- a session tab
- a project workspace mode

## What is missing

### 1. No first-class notes workspace

There is no dedicated Notes surface where users can:
- browse markdown notes from the selected notes root
- read and preview them inline
- edit and save them inline
- send them to an agent from one place

### 2. No safe read and write API for project notes

`context_files.rs` lists files and opens them externally, but it does not expose:
- file content read for project notes
- markdown save
- conflict detection
- write permissions / validation for notes roots

### 3. Dispatcher composer drops attachments on send

Relevant file:
- `packages/web/src/components/dispatcher/DispatcherSessionPane.tsx`

Current behavior:
- `sendMessage()` posts only `{ message }`
- no UI state for selected note paths
- no note picker in composer toolbar

The backend supports attachments, the frontend is simply not using them.

### 4. Session terminal follow-up bar drops attachments on send

Relevant file:
- `packages/web/src/components/sessions/SessionTerminal.tsx`

Current behavior:
- current follow-up path posts to `/api/sessions/{id}/actions`
- that path only forwards `message`
- attachment uploads are currently inserted as raw terminal text, not structured follow-up attachments

This is the second major gap.

### 5. Notion is not a local markdown source

Current code already treats Notion differently. That is correct.

For this feature, the first version should support only filesystem-backed note systems:
- Obsidian
- Logseq
- VS Code
- Typora
- generic markdown folder

When `markdownEditor === "notion"`, the UI should show an honest empty state instead of pretending local markdown editing works.

## Product decision

### Add a new project workspace mode called `Notes`

This is the cleanest fit for the request.

Why this is better than only adding a session tab:
- notes belong to the **project**, not just one run
- the selected note taker is configured at the project or user preference level
- users need a stable place to browse and edit notes even before a session exists
- send-to-agent can target either the project dispatcher or a selected session from the same screen

Recommended top-level workspace modes:
- Direct launch
- Board view
- Notes

## Recommended UX

### Project level Notes workspace

Create a new workspace panel that includes:
- left rail: note tree grouped by folders
- center: markdown editor
- optional right pane or toggle: rendered markdown preview
- header actions:
  - Save
  - Open in Obsidian or selected editor
  - Send to Dispatcher
  - Send to Selected Session
  - New Note
  - Refresh

### Empty states

If `markdownEditorPath` is empty:
- show setup CTA to pick Notes Root

If `markdownEditor === "notion"`:
- show “Local markdown notes are only available for filesystem-backed note tools”

### Obsidian-specific behavior

Use Obsidian URI for open actions when possible.

Official Obsidian help confirms support for:
- `obsidian://open?...`
- `obsidian://new?...`
- absolute-path-based open actions

That means the best Obsidian external-open path is:
- try `obsidian://open?path=...`
- fallback to the existing native app open path if needed

### Sync behavior

Do not add a Conductor sync engine.

If the selected notes root is an Obsidian vault and Obsidian Sync is already enabled, Conductor only needs to:
- write the file to disk
- refresh the editor state when the file changes
- optionally display “Synced by Obsidian” helper text

That gives the user the outcome they want without reverse engineering a proprietary sync system.

## Recommended backend design

Create a dedicated project notes router.

### New backend file
- `crates/conductor-server/src/routes/project_notes.rs`

### New routes

#### `GET /api/project-notes?projectId=...`
Returns a project-scoped notes index.

Response should include:
- `editor`
- `notesRoot`
- `files[]`
  - `path`
  - `displayPath`
  - `name`
  - `sizeBytes`
  - `modifiedAt`
  - `source`
  - `kind`
- `writable`

Implementation notes:
- reuse root resolution logic from `context_files.rs`
- filter to markdown-like note files for this view
- prefer `markdownEditorPath`
- fallback to workspace and board roots only for local markdown editors
- keep Notion out of this path

#### `GET /api/project-notes/file?projectId=...&path=...`
Reads a single note file.

Response should include:
- `path`
- `content`
- `size`
- `modifiedAt`
- `truncated`
- `writable`

Guardrails:
- allow only markdown-like files
- validate path is inside allowed roots
- reject binary files
- cap payload size

#### `PUT /api/project-notes/file`
Saves a single note file.

Request body:
- `projectId`
- `path`
- `content`
- `expectedModifiedAt` optional

Response should include:
- `ok`
- `modifiedAt`
- `savedBytes`

Guardrails:
- validate allowed roots
- markdown-like extensions only
- optimistic concurrency check using modified timestamp
- atomic write using temp file + rename

#### `POST /api/project-notes/open`
Opens the note in the external editor.

Implementation notes:
- for Obsidian, prefer Obsidian URI
- fallback to native open command
- reuse current `open_context_file` behavior where possible

### Router registration

Modify:
- `crates/conductor-server/src/routes/mod.rs`
- `crates/conductor-server/src/lib.rs`

## Recommended frontend design

### New web proxy routes

Create:
- `packages/web/src/app/api/project-notes/route.ts`
- `packages/web/src/app/api/project-notes/file/route.ts`
- `packages/web/src/app/api/project-notes/open/route.ts`

These should mirror the existing proxy patterns used by preferences, context-files, and filesystem.

### New Notes workspace component

Create:
- `packages/web/src/components/notes/ProjectNotesWorkspace.tsx`

Responsibilities:
- fetch note index
- manage selected file
- load file content
- save file content
- trigger external open
- send selected note to dispatcher or session

### Extract shared file tree and viewer helpers

The current codebase already has reusable pieces in two places:
- `SessionOverview.tsx` for file tree + inline preview
- `WorkspaceKanban.tsx` for context note selection and tree search

Recommended shared components:
- `packages/web/src/components/notes/NotesFileTree.tsx`
- `packages/web/src/components/notes/NotesMarkdownEditor.tsx`
- `packages/web/src/components/notes/NotesPreviewPane.tsx`
- `packages/web/src/components/notes/NotesSendToolbar.tsx`

This keeps the new feature from bloating `WorkspaceKanban.tsx` or `SessionOverview.tsx` further.

### Wire project workspace mode into dashboard

Modify:
- `packages/web/src/features/dashboard/DashboardClient.tsx`

Changes:
- extend `DashboardWorkspaceView` to include `notes`
- extend query param handling for `view=notes`
- add Notes button next to Direct launch and Board view
- render `ProjectNotesWorkspace` when notes mode is active

### Optional session tab, later not first

A session-level Notes tab is nice, but it is not required for the first implementation.

The first version should ship the project-level Notes workspace first.

If a session tab is added later, it should reuse the same `ProjectNotesWorkspace` component and just preselect the current project.

## Send-to-agent plan

### Dispatcher send

Modify:
- `packages/web/src/components/dispatcher/DispatcherSessionPane.tsx`
- possibly `packages/web/src/components/dispatcher/DispatcherPane.tsx`

Changes:
- add selected note attachment state in the composer
- extend `sendMessage()` to post `{ message, attachments }`
- use `composerToolbar` to host a note picker or selected-note chips
- preserve current message-only behavior when no attachments are selected

This is low risk because the backend already supports it.

### Session follow-up send

Modify:
- `packages/web/src/components/sessions/SessionTerminal.tsx`
- `packages/web/src/components/sessions/RemoteSessionTerminalImpl.tsx`

Changes:
- stop using `/api/sessions/{id}/actions` for attachment-aware follow-up sends
- use `/api/sessions/{id}/send` instead
- add selected note attachment state beside the existing prompt input
- keep file upload support, but treat note-path sends as structured attachments, not pasted terminal text

This is the cleanest path because the backend route already supports attachments.

### Board to agent handoff

No major backend change needed.

The Notes workspace can send selected note paths to:
- the current project dispatcher via `/api/projects/{projectId}/dispatcher/send`
- a selected task session via `/api/sessions/{id}/send`

This keeps one attachment format everywhere: absolute file paths.

## Implementation tasks

### Task 1. Add backend notes routes

Files:
- Create `crates/conductor-server/src/routes/project_notes.rs`
- Modify `crates/conductor-server/src/routes/mod.rs`
- Modify `crates/conductor-server/src/lib.rs`

Deliverables:
- notes list route
- note read route
- note save route
- note external-open route
- allowed-root tests
- markdown-only save tests
- conflict detection tests

### Task 2. Add web proxy routes

Files:
- Create `packages/web/src/app/api/project-notes/route.ts`
- Create `packages/web/src/app/api/project-notes/file/route.ts`
- Create `packages/web/src/app/api/project-notes/open/route.ts`

Deliverables:
- guarded proxy wrappers for viewer and operator actions

### Task 3. Build Notes workspace UI

Files:
- Create `packages/web/src/components/notes/ProjectNotesWorkspace.tsx`
- Create `packages/web/src/components/notes/NotesFileTree.tsx`
- Create `packages/web/src/components/notes/NotesMarkdownEditor.tsx`
- Create `packages/web/src/components/notes/NotesPreviewPane.tsx`

Deliverables:
- file tree
- markdown editor
- preview toggle
- save flow
- refresh flow
- empty states for no notes root and Notion

### Task 4. Add Notes workspace mode to dashboard

Files:
- Modify `packages/web/src/features/dashboard/DashboardClient.tsx`

Deliverables:
- `view=notes`
- workspace toggle button
- project-scoped notes panel rendering

### Task 5. Wire send-to-dispatcher and send-to-session

Files:
- Modify `packages/web/src/components/dispatcher/DispatcherSessionPane.tsx`
- Modify `packages/web/src/components/dispatcher/DispatcherPane.tsx`
- Modify `packages/web/src/components/sessions/SessionTerminal.tsx`
- Modify `packages/web/src/components/sessions/RemoteSessionTerminalImpl.tsx`

Deliverables:
- attachment chips in dispatcher composer
- note picker action in composer toolbar
- terminal follow-up send path switched to `/send`
- selected note attachments included in request payloads

### Task 6. Polish external open behavior

Files:
- Modify `crates/conductor-server/src/routes/project_notes.rs`
- possibly factor helpers from `crates/conductor-server/src/routes/context_files.rs`

Deliverables:
- Obsidian URI open support
- fallback to native open
- consistent open behavior across editors

## Exact behavior rules

### Rule 1. Notes are project-scoped
The notes workspace should resolve from the selected project, not from the currently selected session only.

### Rule 2. Filesystem-backed editors only
If the selected editor is Notion, show an unsupported state for local markdown editing.

### Rule 3. Conductor writes files, Obsidian Sync syncs files
Conductor should not try to become a sync engine.

### Rule 4. One attachment model everywhere
When a note is sent to an agent, the payload should always be a normal attachment path, not a special note object.

### Rule 5. Safe writes only
All note saves must stay inside allowed roots and use optimistic concurrency.

## Risks and how to avoid them

### Risk 1. Editing a stale file and overwriting Obsidian changes
Mitigation:
- return `modifiedAt`
- require `expectedModifiedAt` on save
- show reload prompt on conflict

### Risk 2. Path traversal outside the notes root
Mitigation:
- reuse canonical allowed-root checks from `context_files.rs`
- reject non-markdown writes

### Risk 3. Treating Notion like a folder
Mitigation:
- explicit Notion empty state
- no fake support in v1

### Risk 4. Duplicating tree logic in three places
Mitigation:
- extract shared notes tree components instead of copying `WorkspaceKanban.tsx`

## Fastest reliable MVP

If we want the quickest correct version, ship this first:
- project-level Notes workspace only
- read and save markdown files from `markdownEditorPath`
- open externally in Obsidian or chosen editor
- send selected note paths to dispatcher and session routes as attachments
- no native sync logic
- no session-level Notes tab yet
- no Notion support yet

That gets the user-visible feature out fast without digging a bad abstraction hole.

## Verification checklist

Run:
- `bun run typecheck`
- `bun run test:packages`
- `cargo test --workspace`

Manual QA:
- set editor to Obsidian and choose a vault root
- switch project workspace to Notes
- open, edit, and save a markdown file
- verify the file changes on disk and in Obsidian
- send the note to project dispatcher and confirm attachment appears in feed
- send the note to a task session and confirm attachment is preserved
- repeat with Logseq or generic markdown folder
- verify Notion shows the unsupported local-notes state

## Bottom line

Conductor already has 70 percent of this feature.

The missing 30 percent is not deep infrastructure. It is mostly:
- a dedicated Notes workspace
- safe note read and write routes
- attachment-aware composer UI for dispatcher and session follow-ups

If we build it this way, the feature will feel native to Conductor and will stay aligned with the product's markdown-first architecture.