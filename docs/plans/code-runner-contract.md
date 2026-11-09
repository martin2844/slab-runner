# Code runner HTTP contract (v1)

The shared contract between slab-agents (client) and slab-runner with `RUNNER_PROFILE=code`.
Both sides implement exactly this. All endpoints require the runner token (same
`Authorization: Bearer` / `X-Runner-Token` rules as today). All errors use the existing
`{ error: { code, message } }` shape.

## Configuration (runner)

| Env | Default | Meaning |
|---|---|---|
| `RUNNER_PROFILE` | `agent` | `code` enables everything below |
| `RUNNER_CODE_ROOT` | `/var/lib/slab-code` (container) / `~/.local/state/slab-runner/code` (local) | Root for workspaces |
| `RUNNER_MAX_ACTIVE_RUNS` | `2` | Concurrent runs; over the limit → `429 RUNNER_AT_CAPACITY` |
| `RUNNER_GIT_ALLOW_FILE_REMOTES` | unset | `1` allows `file://` clone URLs (tests and local dev only) |

`GET /health` additionally returns `"profile": "agent" | "code"`.

Layout: `<root>/workspaces/<workspaceId>/repo` (git checkout) and
`<root>/workspaces/<workspaceId>/handoff` (stage files, never committed).

## Workspace object

```json
{
  "id": "ws_abc",
  "status": "preparing | ready | busy | failed",
  "repository": { "cloneUrl": "https://github.com/o/r.git", "defaultBranch": "main" },
  "branch": "slab/cc-42-4",
  "baseSha": "40-hex or null while preparing",
  "headSha": "40-hex or null",
  "repoPath": "/var/lib/slab-code/workspaces/ws_abc/repo",
  "handoffPath": "/var/lib/slab-code/workspaces/ws_abc/handoff",
  "setup": { "status": "skipped | running | passed | failed", "exitCode": 0, "logTail": "last 4000 chars" },
  "error": null,
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

`busy` = a run or a publish holds the workspace lock.

## Endpoints

### `POST /workspaces` → `202 { data: Workspace }`

```json
{
  "workspaceId": "ws_abc",                         // ^[a-zA-Z0-9_-]{1,80}$; idempotent: same id returns the existing workspace (200)
  "repository": { "cloneUrl": "https://github.com/o/r.git", "defaultBranch": "main" },
  "baseRef": "main",                               // branch to start from; default = defaultBranch
  "branch": "slab/cc-42-4",                        // ^slab/[A-Za-z0-9._/-]{1,120}$
  "fetchToken": "ghs_... | null",                  // used only during clone, via a command-line credential helper; never persisted
  "setupCommand": "pnpm install --frozen-lockfile | null",
  "setupTimeoutSeconds": 900,
  "gitIdentity": { "name": "Slab", "email": "slab@users.noreply.github.com" }
}
```

`cloneUrl` must be `https://github.com/<owner>/<repo>(.git)` (or `file://` when allowed).
Preparation is asynchronous: clone (`--single-branch` of `baseRef`), `git switch -c <branch>`,
remove `origin`, set `user.name`/`user.email` locally, create `handoff/`, run setup with
`sh -c` in `repo/` (timeout; output kept in `setup.logTail`). A setup failure leaves the
workspace `ready` with `setup.status = failed` (agents can still work and fix it); a clone
failure sets `failed` with `error`. Setup finishes when its shell exits (a background child
holding the output does not delay it); processes it leaves behind are killed.

After a restart each `workspace.json` is re-validated with the create-time rules (plus
`baseSha`/`headSha` format); records that fail are not loaded (404; DELETE still removes the
directory and POST recreates it).

### `GET /workspaces` → `{ data: Workspace[] }`
### `GET /workspaces/:id` → `{ data: Workspace }` (404 `WORKSPACE_NOT_FOUND`)
### `DELETE /workspaces/:id` → `{ data: { id, deleted: true } }`

Cancels any active run on it, kills processes left in the workspace, then removes the directory.
Idempotent (404 → still `deleted: true`). While the removal is in progress, `POST /workspaces`
with the same id answers 409 `WORKSPACE_BUSY`.

### `GET /workspaces/:id/handoff` → `{ data: [{ name, size, updatedAt }] }`
### `GET /workspaces/:id/handoff/:name` → `{ data: { name, content, updatedAt } }` (404 `HANDOFF_NOT_FOUND`)
### `PUT /workspaces/:id/handoff/:name` body `{ content }` → `{ data: { name, size, updatedAt } }`

