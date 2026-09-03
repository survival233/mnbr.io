import { waitingMs } from "./memory";
import { guestCityName } from "./cities";
import type { ClassifiedTurn, StayMemory, TurnAct } from "./types";

export type HostBeats = { lead?: string; follow?: string };

function waitBit(stay: StayMemory, now: number): string {
  const ms = waitingMs(stay, now);
  if (ms == null) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "";
  if (min < 60) return ` (${min}m)`;
  return ` (${Math.round(min / 60)}h)`;
}

/**
 * Act-first host reply. Lead acknowledges the classified act from stay.
 * Follow is the next job step. Never a switch on guest wording.
 */
export function composeHostReply(args: {
  act: TurnAct;
  meta?: ClassifiedTurn["meta"];
  stay: StayMemory;
  next?: string;
  now?: number;
}): string[] {
  const stay = args.stay;
  const now = args.now ?? Date.now();
  const itemRaw = stay.lastItem;
  const item = itemRaw
    ? /^[A-Za-z]{3}$/.test(itemRaw.trim())
      ? guestCityName(itemRaw) ?? itemRaw
      : itemRaw
    : undefined;
  const follow = args.next?.trim() || undefined;

  let lead: string | undefined;
  if (args.act === "META" && args.meta === "cancel") {
    lead = "Alright — we’ll leave that.";
  } else if (args.act === "META") {
    lead = item
      ? `${item}${waitBit(stay, now)}.`
      : `This is still open${waitBit(stay, now)}.`;
  } else if (args.act === "REPAIR") {
    lead = item ? `Updated — ${item}.` : "Updated.";
  } else if (args.act === "REASK") {
    lead = stay.waitingSince && item
      ? `${item}${waitBit(stay, now)}.`
      : undefined;
  } else if (args.act === "CONTINUE") {
    lead = "Got it.";
  }

  if (lead && follow && follow.toLowerCase() === lead.toLowerCase()) lead = undefined;
  if (lead && follow) return [lead, follow];
  if (follow) return [follow];
  if (lead) return [lead];
  return [];
}

export function hostBeats(args: Parameters<typeof composeHostReply>[0]): HostBeats {
  const [a, b] = composeHostReply(args);
  return b ? { lead: a, follow: b } : { follow: a };
}
