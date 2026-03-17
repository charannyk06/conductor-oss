# Terminal Phase 2 QA Matrix

Fill this out during the final merge pass. The `Observed` column should capture the actual numbers from `bun run bench:terminal -- <session-id>` or browser DevTools.

| Area | Device / Path | Expected path | Speed target | Correctness gates | Observed | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local attach | macOS or Linux desktop on loopback | token + direct ttyd websocket | connect under 150 ms, usable prompt under 2 s | direct typing, stable scroll, no duplicate input or transport fallback | | Pending | |
| Local refresh restore | same desktop session after reload | token refresh + direct ttyd websocket | reconnect under 2 s | prompt and recent scrollback survive refresh | | Pending | |
| Resize stability | desktop resize narrow to wide and back | ttyd resize frames only | resize feels immediate | no prompt corruption, no duplicate redraw noise | | Pending | |
| iPhone Safari live use | phone viewport on local or private network | direct ttyd websocket | attach and restore feel immediate, reconnect under 2 s | keyboard opens on terminal, typing works, rotate stays stable | | Pending | |
| Android Chrome live use | phone viewport on local or private network | direct ttyd websocket | attach and restore feel immediate, reconnect under 2 s | typing, paste, orientation, tail-follow behavior all work | | Pending | |
| Private remote attach | approved private remote path such as Tailscale | token + direct ttyd websocket | connect under 250 ms, live snapshot under 500 ms | direct typing works, refresh restores same session | | Pending | |
| Remote failure path | approved private remote path with ttyd intentionally blocked | explicit reconnect failure, no alternate websocket transport | failure is explicit and recoverable | user sees reconnect failure, fresh token + ttyd recovers when path returns | | Pending | |

## Sign-Off

- Date:
- Operator:
- Branch or commit:
- Result:
