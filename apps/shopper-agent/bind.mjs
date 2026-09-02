/**
 * Preload (--import): bind PORT before tsx compiles TypeScript.
 * Render’s scan fails if `tsx main.mts` sits in compile for minutes.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";
const startedAt = Date.now();

function starting(req, res) {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/" || url === "/health" || url.startsWith("/health?"))) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        service: "manebra-shopper-agent",
        status: "starting",
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      }),
    );
    return;
  }
  res.writeHead(503, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "starting" }));
}

let handler = starting;

const server = createServer((req, res) => {
  void Promise.resolve(handler(req, res)).catch((e) => {
    console.error(`[shopper-agent] request error: ${e?.message ?? e}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
});

server.on("error", (e) => {
  console.error(`[shopper-agent] listen error: ${e.message}`);
  process.exit(1);
});

globalThis.__shopperSetDispatch = (fn) => {
  handler = fn;
};

process.env.SHOPPER_SKIP_LISTEN = "1";

console.log(`[shopper-agent] bind.mjs binding ${HOST}:${PORT}`);
await new Promise((resolve, reject) => {
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[shopper-agent] listening on ${HOST}:${port}`);
    // #region agent log
    fetch("http://127.0.0.1:7792/ingest/af7dba43-916f-44eb-8996-041bf3055f0c", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ee46bb" },
      body: JSON.stringify({
        sessionId: "ee46bb",
        runId: "post-fix",
        hypothesisId: "H",
        location: "apps/shopper-agent/bind.mjs",
        message: "port bound before tsx",
        data: { port, host: HOST },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    resolve();
  });
  server.once("error", reject);
});
