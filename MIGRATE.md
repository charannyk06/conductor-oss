# Migrating from conductor-v2 to conductor-oss

If you were running an earlier private version of Conductor, here's how to switch.

## What stays the same
- **Obsidian boards** — zero changes to your CONDUCTOR.md files
- **Tags** — `#agent/`, `#project/`, `#type/`, `#priority/` all work identically
- **Columns** — same Inbox → Ready to Dispatch → Dispatching → In Progress → Review → Done → Blocked
- **Session notes** — written to `workspace/sessions/` in the same format
- **`boardDir`** — shared board support works the same

## Steps

### 1. Install
```bash
npm install -g conductor-oss
```

### 2. Copy your config
Copy your existing `conductor.yaml` to your workspace directory. No changes needed — the format is identical.

### 3. Update your LaunchAgent (macOS)

Find your existing plist (`~/Library/LaunchAgents/com.yourname.conductor.plist`) and update the command to use `co start` instead of your old start script.

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/co</string>
  <string>start</string>
  <string>--workspace</string>
  <string>/path/to/your/workspace</string>
</array>
```

Then reload:
```bash
launchctl unload ~/Library/LaunchAgents/com.yourname.conductor.plist
launchctl load ~/Library/LaunchAgents/com.yourname.conductor.plist
```

### 4. That's it

Your Obsidian workspace is untouched. New sessions will be tracked under the new config path hash (`~/.conductor/`).

> **Note:** Old sessions from your previous setup won't appear in the new dashboard — but since they were all completed anyway, this is fine.

## Feature parity checklist

| Feature | Available |
|---------|-----------|
| Inbox auto-tagging | ✅ |
| boardDir (shared boards) | ✅ |
| Done → Review flow | ✅ |
| Session notes | ✅ |
| Startup dedupe | ✅ |
| Promise-based lock (no duplicate dispatch) | ✅ |
| PR tracking | ✅ |
| CI status | ✅ |
| Discord notifications | ✅ |
| Desktop notifications | ✅ |
| Web dashboard | ✅ |
