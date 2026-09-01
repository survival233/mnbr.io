/**
 * Shopper ↔ traveler assignment.
 *
 * Shopper copy must not claim someone is heading their way until a live
 * traveler match exists AND that traveler has accepted. Seeds are never matches.
 *
 * Rules:
 * - Sequential: offer one traveler at a time; first to accept wins.
 * - Decline / timeout: auto-advance to the next untried traveler. Do not tell
 *   the shopper anyone accepted. If the queue is empty, keep the request open.
 * - No live match: keep the request pending until the shopper need-by.
 * - Shopper cancel: the request is no longer valid; a later accept is dropped.
 * - Traveler offer timeout: 2 hours, then the next traveler.
 */

export const TRAVELER_OFFER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function searchingCopy(city: string): string {
  return `I’ll look for a traveler heading to ${city}. I’ll ping you when someone agrees.`;
}

export function noMatchCopy(city: string): string {
  return `No traveler is currently heading to ${city}. I’ll keep this request open and ping you if someone on that route agrees.`;
}

export function waitingCopy(city: string): string {
  return `Still looking for a traveler heading to ${city}. I’ll ping you when someone agrees.`;
}

export function keepLookingCopy(city: string): string {
  return `I’ll keep looking for a traveler heading to ${city}.`;
}

export function requestExpiredCopy(city: string): string {
  return `Nobody agreed in time for ${city}, so I closed this one. Say hi to try again.`;
}

/** Gated confirmation — only after a live traveler accepted an open request. Never name them. */
export function travelerAgreedCopy(_name: string, city: string): string {
  return `Someone heading to ${city} took it.`;
}

export function briefConfirmCopy(city: string): string {
  return `I’ll look for a traveler heading to ${city} — say yes to send the request.`;
}

export function nextUntriedIndex(
  ranked: ReadonlyArray<{ id: string }>,
  tried: Iterable<string>,
): number | null {
  const done = tried instanceof Set ? tried : new Set(tried);
  const i = ranked.findIndex((t) => !done.has(t.id));
  return i >= 0 ? i : null;
}

export function offerTimedOut(
  createdAt: Date,
  now = Date.now(),
  timeoutMs = TRAVELER_OFFER_TIMEOUT_MS,
): boolean {
  return now - createdAt.getTime() >= timeoutMs;
}

export function requestPastDeadline(deadline: Date | undefined, now = Date.now()): boolean {
  return Boolean(deadline && now > deadline.getTime());
}

export function shopperStillWaiting(
  step: string,
  bidId: string | undefined,
  offerId: string,
): boolean {
  return step === "await_traveler_decision" && bidId === offerId;
}

/** The shopper may hear “heading your way” only after accept on a still-open wait. */
export function canConfirmHeadingYourWay(args: {
  offerStatus: string;
  shopperWaiting: boolean;
}): boolean {
  return args.offerStatus === "accepted" && args.shopperWaiting;
}

export function claimsHeadingYourWay(text: string): boolean {
  return /heading your way/i.test(text);
}
