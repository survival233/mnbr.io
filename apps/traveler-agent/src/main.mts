import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

/** Own .env first; sibling envs for shared secrets (not shopper PORT/Relay). */
const SHARED_FROM_SIBLINGS = new Set([
  "LINQ_API_KEY",
  "LINQ_API_V3_API_KEY",
  "LINQ_FROM_PHONE",
  "LINQ_API_BASE",
  "SERPAPI_API_KEY",
  "DATABASE_URL",
  "DIRECT_URL",
  "FLIGHTS_ALLOW_DEMO",
  "FLIGHT_PAYMENT_METHOD_ID",
  "DUFFEL_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "AGENTCARD_CLIENT_ID",
  "AGENTCARD_CLIENT_SECRET",
  "AGENTCARD_WEBHOOK_SECRET",
]);

const linqOff =
  process.env.LINQ_DISABLED === "1" || process.env.DEMO_RELAY_POLL === "1";
const skipFromFiles = new Set(["DEMO_TRANSPORT", "LINQ_TO_PHONE", "LINQ_FROM_PHONE", "LINQ_CHAT_ID"]);

function loadEnvFile(rel: string, allowKeys?: Set<string>) {
  try {
    const p = new URL(rel, import.meta.url);
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      if (process.env[key]) continue;
      if (linqOff && skipFromFiles.has(key)) continue;
      if (allowKeys && !allowKeys.has(key)) continue;
      process.env[key] = m[2]!.trim();
    }
  } catch {
    /* missing ok */
  }
}

/** Render port scan needs this bound before any other boot work. */
const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";
const startedAt = Date.now();

function ok(res: ServerResponse, body: unknown = { ok: true }, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, code: number, msg: string) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

