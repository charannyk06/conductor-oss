# conductor-oss

`conductor-oss` is the published npm package for Conductor's launcher and user-facing `co` CLI.

It starts the local dashboard and Rust backend, scaffolds `conductor.yaml` and `CONDUCTOR.md`, launches agent sessions, and powers the bridge setup flow for paired-device access.

## Choose the right setup

### Local dashboard on the same machine
Use this when your repos and agents are on the same laptop or desktop.

```bash
npx --yes --registry=https://registry.npmjs.org conductor-oss@latest
```

That defaults to `co start --open`.

If you do not pass `--workspace`, the launcher bootstraps a default workspace at:

```text
~/.openclaw/workspace
```

### Existing repo you want Conductor to manage

```bash
cd /path/to/repo
npx --yes --registry=https://registry.npmjs.org conductor-oss@latest init
npx --yes --registry=https://registry.npmjs.org conductor-oss@latest start --workspace . --open
```

This scaffolds:
- `conductor.yaml`
- `CONDUCTOR.md`
- `.conductor/conductor.db`, after the backend starts

### Hosted dashboard plus bridge pairing
Use this when you want to access your machine from another browser or your phone.

```bash
curl -fsSL https://app.conductross.com/bridge/install.sh | sh -s -- --connect --dashboard-url https://app.conductross.com --relay-url https://relay.conductross.com/
```

On Windows PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod -Uri 'https://app.conductross.com/bridge/install.ps1'))) -Connect -DashboardUrl 'https://app.conductross.com' -RelayUrl 'https://relay.conductross.com/'
```

The hosted dashboard is not a cloud IDE. Your repos, terminals, and agents stay on the paired machine.

## Install globally

```bash
npm install -g conductor-oss
co start --open
```

Installed aliases:
- `conductor-oss`
- `conductor`
- `co`

## What the package gives you

- workspace linking for GitHub repos or local folders
- real ttyd-backed terminal sessions in the dashboard
- worktree-isolated agent runs
- Markdown board support through `CONDUCTOR.md`
- session recovery with retry, restore, feedback, and cleanup
- a local SQLite state store in `.conductor/conductor.db`
- bridge setup and pairing for remote access to your own machine

## Common commands

| Command | What it does |
|---------|---------------|
| `co start` | Start the dashboard and Rust backend |
| `co init` | Scaffold `conductor.yaml` and `CONDUCTOR.md` |
| `co setup` | Guided first-run setup |
| `co spawn <project> [prompt]` | Start a new agent session |
| `co list` | List sessions |
| `co status` | Show the current attention-oriented status view |
| `co send <session> <message...>` | Send a message to a running session |
| `co feedback <sessionId> <message...>` | Send reviewer feedback and requeue the session |
| `co retry <sessionOrTask>` | Retry an existing task or session |
| `co restore <session>` | Restore an exited session |
| `co kill <session>` | Kill a session |
| `co cleanup` | Reclaim resources from completed sessions |
| `co doctor` | Diagnose backend and runtime health |
| `co dashboard` | Open the dashboard in a browser |
| `co bridge setup` | Install and pair Conductor Bridge |
| `co mcp-server` | Run Conductor as an MCP server over stdio |
| `co acp-server` | Run Conductor as an ACP server over stdio |

## Ports

Published launcher defaults:
- dashboard: `http://127.0.0.1:4747`
- Rust backend: `http://127.0.0.1:4748`

Source checkout development defaults:
- dashboard: `http://127.0.0.1:3000`
- Rust backend: `http://127.0.0.1:4749`

## Supported agents

Conductor currently includes adapters for:
- Claude Code
- Codex
- Gemini
- Qwen Code
- Amp
- Hermes
- Cursor CLI
- OpenCode
- Droid
- GitHub Copilot
- CCR

The dashboard only offers agents it can discover on your machine.

## Environment notes

If you run the dashboard by itself, set `CONDUCTOR_BACKEND_URL` or `NEXT_PUBLIC_CONDUCTOR_BACKEND_URL` so the web UI can talk to the Rust backend.

If that backend is reachable off-host and dashboard auth is enabled, also set the same `CONDUCTOR_PROXY_AUTH_SECRET` in both processes so forwarded dashboard auth headers can be verified safely.

Unauthenticated public dashboard access is not supported.

## More docs

For the full product overview, architecture, screenshots, and contributor guidance, see:
- GitHub: <https://github.com/charannyk06/conductor-oss>
- Root README: <https://github.com/charannyk06/conductor-oss#readme>
