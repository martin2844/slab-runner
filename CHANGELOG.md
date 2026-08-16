# Changelog

All notable changes to Slab Runner are documented in this file.

## [0.1.0] - 2026-08-16

### Added

- Run Codex agents through a loopback-only HTTP API without exposing the native Codex protocol to callers.
- Stream normalized lifecycle, assistant, tool, approval, usage, failure, and cancellation events over SSE.
- Create and resume Codex threads with per-run Work and Docs MCP configuration.
- Restart a crashed Codex app-server and fail interrupted runs without persisting runtime state or credentials.
