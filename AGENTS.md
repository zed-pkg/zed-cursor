# Agent instructions

## Product intent

This repository is the dedicated Cursor integration for Zed packages. Keep Cursor/VS Code API concerns in TypeScript and package analysis in the Rust analyzer or the side-effect-free TypeScript fallback.

## Safety invariants

- Never execute package commands automatically because a file changed.
- Never read, print, persist, or send Zed tokens or unrelated environment variables.
- Use `execFile` for analyzer and availability checks; do not pass workspace data through a shell.
- User-facing CLI actions must remain explicit, visible in a terminal, and disabled in untrusted workspaces.
- Do not “fix” dependency cycles by deleting declarations without understanding the intended package boundaries.
- Preserve multi-root workspace behavior.

## Validation

Run all applicable checks before publishing:

```bash
npm install
npm run check
npm test
cargo fmt --manifest-path analyzer/Cargo.toml --all -- --check
cargo clippy --manifest-path analyzer/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path analyzer/Cargo.toml --all-targets
```

The TypeScript and Rust analyzers must keep the same `WorkspaceReport` JSON shape. Schema changes require compatibility tests and a schema-version decision.

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.
