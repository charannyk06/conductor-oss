## Summary

<!-- Describe what this PR does in 1-3 sentences. Keep implementation detail here, not in release notes. Link any related issues. -->

Closes #<!-- issue number -->

## User-Facing Release Notes

<!--
Write 1-3 bullets in plain English. These bullets may be published in release notes.

Good: "You can now pick a repository folder from the native OS file picker in Settings."
Bad: "feat: add POST /api/filesystem/pick-directory with osascript / PowerShell / zenity support."

If this PR has no user-facing change, write:
N/A - internal maintenance only
-->

-

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Agent or integration addition / modification
- [ ] Documentation update
- [ ] Refactor / chore

## Checklist

- [ ] `bun run build:frontend` passes for frontend changes
- [ ] `bun run typecheck` passes for TypeScript changes
- [ ] `bun run test:packages` passes for package changes
- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings` pass for Rust changes
- [ ] `cd bridge-cmd && go test ./...` passes for bridge changes
- [ ] No `any` types introduced without justification
- [ ] No secrets or credentials committed
- [ ] Security boundaries, authentication, persistence, and network behavior have regression tests when changed
- [ ] User-facing release notes are filled in plain English or marked internal-only
- [ ] PR title follows conventional commits (`feat:`, `fix:`, `chore:`, etc.)

## Testing

<!-- Describe how you tested these changes. Include any relevant commands or scenarios. -->

```bash
# Commands I used to verify this works:
```

## Screenshots / Demo

<!-- If this is a UI change or a feature with visible output, add a screenshot or GIF. -->