let dispatch: RequestHandler = async (req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/" || url === "/health")) {
    ok(res, {
      service: "manebra-traveler-agent",
      status: "starting",
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
    return;
  }
  fail(res, 503, "starting");
};

const server = createServer((req, res) => {
  void dispatch(req, res).catch((e: any) => {
    console.error(`[traveler-agent] request error: ${e?.message ?? e}`);
    if (!res.headersSent) fail(res, 500, "internal error");
  });
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(`[traveler-agent] listen error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`[traveler-agent] listening on ${HOST}:${port}`);
  setImmediate(() => {
    void boot().catch((e: any) => {
      console.error(`[traveler-agent] boot failed: ${e?.message ?? e}`);
    });
  });
});

async function boot() {
loadEnvFile("./../.env");
loadEnvFile("./../../shopper-agent/.env", SHARED_FROM_SIBLINGS);
loadEnvFile("./../../agent-cli/.env", SHARED_FROM_SIBLINGS);

const { extractChatId, extractInboundText, extractSender, verifyWebhookSignature } = await import(
  "./linq-client.mts"
);
const {
  ensureCloudWebhook,
  extractRelayInbound,
  pollEvents,
  relayConfigured,
  relayTokenKeyNames,
  relayWebhookSecrets,
  verifyRelayWebhookSignature,
} = await import("./relay-client.mts");
const { handleInbound, syncTravelerMarketplace, attachWebhookCardToWaitingTravelers } = await import("./traveler-flow.mts");
const { handleAgentCardWebhook, isAgentCardRequest } = await import("@manebra/webhooks/agentcard");
const { agentcardConfigured, mintPlatformToken } = await import("@repo/agentcard");
const { initSessionStore, sessionKey, sessionStats, persistSessionsNow } = await import(
  "./session.mts"
);

initSessionStore();

const seen = new Set<string>();
let lastInboundAt: number | null = null;
let inboundCount = 0;
let lastChannel: string | null = null;

const identityQueues = new Map<string, Promise<void>>();

function enqueueForIdentity(identity: string, job: () => Promise<void>) {
  const key = sessionKey(identity);
  const prev = identityQueues.get(key) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((e: any) => {
      console.error(`[traveler-agent] handler error for ${identity}: ${e?.message ?? e}`);
    });
  identityQueues.set(
    key,
    next.finally(() => {
      if (identityQueues.get(key) === next) identityQueues.delete(key);
    }),
  );
  return next;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function rememberEvent(eventId: string | undefined): boolean {
  if (!eventId) return true;
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  if (seen.size > 5000) {
    const first = seen.values().next().value;
    if (first) seen.delete(first);
  }
  return true;
}

function ingestRelayEvent(event: any): void {
  if ((event.event_type ?? event.type) !== "message.received") return;
  if (!rememberEvent(event.event_id ?? event.id)) return;

  const inbound = extractRelayInbound(event);
  if (!inbound) {
    console.warn("[traveler-agent] relay event dropped: missing inbound fields");
    return;
  }

  lastInboundAt = Date.now();
  inboundCount += 1;
  lastChannel = "relay";
  console.log(`[traveler-agent] ← relay ${inbound.userId}: ${inbound.text.slice(0, 120)}`);
  enqueueForIdentity(inbound.userId, () =>
    handleInbound({
      phone: inbound.userId,
      chatId: inbound.conversationId,
      text: inbound.text,
      channel: "relay",
      relayEventId: inbound.eventId,
      relayMessageId: inbound.messageId,
    }),
  );
}

async function startRelayLongPoll() {
  if (process.env.DEMO_RELAY_POLL !== "1") return;
  if (!relayConfigured()) {
    console.log(
      "[traveler-agent] DEMO_RELAY_POLL=1 but RELAY_AGENT_TOKEN missing — set it in apps/traveler-agent/.env",
    );
    return;
  }
  let cursor = 0;
  try {
    while (true) {
      const page = await pollEvents({ cursor, timeout: 0, limit: 100 });
      cursor = page.next_cursor ?? cursor;
      if (!page.events?.length || page.events.length < 100) break;
    }
    console.log(`[traveler-agent] Relay long-poll starting (cursor ${cursor})`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/409/.test(msg)) {
      console.error(
        "[traveler-agent] Relay long-poll 409 — disable the webhook on this agent or use a local-only token",
      );
      return;
    }
    console.warn(`[traveler-agent] Relay backlog drain: ${msg}`);
  }
  const loop = async () => {
    while (true) {
      try {
        const page = await pollEvents({ cursor, timeout: 25, limit: 100 });
        for (const event of page.events ?? []) ingestRelayEvent(event);
        cursor = page.next_cursor ?? cursor;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/409/.test(msg)) {
          console.error(
            "[traveler-agent] Relay long-poll 409 — disable the webhook on this agent or use a local-only token",
          );
          return;
        }
        console.warn(`[traveler-agent] Relay long-poll: ${msg}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void loop();
}

dispatch = async (req, res) => {
  const url = req.url ?? "/";
  const hdrs = req.headers as Record<string, string | string[] | undefined>;

  if (
    req.method === "POST" &&
    (isAgentCardRequest(hdrs) || url.startsWith("/webhooks/agentcard"))
  ) {
    const raw = await readBody(req);
    const result = await handleAgentCardWebhook(raw, hdrs);
    if (result.ok) {
      ok(res, { received: true }, result.status);
      if (result.type === "connected_card.updated") {
        void attachWebhookCardToWaitingTravelers(result.identity).then(() => syncTravelerMarketplace());
      } else {
        void syncTravelerMarketplace();
      }
    } else fail(res, result.status, result.status === 401 ? "invalid signature" : "webhook error");
    return;
  }

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    const stats = sessionStats();
    ok(res, {
      service: "manebra-traveler-agent",
      status: "ok",
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      lastInboundAt: lastInboundAt ? new Date(lastInboundAt).toISOString() : null,
      lastActivityAt: stats.lastActivityAt ? new Date(stats.lastActivityAt).toISOString() : null,
      lastChannel,
      sessions: stats.count,
      inboundCount,
      linq: process.env.LINQ_API_KEY || process.env.LINQ_API_V3_API_KEY ? "configured" : "off",
      relay: relayConfigured() ? "configured" : "off",
      agentcard: agentcardConfigured() ? "configured" : "off",
      flights: process.env.SERPAPI_API_KEY
        ? "serpapi"
        : process.env.FLIGHTS_ALLOW_DEMO !== "0"
          ? "demo"
          : "off",
      db: process.env.DATABASE_URL ? "configured" : "off",
    });
    return;
  }

  if (!linqOff && req.method === "POST" && url.startsWith("/webhooks/linq")) {
    const raw = await readBody(req);
    const secret = process.env.LINQ_WEBHOOK_SECRET;
    if (secret) {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      if (!verifyWebhookSignature(secret, raw, headers)) {
        fail(res, 401, "invalid signature");
        return;
      }
    }

    ok(res, { received: true });

    try {
      const event = JSON.parse(raw);
      const type = event.event_type ?? event.type;
      if (type !== "message.received") return;
      if (!rememberEvent(event.event_id ?? event.id)) return;

      const data = event.data ?? event;
      if (data.direction && data.direction !== "inbound") return;

      const phone = extractSender(data);
      const text = extractInboundText(data);
      const chatId = extractChatId(data);
      if (!phone || !text) return;

      lastInboundAt = Date.now();
      inboundCount += 1;
      lastChannel = "linq";
      console.log(`[traveler-agent] ← linq ${phone}: ${text.slice(0, 120)}`);
      enqueueForIdentity(phone, () => handleInbound({ phone, chatId, text, channel: "linq" }));
    } catch (e: any) {
      console.error(`[traveler-agent] linq handler error: ${e.message}`);
    }
    return;
  }

  if (req.method === "POST" && url.startsWith("/webhooks/relay")) {
    const raw = await readBody(req);
    console.log(`[traveler-agent] relay POST bytes=${raw.length}`);
    const secrets = relayWebhookSecrets();
    if (secrets.length) {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      if (!secrets.some((secret) => verifyRelayWebhookSignature(secret, raw, headers))) {
        const signed = ["webhook-id", "webhook-timestamp", "webhook-signature"].filter(
          (k) => headers[k] ?? headers[k.toLowerCase()],
        );
        console.warn(`[traveler-agent] relay webhook 401 headers=${signed.join(",") || "none"}`);
        fail(res, 401, "invalid signature");
        return;
      }
    } else if (process.env.NODE_ENV === "production" && relayConfigured()) {
      fail(res, 500, "RELAY_WEBHOOK_SECRET not set");
      return;
    }

    ok(res, { received: true }, 202);

    try {
      ingestRelayEvent(JSON.parse(raw));
    } catch (e: any) {
      console.error(`[traveler-agent] relay handler error: ${e.message}`);
    }
    return;
  }

  fail(res, 404, "not found");
};

function gracefulExit(code = 0) {
  try {
    persistSessionsNow();
  } catch (e: any) {
    console.warn(`[traveler-agent] persist on exit: ${e?.message ?? e}`);
  }
  process.exit(code);
}

if (!linqOff) console.log(`[traveler-agent] webhook POST /webhooks/linq?version=2026-02-03`);
console.log(`[traveler-agent] webhook POST /webhooks/relay (optional)`);
console.log(
  `[traveler-agent] linq=${linqOff ? "off" : process.env.LINQ_API_KEY || process.env.LINQ_API_V3_API_KEY ? "set" : "MISSING"} relay=${relayConfigured() ? "set" : "off"} keys=${relayTokenKeyNames().join(",") || "none"}`,
);
void ensureCloudWebhook();
if (agentcardConfigured()) {
  void mintPlatformToken()
    .then((okMint) => {
      console.log(`[traveler-agent] AgentCard platform token ${okMint ? "minted" : "skipped"}`);
    })
    .catch((e: any) => {
      console.warn(`[traveler-agent] AgentCard token mint failed: ${e?.message ?? e}`);
    });
}
void startRelayLongPoll();
const pollMarketplace =
  Boolean(process.env.DATABASE_URL?.trim()) ||
  process.env.PAYMENT_MODE === "demo" ||
  process.env.DEMO_LOCAL_CHAIN === "1" ||
  process.env.DEMO_LOCAL_CHAIN === "true";
if (pollMarketplace) {
  void import("@manebra/db")
    .then(({ expireStaleMarketplaceOffers }) => expireStaleMarketplaceOffers())
    .then((n) => {
      if (n) console.log(`[traveler-agent] expired ${n} stale marketplace offer(s)`);
    })
    .catch((e: any) => {
      console.warn(`[traveler-agent] expire stale offers: ${e?.message ?? e}`);
    });
  setInterval(() => {
    void syncTravelerMarketplace().catch((e: any) => {
      console.warn(`[traveler-agent] marketplace sync: ${e?.message ?? e}`);
    });
  }, 2000);
}

process.on("SIGINT", () => {
  console.log("[traveler-agent] shutting down…");
  gracefulExit(0);
});
process.on("SIGTERM", () => gracefulExit(0));
}
