# Slab Runner

Slab Runner is a small local daemon that executes agent turns through registered runtime adapters. The Slab control plane sends an agent definition, a message, a runtime thread identifier, and an allowlist of MCP servers. Runner returns one stable event protocol regardless of the runtime behind it.

Runner ships a stable Codex adapter through `codex app-server`, plus
experimental Claude Agent SDK, Direct API, Gemini CLI, and OpenRouter adapters.
Gemini is consumed only through its documented `stream-json` interface; Runner
never parses its human terminal UI.

```text
Next.js control plane
        |
        | loopback HTTP + SSE
        v
   Slab Runner
        |
        +-----------+-----------+-----------+------------+
        |           |           |           |            |
        v           v           v           v            v
 Codex app-server  Claude SDK  Direct API  Gemini CLI  OpenRouter
        |
        +-- Slab Work MCP
        +-- Slab Docs MCP
```

Runner owns runtime execution only. It does not persist chats, agent definitions, credentials, memory, schedules, product state, or thread mappings.

## Requirements

- Node.js 22 or later
- Codex CLI installed and authenticated for Codex runs
- an Anthropic API key configured in Slab Agents for Claude runs
- Gemini CLI account authorization in Runner-owned storage for Gemini runs
- an OpenRouter API key configured in Slab Agents for OpenRouter runs

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

The default address is `http://127.0.0.1:6990`. Slab Runner accepts
`0.0.0.0` only when a Runner token is configured, for an authenticated private
container network. It does not accept arbitrary interface addresses.

## Configuration

| Variable             | Default                             | Description                                                               |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `RUNNER_HOST`        | `127.0.0.1`                         | Listening interface; only `127.0.0.1`, `::1`, or `localhost` are accepted |
| `RUNNER_PORT`        | `6990`                              | Listening port                                                            |
| `CODEX_BIN`          | `codex`                             | Codex executable path or name                                             |
| `RUNNER_CODEX_HOME`  | `~/.local/state/slab-runner/codex`  | Dedicated persistent Codex state used only by Slab Runner                 |
| `GEMINI_BIN`         | `gemini`                            | Gemini CLI executable path or name                                        |
| `RUNNER_GEMINI_HOME` | `~/.local/state/slab-runner/gemini` | Dedicated persistent Gemini account state used only by Slab Runner        |
| `RUNNER_TOKEN`       | unset                               | Optional local bearer token, minimum 16 characters                        |
| `RUNNER_TOKEN_FILE`  | unset                               | File containing the bearer token; mutually exclusive with `RUNNER_TOKEN`  |

When `RUNNER_TOKEN` is set, every operational endpoint accepts either `Authorization: Bearer <token>` or `X-Runner-Token: <token>`. `GET /health` remains available for local health probes.

For a container deployment, use:

```dotenv
RUNNER_HOST=0.0.0.0
RUNNER_TOKEN_FILE=/run/secrets/runner_token
RUNNER_CODEX_HOME=/var/lib/slab-runner/codex
RUNNER_GEMINI_HOME=/var/lib/slab-runner/gemini
CODEX_BIN=/usr/local/bin/codex
GEMINI_BIN=/usr/local/bin/gemini
```