`name` matches `^[a-z0-9][a-z0-9._-]{0,80}# Code runner HTTP contract (v1)

The shared contract between slab-agents (client) and slab-runner with `RUNNER_PROFILE=code`.
Both sides implement exactly this. All endpoints require the runner token (same
`Authorization: Bearer` / `X-Runner-Token` rules as today). All errors use the existing
`{ error: { code, message } }` shape.

## Configuration (runner)

| Env | Default | Meaning |
|---|---|---|
| `RUNNER_PROFILE` | `agent` | `code` enables everything below |
| `RUNNER_CODE_ROOT` | `/var/lib/slab-code` (container) / `~/.local/state/slab-runner/code` (local) | Root for workspaces |
| `RUNNER_MAX_ACTIVE_RUNS` | `2` | Concurrent runs; over the limit → `429 RUNNER_AT_CAPACITY` |
| `RUNNER_GIT_ALLOW_FILE_REMOTES` | unset | `1` allows `file://` clone URLs (tests and local dev only) |

`GET /health` additionally returns `"profile": "agent" | "code"`.

Layout: `<root>/workspaces/<workspaceId>/repo` (git checkout) and
`<root>/workspaces/<workspaceId>/handoff` (stage files, never committed).

## Workspace object

```json
{
  "id": "ws_abc",
  "status": "preparing | ready | busy | failed",
  "repository": { "cloneUrl": "https://github.com/o/r.git", "defaultBranch": "main" },
  "branch": "slab/cc-42-4",
  "baseSha": "40-hex or null while preparing",
  "headSha": "40-hex or null",
  "repoPath": "/var/lib/slab-code/workspaces/ws_abc/repo",
  "handoffPath": "/var/lib/slab-code/workspaces/ws_abc/handoff",
  "setup": { "status": "skipped | running | passed | failed", "exitCode": 0, "logTail": "last 4000 chars" },
  "error": null,
  "createdAt": "ISO", "updatedAt": "ISO"
}
```

`busy` = a run or a publish holds the workspace lock.

## Endpoints

### `POST /workspaces` → `202 { data: Workspace }`

```json
{
  "workspaceId": "ws_abc",                         // ^[a-zA-Z0-9_-]{1,80}$; idempotent: same id returns the existing workspace (200)
  "repository": { "cloneUrl": "https://github.com/o/r.git", "defaultBranch": "main" },
  "baseRef": "main",                               // branch to start from; default = defaultBranch
  "branch": "slab/cc-42-4",                        // ^slab/[A-Za-z0-9._/-]{1,120}$
  "fetchToken": "ghs_... | null",                  // used only during clone, via a command-line credential helper; never persisted
  "setupCommand": "pnpm install --frozen-lockfile | null",
  "setupTimeoutSeconds": 900,
  "gitIdentity": { "name": "Slab", "email": "slab@users.noreply.github.com" }
}
```

`cloneUrl` must be `https://github.com/<owner>/<repo>(.git)` (or `file://` when allowed).
Preparation is asynchronous: clone (`--single-branch` of `baseRef`), `git switch -c <branch>`,
remove `origin`, set `user.name`/`user.email` locally, create `handoff/`, run setup with
`sh -c` in `repo/` (timeout; output kept in `setup.logTail`). A setup failure leaves the
workspace `ready` with `setup.status = failed` (agents can still work and fix it); a clone
failure sets `failed` with `error`.

### `GET /workspaces` → `{ data: Workspace[] }`
### `GET /workspaces/:id` → `{ data: Workspace }` (404 `WORKSPACE_NOT_FOUND`)
### `DELETE /workspaces/:id` → `{ data: { id, deleted: true } }`

Cancels any active run on it, kills processes left in the workspace, then removes the directory.
Idempotent (404 → still `deleted: true`). While the removal is in progress, `POST /workspaces`
with the same id answers 409 `WORKSPACE_BUSY`.

### `GET /workspaces/:id/handoff` → `{ data: [{ name, size, updatedAt }] }`
### `GET /workspaces/:id/handoff/:name` → `{ data: { name, content, updatedAt } }` (404 `HANDOFF_NOT_FOUND`)
### `PUT /workspaces/:id/handoff/:name` body `{ content }` → `{ data: { name, size, updatedAt } }`

. Max 2 MB. UTF-8 text. Only regular files with a
single link are listed or read (symlinks, hardlinks and other file types are skipped / 404
`HANDOFF_NOT_FOUND`), opened with `O_NOFOLLOW` and read from the verified descriptor. If the
handoff directory itself is not a real directory (e.g. a symlink), list returns `[]`, read returns
404 and write returns 409 `WORKSPACE_STATE_MISMATCH`.

### `GET /workspaces/:id/diff` → `{ data: Diff }`

