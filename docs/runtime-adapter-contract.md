# Runtime adapter contract

`RuntimeAdapter` is Slab Runner's provider boundary. The control plane speaks
one execution protocol; each adapter translates that protocol to one runtime
without leaking provider-specific requests, events, or approval values.

The source-of-truth interface is [`src/runtime/adapter.ts`](../src/runtime/adapter.ts).
The black-box acceptance suite is
[`tests/conformance/runtime-adapter.ts`](../tests/conformance/runtime-adapter.ts).

## Static definition

Every adapter publishes a sanitized `RuntimeDefinition`:

- a stable lowercase `id` used by `runtime.type`;
- a human-readable `displayName`;
- `stable` or `experimental` maturity;
- supported authentication modes, never credentials;
- every capability flag in `runtimeCapabilityKeys`.

Capabilities are explicit so absence is observable. A provider must not claim a
capability that its adapter cannot enforce. The definition is returned by
`GET /runtimes` and copied into `run.started` for auditability.

The shared suite always verifies identity, health, process lifecycle, and basic
assistant completion. Capability-specific scenarios run only when the adapter
declares that capability. Product policy can therefore distinguish a truthful
experimental adapter from a stable adapter with the complete operational set.

Health is dynamic and separate from identity. It reports availability,
authentication state, a bounded reason code, and the check timestamp. Health
responses must not contain account PII, tokens, provider payloads, or stack
traces. Runner supplies an abort signal to bound probes; adapters must pass it
to their provider transport so a timed-out check releases pending resources and
a later probe can recover.

An adapter that requires no provider authentication declares `none`; an empty
authentication-mode list is not an implicit no-auth mode.

## Execution lifecycle

Runner selects an adapter from its server-side registry. A syntactically valid
but unregistered runtime is rejected before a run is accepted.

```text
POST /runs
  -> registered adapter
  -> startThread | resumeThread
  -> runTurn
  -> normalized events
  -> one terminal run event
```

`startThread` creates isolated provider state. `resumeThread` resumes only the
runtime thread ID supplied by the control plane. Runner does not decide product
continuity and does not persist thread mappings.

The adapter must use only the MCP servers and approval configuration supplied
in the run request. It may not add globally configured servers or expose
credentials in normalized events. MCP capability is a per-run snapshot.

Runner owns `run.*`, `thread.created`, and `context.bootstrap`. Adapters may
emit only assistant, tool, runtime-warning, approval, and usage events through
`RuntimeEventSink`. Runner rejects an adapter that attempts to spoof its
manager-owned lifecycle so in-memory status, durable history, and replay cannot
diverge.

## Normalized invariants

Adapters must preserve these invariants regardless of native provider behavior:

- assistant output uses `assistant.delta` and `assistant.completed`;
- every `tool.started` terminates exactly once as `tool.completed` or
  `tool.failed`;
- a native failed terminal becomes `tool.failed` with
  `reason: provider_reported_failure`;
- a missing native terminal tool event becomes `tool.failed` with
  `reason: terminal_event_missing`;
- recoverable provider errors are sanitized `runtime.warning` events and do not
  automatically fail the run;
- usage uses `usage.updated` with normalized input, cached, uncached, output,
  and context-window fields when the provider supplies them;
- approvals use Slab approval IDs and `approve | deny`, not native IDs or
  decision names;
- cancellation settles as normalized `RUN_CANCELLED` only after the adapter has
  asked the provider to interrupt;
- provider errors become bounded `RunnerError` codes without stack traces;
- a turn and a run each settle once.

## Adding a provider

1. Implement `RuntimeAdapter` in `src/adapters`.
2. Register it once in the runner composition root.
3. Add a semantic driver for the provider's external SDK/process.
4. Run the shared conformance suite against the real adapter boundary.
5. Add provider-specific tests only for behavior outside the shared contract,
   such as authentication or native configuration translation.

Do not edit the HTTP protocol or normalized event names merely to accommodate a
provider. Extend the shared contract only when the new concept is meaningful to
all consumers.

## Codex baseline

Codex is the first conforming adapter. It currently declares two limitations:

- `mcpToolAllowlist: false`: Codex receives approval policy per MCP tool and
  Runner rejects denied requests, but the provider does not expose a complete
  visibility allowlist;
