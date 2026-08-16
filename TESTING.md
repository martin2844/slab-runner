# Testing

Slab Runner uses Vitest for unit and HTTP integration tests. The suite treats the Codex process as a boundary and replaces it with deterministic fakes; this keeps normal tests fast and prevents them from consuming model quota.

```bash
npm test
npm run test:coverage
```

Tests live in `tests/` and use `*.test.ts` names. Test exported behavior rather than private implementation details. Every error path, state transition, and protocol mapping should have a regression test when it changes.

The goal is complete behavioral coverage. New adapter methods need tests for success, protocol errors, process crashes, and invalid ordering. New HTTP endpoints need tests for validation, authentication, and safe error responses.
