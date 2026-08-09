import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "./session.mts";

const DEFAULT_PATH = join(process.cwd(), ".traveler-sessions.json");

function path(): string {
  return process.env.TRAVELER_SESSIONS_PATH?.trim() || DEFAULT_PATH;
}

function revive(raw: any): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const phone = String(raw.phone ?? "").trim();
  if (!phone) return null;
  const s: Session = {
    phone,
    chatId: raw.chatId ?? null,
    relayEventId: raw.relayEventId,
    relayReplySeq: typeof raw.relayReplySeq === "number" ? raw.relayReplySeq : 0,
    relayMessageId: raw.relayMessageId,
    step: raw.step ?? "idle",
    travelOrigin: raw.travelOrigin,
    travelDestination: raw.travelDestination,
    travelDepartDate: raw.travelDepartDate,
    travelArriveBy: raw.travelArriveBy ? new Date(raw.travelArriveBy) : undefined,
    flightOptions: raw.flightOptions,
    selectedFlight: raw.selectedFlight,
    flightBookingRef: raw.flightBookingRef,
    earnOffers: raw.earnOffers,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
  return s;
}

export function loadSessionsInto(map: Map<string, Session>): void {
  const p = path();
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const entries = Array.isArray(data) ? data : data?.sessions;
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const s = revive(raw);
      if (!s) continue;
      const key = s.phone.startsWith("usr_") || s.phone.startsWith("relay:") || s.phone.startsWith("cnv_")
        ? s.phone
        : s.phone.replace(/\D/g, "") || s.phone;
      map.set(key, s);
    }
  } catch (e) {
    console.warn("[traveler-agent] failed to load sessions:", (e as Error).message);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function schedulePersist(map: Map<string, Session>): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    persistNow(map);
  }, 400);
}

export function persistNow(map: Map<string, Session>): void {
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const sessions = [...map.values()].map((s) => ({
      ...s,
      travelArriveBy: s.travelArriveBy?.toISOString(),
    }));
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, p);
  } catch (e) {
    console.warn("[traveler-agent] failed to persist sessions:", (e as Error).message);
  }
}
