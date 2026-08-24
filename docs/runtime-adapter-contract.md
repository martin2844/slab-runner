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
traces.

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

- `mcpToolAllowlist: false`: Codex receives approval policy per MCP tool, but
  Runner does not enforce a visibility allowlist inside the server;
- `modelDiscovery: false` and `modelValidation: false`: a configured model is
  passed to Codex, but Runner does not yet enumerate or pre-validate Codex
  models.

All other declared Codex capabilities are exercised by the shared conformance
suite. These limitations are visible metadata, not hidden assumptions.
