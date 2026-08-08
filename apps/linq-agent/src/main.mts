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
const { handleInbound } = await import("./shopper-flow.mts");
const { initSessionStore, sessionStats, persistSessionsNow } = await import("./session.mts");

initSessionStore();

const PORT = Number(process.env.PORT ?? process.env.LINQ_AGENT_PORT ?? "8790");
const seen = new Set<string>();
const startedAt = Date.now();
let lastInboundAt: number | null = null;
let inboundCount = 0;

/** Serialize handling per phone so rapid texts don’t race the state machine. */
const phoneQueues = new Map<string, Promise<void>>();

function enqueueForPhone(phone: string, job: () => Promise<void>) {
  const key = phone.replace(/\D/g, "");
  const prev = phoneQueues.get(key) ?? Promise.resolve();
  const next = prev
    .then(job)
    .catch((e: any) => {
      console.error(`[linq-agent] handler error for ${phone}: ${e?.message ?? e}`);
    });
  phoneQueues.set(
    key,
    next.finally(() => {
      if (phoneQueues.get(key) === next) phoneQueues.delete(key);
    }),
  );
  return next;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function ok(res: ServerResponse, body: unknown = { ok: true }) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, code: number, msg: string) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
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
      sessions: stats.count,
      inboundCount,
    });
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

    // Ack fast — process async
    ok(res, { received: true });

    try {
      const event = JSON.parse(raw);
      const type = event.event_type ?? event.type;
      if (type !== "message.received") return;

      const eventId = event.event_id ?? event.id;
      if (eventId) {
        if (seen.has(eventId)) return;
        seen.add(eventId);
        if (seen.size > 5000) {
          const first = seen.values().next().value;
          if (first) seen.delete(first);
        }
      }

      const data = event.data ?? event;
      if (data.direction && data.direction !== "inbound") return;

      const phone = extractSender(data);
      const text = extractInboundText(data);
      const chatId = extractChatId(data);
      if (!phone || !text) return;

      lastInboundAt = Date.now();
      inboundCount += 1;
      console.log(`[linq-agent] ← ${phone}: ${text.slice(0, 120)}`);
      enqueueForPhone(phone, () => handleInbound({ phone, chatId, text }));
    } catch (e: any) {
      console.error(`[linq-agent] handler error: ${e.message}`);
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
  console.log(
    `[linq-agent] from=${process.env.LINQ_FROM_PHONE ?? "(unset)"} key=${
      process.env.LINQ_API_KEY || process.env.LINQ_API_V3_API_KEY ? "set" : "MISSING"
    }`,
  );
});

process.on("SIGINT", () => {
  console.log("[linq-agent] shutting down…");
  gracefulExit(0);
});
process.on("SIGTERM", () => gracefulExit(0));
