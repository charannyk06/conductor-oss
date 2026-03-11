# Terminal Phase 2 QA Matrix

Fill this out during the final merge pass. The `Observed` column should capture the actual numbers from `bun run bench:terminal -- <session-id>` or browser DevTools.

| Area | Device / Path | Expected transport | Speed target | Correctness gates | Observed | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local attach | macOS or Linux desktop on loopback | `websocket` with `connection-path=direct` | connection under 150 ms, usable prompt under 2 s | direct typing, stable scroll, no unwanted fallback | | Pending | |
| Local refresh restore | same desktop session after reload | `websocket` + restore snapshot | snapshot under 200 ms | prompt and recent scrollback survive refresh | | Pending | |
| Resize stability | desktop resize narrow to wide and back | `websocket` | resize control under 150 ms | no prompt corruption, no duplicate redraw noise | | Pending | |
| iPhone Safari live use | phone viewport on local or private network | `websocket` preferred | attach and restore feel immediate, reconnect under 2 s | keyboard opens on terminal, typing works, rotate stays stable | | Pending | |
| Android Chrome live use | phone viewport on local or private network | `websocket` preferred | attach and restore feel immediate, reconnect under 2 s | typing, paste, orientation, tail-follow behavior all work | | Pending | |
| Private remote attach | approved private remote path such as Tailscale | `websocket` with `connection-path=managed_remote` | connection under 250 ms, live snapshot under 500 ms | direct typing works, refresh restores same session | | Pending | |
| Remote failure path | approved private remote path with websocket intentionally disabled | explicit `snapshot` fallback | fallback is explicit and recoverable | user sees recovery mode, reconnect returns to websocket when path recovers | | Pending | |

## Sign-Off

- Date:
- Operator:
- Branch or commit:
- Result:
