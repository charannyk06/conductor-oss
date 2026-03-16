# Conductor + Superset Terminal Architecture Integration

## Executive Summary

This document outlines the integration of Superset's terminal and workspace isolation patterns into Conductor OSS. Conductor already has a sophisticated terminal infrastructure (PTY subprocess, WebSocket streaming, xterm.js UI) that exceeds Superset's capabilities in many areas. This integration focuses on adding Superset's unique features: worktree isolation, multi-pane UI, and workspace presets.

## Current State Analysis

### Conductor's Existing Terminal Stack (Production-Ready)

**Rust Backend (`crates/conductor-server/src/state/`):**
- `terminal_supervisor.rs` - Token auth, connection management, 649 lines
- `terminal_hosts.rs` - Host registry, session lifecycle, 301 lines
- `pty_subprocess.rs` - Binary framing protocol (matches Superset exactly)
- `terminal_history.rs` - Terminal capture and persistence
- `terminal_escape_filter.rs` - Escape sequence handling

**Web Dashboard (`packages/web/src/components/sessions/`):**
- `SessionTerminal.tsx` - Main terminal component, 1200+ lines
- Full xterm.js integration with WebGL, search, fit addons
- WebSocket + SSE transport with automatic fallback
- Mobile-responsive with touch support
- File drag-and-drop, link detection
- Composer for terminal input with attachments

**Key Files:**
```
crates/conductor-executors/src/pty_subprocess.rs      # Binary framing (5-byte header)
crates/conductor-server/src/state/terminal_supervisor.rs  # Connection management
crates/conductor-server/src/state/terminal_hosts.rs      # Session registry
packages/web/src/components/sessions/SessionTerminal.tsx # xterm.js UI
packages/web/src/components/sessions/terminal/*.ts      # Terminal hooks
```

### What's Already Better Than Superset

1. **Unified Transport** - Single WebSocket for both stream and control (Superset uses separate sockets)
2. **Access Control** - HMAC tokens with operator/viewer roles (Superset has no RBAC)
3. **Terminal Snapshots** - Persisted state restoration (Superset has this too)
4. **Mobile Support** - Touch-optimized terminal (Superset desktop-only)
5. **Escape Filtering** - Proper OSC-7 CWD tracking
6. **Binary Protocol** - 5-byte header framing (identical to Superset)

---

## Superset Features to Integrate

### 1. Git Worktree Isolation

**Superset Approach:**
```
~/.superset/worktrees/
├── {project}/
│   └── {branch-name}/          # Git worktree directory
```

**Integration Plan:**
```rust
// crates/conductor-git/src/worktree.rs
pub struct WorktreeManager {
    base_path: PathBuf,
}

impl WorktreeManager {
    pub async fn create_worktree(
        &self,
        project_path: &Path,
        task_id: &str,
    ) -> Result<PathBuf> {
        let branch = format!("conductor/{}", task_id);
        let worktree_path = self.base_path.join(task_id);
        
        // git worktree add -b conductor/{task_id} {path} {base-branch}
        git2::Repository::open(project_path)?
            .worktree(&branch, &worktree_path, None)?;
            
        Ok(worktree_path)
    }
}
```

### 2. Multi-Pane Terminal Layout

**Superset Approach:**
- React state-based pane management
- Split panes (horizontal/vertical)
- Tab system for workspaces

**Integration Plan:**
```typescript
// packages/web/src/components/terminal/TerminalLayout.tsx
interface Pane {
  id: string;
  type: 'terminal' | 'diff' | 'preview';
  sessionId?: string;
  split?: 'horizontal' | 'vertical';
  children?: Pane[];
}

interface TerminalWorkspace {
  id: string;
  name: string;
  panes: Pane;
  activePaneId: string;
}
```

### 3. Workspace Presets

**Superset Config (`.superset/config.json`):**
```json
{
  "setup": ["./.superset/setup.sh"],
  "teardown": ["./.superset/teardown.sh"]
}
```

