import { isAbsolute } from "node:path";
import { z } from "zod";

export const normalizedEventTypes = [
  "run.started",
  "context.bootstrap",
  "thread.created",
  "assistant.delta",
  "assistant.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "runtime.warning",
  "approval.required",
  "approval.resolved",
  "usage.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export type NormalizedEventType = (typeof normalizedEventTypes)[number];

export interface RunnerEvent {
  id: number;
  type: NormalizedEventType;
  runId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface McpServerDefinition {
  name: "work" | "docs" | "posthog" | "email";
  url: string;
  headers: Record<string, string>;
  approval?: {
    defaultMode: "approve" | "prompt";
    tools: Record<string, "approve" | "prompt">;
  };
}

export interface AgentExecutionRequest {
  runId: string;
  agent: {
    id: string;
    name: string;
    role: string;
    instructions: string;
    fullAccess: boolean;
  };
  runtime: {
    type: "codex";
    model: string | null;
  };
  thread: {
    runtimeThreadId: string | null;
  };
  message: string;
  context: Array<{ role: "user" | "assistant"; body: string }>;
  mcpServers: McpServerDefinition[];
  cwd: string | null;
}

const headerSchema = z.record(
  z.string().min(1).max(128),
  z.string().max(8_192),
);

const mcpServerSchema = z
  .object({
    name: z.enum(["work", "docs", "posthog", "email"]),
    url: z.string().url().max(2_048),
    headers: headerSchema.default({}),
    credentials: z
      .object({
        bearerToken: z.string().min(1).max(16_384).optional(),
        headers: headerSchema.optional(),
      })
      .optional(),
    approval: z
      .object({
        defaultMode: z.enum(["approve", "prompt"]),
        tools: z
          .record(z.string().min(1).max(200), z.enum(["approve", "prompt"]))
          .default({}),
      })
      .optional(),
  })
  .superRefine((server, context) => {
    const parsedUrl = new URL(server.url);
    if (!(["http:", "https:"] as string[]).includes(parsedUrl.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "MCP server URLs must use HTTP or HTTPS",
      });
    }
    if (parsedUrl.username || parsedUrl.password) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "MCP credentials must not be embedded in URLs",
      });
    }
  })
  .transform((server) => {
    const headers = {
      ...server.headers,
      ...server.credentials?.headers,
    };
    if (server.credentials?.bearerToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${server.credentials.bearerToken}`;
    }
    return {
      name: server.name,
      url: server.url,
      headers,
      ...(server.approval ? { approval: server.approval } : {}),
    };
  });

const canonicalRequestSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  agent: z.object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(10_000),
    instructions: z.string().trim().min(1).max(100_000),
    fullAccess: z.boolean().default(false),
  }),
  runtime: z.object({
    type: z.literal("codex"),
    model: z.string().trim().min(1).max(200).nullable(),
  }),
  thread: z.object({
    runtimeThreadId: z.string().trim().min(1).max(500).nullable(),
  }),
  message: z.string().trim().min(1).max(200_000),
  context: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        body: z.string().max(200_000),
      }),
    )
    .max(50),
  mcpServers: z
    .array(mcpServerSchema)
    .max(8)
    .refine(
      (servers) =>
        new Set(servers.map(({ name }) => name)).size === servers.length,
      "MCP server names must be unique",
    ),
  cwd: z
    .string()
    .max(4_096)
    .refine(isAbsolute, "cwd must be an absolute path")
    .nullable(),
});

function normalizeMcpServers(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const definitions = value as Record<string, unknown>;
  return Object.entries(definitions).map(([name, definition]) => ({
    ...(definition && typeof definition === "object"
      ? (definition as Record<string, unknown>)
      : {}),
    name,
  }));
}

function normalizeExecutionRequest(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const raw = input as Record<string, unknown>;
  const rawAgent =
    raw.agent && typeof raw.agent === "object"
      ? (raw.agent as Record<string, unknown>)
      : {};
  const rawRuntime =
    raw.runtime && typeof raw.runtime === "object"
      ? (raw.runtime as Record<string, unknown>)
      : {};
  const rawThread =
    raw.thread && typeof raw.thread === "object"
      ? (raw.thread as Record<string, unknown>)
      : {};
  const runtimeType =
    typeof raw.runtime === "string" ? raw.runtime : rawRuntime.type;
  const name = rawAgent.name;
  return {
    runId: raw.runId ?? raw.run_id,
    agent: {
      id: rawAgent.id ?? name,
      name,
      role: rawAgent.role,
      instructions: rawAgent.instructions,
      fullAccess: rawAgent.fullAccess ?? rawAgent.full_access ?? false,
    },
    runtime: {
      type: runtimeType,
      model: rawRuntime.model ?? raw.model ?? null,
    },
    thread: {
      runtimeThreadId:
        rawThread.runtimeThreadId ??
        raw.runtimeThreadId ??
        raw.runtime_thread_id ??
        null,
    },
    message: raw.message ?? raw.prompt,
    context: raw.context ?? [],
    mcpServers: normalizeMcpServers(raw.mcpServers ?? raw.mcp_servers),
    cwd: raw.cwd ?? null,
  };
}

export function parseExecutionRequest(input: unknown): AgentExecutionRequest {
  return canonicalRequestSchema.parse(normalizeExecutionRequest(input));
}

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});
