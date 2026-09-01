/**
 * Structured item from an utterance. A product name/brand/model, or null.
 * Never the full shopping-intent sentence.
 */
import { parseDate, parseUsdCents } from "./parse";
import { parseShoppingCity, parseDeliveryTown } from "./cities";

const WEEKDAY =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)$/i;

const FILLER = /^(ok|okay|yes|no|hi|hey|yo|hmm+|huh|uh|um|idk|maybe|please)$/i;

const PRODUCT_URL_RE = /https?:\/\/[^\s<>"']+/i;

/** First http(s) product URL in the utterance, or null. */
export function extractProductUrl(text: string): string | null {
  const m = (text ?? "").match(PRODUCT_URL_RE);
  if (!m) return null;
  try {
    const u = new URL(m[0].replace(/[),.;]+$/g, ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Peel a request shell (subject + intent verb + beneficiary + determiner). */
const INTENT_PREFIX =
  /^(?:(?:please|kindly|hey|hi|hello|yo|actually|instead)[,!\s]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:i(?:'m|'d| am| would)?\s+(?:(?:want|need|like)\s+(?:you\s+to\s+|to\s+)?)?)?(?:(?:help(?:\s+me)?\s+(?:to\s+)?)?)?(?:get|shop|buy|find|look(?:ing)?(?:\s+for)?|search(?:ing)?(?:\s+for)?|order|pick\s+up|grab)(?:\s+for)?\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|some|one)\s+)?/i;

function isIndefinite(s: string): boolean {
  return /^(this|that|it|one|ones|some|any|something|anything|stuff|things?|item|product|them|me|us|myself)$/i.test(
    s,
  );
}

function isBareItemWord(s: string): boolean {
  return /^(this|that|the)\s+(item|product|thing|one)$/i.test(s);
}

function isIntentVerbOnly(s: string): boolean {
  return /^(to\s+)?(shop|buy|find|get|look|search|order|help|browse)(ing)?(\s+(for\s+)?(me|us|something|anything|it|one|this|that))?$/i.test(
    s,
  ) || /^(for\s+)?(me|us)$/i.test(s);
}

function stillARequestClause(s: string): boolean {
  const t = s.toLowerCase();
  if (/^(i|i'm|im|i’d|i'd|we|you|they|can|could|would|will|please)\b/.test(t)) return true;
  if (/\b(want to|need to|like to|going to|trying to|help me)\b/.test(t)) return true;
  return false;
}

function stripTails(s: string): string {
  return s
    .replace(/\s+instead\b.*$/i, "")
    .replace(/\s+from\s+(the\s+)?(us|usa|united states)\b.*$/i, "")
    .replace(/\s+from\s+(amazon|walmart|target|apple|best\s*buy)\b.*$/i, "")
    .replace(/\s+(in|near|at)\s+[a-z][a-z\s.]{1,40}$/i, "")
    .replace(/\s+please[.!?]*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function peelShell(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  t = t.replace(/^(?:please|kindly|hey|hi|hello|yo|actually|instead)[,!\s]+/i, "");
  t = stripTails(t);
  for (let i = 0; i < 3; i++) {
    const m = t.match(INTENT_PREFIX);
    if (!m) break;
    const next = t.slice(m[0].length).trim();
    if (!next || next === t) break;
    t = next;
  }
  if (stillARequestClause(t)) {
    const afterVerb = t.match(
      /\b(?:shop|buy|get|find|order|grab|look(?:ing)?(?:\s+for)?|search(?:ing)?(?:\s+for)?)\s+(?:me\s+)?(?:a|an|the|some)?\s*(.+)$/i,
    );
    if (afterVerb?.[1]) t = afterVerb[1].trim();
    else {
      const afterWant = t.match(/\b(?:want|need|like)\s+(?:you\s+to\s+)?(.+)$/i);
      if (afterWant?.[1]) t = afterWant[1].trim();
    }
  }
  t = t.replace(/^(a|an|the|some|one)\s+/i, "").trim();
  t = stripTails(t);
  t = t.replace(/\s+(please|thanks|thank you)$/i, "").trim();
  return t;
}

function looksLikeProductName(s: string): boolean {
  if (s.length < 2 || s.length > 80) return false;
  if (FILLER.test(s) || isIndefinite(s) || isBareItemWord(s) || isIntentVerbOnly(s)) return false;
  if (stillARequestClause(s)) return false;
  if (/^(which|what|where|who|how|why|when)\b/i.test(s)) return false;
  if (/\?/.test(s)) return false;
  if (WEEKDAY.test(s) || parseDate(s)) return false;
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/i.test(s)) {
    return false;
  }
  if (parseUsdCents(s) != null && /^\$?\d/.test(s.trim()) && s.split(/\s+/).length <= 2) {
    return false;
  }
  if (parseShoppingCity(s) || parseDeliveryTown(s)) return false;
  return true;
}

/** Concrete product, or null. Never the raw utterance unless that utterance is the name. */
export function parseItem(text: string): string | null {
  const raw = (text ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return null;
  if (extractProductUrl(raw)) return null;
  const leftover = peelShell(raw);
  if (!looksLikeProductName(leftover)) return null;
  return leftover.slice(0, 80).trim();
}