Do not publish port `6990` on the host. Slab Agents reaches Runner through the
private Compose network and authenticates with the same token.

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
  "data": [
    {
      "id": "codex",
      "displayName": "Codex",
      "stability": "stable",
      "authModes": ["chatgpt", "api_key", "cloud_provider"],
      "capabilities": {
        "freshThreads": true,
        "threadResume": true,
        "mcpServers": true,
        "mcpToolAllowlist": false,
        "toolApprovals": true,
        "toolLifecycle": true,
        "runtimeWarnings": true,
        "usageReporting": true,
        "cancellation": true,
        "modelSelection": true,
        "modelDiscovery": false,
        "modelValidation": false,
        "contextProfiling": true,
        "budgetIncrementalUsage": true,
        "budgetNativeTokenLimit": false,
        "budgetNativeCostLimit": false
      },
      "available": true,
      "status": "available",
      "reasonCode": "ready",
      "authentication": { "status": "authenticated", "mode": "chatgpt" },
      "checkedAt": "2026-08-24T08:00:00.000Z"
    }
  ]
}
```

The response contains one row per registered adapter. Codex availability comes
from the account exposed by `codex app-server`; process readiness alone is not
enough. Claude reports `authentication_required` at this low-level endpoint
because its encrypted credential is owned by the control plane and supplied
only for the selected run. Settings combines this definition with the latest
server-side Anthropic verification.

Gemini availability requires both the CLI binary and a non-empty official
OAuth credential in the isolated Gemini home. In the packaged stack, use
`sudo slabctl gemini login`; the control plane receives only sanitized account
health and never reads the credential.

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
      },
      "approval": {
        "defaultMode": "deny",
        "tools": {
          "get_issue": "approve",
          "assign_issue": "approve",
          "set_issue_status": "prompt"
        }
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

Runner accepts up to eight uniquely named HTTP(S) MCP servers selected by the
control plane for that run. Credentials are forwarded to the selected runtime
as MCP HTTP headers, held in memory for the active run, and redacted from
normalized events and logs.

Each server may carry a run-scoped tool policy. `approve` executes without an
operator pause, `prompt` requires an approval on runtimes that support it, and
`deny` makes the tool unavailable. Direct API, OpenRouter, and Gemini remove
denied tools from discovery; Codex and Claude also reject denied calls locally
because their provider interfaces cannot guarantee complete tool hiding.
Runtimes without an approval round-trip omit `prompt` tools.

For `runtime.type: "claude"`, the authenticated control plane also supplies an
API-key credential in the private Runner request. Runner replaces it with a
short-lived surrogate before starting the Claude SDK child process. A
loopback-only proxy injects the real key only when forwarding `/v1/*` requests
to the fixed `api.anthropic.com` origin. The real key is never placed in the
agent process environment, prompt, MCP configuration, normalized events, or
journal.

For a new thread, omit `runtimeThreadId` or set it to `null`. Runner emits `thread.created`; the control plane must store its `runtimeThreadId` and send it with the next run. Runner never becomes the source of truth for that mapping.

`budget` is optional. Claude maps `maxCostUsd` to the SDK's enforced
`maxBudgetUsd`. Claude task budgets are advisory, so Runner rejects a Claude
request with `maxTokens`; the control plane must fail closed instead of calling
that a hard token limit. Codex token ceilings are enforced by the control plane
at normalized incremental usage boundaries.

Gemini emits aggregate usage after a Run and exposes no native hard token or
cost ceiling through this CLI path. Runner therefore rejects Gemini Runs that
carry either hard limit before starting the process. Headless Gemini cannot
pause for a Slab approval round-trip: prompt-gated MCP tools are omitted from
that Run, while explicitly approved tools remain visible.

OpenRouter uses the fixed `https://openrouter.ai/api/v1` Chat Completions
endpoint. Runner sends provider routing preferences on every model call and
defaults to providers that support all requested parameters, deny data
collection, and advertise zero data retention. The control plane may explicitly
relax those preferences per workspace. OpenRouter's final streaming usage is
normalized with token counts and provider-reported USD cost for each model call;
the control plane aggregates those call costs for the Run.

The runtime catalog advertises budget enforcement capabilities explicitly. Consumers
must treat a missing budget capability as unsupported so rolling upgrades fail
closed instead of silently dropping a hard limit.

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
- `context.bootstrap`
- `thread.created`
- `assistant.delta`
- `assistant.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `runtime.warning`
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
Runtime-provider invariants and the adapter onboarding path are documented in
[docs/runtime-adapter-contract.md](./docs/runtime-adapter-contract.md).

The main module boundaries are:

- `src/app-server`: Codex process lifecycle and JSON-RPC transport
- `src/adapters`: runtime-specific translation
- `src/runtime`: public protocol, run state, approvals, and event replay
- `src/http`: loopback HTTP and SSE API

Future Kimi, OpenAI API, or other provider support must implement
`RuntimeAdapter` and pass the shared conformance suite without changing the HTTP
contract or normalized event names.
