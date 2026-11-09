# Changelog

All notable changes to Slab Runner are documented in this file.

## [Unreleased]

### Added

- Code profile (`RUNNER_PROFILE=code`): per-task git workspaces (`/workspaces`), stage handoff files, diffs including uncommitted work, and publishing of the workspace branch with a short-lived token. Publishing refuses changes under `.github/workflows/`.
- Runs can target a workspace (`workspace.id`); Codex then runs in the checkout without per-command approvals, with a wall-clock limit (`RUN_TIME_LIMIT`).
- `RUNNER_MAX_ACTIVE_RUNS` concurrency limit (`429 RUNNER_AT_CAPACITY`).
- Docker `code` build target with git and build tools.

### Security

- Code profile publishing no longer runs credentialed git inside the agent's checkout: changes are committed without credentials or hooks, fetched into a fresh temporary bare repository, and checked and pushed from there. All runner git commands ignore system/global config, replace objects and inherited `GIT_*` variables.
- Tokens are passed through a command-line credential helper instead of an on-disk `GIT_ASKPASS` script under `RUNNER_CODE_ROOT`.
- The forbidden-path check covers every commit in `baseSha..HEAD`; `.gitmodules` is forbidden by default.
- `POST /workspaces/:id/publish` requires `branch` and `baseSha` and answers `409 WORKSPACE_STATE_MISMATCH` when they differ from the workspace; persisted workspace metadata is re-validated on restart.
- Handoff reads skip symlinks, hardlinks and symlinked handoff directories.
- Processes left in a workspace are killed when a run ends, after setup, and before diff and publish; setup completes on process exit.
- Re-creating a workspace while it is being deleted answers `409 WORKSPACE_BUSY`; code-profile runs without a workspace answer `400 WORKSPACE_REQUIRED`.

## [0.1.0] - 2026-08-16

### Added

- Run Codex agents through a loopback-only HTTP API without exposing the native Codex protocol to callers.
- Stream normalized lifecycle, assistant, tool, approval, usage, failure, and cancellation events over SSE.
- Create and resume Codex threads with per-run Work and Docs MCP configuration.
- Restart a crashed Codex app-server and fail interrupted runs without persisting runtime state or credentials.
