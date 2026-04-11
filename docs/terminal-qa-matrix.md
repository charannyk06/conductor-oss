# Terminal Phase 2 QA Matrix

Fill this out during the final merge pass. The `Observed` column should capture the actual numbers from `bun run bench:terminal -- <session-id>` or browser DevTools.

| Area | Device / Path | Expected path | Speed target | Correctness gates | Observed | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local attach | macOS or Linux desktop on loopback | token + backend terminal websocket | connect under 150 ms, usable prompt under 2 s | native typing, stable scroll, no duplicate input or transport fallback | | Pending | |
| Local refresh restore | same desktop session after reload | token refresh + backend terminal websocket | reconnect under 2 s | prompt and recent scrollback survive refresh | | Pending | |
| Resize stability | desktop resize narrow to wide and back | terminal resize frames only | resize feels immediate | no prompt corruption, no duplicate redraw noise | | Pending | |
| iPhone Safari live use | phone viewport on local or private network | backend terminal websocket | attach and restore feel immediate, reconnect under 2 s | keyboard opens on terminal, typing works, rotate stays stable | | Pending | |
| Android Chrome live use | phone viewport on local or private network | backend terminal websocket | attach and restore feel immediate, reconnect under 2 s | typing, paste, orientation, tail-follow behavior all work | | Pending | |
| External attach | authenticated non-loopback dashboard path | token + backend terminal websocket | connect under 250 ms, live snapshot under 500 ms | native typing works, refresh restores same session | | Pending | |
| External failure path | authenticated non-loopback dashboard path with the terminal stream intentionally blocked | explicit reconnect failure, no alternate websocket transport | failure is explicit and recoverable | user sees reconnect failure, fresh token + terminal stream recovers when path returns | | Pending | |

## Sign-Off

- Date:
- Operator:
- Branch or commit:
- Result:
