# Terminal QA Checklist

Use this checklist before merging terminal architecture changes. Record the observed timings and pass/fail notes in [docs/terminal-qa-matrix.md](docs/terminal-qa-matrix.md).

## Desktop

- [ ] Launch a fresh session from the dashboard on macOS or Linux desktop.
- [ ] Confirm the session detail terminal resolves `transport: "websocket"` and reaches a usable prompt without degrading into snapshot mode.
- [ ] Type directly into the terminal and verify shell editing, Enter, Backspace, Ctrl+C, and paste all work.
- [ ] Scroll upward while output is streaming and confirm the viewport does not jump back to the live tail until `Jump to latest` is used.
- [ ] Resize the browser narrower and wider and confirm the prompt reflows without garbling or duplicate redraw noise.
- [ ] Refresh the tab and confirm recent output plus the active prompt reappear quickly.
- [ ] Switch away from the tab and back again and confirm the terminal remains interactive.
- [ ] Capture `Server-Timing` from the connection and snapshot requests.

## iPhone Safari

- [ ] Open the same live session from an iPhone-sized Safari viewport.
- [ ] Tap into the terminal and confirm the on-screen keyboard opens against the real terminal surface.
- [ ] Verify direct typing works without relying on a separate text rail.
- [ ] Use accessory actions such as Tab, arrows, Ctrl+C, and Enter if exposed by the UI.
- [ ] Rotate between portrait and landscape and confirm resize does not corrupt the prompt.
- [ ] Scroll up in terminal history, wait for more output, and confirm the viewport position is preserved.
- [ ] Background Safari briefly, return, and confirm reconnect restores the terminal instead of replacing it with a degraded recovery rail by default.

## Android Chrome

- [ ] Open the same session on Android Chrome.
- [ ] Verify direct terminal typing, keyboard open behavior, Enter, Backspace, and paste.
- [ ] Confirm orientation changes preserve terminal readability and usable font sizing.
- [ ] Confirm tab switch or short network interruption reconnects cleanly.
- [ ] Verify `Jump to latest` appears only when the viewport is above the live tail.

## Private Remote Browser

- [ ] Validate an approved private remote path such as Tailscale with the remote runtime in `ready` state.
- [ ] Confirm `/api/sessions/:id/terminal/connection` resolves `transport: "websocket"` instead of defaulting to snapshot recovery mode.
- [ ] Confirm `x-conductor-terminal-connection-path` reports `managed_remote` when the private link is active.
- [ ] Refresh the remote tab and confirm reconnect restores the same session content and prompt.
- [ ] Confirm direct typing works after reconnect without requiring page navigation.
- [ ] Trigger an intentional failure path or disable the remote websocket endpoint temporarily and confirm any snapshot fallback is explicit, visible, and recoverable.

## Diagnostics To Capture On Failure

- [ ] session id
- [ ] device and browser
- [ ] local vs remote access path
- [ ] terminal connection headers (`Server-Timing`, transport, connection path, interactive)
- [ ] terminal snapshot headers (`Server-Timing`, source, live, restored, format)
- [ ] terminal connection payload (`transport`, `fallbackReason`)
- [ ] terminal snapshot payload (`source`, `live`, `restored`, `sequence`)
- [ ] browser console and network errors
