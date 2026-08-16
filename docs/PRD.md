# Slab Runner MVP PRD

## Summary

Slab Runner is a local daemon responsible only for executing agent runtimes. The control plane must not know the internal protocol of Codex or future runtimes. Runner exposes one uniform HTTP and event interface.

The MVP path is:

```text
Next.js App -> localhost HTTP -> Slab Runner -> Codex app-server
                                                   |-> Slab Work MCP
                                                   |-> Slab Docs MCP
```

## Responsibility

Runner answers one request: execute this agent, in this runtime thread, with this message and these allowed tools.

Runner does not own Work, Docs, UI, scheduling, persistent agent definitions, business state, memory, CRM, or product decisions.

## Runtime

The MVP supports Codex only and must integrate through `codex app-server`, never by parsing human-readable `codex` output.

The architecture must allow future Kimi, Claude, OpenAI API, and Anthropic API adapters without changing the protocol between Next.js and Runner.

The Codex adapter must support:

- creating and resuming threads;
- starting and cancelling turns;
- streaming assistant output;
- observing tool activity;
- receiving and resolving approvals;
- detecting completion and errors.

## Stack and process

- Node.js and TypeScript
- a small Express HTTP server
- Zod validation
- child processes
- SSE from Runner to Next.js
- no database, Docker, Redis, or external queue

Development starts with `npm run dev`. The built form starts with `slab-runner start` and listens on `127.0.0.1:6990` by default. It must never default to `0.0.0.0`.

Configuration:

```dotenv
RUNNER_HOST=127.0.0.1
RUNNER_PORT=6990
CODEX_BIN=codex
RUNNER_TOKEN=
```

## Runtime adapter

The conceptual adapter interface is:

```text
health()
startThread()
resumeThread()
runTurn()
cancelRun()
respondToApproval()
shutdown()
```

Codex details remain inside `CodexAdapter`. Next.js never sends Codex commands or consumes native Codex events.

## Execution request

```json
{
  "runId": "...",
  "agent": {
    "id": "...",
    "name": "COO",
    "role": "...",
    "instructions": "..."
  },
  "runtime": {
    "type": "codex",
    "model": null
  },
  "thread": {
    "runtimeThreadId": null
  },
  "message": "...",
  "mcpServers": []
}
```

Runner does not persist the request after its short in-memory retention window.

## MCP servers

Runner supplies only the MCP servers allowed for an execution. The MVP names are `work` and `docs`. A definition contains a name, URL, and credentials.

Credentials must never appear in logs, normalized events, UI errors, or stack traces. The design must allow different server permissions by agent later, although every MVP agent may receive Work and Docs.

## HTTP API

- `GET /health`
- `GET /runtimes`
- `POST /runs`
- `GET /runs/:runId/events`
- `DELETE /runs/:runId`
- `POST /runs/:runId/approvals/:approvalId`

Creating a run returns immediately with its identifier and `running` status. Streaming occurs over the separate SSE endpoint.

## Normalized events

The minimum event vocabulary is:

```text
run.started
thread.created
assistant.delta
assistant.completed
tool.started
tool.completed
approval.required
approval.resolved
usage.updated
run.completed
run.failed
run.cancelled
```

The UI consumes Slab Runner events, never native Codex events.

## Thread mapping

When `runtimeThreadId` is null, Runner creates a thread and emits `thread.created` with the runtime identifier. Next.js persists that identifier and supplies it on later runs. Next.js, not Runner, is the source of truth for the mapping.

## Codex app-server lifecycle

Runner maintains one long-running local `codex app-server` process:

```text
locate Codex -> spawn app-server -> initialize -> ready
```

If app-server crashes, current runs fail, the process restarts, and availability recovers. Runner does not replay a partially executed turn.

## Approvals

Runner holds active approval state in memory. It emits `approval.required`, waits for the control plane to send `approve` or `deny`, maps that decision to the native runtime response, and emits `approval.resolved`.

## Errors

Minimum normalized codes:

```text
RUNTIME_UNAVAILABLE
RUNTIME_CRASHED
THREAD_NOT_FOUND
MCP_CONNECTION_FAILED
RUN_CANCELLED
APPROVAL_FAILED
UNKNOWN_RUNTIME_ERROR
```

User-facing responses do not contain stack traces by default.

## Security

- Bind only to loopback.
- Optionally require a local Runner token.
- Never expose Codex directly.
- Never persist secrets.
- Never provide an arbitrary process execution endpoint.
- Execute only through a registered `RuntimeAdapter`.
- Keep the default CWD outside any project workspace.

An explicit absolute CWD remains possible for a future coding agent, but it is not required for the MVP.

## Memory, scheduling, and multi-agent behavior

Runner implements no memory and stores no chats, facts, summaries, or embeddings. Continuity comes from the runtime thread, control-plane history, Slab Docs, and Slab Work.

Runner does not know about cron jobs. Manual and automated execution both use `POST /runs`.

Runner does not coordinate agents. COO, Sales, and DataOps runs remain independent; coordination belongs in Slab work items, Next.js, or future orchestration logic.

## Definition of done

The MVP is complete when:

1. Runner starts locally and detects Codex availability.
2. Runner starts and initializes `codex app-server`.
3. Next.js can create a run.
4. Runner creates a Codex thread and resumes it on a later message.
5. Assistant output and tool activity stream as normalized events.
6. Runner waits for approvals and forwards approve or deny decisions.
7. Codex can use the allowed remote Work and Docs MCP servers.
8. Completion and errors use the normalized protocol.
9. A Codex crash does not require a manual Runner restart.
10. Secrets never appear in logs.
11. Next.js needs no knowledge of the Codex protocol.

## Non-goals

The MVP does not implement scheduling, persistent queues, remote or distributed runners, Docker, agent memory, Honcho, business logic, Work, Docs, Gmail, webhooks, non-Codex adapters, multi-agent planning, or permanently alive background agents.

## Architectural principle

Slab Runner should be replaceable and boring:

```text
Agent Definition + Input + Runtime + MCP Tools -> Execution -> Normalized Events
```

The control plane decides what to do. The runtime reasons. MCP servers provide capabilities. Runner only connects those pieces.
