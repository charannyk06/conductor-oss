# Workspace Soak Checklist

Use this after terminal, dispatcher, or preview changes. The goal is to prove that the dashboard keeps identity and continuity under real usage, not just unit tests.

## Debug hooks

In development builds, the dashboard exposes lightweight debug state in the browser console:

- `window.__conductorSessionTerminalDebug?.getState()`
- `window.__conductorDispatcherDebug?.getState()`
- `window.__conductorSessionPreviewDebug?.getState()`

Capture those snapshots before and after each scenario.

## Terminal

- [ ] Open a live coding session terminal.
- [ ] Record initial terminal metrics.
- [ ] Switch between terminal, dispatcher, preview, and skills tabs 10 times.
- [ ] Switch between two different sessions 10 times.
- [ ] Background the tab for 30 seconds, return, and confirm the same terminal remains usable.
- [ ] Toggle network offline and back online, then confirm recovery happens without apparent terminal replacement unless the transport actually died.
- [ ] Confirm terminal metrics show sensible counts for iframe loads, silent refreshes, and reconnect-driven refreshes.

## Dispatcher

- [ ] Open a busy dispatcher thread with live streaming output.
- [ ] Record initial dispatcher metrics.
- [ ] Scroll upward while new output is streaming and confirm the feed does not jump unexpectedly.
- [ ] Hide the dispatcher tab, wait for live output elsewhere, then return.
- [ ] Confirm the feed content is still present and does not duplicate entries after reconnect.
- [ ] Confirm dispatcher metrics show reconnects and fallback reloads only when expected.

## Preview

- [ ] Open preview on an active dev server URL.
- [ ] Record initial preview metrics.
- [ ] Switch away from preview and back repeatedly.
- [ ] Confirm the preview stays mounted and the Elements, Console, and Network tabs keep useful state.
- [ ] In Inspect mode, select an element, queue it for terminal input, and confirm the selection survives short tab switches.
- [ ] Disconnect or kill the preview worker session and confirm the preview falls back to a disconnected state instead of a hard failure.
- [ ] Confirm preview metrics show status loads, poll counts, auto-connect attempts, and screenshot loads.

## Suggested pass criteria

- Terminal feels like the same surface after passive lifecycle events.
- Dispatcher feed does not duplicate or wipe conversation state on reconnect.
- Preview does not hard-reset just because the user switched tabs.
- Debug metrics match the visible behavior.

## Capture on failure

- Commit hash
- Browser and OS
- Session id
- Debug hook snapshots for terminal, dispatcher, and preview
- Relevant network errors and websocket close codes
- Short screen recording if the issue is visual