```json
{
  "baseSha": "...", "headSha": "...",
  "files": [{ "path": "src/a.ts", "status": "M|A|D|R", "insertions": 3, "deletions": 1 }],
  "insertions": 10, "deletions": 4,
  "uncommitted": true,
  "commits": [{ "sha": "...", "subject": "..." }],
  "patch": "unified diff of baseSha..worktree, truncated to 1 MB",
  "truncated": false
}
```

Includes uncommitted changes (diff of `baseSha` against the working tree, untracked files included via `git add -N` equivalent / intent-to-add on a temporary index). When no run
holds the workspace, processes left in it are killed first.

### `POST /workspaces/:id/publish` → `{ data: PublishResult }`

```json
{
  "branch": "slab/cc-42-4",                            // required; ^slab/[A-Za-z0-9._/-]{1,120}$ and a safe ref name
  "baseSha": "40-hex",                                 // required; the baseSha returned by POST/GET /workspaces
  "pushToken": "ghs_...",
  "remoteUrl": "https://github.com/o/r.git",
  "commitMessage": "[CC-42] Apply pending changes",   // used only if there are uncommitted changes
  "forbiddenPaths": [".github/workflows/", ".gitmodules"] // path prefixes; default shown
}
```

`branch` and `baseSha` are the control plane's own record of the workspace; the runner does not
trust its `workspace.json` (it lives in an agent-writable directory). Missing or malformed →
400 `INVALID_REQUEST`; different from the workspace's branch or baseSha → 409
`WORKSPACE_STATE_MISMATCH`.

Steps:

1. Take the lock (409 `WORKSPACE_BUSY` if a run is active) and kill processes left in the
   workspace.
2. In the checkout, commit uncommitted changes (`git add -A`, `commit --no-verify`, hooks
   disabled, no credential in the environment).
3. Create a fresh bare repository in a private temporary directory outside the workspace and
   fetch the checkout's `HEAD` and `baseSha` into it (local fetch, no credentials). If `baseSha`
   is not in the checkout → 409 `WORKSPACE_STATE_MISMATCH`.
4. In that repository, list the changed paths of **every** commit in `baseSha..HEAD`
   (`git diff-tree -r -m --root --no-renames`, merges against each parent) plus the
   end-to-end `baseSha..HEAD` diff; if any path starts with a forbidden prefix → 422
   `PUBLISH_POLICY_VIOLATION` with `details: [paths]`.
5. From that repository, `git push --force <remoteUrl> <headSha>:refs/heads/<branch>` with the
   token passed through a command-line credential helper (force is allowed because the branch
   is owned by the run). Push failure → 502 `GIT_PUSH_FAILED` with a sanitized message. The
   temporary repository is deleted afterwards.

Every git command the runner runs uses `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_NO_REPLACE_OBJECTS=1`, no inherited `GIT_*` variables and `core.hooksPath=/dev/null`.

```json
{ "branch": "slab/cc-42-4", "headSha": "...", "baseSha": "...", "commits": 3,
  "insertions": 10, "deletions": 4, "files": 6 }
```

### Runs: `POST /runs` additions

```json
{ "...existing fields...": "...",
  "workspace": { "id": "ws_abc" },
  "limits": { "wallClockSeconds": 3600 } }
```

- In the code profile `workspace` is required: a run without it (plain `cwd` run) → 400
  `WORKSPACE_REQUIRED`.
- `workspace` requires `RUNNER_PROFILE=code` (else 400 `PROFILE_NOT_ENABLED`). With
  `workspace`, `cwd` must be null; the runner uses `<workspace>/repo`.
- Workspace must be `ready` (409 `WORKSPACE_NOT_READY` / `WORKSPACE_BUSY`). The run holds the
  lock until it ends; on its terminal state every process whose working directory is inside the
  workspace (other than the runner and its ancestors) is killed before the lock is released
  (Linux, via `/proc`; a no-op elsewhere).
- Only the `codex` runtime is supported with a workspace (400 `RUNTIME_UNSUPPORTED_FOR_PROFILE`).
- Codex thread params for workspace runs: `cwd = repoPath`, `approvalPolicy: "never"`,
  `sandbox: "danger-full-access"` (the container is the sandbox). MCP approval policy unchanged.
- Developer instructions get an extra block: checkout path, handoff path, branch, "no git
  remote; never push; never edit .github/workflows".
- `limits.wallClockSeconds` (default 3600, max 14400): on expiry the run is cancelled and
  the terminal event is `run.failed` with code `RUN_TIME_LIMIT`.
- Thread resume works as today (the control plane passes `thread.runtimeThreadId` to continue
  a stage conversation).
