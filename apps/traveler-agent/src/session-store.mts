import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "./session.mts";
import { blankTrip, ensureTrip, type TripState } from "./trip-state.mts";

const DEFAULT_PATH = join(process.cwd(), ".traveler-sessions.json");

function path(): string {
  return process.env.TRAVELER_SESSIONS_PATH?.trim() || DEFAULT_PATH;
}

function reviveTrip(raw: any): TripState {
  const trip = blankTrip();
  if (!raw || typeof raw !== "object") return trip;
  if (raw.origin) {
    trip.origin = String(raw.origin);
    trip.confirmed.push("origin");
  }
  if (raw.destination) {
    trip.destination = String(raw.destination);
    trip.confirmed.push("destination");
  }
  if (raw.departure_date || raw.departDate) {
    trip.departure_date = String(raw.departure_date ?? raw.departDate);
    trip.confirmed.push("departure_date");
  }
  if (Array.isArray(raw.confirmed)) {
    trip.confirmed = [...new Set([...trip.confirmed, ...raw.confirmed])] as TripState["confirmed"];
  }
  if (raw.arrive_by) trip.arrive_by = String(raw.arrive_by);
  if (raw.note) trip.note = String(raw.note);
  trip.updated_at = typeof raw.updated_at === "number" ? raw.updated_at : Date.now();
  return trip;
}

function revive(raw: any): Session | null {
  if (!raw || typeof raw !== "object") return null;
  const phone = String(raw.phone ?? "").trim();
  if (!phone) return null;

  const flightOptions = Array.isArray(raw.flightOptions)
    ? raw.flightOptions.map((o: any) => ({
        ...o,
        departAt: o.departAt ? new Date(o.departAt) : o.departAt,
        arriveAt: o.arriveAt ? new Date(o.arriveAt) : o.arriveAt,
      }))
    : undefined;
  const selectedFlight = raw.selectedFlight
    ? {
        ...raw.selectedFlight,
        departAt: raw.selectedFlight.departAt
          ? new Date(raw.selectedFlight.departAt)
          : raw.selectedFlight.departAt,
        arriveAt: raw.selectedFlight.arriveAt
          ? new Date(raw.selectedFlight.arriveAt)
          : raw.selectedFlight.arriveAt,
      }
    : undefined;

  const s: Session = {
    phone,
    chatId: raw.chatId ?? null,
    channel: raw.channel === "relay" ? "relay" : "linq",
    relayEventId: raw.relayEventId,
    relayReplySeq: typeof raw.relayReplySeq === "number" ? raw.relayReplySeq : 0,
    relayMessageId: raw.relayMessageId,
    step: raw.step ?? "idle",
    trip: reviveTrip(raw.trip ?? {
      origin: raw.travelOrigin,
      destination: raw.travelDestination,
      departure_date: raw.travelDepartDate,
    }),
    travelOrigin: raw.travelOrigin,
    travelDestination: raw.travelDestination,
    travelDepartDate: raw.travelDepartDate,
    travelArriveBy: raw.travelArriveBy ? new Date(raw.travelArriveBy) : undefined,
    flightOptions,
    selectedFlight,
    flightBookingRef: raw.flightBookingRef,
    earnOffers: raw.earnOffers,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
  ensureTrip(s);
  return s;
}

export function loadSessionsInto(map: Map<string, Session>): void {
  const p = path();
  if (!existsSync(p)) return;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const entries = Array.isArray(data) ? data : data?.sessions;
    if (!Array.isArray(entries)) return;
    let n = 0;
    for (const raw of entries) {
      const s = revive(raw);
      if (!s) continue;
      const key =
        s.phone.startsWith("usr_") ||
        s.phone.startsWith("relay:") ||
        s.phone.startsWith("cnv_") ||
        s.phone.startsWith("chat_")
          ? s.phone
          : s.phone.replace(/\D/g, "") || s.phone;
      map.set(key, s);
      n++;
    }
    console.log(`[traveler-agent] restored ${n} session(s) from ${p}`);
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
  }, 150);
}

export function persistNow(map: Map<string, Session>): void {
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const sessions = [...map.values()].map((s) => {
      ensureTrip(s);
      return {
        ...s,
        travelArriveBy: s.travelArriveBy?.toISOString(),
        trip: s.trip,
        flightOptions: s.flightOptions?.map((o) => ({
          ...o,
          departAt: o.departAt instanceof Date ? o.departAt.toISOString() : o.departAt,
          arriveAt: o.arriveAt instanceof Date ? o.arriveAt.toISOString() : o.arriveAt,
        })),
        selectedFlight: s.selectedFlight
          ? {
              ...s.selectedFlight,
              departAt:
                s.selectedFlight.departAt instanceof Date
                  ? s.selectedFlight.departAt.toISOString()
                  : s.selectedFlight.departAt,
              arriveAt:
                s.selectedFlight.arriveAt instanceof Date
                  ? s.selectedFlight.arriveAt.toISOString()
                  : s.selectedFlight.arriveAt,
            }
          : undefined,
      };
    });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2));
    renameSync(tmp, p);
  } catch (e) {
    console.warn("[traveler-agent] failed to persist sessions:", (e as Error).message);
  }
}
