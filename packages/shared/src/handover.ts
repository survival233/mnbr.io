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
