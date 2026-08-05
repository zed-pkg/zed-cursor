# Zed Package Insights for Cursor

`zed-cursor` is a dedicated Cursor extension for understanding and repairing Zed package state directly inside the IDE.

Cursor is based on the VS Code codebase, so the extension host is implemented in TypeScript against the VS Code Extension API. Package analysis is implemented twice:

- a bundled Rust analyzer for fast, deterministic workspace scans;
- a TypeScript fallback so diagnostics still work when a native binary is unavailable during development or on an unsupported platform.

The extension is designed for Cursor first and can also run in compatible VS Code-derived editors.

## Features

- Discovers `.zpkg.toml` manifests in single-root and multi-root workspaces.
- Validates package identity, dependency declarations, local dependency paths, lockfile presence, empty or stale lockfiles, and local workspace dependency cycles.
- Publishes diagnostics in the editor and Problems panel.
- Offers code actions and recommended resolutions instead of only reporting failures.
- Shows a Zed Packages activity-bar view with package health, dependencies, issues, and actions.
- Shows a richer package dashboard with health totals and guided commands.
- Maintains a status-bar package-health indicator.
- Runs supported Zed CLI actions in an explicit terminal:
  - `zed install`
  - `zed install --frozen`
  - `zed build`
  - `zed env verify`
  - `zed self-update --check`
- Copies a structured resolution prompt for an IDE agent when a problem needs deeper semantic work.
- Honors workspace trust and never auto-runs mutating commands.

## Architecture

```text
Cursor extension host
  ├── TypeScript UI and command layer
  │   ├── diagnostics + quick fixes
  │   ├── package tree
  │   ├── dashboard webview
  │   ├── status bar
  │   └── safe Zed CLI terminal actions
  └── analyzer boundary
      ├── bundled Rust analyzer
      └── TypeScript fallback analyzer
```

C, C++, or Rust alone are not appropriate for the extension host because Cursor exposes the VS Code JavaScript/TypeScript extension API. Rust is used behind that API boundary where native traversal and graph analysis provide value.

## Commands

| Command | Purpose |
| --- | --- |
| `Zed: Refresh Package Insights` | Re-scan all package manifests and lockfiles. |
| `Zed: Show Package Insights` | Open the workspace or selected-package dashboard. |
| `Zed: Initialize Package` | Run `zed init` in the selected workspace after confirmation. |
| `Zed: Open Package Manifest` | Open the selected package's `.zpkg.toml`. |
| `Zed: Install Dependencies` | Run `zed install` after confirmation. |
| `Zed: Install Frozen Dependencies` | Validate the lockfile with `zed install --frozen`. |
| `Zed: Build Package` | Run the package build hooks through `zed build`. |
| `Zed: Verify Developer Environment` | Run `zed env verify`. |
| `Zed: Check CLI Update` | Run `zed self-update --check`. |
| `Zed: Copy Resolution Prompt` | Copy package issues, dependency state, and validation steps for an IDE agent. |

## Settings

- `zedCursor.cliPath`: Zed CLI executable, default `zed`.
- `zedCursor.analyzerPath`: optional explicit native analyzer path.
- `zedCursor.preferRustAnalyzer`: prefer the bundled native analyzer.
- `zedCursor.scanExclude`: directories excluded from package discovery.
- `zedCursor.confirmMutatingCommands`: require confirmation before install/build operations.
- `zedCursor.maxManifests`: scan ceiling for very large workspaces.
- `zedCursor.refreshDebounceMs`: debounce interval for file watcher refreshes.

## Development

Prerequisites:

- Node.js 22 or newer
- npm
- Rust stable

```bash
npm install
npm run check
npm test
cargo test --manifest-path analyzer/Cargo.toml --all-targets
npm run package
```

Press `F5` from Cursor or VS Code to launch an Extension Development Host after dependencies are installed.

## Native analyzer packaging

Release automation builds `zed-cursor-analyzer` for:

- Linux x64
- macOS x64
- macOS arm64
- Windows x64

Binaries are assembled under `bin/<platform>-<arch>/` before the VSIX is produced. The TypeScript fallback remains available if a binary is absent.

## Distribution

Cursor uses a VS Code-compatible extension model. Release automation produces a VSIX and can publish it to Open VSX when the `OVSX_PAT` repository secret is configured. A VSIX can also be installed manually with `Extensions: Install from VSIX…`.

## Security and trust

The extension reads package manifests, lockfiles, and referenced local dependency paths. It does not transmit workspace contents. It does not read or expose Zed authentication tokens. CLI commands are user initiated, shown in the terminal, and blocked in untrusted workspaces.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Roadmap

- Consume a shared, versioned report schema from `zed-pkg/zed-interfaces`.
- Add registry-backed version drift and vulnerability metadata when authenticated Zed APIs expose stable read-only endpoints.
- Visualize the dependency graph and explain why a dependency is present.
- Add lockfile-aware package update previews and safe manifest edits.
- Integrate Zed CLI structured JSON output as those commands become available.
