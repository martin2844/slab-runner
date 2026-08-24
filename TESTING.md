# Testing

Slab Runner uses Vitest for unit and HTTP integration tests. The suite treats the Codex process as a boundary and replaces it with deterministic fakes; this keeps normal tests fast and prevents them from consuming model quota.

```bash
npm test
npm run test:coverage
```

Tests live in `tests/` and use `*.test.ts` names. Test exported behavior rather than private implementation details. Every error path, state transition, and protocol mapping should have a regression test when it changes.

The goal is complete behavioral coverage. New adapter methods need tests for success, protocol errors, process crashes, and invalid ordering. New HTTP endpoints need tests for validation, authentication, and safe error responses.

## Runtime conformance

Every runtime provider must run the reusable black-box suite in
`tests/conformance/runtime-adapter.ts`. The provider supplies a small semantic
driver for its external SDK or process; the suite interacts with the public
`RuntimeAdapter` and asserts normalized behavior.

The suite covers definition and health metadata, fresh/resumed threads, event
normalization, exactly-once tool terminals, warnings, approvals, usage, and
cancellation. Provider-specific tests remain appropriate for authentication and
native configuration translation, but they do not replace conformance.
Capability-specific scenarios are conditional on the adapter's declared
support; the static-definition test still requires every capability to be
present as an explicit boolean.
