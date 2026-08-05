# Contributing

1. Create a feature branch from `dev` when the repository's integration branch is available; otherwise branch from the current default branch.
2. Keep extension-host changes in `src/` and native analysis changes in `analyzer/`.
3. Add regression tests for every analyzer rule or parser fix.
4. Run the Node and Rust validation commands documented in `AGENTS.md`.
5. Open a pull request with the user impact, design tradeoffs, validation evidence, and any report-schema changes.

Prefer semantic fixes over suppressing diagnostics. A recommendation should explain the safest next action and should not mutate package state without user initiation.
