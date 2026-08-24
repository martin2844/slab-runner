import type { McpServerDefinition } from "./protocol.js";

export const READ_ONLY_MCP_TOOLS: Record<string, readonly string[]> = {
  work: [
    "list_projects",
    "get_project",
    "list_issues",
    "get_issue",
    "search_issues",
    "list_comments",
    "list_links",
    "get_blocked_issues",
    "get_issue_history",
  ],
  docs: [
    "list_docs",
    "search_docs",
    "get_doc",
    "list_doc_revisions",
    "get_doc_revision",
  ],
  posthog: ["list_projects", "query_analytics"],
  email: [
    "email_list_accounts",
    "email_search",
    "email_get_message",
    "email_list_threads",
  ],
};

export const MCP_SERVER_ALIASES: Record<
  string,
  keyof typeof READ_ONLY_MCP_TOOLS
> = {
  work: "work",
  slab: "work",
  docs: "docs",
  "slab-docs": "docs",
  posthog: "posthog",
  email: "email",
};

export function readOnlyToolsForServer(
  serverName: string,
): readonly string[] | undefined {
  return READ_ONLY_MCP_TOOLS[MCP_SERVER_ALIASES[serverName] ?? serverName];
}

export function effectiveMcpToolPolicy(
  server: McpServerDefinition,
  fullAccess: boolean,
): { defaultMode: "approve" | "prompt"; tools: Record<string, "approve" | "prompt"> } {
  if (server.approval) return server.approval;
  const readOnlyTools = fullAccess ? undefined : readOnlyToolsForServer(server.name);
  return {
    defaultMode: fullAccess ? "approve" : "prompt",
    tools: Object.fromEntries(
      (readOnlyTools ?? []).map((tool) => [tool, "approve" as const]),
    ),
  };
}
