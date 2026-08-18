# Slab Runner

Slab Runner is a small local daemon that executes agent turns through registered runtime adapters. The Slab control plane sends an agent definition, a message, a runtime thread identifier, and an allowlist of MCP servers. Runner returns one stable event protocol regardless of the runtime behind it.

The MVP supports Codex through `codex app-server`. It does not parse human-readable CLI output.

```text
Next.js control plane
        |
        | loopback HTTP + SSE
        v
   Slab Runner
        |
        | JSON-RPC over stdio
        v
 Codex app-server
        |
        +-- Slab Work MCP
        +-- Slab Docs MCP
```

Runner owns runtime execution only. It does not persist chats, agent definitions, credentials, memory, schedules, product state, or thread mappings.

## Requirements

- Node.js 22 or later
- Codex CLI installed and authenticated

## Run locally

```bash
npm install
npm run dev
```

Build and run the installed form:

```bash
npm run build
npm start
```

The package also exposes:

```bash
slab-runner start
```

The default address is `http://127.0.0.1:6990`. Slab Runner refuses non-loopback host values.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RUNNER_HOST` | `127.0.0.1` | Listening interface; only `127.0.0.1`, `::1`, or `localhost` are accepted |
| `RUNNER_PORT` | `6990` | Listening port |
| `CODEX_BIN` | `codex` | Codex executable path or name |
| `RUNNER_CODEX_HOME` | `~/.local/state/slab-runner/codex` | Dedicated persistent Codex state used only by Slab Runner |
| `RUNNER_TOKEN` | unset | Optional local bearer token, minimum 16 characters |

When `RUNNER_TOKEN` is set, every operational endpoint accepts either `Authorization: Bearer <token>` or `X-Runner-Token: <token>`. `GET /health` remains available for local health probes.

Runner starts Codex with `RUNNER_CODEX_HOME`, not the user's primary
`~/.codex` directory. On first startup it copies file-based Codex
authentication into that private directory and writes a managed config without
MCP servers. Work, Docs, and integration MCP definitions are supplied per run by
the control plane, so global Codex MCP entries cannot become agent tools.

## HTTP API

### Health

```http
GET /health
```

```json
{ "status": "ok" }
```

### Runtime availability

```http
GET /runtimes
```

```json
{
  "data": [{ "id": "codex", "available": true }]
}
```

Availability becomes false while Codex is missing, starting, or restarting.

### Create a run

```http
POST /runs
Content-Type: application/json
```

```json
{
  "runId": "run_123",
  "agent": {
    "id": "coo",
    "name": "COO",
    "role": "Own operating cadence and work classification.",
    "instructions": "Use Slab Work and Slab Docs as the source of truth."
  },
  "runtime": {
    "type": "codex",
    "model": null
  },
  "thread": {
    "runtimeThreadId": null
  },
  "message": "Classify the new work items.",
  "mcpServers": [
    {
      "name": "work",
      "url": "http://127.0.0.1:6969/mcp",
      "credentials": {
        "bearerToken": "..."
      }
    },
    {
      "name": "docs",
      "url": "http://127.0.0.1:6980/mcp",
      "credentials": {
        "headers": {
          "X-API-Key": "..."
        }
      }
    }
  ],
  "cwd": null
}
```

The response is immediate:

```json
{ "runId": "run_123", "status": "running" }
```

Only the control-plane server names `work`, `docs`, and `posthog` are accepted in the MVP. Credentials are forwarded to Codex as MCP HTTP headers, held in memory for the active run, and redacted from normalized events and logs.

For a new thread, omit `runtimeThreadId` or set it to `null`. Runner emits `thread.created`; the control plane must store its `runtimeThreadId` and send it with the next run. Runner never becomes the source of truth for that mapping.

`cwd` is optional. Without it, Codex runs in an empty directory under the system temporary directory rather than in the Runner repository. A future coding agent can provide an existing absolute project path explicitly.

The parser also accepts the current control-plane aliases (`run_id`, `runtime_thread_id`, `prompt`, and `mcp_servers`) during migration. The emitted protocol always uses the canonical format below.

### Stream events

```http
GET /runs/run_123/events
Accept: text/event-stream
```

Every SSE message includes an incremental `id`, an SSE `event` matching `type`, and a JSON body:

```text
id: 3
event: assistant.delta
data: {"id":3,"type":"assistant.delta","runId":"run_123","timestamp":"...","data":{"delta":"Hello"}}
```

The normalized event types are:

- `run.started`
- `thread.created`
- `assistant.delta`
- `assistant.completed`
- `tool.started`
- `tool.completed`
- `approval.required`
- `approval.resolved`
- `usage.updated`
- `run.completed`
- `run.failed`
- `run.cancelled`

Runner keeps a bounded in-memory replay buffer so a client can connect after `POST /runs` without losing early events. `Last-Event-ID` resumes after the supplied event ID. Completed run buffers expire after 15 minutes.

### Cancel a run

```http
DELETE /runs/run_123
```

Cancellation maps to Codex `turn/interrupt`. Runner emits `run.cancelled` after the runtime confirms interruption. Cancelling before a turn starts prevents that turn from being created.

### Resolve an approval

```http
POST /runs/run_123/approvals/approval_123
Content-Type: application/json

{ "decision": "approve" }
```

The other decision is `deny`. Native Codex request identifiers and decision names are not exposed to the control plane.

## Errors

Failures are normalized and never include stack traces:

```json
{
  "type": "run.failed",
  "data": {
    "error": {
      "code": "RUNTIME_UNAVAILABLE",
      "message": "Codex runtime is unavailable"
    }
  }
}
```

Runtime error codes include:

- `RUNTIME_UNAVAILABLE`
- `RUNTIME_CRASHED`
- `THREAD_NOT_FOUND`
- `MCP_CONNECTION_FAILED`
- `RUN_CANCELLED`
- `APPROVAL_FAILED`
- `UNKNOWN_RUNTIME_ERROR`

## Codex lifecycle

Runner starts one long-running `codex app-server --stdio` child process and performs the required `initialize` / `initialized` handshake. Requests and notifications use newline-delimited JSON-RPC messages.

If app-server exits, Runner:

1. marks active runs as `RUNTIME_CRASHED`;
2. rejects pending native requests;
3. restarts Codex with capped exponential backoff;
4. restores runtime availability after a fresh handshake.

Partially executed turns are never replayed automatically.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
```

Normal tests use a deterministic app-server transport double and do not consume Codex quota. See [TESTING.md](./TESTING.md) for conventions.

The complete product requirements are preserved in [docs/PRD.md](./docs/PRD.md).

The main module boundaries are:

- `src/app-server`: Codex process lifecycle and JSON-RPC transport
- `src/adapters`: runtime-specific translation
- `src/runtime`: public protocol, run state, approvals, and event replay
- `src/http`: loopback HTTP and SSE API

Future Kimi, Claude, OpenAI API, or Anthropic API support should implement `RuntimeAdapter` without changing the HTTP contract or normalized event names.
