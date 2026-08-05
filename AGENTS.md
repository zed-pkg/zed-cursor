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
