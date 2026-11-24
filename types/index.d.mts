export interface McpToolObservationInput {
  endpoint: string;
  toolName: string;
  protocolVersion?: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolObservation {
  id: `ni:///sha-256;${string}`;
  endpoint: string;
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  tool: Record<string, unknown>;
  callResult?: Record<string, unknown>;
}

export declare class McpToolObservationRefusal extends Error {
  code: "MCP_TOOL_OBSERVATION_REFUSED";
  evidence?: unknown;
}

export declare function observeMcpTool(
  input: McpToolObservationInput,
  options?: { fetchImpl?: typeof fetch },
): Promise<McpToolObservation>;
