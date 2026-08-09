import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, Step } from "./session.mts";

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".sessions.json");

const SHOP_STEPS = new Set<string>([
  "idle",
  "await_product",
  "await_product_confirm",
  "await_shopping_city",
  "await_listing",
  "await_delivery_city",
  "await_deadline",
  "await_max_fee",
  "await_extend",
  "await_traveler",
  "await_pay_confirm",
  "await_handover_done",
  "done",
]);

function storePath(): string {
  return process.env.LINQ_SESSIONS_PATH?.trim() || DEFAULT_PATH;
}

type Persisted = {
  version: 1;
  sessions: Record<string, SerializedSession>;
};

type SerializedSession = Omit<Session, "deadline" | "updatedAt"> & {
  deadline?: string;
  updatedAt: number;
  /** Legacy dual-mode fields (ignored). */
  mode?: string;
  travelOrigin?: unknown;
  travelDestination?: unknown;
  travelDepartDate?: unknown;
  travelArriveBy?: unknown;
  flightOptions?: unknown;
  selectedFlight?: unknown;
  flightBookingRef?: unknown;
  earnOffers?: unknown;
};

function serialize(s: Session): SerializedSession {
  return {
    ...s,
    deadline: s.deadline ? s.deadline.toISOString() : undefined,
    updatedAt: s.updatedAt,
  };
}

function deserialize(raw: SerializedSession): Session {
  const step = SHOP_STEPS.has(String(raw.step)) ? (raw.step as Step) : "idle";
  const {
    mode: _mode,
    travelOrigin: _o,
    travelDestination: _d,
    travelDepartDate: _dd,
    travelArriveBy: _ta,
    flightOptions: _fo,
    selectedFlight: _sf,
    flightBookingRef: _fb,
    earnOffers: _eo,
    ...rest
  } = raw;
  return {
    ...rest,
    deadline: raw.deadline ? new Date(raw.deadline) : undefined,
    step,
  };
}

let dirty = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function loadSessionsInto(map: Map<string, Session>): number {
  const path = storePath();
  if (!existsSync(path)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Persisted;
    let n = 0;
    for (const [key, raw] of Object.entries(parsed.sessions ?? {})) {
      map.set(key, deserialize(raw));
      n++;
    }
    console.log(`[linq-agent] restored ${n} session(s) from ${path}`);
    return n;
  } catch (e: any) {
    console.warn(`[linq-agent] session load failed: ${e?.message ?? e}`);
    return 0;
  }
}

function flush(map: Map<string, Session>) {
  const path = storePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body: Persisted = { version: 1, sessions: {} };
    for (const [k, s] of map) body.sessions[k] = serialize(s);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, path);
    dirty = false;
  } catch (e: any) {
    console.warn(`[linq-agent] session save failed: ${e?.message ?? e}`);
  }
}

/** Debounced persist so rapid texts don’t thrash disk. */
export function schedulePersist(map: Map<string, Session>) {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (dirty) flush(map);
  }, 400);
}

export function persistNow(map: Map<string, Session>) {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush(map);
}
