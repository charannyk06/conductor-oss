# Terminal QA Checklist

Use this checklist before releasing terminal architecture changes. The goal is to validate one terminal model across desktop, phone, and approved remote-browser paths.

## Desktop

- [ ] Launch a fresh session from the dashboard on macOS or Linux desktop.
- [ ] Confirm the session detail terminal connects over websocket and reaches a usable prompt without falling back to a fake console.
- [ ] Type directly into the terminal and verify shell editing, Enter, Backspace, Ctrl+C, and paste all work.
- [ ] Scroll upward while output is streaming and confirm the viewport does not jump back to the bottom until `Jump to latest` is used.
- [ ] Resize the browser window narrower and wider and confirm the prompt reflows without garbling or duplicate redraw noise.
- [ ] Refresh the tab and confirm recent output plus the active prompt reappear quickly.
- [ ] Switch away from the tab and back again and confirm the terminal remains interactive.

## iPhone Safari

- [ ] Open the same live session from an iPhone-sized Safari viewport.
- [ ] Tap into the terminal and confirm the on-screen keyboard opens against the real terminal surface.
- [ ] Verify direct typing works without relying on a separate text rail.
- [ ] Use accessory actions such as Tab, arrows, Ctrl+C, and Enter if exposed by the UI.
- [ ] Rotate between portrait and landscape and confirm resize does not corrupt the prompt.
- [ ] Scroll up in terminal history, wait for more output, and confirm the viewport position is preserved.
- [ ] Background Safari briefly, return, and confirm reconnect restores the terminal instead of replacing it with a degraded console by default.

## Android Chrome

- [ ] Open the same session on Android Chrome.
- [ ] Verify direct terminal typing, keyboard open behavior, Enter, Backspace, and paste.
- [ ] Confirm orientation changes preserve terminal readability and usable font sizing.
- [ ] Confirm tab switch or short network interruption reconnects cleanly.
- [ ] Verify `Jump to latest` appears only when the viewport is above the live tail.

## Remote Browser

- [ ] Validate a private remote path such as Tailscale with the remote runtime in `ready` state.
- [ ] Confirm `/api/sessions/:id/terminal/connection` resolves `transport: "websocket"` instead of defaulting to polling.
- [ ] Refresh the remote tab and confirm reconnect restores the same session content and prompt.
- [ ] Confirm direct typing works after reconnect without requiring page navigation.
- [ ] Trigger an intentional failure path or disable the remote websocket endpoint temporarily and confirm any `http-poll` fallback is explicit, visible, and recoverable.

## Diagnostics To Capture On Failure

- [ ] Session id
- [ ] Device and browser
- [ ] Local vs remote access path
- [ ] Terminal connection payload (`transport`, `wsUrl` presence)
- [ ] Terminal snapshot payload (`source`, `live`, `restored`)
- [ ] Browser console and network errors