**Conductor Integration (`conductor.yaml`):**
```yaml
workspaces:
  presets:
    - name: "Node.js Project"
      pattern: "package.json"
      setup:
        - "npm install"
        - "cp .env.example .env"
      teardown:
        - "rm -rf node_modules"
      
    - name: "Python Project"
      pattern: "requirements.txt"
      setup:
        - "python -m venv .venv"
        - "source .venv/bin/activate && pip install -r requirements.txt"
```

### 4. Agent Monitoring Dashboard

**Features:**
- Grid view of all active sessions
- Live status indicators (running, idle, error)
- Quick actions (stop, restart, open)
- Resource usage (CPU, memory)
- Recent output preview

**Component Structure:**
```
packages/web/src/components/dashboard/
├── AgentGrid.tsx          # Main grid view
├── AgentCard.tsx          # Individual agent card
├── AgentStatusBadge.tsx   # Status indicator
├── AgentActions.tsx       # Quick action buttons
└── ResourceMonitor.tsx    # CPU/Memory charts
```

### 5. Keyboard Shortcuts

**Superset Shortcuts to Add:**
```
Workspace Navigation:
  ⌘1-9         Switch to workspace 1-9
  ⌘⌥↑/↓        Previous/next workspace
  ⌘N           New workspace
  ⌘⇧N          Quick create workspace
  ⌘⇧O          Open project

Terminal:
  ⌘T           New tab
  ⌘W           Close pane
  ⌘D           Split right
  ⌘⇧D          Split down
  ⌘K           Clear terminal
  ⌘F           Find in terminal
  ⌘⌥←/→        Previous/next tab

Layout:
  ⌘B           Toggle sidebar
  ⌘L           Toggle changes panel
```

---

## Implementation Phases

### Phase 1: Worktree Isolation (Week 1-2)
- [ ] Add `conductor-git/src/worktree.rs`
- [ ] Integrate worktree creation into session spawn
- [ ] Add worktree cleanup on session end
- [ ] UI: Show worktree path in session details
- [ ] Migration: Handle existing non-worktree sessions

### Phase 2: Multi-Pane Layout (Week 3-4)
- [ ] Create `TerminalLayout` component
- [ ] Implement pane splitting logic
- [ ] Add tab bar component
- [ ] Persist layout state to localStorage
- [ ] Keyboard shortcuts for navigation

### Phase 3: Workspace Presets (Week 5-6)
- [ ] Extend `conductor.yaml` schema
- [ ] Add preset detection logic
- [ ] Create setup/teardown runner
- [ ] UI: Preset selection during workspace creation
- [ ] Progress indicators for setup tasks

### Phase 4: Agent Dashboard (Week 7-8)
- [ ] Create `/dashboard` route
- [ ] Implement AgentGrid component
- [ ] Add real-time status updates (SSE)
- [ ] Resource monitoring integration
- [ ] Quick action implementation

### Phase 5: Desktop App (Week 9-10)
- [ ] Electron wrapper setup
- [ ] Native menu integration
- [ ] Global keyboard shortcuts
- [ ] Auto-updater
- [ ] DMG/Installer packaging

---

## File Structure Changes

### New Files

```
crates/
  conductor-git/
    src/worktree.rs              # Git worktree operations
    src/presets.rs               # Workspace preset handling
    
  conductor-server/
    src/routes/workspaces.rs     # Workspace CRUD endpoints
    
packages/
  web/
    src/components/
      layout/
        TerminalLayout.tsx       # Multi-pane layout
        PaneSplitter.tsx         # Resizable split panes
        TabBar.tsx               # Workspace tabs
      dashboard/
        AgentGrid.tsx            # Agent monitoring
        AgentCard.tsx            # Agent card component
        ResourceCharts.tsx       # Resource monitoring
      workspace/
        WorkspaceCreator.tsx     # Create workspace UI
        PresetSelector.tsx       # Preset selection
        SetupProgress.tsx        # Setup task progress
    src/hooks/
      useKeyboardShortcuts.ts    # Global shortcuts
      useWorktree.ts             # Worktree management
      useWorkspaceLayout.ts      # Layout persistence
      
  desktop/                       # NEW: Electron app
    src/
      main/
        index.ts                 # Main process
        menu.ts                  # Native menus
        shortcuts.ts             # Global shortcuts
      renderer/
        index.tsx                # Renderer entry
    package.json
```

