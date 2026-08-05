import {
  canonicalizeHttpsUrl,
} from "@red-cup-engineering/canonicalize-https-url-service";
import {
  EMPTY_WITNESS_ROOT,
  identifyNormalizedSemanticContent,
} from "@red-cup-engineering/semantic-content-identify-service";
import { jsonToTerm } from "@red-cup-engineering/relation-model-notation-json-codec";
import { inferTy } from "@red-cup-engineering/relation-model-notation-typing";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_PAGES = 128;

export class McpToolObservationRefusal extends Error {
  constructor(reason, evidence = undefined) {
    super(reason);
    this.name = "McpToolObservationRefusal";
    this.code = "MCP_TOOL_OBSERVATION_REFUSED";
    this.evidence = evidence;
  }
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpToolObservationRefusal(`${label} must be an object`, value);
  }
  return value;
}

function exactName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new McpToolObservationRefusal("toolName must be one bounded non-empty string");
  }
  return value;
}

async function rpc(fetchImpl, endpoint, protocolVersion, sessionId, id, method, params) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": protocolVersion,
  };
  if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    redirect: "error",
  });
  if (!response || typeof response !== "object" || typeof response.json !== "function") {
    throw new McpToolObservationRefusal(`${method} did not return an HTTP response`);
  }
  const payload = record(await response.json(), `${method} response`);
  if (!response.ok) throw new McpToolObservationRefusal(`${method} returned HTTP ${response.status}`, payload);
  if (payload.jsonrpc !== "2.0" || payload.id !== id) {
    throw new McpToolObservationRefusal(`${method} returned a mismatched JSON-RPC envelope`, payload);
  }
  if (payload.error !== undefined) {
    throw new McpToolObservationRefusal(`${method} returned an MCP error`, payload.error);
  }
  return {
    result: record(payload.result, `${method} result`),
    sessionId: response.headers?.get?.("mcp-session-id") ?? sessionId,
  };
}

export async function observeMcpTool(input, options = {}) {
  const candidate = record(input, "input");
  const endpoint = canonicalizeHttpsUrl(candidate.endpoint, "endpoint", { requireDns: true });
  const toolName = exactName(candidate.toolName);
  const requestedVersion = typeof candidate.protocolVersion === "string"
    ? candidate.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new McpToolObservationRefusal("fetch implementation is unavailable");

  const initialized = await rpc(fetchImpl, endpoint, requestedVersion, undefined, 1, "initialize", {
    protocolVersion: requestedVersion,
    capabilities: {},
    clientInfo: { name: "mcp-tool-observation-service", version: "0.1.0" },
  });
  const protocolVersion = initialized.result.protocolVersion;
  if (typeof protocolVersion !== "string" || protocolVersion.length === 0) {
    throw new McpToolObservationRefusal("initialize omitted protocolVersion", initialized.result);
  }
  const serverInfo = record(initialized.result.serverInfo, "initialize serverInfo");

  const tools = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = await rpc(
      fetchImpl,
      endpoint,
      protocolVersion,
      initialized.sessionId,
      2 + page,
      "tools/list",
      cursor === undefined ? {} : { cursor },
    );
    if (!Array.isArray(listed.result.tools)) {
      throw new McpToolObservationRefusal("tools/list omitted tools", listed.result);
    }
    tools.push(...listed.result.tools.map((tool) => record(tool, "tool")));
    const nextCursor = listed.result.nextCursor;
    if (nextCursor === undefined) break;
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || cursors.has(nextCursor)) {
      throw new McpToolObservationRefusal("tools/list returned an invalid pagination cursor", nextCursor);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
    if (page === MAX_TOOL_PAGES - 1) {
      throw new McpToolObservationRefusal("tools/list exceeded the pagination bound");
    }
  }

  const matches = tools.filter((tool) => tool.name === toolName);
  if (matches.length !== 1) {
    throw new McpToolObservationRefusal(
      matches.length === 0 ? `MCP tool not found: ${toolName}` : `MCP tool name is not unique: ${toolName}`,
      tools,
    );
  }

  let callResult;
  if (Object.prototype.hasOwnProperty.call(candidate, "arguments")) {
    record(candidate.arguments, "arguments");
    const called = await rpc(
      fetchImpl,
      endpoint,
      protocolVersion,
      initialized.sessionId,
      2 + Math.min(tools.length, MAX_TOOL_PAGES),
      "tools/call",
      { name: toolName, arguments: candidate.arguments },
    );
    callResult = called.result;
  }

  const body = {
    endpoint,
    protocolVersion,
    serverInfo,
    tool: matches[0],
    ...(callResult === undefined ? {} : { callResult }),
  };
  const term = jsonToTerm(body);
  const semanticType = inferTy([], term);
  if (semanticType === null) {
    throw new McpToolObservationRefusal("MCP observation does not derive an RMN semantic type", body);
  }
  const identity = identifyNormalizedSemanticContent({
    objectKind: "mcp.tool-observation",
    semanticType,
    term,
    witnessRoot: EMPTY_WITNESS_ROOT,
  });
  return Object.freeze({ id: identity.id, ...body });
}