- `modelDiscovery: false` and `modelValidation: false`: a configured model is
  passed to Codex, but Runner does not yet enumerate or pre-validate Codex
  models.

All other declared Codex capabilities are exercised by the shared conformance
suite. These limitations are visible metadata, not hidden assumptions.

## Claude experimental adapter

Claude uses the official Claude Agent SDK and the same normalized lifecycle as
Codex. The control plane owns the encrypted Anthropic API key, verifies it with
the bounded Models API, and supplies it only on the private per-run request.
Runner does not put that key in the spawned agent process. Instead it creates a
short-lived surrogate and a loopback-only credential proxy whose upstream is
fixed to `api.anthropic.com`.

The adapter translates SDK assistant, tool, usage, retry, approval, and
cancellation events. It uses a host-selected `sessionId` for fresh execution
and `resume` only when the control plane explicitly supplies a prior chat
thread. Provider authentication failures use
`RUNTIME_AUTHENTICATION_REQUIRED`; other provider failures remain bounded
`RUNTIME_CRASHED` errors. Claude remains experimental until real deployment
acceptance proves its complete MCP and approval semantics.

Claude currently declares `mcpToolAllowlist: false`. Run-scoped MCP server
assignment and per-tool approval policies are enforced, including immediate
local rejection for denied tools, but the SDK permission options do not remove
unlisted tools from the model-visible server catalog.
Result usage is emitted as an explicit Run aggregate with the provider turn
count; consumers must not derive per-call initial or peak context from it.

The loopback credential proxy applies a bounded upstream timeout and destroys
active Anthropic requests when the downstream disconnects or Runner shuts
down.

## Direct API experimental adapter

Direct API is a server-side tool loop for providers that expose either the
OpenAI Responses API or an OpenAI-compatible Chat Completions API. The control
plane supplies an operator-configured base URL, protocol, model, and write-only
API key on the private Run request. The base URL and credential never become
model input, MCP tool arguments, capability-snapshot metadata, or normalized
events. Provider redirects are disabled.

The adapter converts only the MCP servers assigned to that Run into provider
function definitions. Provider function arguments are parsed as JSON objects;
invalid arguments fail terminally and are never forwarded to MCP. MCP calls
remain subject to the per-server tool policy. Denied tools are removed from the
model-visible function list and rejected locally if a provider still requests
one; every dispatched call is wrapped in exactly one normalized
started/terminal lifecycle. The model cannot construct an arbitrary HTTP
request through this adapter.

Responses are requested with provider storage disabled. Chat continuity is
implemented by control-plane conversation rehydration, while non-chat Runs
remain fresh. The logical runtime thread ID is therefore audit identity rather
than provider-side retained state.

Usage is normalized once per provider model call. Hard token and priced cost
limits are enforced at each reported usage boundary; a provider that omits
usage fails closed when a hard limit is active. Direct API does not claim a
native token or cost ceiling, and an upstream call can cross a limit before its
terminal usage becomes observable. `mcpToolAllowlist` is true because explicit
deny rules remove tools from both Responses and Chat Completions definitions.

## Gemini CLI experimental adapter

Gemini uses the official CLI's newline-delimited `stream-json` protocol. The
adapter accepts only bounded JSON events and rejects human-readable or
oversized output. It maps assistant messages, MCP tool use/results, runtime
errors, aggregate usage, cancellation, and terminal completion to the shared
contract. Any tool still open when the process ends receives exactly one
`tool.failed` event with `terminal_event_missing`.

Each Run receives a protected temporary system-settings file and admin policy.
Only its run-scoped MCP servers are configured, Gemini built-ins are disabled,
and tools permitted by the server's Slab approval policy are filtered before
discovery. MCP credentials exist only in that mode-0600 temporary file, are
redacted from events, and are deleted at Run termination.

Google OAuth state is runtime-owned under `RUNNER_GEMINI_HOME`. Health checks
report only authenticated/required state and never credential contents.
Headless Gemini does not provide a reliable Slab approval callback, so the
adapter declares `toolApprovals: false`: prompt-gated tools are unavailable
rather than silently approved. Usage is a Run aggregate and the CLI exposes no
native hard cost/token cap; hard-budget requests fail before process creation.
Gemini remains experimental until a real account-authenticated deployment
exercise proves provider execution and MCP behavior.