### Modified Files

```
crates/conductor-core/src/models/session.rs
  - Add worktree_path field
  
crates/conductor-executors/src/executor.rs
  - Integrate worktree creation
  
crates/conductor-db/src/migrations.rs
  - Add worktree_path column
  
packages/web/src/components/sessions/SessionTerminal.tsx
  - Support multi-pane context
  
packages/web/src/hooks/useSessions.ts
  - Add dashboard view queries
```

---

## Database Schema Changes

### New Tables

```sql
-- Workspaces (groups of related sessions)
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    preset_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Workspace layout state
CREATE TABLE workspace_layouts (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    layout_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Preset definitions
CREATE TABLE workspace_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    pattern TEXT,  -- Glob pattern for auto-detection
    setup_commands TEXT,  -- JSON array
    teardown_commands TEXT,  -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Modified Tables

```sql
-- Add to sessions table
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
ALTER TABLE sessions ADD COLUMN pane_id TEXT;  -- For multi-pane layout
```

---

## API Changes

### New Endpoints

```rust
// Workspaces
GET    /api/workspaces                      # List workspaces
POST   /api/workspaces                      # Create workspace
GET    /api/workspaces/:id                  # Get workspace
DELETE /api/workspaces/:id                  # Delete workspace
PATCH  /api/workspaces/:id/layout           # Update layout

// Worktree
POST   /api/sessions/:id/worktree/create    # Create worktree
DELETE /api/sessions/:id/worktree           # Remove worktree
GET    /api/sessions/:id/worktree/status    # Get worktree status

// Presets
GET    /api/presets                         # List presets
POST   /api/presets                         # Create preset
GET    /api/presets/detect                  # Auto-detect preset for project

// Dashboard
GET    /api/dashboard/agents                # Get all agent statuses
GET    /api/dashboard/stats                 # Aggregate statistics
```

---

## Testing Strategy

### Unit Tests
- Worktree creation/cleanup
- Preset detection logic
- Layout serialization
- Keyboard shortcut handling

### Integration Tests
- End-to-end workspace creation flow
- Multi-pane terminal interactions
- Preset setup/teardown execution
- Dashboard real-time updates

### Performance Tests
- 10+ concurrent terminal sessions
- Worktree creation overhead
- Dashboard with 50+ agents
- Memory usage over time

---

## Migration Guide

### For Existing Users

1. **Automatic Migration:**
   ```bash
   conductor migrate --to=v2-workspaces
   ```
   - Creates default workspace for existing sessions
   - Sets up worktrees for active projects
   - Preserves all session history

2. **Manual Steps:**
   - Review `conductor.yaml` for new preset section
   - Add `.conductor/setup.sh` if needed
   - Update IDE integrations with new paths

### Breaking Changes

- Session paths now include worktree directory
- WebSocket URL format unchanged
- API additions only (no removals)

---

## Performance Targets

Based on Superset benchmarks and Conductor's existing performance:

| Metric | Target | Current |
|--------|--------|---------|
| Terminal latency | <50ms | <30ms ✅ |
| Worktree creation | <2s | N/A |
| Session spawn | <3s | <2s ✅ |
| Dashboard load (50 agents) | <1s | N/A |
| Memory per session | <50MB | <30MB ✅ |

---

## Security Considerations

1. **Worktree Isolation:**
   - Each session in separate git worktree
   - No access to other sessions' files
   - Automatic cleanup on session end

2. **Preset Execution:**
   - Sandboxed shell execution
   - Timeout on setup scripts
   - Audit logging for all commands

3. **Dashboard Access:**
   - Respect existing RBAC roles
   - Operator: Full control
   - Viewer: Read-only terminal access

---

## Conclusion

Conductor is already 90% of the way to Superset's terminal architecture. The remaining 10% (worktree isolation, multi-pane UI, workspace presets) can be implemented in 8-10 weeks following this plan. The result will be a best-of-both-worlds solution:

- **Conductor's strengths:** Rust performance, access control, mobile support
- **Superset's strengths:** Workspace isolation, multi-pane UI, presets

This integration positions Conductor as the premier open-source terminal for AI agents.
