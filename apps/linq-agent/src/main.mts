import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

// Load env before app modules read process.env
for (const rel of ["./../.env", "./../../agent-cli/.env"]) {
  try {
    const p = new URL(rel, import.meta.url);
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* missing ok */
  }
}

const { extractChatId, extractInboundText, extractSender, verifyWebhookSignature } = await import(
  "./linq-client.mts"
);
const {
  extractRelayInbound,
  relayConfigured,
  resolveImagesForVision,
  verifyRelayWebhookSignature,
} = await import("./relay-client.mts");
const { handleInbound } = await import("./shopper-flow.mts");
const { initSessionStore, sessionKey, sessionStats, persistSessionsNow } = await import(
  "./session.mts"
);

initSessionStore();

const PORT = Number(process.env.PORT ?? process.env.LINQ_AGENT_PORT ?? "8790");
const seen = new Set<string>();
const startedAt = Date.now();
let lastInboundAt: number | null = null;
let inboundCount = 0;
let lastChannel: string | null = null;

/** Serialize handling per identity so rapid texts don’t race the state machine. */
const identityQueues = new Map<string, Promise<void>>();

function enqueueForIdentity(identity: string, job: () => Promise<void>) {
  const key = sessionKey(identity);
  const prev = identityQueues.get(key) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((e: any) => {
      console.error(`[linq-agent] handler error for ${identity}: ${e?.message ?? e}`);
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

function ok(res: ServerResponse, body: unknown = { ok: true }, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, code: number, msg: string) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
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

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/" || url === "/health")) {
    const stats = sessionStats();
    ok(res, {
      service: "manebra-linq-agent",
      status: "ok",
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      lastInboundAt: lastInboundAt ? new Date(lastInboundAt).toISOString() : null,
      lastActivityAt: stats.lastActivityAt ? new Date(stats.lastActivityAt).toISOString() : null,
      lastChannel,
      sessions: stats.count,
      inboundCount,
      relay: relayConfigured() ? "configured" : "off",
      vision: process.env.OPENAI_API_KEY ? "openai" : "off",
      cognition:
        process.env.OPENAI_API_KEY
          ? "openai"
          : process.env.HF_TOKEN
            ? "hf-fallback"
            : "off",
      llmProvider: process.env.LLM_PROVIDER ?? "auto",
    });
    return;
  }

  if (req.method === "POST" && url.startsWith("/webhooks/relay")) {
    const raw = await readBody(req);
    const secret = process.env.RELAY_WEBHOOK_SECRET;
    if (secret) {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      if (!verifyRelayWebhookSignature(secret, raw, headers)) {
        fail(res, 401, "invalid signature");
        return;
      }
    } else if (process.env.NODE_ENV === "production") {
      fail(res, 500, "RELAY_WEBHOOK_SECRET not set");
      return;
    }

    // Ack fast (Relay wants 2xx within 10s)
    ok(res, { received: true }, 202);

    try {
      const event = JSON.parse(raw);
      if ((event.event_type ?? event.type) !== "message.received") return;
      if (!rememberEvent(event.event_id ?? event.id)) return;

      const inbound = extractRelayInbound(event);
      if (!inbound) return;

      lastInboundAt = Date.now();
      inboundCount += 1;
      lastChannel = "relay";
      const preview = inbound.text || (inbound.imageRefs.length ? `[${inbound.imageRefs.length} image(s)]` : "");
      console.log(
        `[linq-agent] ← relay ${inbound.userId}: ${preview.slice(0, 120)}` +
          (inbound.imageRefs.length ? ` images=${inbound.imageRefs.length}` : ""),
      );
      enqueueForIdentity(inbound.userId, async () => {
        // Resolve images inside the handler path after session ack/typing — not before enqueue metadata.
        const imageUrls = inbound.imageRefs.length
          ? await resolveImagesForVision(inbound.imageRefs)
          : [];
        if (inbound.imageRefs.length) {
          console.log(
            `[linq-agent] vision resolved ${imageUrls.length}/${inbound.imageRefs.length} image(s) for ${inbound.userId}`,
          );
        }
        await handleInbound({
          phone: inbound.userId,
          chatId: inbound.conversationId,
          text: inbound.text,
          imageUrls,
          mediaFailed: Boolean(inbound.imageRefs.length && !imageUrls.length),
          channel: "relay",
          relayEventId: inbound.eventId,
          relayMessageId: inbound.messageId,
        });
      });
    } catch (e: any) {
      console.error(`[linq-agent] relay handler error: ${e.message}`);
    }
    return;
  }

  if (req.method === "POST" && url.startsWith("/webhooks/linq")) {
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
      console.log(`[linq-agent] ← linq ${phone}: ${text.slice(0, 120)}`);
      enqueueForIdentity(phone, () => handleInbound({ phone, chatId, text, channel: "linq" }));
    } catch (e: any) {
      console.error(`[linq-agent] linq handler error: ${e.message}`);
    }
    return;
  }

  fail(res, 404, "not found");
});

function gracefulExit(code = 0) {
  try {
    persistSessionsNow();
  } catch (e: any) {
    console.warn(`[linq-agent] persist on exit: ${e?.message ?? e}`);
  }
  process.exit(code);
}

server.listen(PORT, () => {
  console.log(`[linq-agent] listening on :${PORT}`);
  console.log(`[linq-agent] webhook POST /webhooks/linq?version=2026-02-03`);
  console.log(`[linq-agent] webhook POST /webhooks/relay`);
  console.log(
    `[linq-agent] linq key=${
      process.env.LINQ_API_KEY || process.env.LINQ_API_V3_API_KEY ? "set" : "MISSING"
    } relay=${relayConfigured() ? "set" : "off"}`,
  );
});

process.on("SIGINT", () => {
  console.log("[linq-agent] shutting down…");
  gracefulExit(0);
});
process.on("SIGTERM", () => gracefulExit(0));
