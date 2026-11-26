/**
 * SSRF guard for server-side fetches of user-supplied URLs (pasted product
 * links, store pages). Blocks non-HTTP(S) schemes and any host that resolves to
 * a private / loopback / link-local / reserved address — including after each
 * redirect hop, which is the common SSRF bypass.
 *
 * Residual risk: DNS rebinding between this check and fetch's own resolution is
 * not fully closed here (that needs a pinned-lookup agent). This stops the
 * practical attacks: literal internal IPs, cloud metadata (169.254.169.254),
 * and redirects to internal hosts.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

function ipv4Blocked(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true; // loopback / unspecified
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb"))
    return true; // link-local fe80::/10
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local fc00::/7
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (m) return ipv4Blocked(m[1]!);
  return false;
}

function addrBlocked(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // not a parseable IP → block
}

/** Throws if the URL is not a safe, public HTTP(S) target. Returns the parsed URL. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("blocked: invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("blocked: scheme");
  const host = u.hostname;
  if (net.isIP(host)) {
    if (addrBlocked(host)) throw new Error("blocked: private address");
    return u;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("blocked: dns");
  }
  if (!addrs.length || addrs.some((a) => addrBlocked(a.address))) {
    throw new Error("blocked: private address");
  }
  return u;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  text: string;
}

/**
 * Fetch a user-supplied URL with SSRF protection: validates the host (and each
 * redirect hop) against assertPublicUrl, caps redirects and body size. Throws
 * on a blocked host; returns the response text otherwise.
 */
export async function safeFetchText(
  raw: string,
  init: RequestInit & { maxRedirects?: number; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeFetchResult | null> {
  const { maxRedirects = 2, timeoutMs = 8_000, maxBytes = 400_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let current = raw;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicUrl(current);
      const res = await fetch(current, { ...rest, redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: res.ok, status: res.status, url: current, text: "" };
        current = new URL(loc, current).toString();
        continue;
      }
      const text = (await res.text()).slice(0, maxBytes);
      return { ok: res.ok, status: res.status, url: res.url || current, text };
    }
    return null; // too many redirects
  } finally {
    clearTimeout(timer);
  }
}
