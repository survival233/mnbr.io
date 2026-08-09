import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, Step } from "./session.mts";

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".sessions.json");

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
};

function serialize(s: Session): SerializedSession {
  return {
    ...s,
    deadline: s.deadline ? s.deadline.toISOString() : undefined,
    updatedAt: s.updatedAt,
  };
}

function deserialize(raw: SerializedSession): Session {
  const flightOptions = raw.flightOptions?.map((o) => ({
    ...o,
    departAt: new Date(o.departAt as unknown as string),
    arriveAt: new Date(o.arriveAt as unknown as string),
  }));
  const selectedFlight = raw.selectedFlight
    ? {
        ...raw.selectedFlight,
        departAt: new Date(raw.selectedFlight.departAt as unknown as string),
        arriveAt: new Date(raw.selectedFlight.arriveAt as unknown as string),
      }
    : undefined;
  return {
    ...raw,
    mode: raw.mode ?? "shop",
    deadline: raw.deadline ? new Date(raw.deadline) : undefined,
    travelArriveBy: raw.travelArriveBy ? new Date(raw.travelArriveBy as unknown as string) : undefined,
    flightOptions,
    selectedFlight,
    step: raw.step as Step,
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
