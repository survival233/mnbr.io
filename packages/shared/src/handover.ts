/** Handover codes — PRD §10.2. Bid-bound HMAC; plaintext never stored. */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const HANDOVER_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const HANDOVER_MAX_ATTEMPTS = 5;

export function generateHandoverCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashHandoverCode(code: string, bidId: string, secret: string): string {
  return createHmac("sha256", secret).update(`${bidId}:${code}`).digest("hex");
}

export function verifyHandoverCode(candidate: string, bidId: string, storedHash: string, secret: string): boolean {
  const candidateHash = hashHandoverCode(candidate, bidId, secret);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handoverSecret(): string | null {
  return process.env.HANDOVER_SECRET?.trim() || null;
}

const STORED_PREFIX = "h:";

/**
 * The value to STORE in the offer row for a handover code. With HANDOVER_SECRET
 * set, stores a keyed, truncated hash ("h:" + 30 hex = 32 chars, which fits the
 * existing handover_code column) so the plaintext code is never persisted — no
 * schema migration required. Without the secret it returns the plaintext code,
 * so behavior is unchanged until the secret is set on both services.
 */
export function storedHandoverCode(code: string, bidId: string): string {
  const secret = handoverSecret();
  if (!secret) return code;
  return STORED_PREFIX + hashHandoverCode(code, bidId, secret).slice(0, 30);
}

/** True if a stored value is a hashed handover code (vs legacy plaintext). */
export function isHashedHandover(stored: string): boolean {
  return stored.startsWith(STORED_PREFIX);
}

/**
 * Verify an entered code against the stored value — a keyed hash when present,
 * else a legacy plaintext code (for offers written before hashing). Always
 * constant-time.
 */
export function verifyStoredHandoverCode(entered: string, bidId: string, stored: string): boolean {
  if (!stored) return false;
  if (isHashedHandover(stored)) {
    const secret = handoverSecret();
    if (!secret) return false;
    const expected = STORED_PREFIX + hashHandoverCode(entered, bidId, secret).slice(0, 30);
    const a = Buffer.from(expected);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const a = Buffer.from(entered);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
