import assert from "node:assert/strict";
import test from "node:test";

import {
  McpToolObservationRefusal,
  observeMcpTool,
} from "../src/observe-mcp-tool.mjs";

function response(id, result, session = undefined) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name === "mcp-session-id" ? session : undefined },
    json: async () => ({ jsonrpc: "2.0", id, result }),
  };
}

test("initializes, exhausts tools/list, invokes one exact tool, and identifies the observation", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ request, headers: init.headers });
    if (request.method === "initialize") {
      return response(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      }, "session-1");
    }
    if (request.method === "tools/list" && request.params.cursor === undefined) {
      return response(request.id, {
        tools: [{ name: "other", inputSchema: { type: "object" } }],
        nextCursor: "next",
      });
    }
    if (request.method === "tools/list") {
      return response(request.id, {
        tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }],
      });
    }
    return response(request.id, {
      content: [{ type: "text", text: request.params.arguments.text }],
      structuredContent: { echoed: request.params.arguments.text },
    });
  };

  const observed = await observeMcpTool({
    endpoint: "https://agent.example/mcp",
    toolName: "echo",
    arguments: { text: "hello" },
  }, { fetchImpl });

  assert.match(observed.id, /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
  assert.equal(observed.tool.name, "echo");
  assert.deepEqual(observed.callResult.structuredContent, { echoed: "hello" });
  assert.deepEqual(requests.map(({ request }) => request.method), [
    "initialize", "tools/list", "tools/list", "tools/call",
  ]);
  assert.equal(requests[1].headers["mcp-session-id"], "session-1");
});

test("refuses absent and duplicate tool identities", async () => {
  const fixture = (tools) => async (_url, init) => {
    const request = JSON.parse(init.body);
    return request.method === "initialize"
      ? response(request.id, {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "fixture", version: "1" },
        })
      : response(request.id, { tools });
  };
  await assert.rejects(
    observeMcpTool(
      { endpoint: "https://agent.example/mcp", toolName: "missing" },
      { fetchImpl: fixture([]) },
    ),
    (error) => error instanceof McpToolObservationRefusal && /not found/u.test(error.message),
  );
  await assert.rejects(
    observeMcpTool(
      { endpoint: "https://agent.example/mcp", toolName: "echo" },
      { fetchImpl: fixture([{ name: "echo" }, { name: "echo" }]) },
    ),
    (error) => error instanceof McpToolObservationRefusal && /not unique/u.test(error.message),
  );
});
