import {
  DirectApiAdapter,
  type DirectApiClientFactory,
  type DirectApiRuntimeProfile,
  DIRECT_API_RUNTIME_DEFINITION,
} from "./direct-api-adapter.js";
import type { McpToolClient } from "./mcp-tool-client.js";
import type { RuntimeDefinition } from "../runtime/adapter.js";

export const OPENROUTER_RUNTIME_DEFINITION = {
  id: "openrouter",
  displayName: "OpenRouter",
  stability: "experimental",
  authModes: ["api_key"],
  capabilities: { ...DIRECT_API_RUNTIME_DEFINITION.capabilities },
} satisfies RuntimeDefinition;

const OPENROUTER_RUNTIME_PROFILE: DirectApiRuntimeProfile = {
  definition: OPENROUTER_RUNTIME_DEFINITION,
  providerName: "OpenRouter",
  authentication: {
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    providerRouting: {
      requireParameters: true,
      dataCollection: "deny",
      zdr: true,
    },
  },
};

export class OpenRouterAdapter extends DirectApiAdapter {
  constructor(
    clientFactory?: DirectApiClientFactory,
    mcpFactory?: () => McpToolClient,
  ) {
    super(clientFactory, mcpFactory, OPENROUTER_RUNTIME_PROFILE);
  }
}
