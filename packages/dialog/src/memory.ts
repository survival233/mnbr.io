import type { StayMemory } from "./types";

export type { StayMemory };

export type DialogTurn = { role: "user" | "assistant"; text: string };

export function ensureStay(stay?: StayMemory | null): StayMemory {
  return stay ?? { openedAt: Date.now() };
}

export function rememberQuestion(stay: StayMemory, question: string): void {
  const q = question.trim();
  if (q) stay.lastQuestion = q.slice(0, 280);
}

export function rememberItem(stay: StayMemory, item: string): void {
  const v = item.trim();
  if (v) stay.lastItem = v.slice(0, 120);
}

export function rememberQuote(stay: StayMemory, totalCents: number): void {
  if (Number.isFinite(totalCents) && totalCents > 0) stay.lastQuoteCents = totalCents;
}

export function rememberCounterparty(stay: StayMemory, name?: string, id?: string): void {
  if (name?.trim()) stay.lastTravelerName = name.trim().slice(0, 80);
  if (id?.trim()) stay.lastTravelerId = id.trim();
}

export function rememberOffer(stay: StayMemory, offerId: string): void {
  if (offerId.trim()) stay.lastOfferId = offerId.trim();
}

export function rememberWait(stay: StayMemory, at = Date.now()): void {
  if (stay.waitingSince == null) stay.waitingSince = at;
}

export function clearWait(stay: StayMemory): void {
  stay.waitingSince = undefined;
}

export function waitingMs(stay: StayMemory, now = Date.now()): number | null {
  if (stay.waitingSince == null) return null;
  return Math.max(0, now - stay.waitingSince);
}

function waitLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

/** Compact stay for LLM injection. Not a second form store. */
export function staySummary(stay: StayMemory, now = Date.now()): string {
  const wait = waitingMs(stay, now);
  return [
    stay.lastItem && `item=${stay.lastItem}`,
    stay.lastQuoteCents != null && `quote_cents=${stay.lastQuoteCents}`,
    stay.lastTravelerName && `counterparty=${stay.lastTravelerName}`,
    stay.lastOfferId && `offer=${stay.lastOfferId}`,
    wait != null && `waiting=${waitLabel(wait)}`,
    stay.lastQuestion && `last_ask=${stay.lastQuestion}`,
    stay.lastAct && `last_act=${stay.lastAct}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function recentTurnsText(turns: DialogTurn[] | undefined, n = 8): string {
  const rows = (turns ?? []).slice(-n);
  if (!rows.length) return "";
  return rows.map((t) => `${t.role}: ${t.text}`).join("\n");
}

export function llmStayBlock(stay: StayMemory | undefined, turns?: DialogTurn[]): string {
  const mem = staySummary(stay ?? {});
  const hist = recentTurnsText(turns);
  return [mem && `Stay: ${mem}`, hist && `Recent turns:\n${hist}`].filter(Boolean).join("\n");
}
