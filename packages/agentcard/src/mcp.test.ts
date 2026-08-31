/**
 * MCP flow against a mock Streamable-HTTP JSON-RPC server.
 * The mock advertises an ARBITRARY toolset (including an invented future tool
 * this code has never seen) — the integration must forward ALL of it. Never
 * assert a fixed/expected set of production tool names here.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Whatever the server advertises — deliberately including a tool that does not
// exist today, to prove zero-code-change forwarding of future tools.
const MOCK_TOOLS = [
  { name: "create_card", description: "Create a virtual card", inputSchema: { type: "object", properties: { nickname: { type: "string" } } } },
  { name: "approve_request", description: "Resolve an approval gate", inputSchema: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] } },
  { name: "quantum_entangle_card_2031", description: "Invented future tool", inputSchema: { type: "object", properties: { qubits: { type: "number" } } } },
];

let server: Server;
let base: string;
let validBearers = new Set<string>(["at_user_1", "acs_org_secret"]);
const seenBearers: string[] = [];
let refreshCount = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/token" && req.method === "POST") {
        refreshCount += 1;
        const at = `at_user_${refreshCount + 1}`;
        validBearers.add(at);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: at, refresh_token: `rt_rot_${refreshCount}`, expires_in: 86400 }));
        return;
      }
      if (req.url === "/mcp" && req.method === "POST") {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        seenBearers.push(bearer);
        if (!validBearers.has(bearer)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        const msg = JSON.parse(raw);
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-agentcard", version: "0.0.0" } },
          }));
          return;
        }
        if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
          res.writeHead(202); res.end();
          return;
        }
        if (msg.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: MOCK_TOOLS } }));
          return;
        }
        if (msg.method === "tools/call") {
          const { name, arguments: args } = msg.params;
          let payload: unknown;
          if (name === "create_card") payload = { approval_required: true, approval_id: "apr_123" };
          else if (name === "approve_request" && args?.approvalId === "apr_123") payload = { approved: true, card: { id: "card_1", last4: "4242" } };
          else payload = { echoed: { name, args } };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  process.env.AGENTCARD_API_URL = base;
  process.env.AGENTCARD_PUBLIC_URL = "http://localhost:8790";
  process.env.AGENTCARD_OAUTH_CLIENT_ID = "client-test-id";
  process.env.AGENTCARD_OAUTH_CLIENT_SECRET = "acs_org_secret";
  process.env.AGENTCARD_OAUTH_STORE_PATH = join(mkdtempSync(join(tmpdir(), "ac-mcp-")), "store.json");
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

import { putOAuthConnection, getOAuthConnection, resetDiscoveryCache } from "./oauth";
import { callCardTool, listCardTools, redactCardContent, withOrgMcp } from "./mcp";

const USER = "+15550009999";

function firstText(result: unknown): unknown {
  const content = (result as any)?.content;
  return JSON.parse(content?.[0]?.text ?? "null");
}

describe("dynamic toolset", () => {
  it("forwards EVERY advertised tool, including ones invented after this code was written", async () => {
    resetDiscoveryCache();
    putOAuthConnection({ identity: USER, accessToken: "at_user_1", refreshToken: "rt_0", expiresAt: Date.now() + 3600_000 });
    const tools = await listCardTools(USER);
    // full pass-through: exactly what the server advertised, schemas verbatim
    expect(tools.map((t) => t.name).sort()).toEqual(MOCK_TOOLS.map((t) => t.name).sort());
    const invented = tools.find((t) => t.name === "quantum_entangle_card_2031")!;
    expect(invented.inputSchema).toEqual(MOCK_TOOLS[2].inputSchema);
  });
});

describe("tools/call incl. approval gate", () => {
  it("create_card surfaces approval_required; approve_request resolves it", async () => {
    const created = firstText(await callCardTool(USER, "create_card", { nickname: "groceries" })) as any;
    expect(created.approval_required).toBe(true);
    const approved = firstText(await callCardTool(USER, "approve_request", { approvalId: created.approval_id })) as any;
    expect(approved.approved).toBe(true);
    expect(approved.card.last4).toBe("4242");
  });
});

describe("token refresh", () => {
  it("refreshes a near-expired token before connecting and persists rotation", async () => {
    putOAuthConnection({ identity: USER, accessToken: "at_user_1", refreshToken: "rt_1", expiresAt: Date.now() - 1 });
    const tools = await listCardTools(USER);
    expect(tools.length).toBe(MOCK_TOOLS.length);
    const conn = getOAuthConnection(USER)!;
    expect(conn.accessToken).not.toBe("at_user_1");
    expect(conn.refreshToken).toMatch(/^rt_rot_/);
  });

  it("recovers from a mid-flight 401 by refreshing once and retrying", async () => {
    validBearers.delete(getOAuthConnection(USER)!.accessToken);
    putOAuthConnection({ ...getOAuthConnection(USER)!, expiresAt: Date.now() + 3600_000 }); // looks fresh, but revoked server-side
    const result = firstText(await callCardTool(USER, "quantum_entangle_card_2031", { qubits: 3 })) as any;
    expect(result.echoed.name).toBe("quantum_entangle_card_2031");
    expect(getOAuthConnection(USER)!.accessToken).toMatch(/^at_user_/);
  });
});

describe("org door", () => {
  it("uses the raw client_secret as the MCP bearer", async () => {
    const tools = await withOrgMcp(async (c) => (await c.listTools()).tools);
    expect(tools.length).toBe(MOCK_TOOLS.length);
    expect(seenBearers).toContain("acs_org_secret");
  });
});

describe("redaction", () => {
  it("masks PAN-length digit runs and CVV fields", () => {
    const s = redactCardContent('{"number":"4242 4242 4242 4242","cvv":"123"}');
    expect(s).not.toMatch(/4242 4242/);
    expect(s).not.toMatch(/"cvv":"123"/);
  });
});
