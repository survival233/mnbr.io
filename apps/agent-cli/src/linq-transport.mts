/**
 * Linq iMessage transport for the Manebra demo.
 *
 * Replaces terminal readline with: send question via `linq` CLI → wait for
 * message.received (forwarded by `linq webhooks listen --forward-to`).
 *
 * Env:
 *   DEMO_TRANSPORT=linq
 *   LINQ_TO_PHONE=+1…          (your personal phone, E.164)
 *   LINQ_FROM_PHONE=+1…        (optional; defaults to linq whoami number)
 *   LINQ_WEBHOOK_PORT=8787     (optional)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LinqTransport = {
  ask: (question: string, auto?: string) => Promise<string>;
  say: (text: string) => Promise<void>;
  close: () => Promise<void>;
};

type Pending = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  since: number;
};

function extractText(data: any): string {
  const parts = data?.parts ?? data?.message?.parts ?? [];
  if (Array.isArray(parts)) {
    const texts = parts
      .filter((p: any) => p?.type === "text" || typeof p?.value === "string")
      .map((p: any) => String(p.value ?? p.text ?? "").trim())
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  const direct = data?.text ?? data?.body ?? data?.message?.text;
  return typeof direct === "string" ? direct.trim() : "";
}

function senderHandle(data: any): string {
  return String(
    data?.sender_handle?.handle ??
      data?.from_handle?.handle ??
      data?.from ??
      "",
  );
}

async function linqJson(args: string[]): Promise<any> {
  const { stdout, stderr } = await execFileAsync("linq", [...args, "--json"], {
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  const combined = `${stdout}\n${stderr}`;
  const start = combined.indexOf("{");
  if (start < 0) throw new Error(`linq ${args.join(" ")}: no JSON in output:\n${combined}`);
  // Parse from the first `{` — pretty-printed CLI JSON nests many `{` later.
  return JSON.parse(combined.slice(start));
}

async function resolveFromPhone(): Promise<string | undefined> {
  if (process.env.LINQ_FROM_PHONE) return process.env.LINQ_FROM_PHONE;
  try {
    const me = await linqJson(["whoami"]);
    return me?.phoneNumber ?? me?.phone_number ?? me?.linqNumber ?? me?.linq_number ?? undefined;
  } catch {
    return undefined;
  }
}

export async function createLinqTransport(opts: {
  toPhone: string;
  log?: (msg: string) => void;
}): Promise<LinqTransport> {
  const log = opts.log ?? console.log;
  const toPhone = opts.toPhone;
  const fromPhone = await resolveFromPhone();
  const port = Number(process.env.LINQ_WEBHOOK_PORT ?? "8787");
  const forwardUrl = `http://127.0.0.1:${port}/linq?version=2026-02-03`;

  let chatId: string | null = process.env.LINQ_CHAT_ID ?? null;
  let pending: Pending | null = null;
  const seenEventIds = new Set<string>();

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url?.startsWith("/linq")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      try {
        const event = JSON.parse(raw);
        const type = event.event_type ?? event.type ?? req.headers["x-webhook-event"];
        if (type !== "message.received") return;
        const eventId = event.event_id ?? event.id;
        if (eventId && seenEventIds.has(eventId)) return;
        if (eventId) seenEventIds.add(eventId);

        const data = event.data ?? event;
        if (data.direction && data.direction !== "inbound") return;
        const from = senderHandle(data);
        if (from && from !== toPhone) {
          // Allow match if digits-only equal (formatting variants)
          const dig = (s: string) => s.replace(/\D/g, "");
          if (dig(from) !== dig(toPhone)) return;
        }
        const text = extractText(data);
        if (!text) return;
        if (data.chat?.id) chatId = data.chat.id;
        if (pending && Date.now() >= pending.since) {
          const p = pending;
          pending = null;
          p.resolve(text);
        }
      } catch (e: any) {
        log(`[linq] webhook parse error: ${e.message}`);
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  log(`[linq] webhook receiver on ${forwardUrl}`);

  const listener: ChildProcess = spawn(
    "linq",
    ["webhooks", "listen", "--events", "message.received", "--forward-to", forwardUrl],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  listener.stdout?.on("data", (b) => {
    const s = b.toString();
    if (/Listening|forward|subscribed|message\.received/i.test(s)) log(`[linq-listen] ${s.trim()}`);
  });
  listener.stderr?.on("data", (b) => log(`[linq-listen] ${b.toString().trim()}`));

  // Give the temporary subscription a moment to attach
  await new Promise((r) => setTimeout(r, 1500));

  async function send(text: string): Promise<void> {
    if (!chatId) {
      const args = ["chats", "create", "--to", toPhone, "--message", text];
      if (fromPhone) args.push("--from", fromPhone);
      const out = await linqJson(args);
      chatId =
        out?.chat?.id ??
        out?.id ??
        out?.chat_id ??
        null;
      if (!chatId) throw new Error(`linq chats create did not return chat.id: ${JSON.stringify(out)}`);
      log(`[linq] chat ${chatId}`);
      return;
    }
    await linqJson(["messages", "send", chatId, "--message", text]);
  }

  async function ask(question: string, auto?: string): Promise<string> {
    if (process.env.DEMO_AUTO === "1" && auto != null) {
      await send(`${question}\n\n(auto: ${auto})`);
      return auto;
    }
    const prompt = auto
      ? `${question}\n\nReply with your answer. (demo default would be: ${auto})`
      : `${question}\n\nReply with your answer.`;
    await send(prompt);
    log(`[linq] waiting for reply from ${toPhone}…`);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending) {
          pending.reject(new Error("timed out waiting for iMessage reply (10 min)"));
          pending = null;
        }
      }, 10 * 60_000);
      pending = {
        since: Date.now(),
        reject,
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
      };
    });
  }

  async function say(text: string): Promise<void> {
    await send(text);
  }

  async function close(): Promise<void> {
    listener.kill("SIGTERM");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { ask, say, close };
}
