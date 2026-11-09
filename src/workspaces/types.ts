import { z } from "zod";
import { WORKSPACE_ID_PATTERN } from "../runtime/protocol.js";
import { isSafeRefName } from "./git.js";

export type WorkspaceStatus = "preparing" | "ready" | "busy" | "failed";
export type SetupStatus = "skipped" | "running" | "passed" | "failed";

export interface Workspace {
  id: string;
  status: WorkspaceStatus;
  repository: { cloneUrl: string; defaultBranch: string };
  branch: string;
  baseSha: string | null;
  headSha: string | null;
  repoPath: string;
  handoffPath: string;
  setup: { status: SetupStatus; exitCode: number | null; logTail: string };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Persisted form: never contains tokens. */
export interface StoredWorkspace extends Workspace {
  baseRef: string;
  gitIdentity: { name: string; email: string };
}

export interface HandoffEntry {
  name: string;
  size: number;
  updatedAt: string;
}

export interface DiffFile {
  path: string;
  status: "M" | "A" | "D" | "R";
  insertions: number;
  deletions: number;
}

export interface WorkspaceDiff {
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  insertions: number;
  deletions: number;
  uncommitted: boolean;
  commits: Array<{ sha: string; subject: string }>;
  patch: string;
  truncated: boolean;
}

export interface PublishResult {
  branch: string;
  headSha: string;
  baseSha: string;
  commits: number;
  insertions: number;
  deletions: number;
  files: number;
}

export const WORKSPACE_BRANCH_PATTERN = /^slab\/[A-Za-z0-9._/-]{1,120}$/;
export const HANDOFF_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/;
export const HANDOFF_MAX_BYTES = 2 * 1024 * 1024;
export const SETUP_LOG_TAIL_CHARS = 4_000;
export const DIFF_PATCH_MAX_BYTES = 1024 * 1024;
export const DEFAULT_FORBIDDEN_PATHS = [".github/workflows/", ".gitmodules"];
export const SHA1_PATTERN = /^[0-9a-f]{40}$/;

const refName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isSafeRefName, "Invalid git ref name");

// No control characters: these values end up in git config.
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Invalid characters");

const workspaceBranch = z
  .string()
  .regex(WORKSPACE_BRANCH_PATTERN)
  .refine(isSafeRefName, "Invalid git branch name");

export const createWorkspaceSchema = z.object({
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  repository: z.object({
    cloneUrl: z.string().trim().min(1).max(2_048),
    defaultBranch: refName,
  }),
  baseRef: refName.nullish(),
  branch: workspaceBranch,
  fetchToken: z.string().min(1).max(16_384).nullish(),
  setupCommand: z.string().trim().min(1).max(20_000).nullish(),
  setupTimeoutSeconds: z.number().int().min(1).max(14_400).default(900),
  gitIdentity: z
    .object({ name: plainText(200), email: plainText(320) })
    .default({ name: "Slab", email: "slab@users.noreply.github.com" }),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

/**
 * `workspace.json` lives in an agent-writable directory. On recovery every
 * field is re-validated with the create-time rules; records that fail are not
 * loaded.
 */
export const storedWorkspaceSchema = z.object({
  id: z.string().regex(WORKSPACE_ID_PATTERN),
  status: z.enum(["preparing", "ready", "busy", "failed"]),
  repository: createWorkspaceSchema.shape.repository,
  branch: workspaceBranch,
  baseSha: z.string().regex(SHA1_PATTERN).nullable(),
  headSha: z.string().regex(SHA1_PATTERN).nullable(),
  repoPath: z.string(),
  handoffPath: z.string(),
  setup: z.object({
    status: z.enum(["skipped", "running", "passed", "failed"]),
    exitCode: z.number().int().nullable(),
    logTail: z.string().max(SETUP_LOG_TAIL_CHARS * 2),
  }),
  error: z.string().max(10_000).nullable(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  baseRef: refName,
  gitIdentity: z.object({ name: plainText(200), email: plainText(320) }),
});

export const publishSchema = z.object({
  /** Must equal the workspace branch; the push target is exactly refs/heads/<branch>. */
  branch: workspaceBranch,
  /** Must equal the workspace baseSha; every commit in baseSha..HEAD is checked. */
  baseSha: z.string().regex(SHA1_PATTERN, "baseSha must be a 40-character hex SHA"),
  pushToken: z.string().min(1).max(16_384),
  remoteUrl: z.string().trim().min(1).max(2_048),
  commitMessage: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .default("Apply pending changes"),
  forbiddenPaths: z
    .array(z.string().min(1).max(500))
    .max(100)
    .default(DEFAULT_FORBIDDEN_PATHS),
});

export type PublishInput = z.infer<typeof publishSchema>;

export const handoffWriteSchema = z.object({ content: z.string() });
