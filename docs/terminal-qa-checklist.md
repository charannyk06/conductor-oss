# Terminal QA Checklist

Use this checklist before merging terminal architecture changes. Record the observed timings and pass/fail notes in [docs/terminal-qa-matrix.md](docs/terminal-qa-matrix.md).

## Desktop

- [ ] Launch a fresh session from the dashboard on macOS or Linux desktop.
- [ ] Confirm the session detail terminal reaches a usable ttyd-backed prompt through the backend ttyd facade.
- [ ] Type directly into the terminal and verify shell editing, Enter, Backspace, Ctrl+C, and paste all work.
- [ ] Scroll upward while output is streaming and confirm the viewport does not jump back to the live tail until `Jump to latest` is used.
- [ ] Resize the browser narrower and wider and confirm the prompt reflows without garbling or duplicate redraw noise.
- [ ] Refresh the tab and confirm recent output plus the active prompt reappear quickly.
- [ ] Switch away from the tab and back again and confirm the terminal remains interactive.
- [ ] Capture `Server-Timing` from the token and snapshot requests plus websocket open timing in DevTools.

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
- [ ] Verify native terminal typing, keyboard open behavior, Enter, Backspace, and paste.
- [ ] Confirm orientation changes preserve terminal readability and usable font sizing.
- [ ] Confirm tab switch or short network interruption reconnects cleanly.
- [ ] Verify `Jump to latest` appears only when the viewport is above the live tail.

## External Browser

- [ ] Validate an authenticated non-loopback dashboard path behind the configured access layer.
- [ ] Confirm the terminal stream stays on the authenticated ttyd facade WS (`/api/sessions/:id/terminal/ttyd/ws`) using a live token from `/api/sessions/:id/terminal/token`.
- [ ] Refresh the external tab and confirm reconnect restores the same session content and prompt.
- [ ] Confirm direct typing works after reconnect without requiring page navigation.
- [ ] Trigger an intentional failure path and confirm terminal reconnect behavior is explicit (token refresh + ttyd reconnect) before any snapshot recovery path is used.

## Diagnostics To Capture On Failure

- [ ] session id
- [ ] device and browser
- [ ] loopback vs external dashboard path
- [ ] terminal token headers and payload (`required`, `expiresInSeconds`)
- [ ] terminal snapshot headers (`Server-Timing`, source, live, restored, format)
- [ ] terminal snapshot payload (`source`, `live`, `restored`, `sequence`)
- [ ] websocket close code, ttyd facade query string shape (token presence), and reconnect timing
- [ ] browser console and network errors
