/**
 * Host-agnostic Connect Calendar tools.
 *
 * OAuth URLs, tokens, and trip rows are produced here — chat hosts only render
 * the structured result. Relay is not imported. Gmail is not requested.
 *
 * Trips are proposed (optedIn false) until the traveler says yes. Disconnect
 * keeps opted-in trips; erasure deletes derived rows unless an active claim
 * still needs the snapshot.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { fetchGoogleCalendarEvents, parseFlightEvent, type CalendarEventInput } from "@manebra/calendar";

export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const RETENTION_MS = 30 * 24 * 3600_000;
const STATE_TTL_MS = 15 * 60_000;

export type CalendarTripStatus = "proposed" | "upcoming" | "declined";

export type CalendarTripRecord = {
  id: string;
  travelerId: string;
  travelerName: string;
  externalEventId: string;
  originCity: string;
  destinationCity: string;
  departureDate: Date;
  departAt: Date;
  arriveAt: Date | null;
  timezone: string;
  status: CalendarTripStatus;
  optedIn: boolean;
  optedInAt: Date | null;
  retentionUntil: Date;
  confidence: number;
  source: "calendar";
};

export type CalendarLinkRecord = {
  travelerId: string;
  provider: "google" | "apple";
  status: "connected" | "disconnected";
  scopes: string[];
  tokenCipher: string | null;
  refreshCipher: string | null;
  expiresAt: Date | null;
  connectedAt: Date | null;
  revokedAt: Date | null;
};

export interface CalendarStore {
  getLink(travelerId: string): Promise<CalendarLinkRecord | null>;
  saveLink(link: CalendarLinkRecord): Promise<void>;
  deleteLink(travelerId: string): Promise<void>;
  listTrips(travelerId: string): Promise<CalendarTripRecord[]>;
  saveTrip(trip: CalendarTripRecord): Promise<CalendarTripRecord>;
  deleteTrips(travelerId: string, ids: string[]): Promise<number>;
}

export function createMemoryCalendarStore(): CalendarStore {
  const links = new Map<string, CalendarLinkRecord>();
  const trips = new Map<string, CalendarTripRecord>();
  return {
    async getLink(travelerId) {
      return links.get(travelerId) ?? null;
    },
    async saveLink(link) {
      links.set(link.travelerId, link);
    },
    async deleteLink(travelerId) {
      links.delete(travelerId);
    },
    async listTrips(travelerId) {
      return [...trips.values()].filter((t) => t.travelerId === travelerId);
    },
    async saveTrip(trip) {
      const prev = [...trips.values()].find(
        (t) => t.travelerId === trip.travelerId && t.externalEventId === trip.externalEventId,
      );
      const row = { ...trip, id: prev?.id ?? trip.id };
      if (prev) trips.delete(prev.id);
      trips.set(row.id, row);
      return row;
    },
    async deleteTrips(travelerId, ids) {
      let n = 0;
      for (const id of ids) {
        const row = trips.get(id);
        if (row && row.travelerId === travelerId) {
          trips.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };
}

let activeStore: CalendarStore = createMemoryCalendarStore();

export function setCalendarStore(store: CalendarStore): void {
  activeStore = store;
}

export function getCalendarStore(): CalendarStore {
  return activeStore;
}

function tokenKey(): Buffer {
  const hex = process.env.CALENDAR_TOKEN_KEY?.trim();
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim() || process.env.CALENDAR_TOKEN_KEY?.trim() || "dev-calendar-token-key";
  return createHash("sha256").update(`manebra-calendar-token:${secret}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function openSecret(sealed: string): string | null {
  const [v, ivB, tagB, encB] = sealed.split(".");
  if (v !== "v1" || !ivB || !tagB || !encB) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    const out = Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}

export type OAuthState = {
  tid: string;
  cid: string | null;
  ch: "relay" | "linq";
  exp: number;
};

export function signOAuthState(payload: OAuthState): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", tokenKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readOAuthState(state: string, now = Date.now()): OAuthState | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", tokenKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (!payload?.tid || typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function googleRedirectUri(): string | null {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = process.env.PUBLIC_BASE_URL?.trim() || process.env.TRAVELER_PUBLIC_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/oauth/google/callback`;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim() && googleRedirectUri());
}

function authUrl(state: string): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const redirect = googleRedirectUri();
  if (!clientId || !redirect) return null;
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: "offline",
    include_granted_scopes: "false",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export type ConnectStartResult =
  | { ok: true; provider: "google"; connectUrl: string; scopes: string[] }
  | { ok: false; code: "stub" | "unconfigured"; provider: "apple" | "google"; message: string };

export async function calendarConnectStart(
  input: {
    travelerId: string;
    chatId?: string | null;
    channel?: "relay" | "linq";
    provider?: "google" | "apple";
    now?: number;
  },
  store: CalendarStore = getCalendarStore(),
): Promise<ConnectStartResult> {
  const provider = input.provider ?? "google";
  if (provider === "apple") {
    return { ok: false, code: "stub", provider: "apple", message: "phone_calendar_stub" };
  }
  const now = input.now ?? Date.now();
  const state = signOAuthState({
    tid: input.travelerId,
    cid: input.chatId ?? null,
    ch: input.channel ?? "relay",
    exp: now + STATE_TTL_MS,
  });
  const connectUrl = authUrl(state);
  if (!connectUrl) {
    return { ok: false, code: "unconfigured", provider: "google", message: "google_oauth_unconfigured" };
  }
  void store;
  return { ok: true, provider: "google", connectUrl, scopes: [GOOGLE_CALENDAR_SCOPE] };
}

export async function calendarConnectStatus(
  travelerId: string,
  store: CalendarStore = getCalendarStore(),
): Promise<{ connected: boolean; provider: string | null; scopes: string[] }> {
  const link = await store.getLink(travelerId);
  if (!link || link.status !== "connected") {
    return { connected: false, provider: link?.provider ?? null, scopes: [] };
  }
  return { connected: true, provider: link.provider, scopes: link.scopes };
}

function isIana(zone: string | null | undefined): zone is string {
  if (!zone || zone === "UTC") return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function asDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Confirmed-flight heuristic: provider status confirmed, parser confidence ≥ 0.7. */
export function confirmedFlightEvents(events: CalendarEventInput[], now = new Date()): CalendarEventInput[] {
  return events.filter((ev) => {
    const status = (ev.status ?? "confirmed").toLowerCase();
    if (status === "tentative" || status === "cancelled") return false;
    const parsed = parseFlightEvent(ev, now);
    return parsed.ok && parsed.trip.confidence >= 0.7;
  });
}

export function formatTripWhen(departAt: Date, timezone: string): string {
  const zone = isIana(timezone) ? timezone : "UTC";
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(departAt);
  return zone === "UTC" ? `${local} UTC` : local;
}

/**
 * Write proposed trips for confirmed flights. Source prose is not stored.
 * Opt-in is never set here. Re-sync keeps an existing yes or no.
 */
export async function proposeConfirmedFlights(
  input: { travelerId: string; travelerName: string; events: CalendarEventInput[]; now?: Date },
  store: CalendarStore = getCalendarStore(),
): Promise<CalendarTripRecord[]> {
  const now = input.now ?? new Date();
  const existing = await store.listTrips(input.travelerId);
  const written: CalendarTripRecord[] = [];
  for (const ev of confirmedFlightEvents(input.events, now)) {
    const parsed = parseFlightEvent(ev, now);
    if (!parsed.ok || parsed.trip.confidence < 0.7) continue;
    if (!/^[\w:.-]{3,255}$/.test(ev.externalEventId)) continue;
    const prev = existing.find((t) => t.externalEventId === ev.externalEventId);
    const departAt = asDate(ev.startsAt);
    const arriveAt = ev.endsAt ? asDate(ev.endsAt) : null;
    const timezone = isIana(ev.timeZone) ? ev.timeZone : "UTC";
    const retentionUntil = new Date((arriveAt ?? departAt).getTime() + RETENTION_MS);
    const keepChoice = prev?.optedIn || prev?.status === "declined";
    const row: CalendarTripRecord = {
      id: prev?.id ?? randomUUID(),
      travelerId: input.travelerId,
      travelerName: input.travelerName,
      externalEventId: ev.externalEventId,
      originCity: parsed.trip.departureCity,
      destinationCity: parsed.trip.destinationCity,
      departureDate: parsed.trip.departureDate,
      departAt,
      arriveAt,
      timezone,
      confidence: parsed.trip.confidence,
      retentionUntil: prev?.optedIn && prev.retentionUntil ? prev.retentionUntil : retentionUntil,
      source: "calendar",
      optedIn: prev?.optedIn ?? false,
      optedInAt: prev?.optedInAt ?? null,
      status: keepChoice ? (prev!.optedIn ? "upcoming" : "declined") : "proposed",
    };
    written.push(await store.saveTrip(row));
  }
  return written.filter((t) => t.status === "proposed");
}

export type TokenBundle = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
};

export type OAuthDeps = {
  exchangeCode?: (code: string) => Promise<TokenBundle>;
  fetchEvents?: (accessToken: string) => Promise<CalendarEventInput[]>;
  now?: number;
};

function scopeAllowsCalendar(scope: string | undefined): boolean {
  if (!scope) return true;
  return scope.split(/\s+/).some((s) => s === GOOGLE_CALENDAR_SCOPE || s.endsWith("/calendar.events.readonly") || s.endsWith("/calendar.readonly"));
}

export async function completeGoogleOAuth(
  input: { code?: string | null; state?: string | null; error?: string | null },
  deps: OAuthDeps = {},
  store: CalendarStore = getCalendarStore(),
): Promise<
  | { ok: true; travelerId: string; chatId: string | null; channel: "relay" | "linq"; proposed: CalendarTripRecord[] }
  | { ok: false; reason: "denied" | "bad_state" | "exchange" | "scope"; travelerId?: string; chatId?: string | null; channel?: "relay" | "linq" }
> {
  const now = deps.now ?? Date.now();
  const payload = input.state ? readOAuthState(input.state, now) : null;
  if (!payload) return { ok: false, reason: "bad_state" };
  if (input.error || !input.code) {
    return { ok: false, reason: "denied", travelerId: payload.tid, chatId: payload.cid, channel: payload.ch };
  }
  const exchange = deps.exchangeCode ?? exchangeGoogleCode;
  let tokens: TokenBundle;
  try {
    tokens = await exchange(input.code);
  } catch {
    return { ok: false, reason: "exchange", travelerId: payload.tid, chatId: payload.cid, channel: payload.ch };
  }
  if (!scopeAllowsCalendar(tokens.scope)) {
    return { ok: false, reason: "scope", travelerId: payload.tid, chatId: payload.cid, channel: payload.ch };
  }
  const link: CalendarLinkRecord = {
    travelerId: payload.tid,
    provider: "google",
    status: "connected",
    scopes: [GOOGLE_CALENDAR_SCOPE],
    tokenCipher: sealSecret(tokens.accessToken),
    refreshCipher: tokens.refreshToken ? sealSecret(tokens.refreshToken) : (await store.getLink(payload.tid))?.refreshCipher ?? null,
    expiresAt: new Date(now + Math.max(60, tokens.expiresIn) * 1000),
    connectedAt: new Date(now),
    revokedAt: null,
  };
  await store.saveLink(link);
  const fetchEvents = deps.fetchEvents ?? ((accessToken: string) => fetchGoogleCalendarEvents({ accessToken, calendarIds: "all" }));
  let events: CalendarEventInput[] = [];
  try {
    events = await fetchEvents(tokens.accessToken);
  } catch {
    events = [];
  }
  const proposed = await proposeConfirmedFlights(
    { travelerId: payload.tid, travelerName: `Traveler ${payload.tid.slice(-4)}`, events, now: new Date(now) },
    store,
  );
  return { ok: true, travelerId: payload.tid, chatId: payload.cid, channel: payload.ch, proposed };
}

async function exchangeGoogleCode(code: string): Promise<TokenBundle> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: googleRedirectUri() ?? "",
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`google token ${res.status}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token) throw new Error("google token missing access");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    scope: json.scope,
  };
}

export async function chooseCalendarTrip(
  input: { travelerId: string; externalEventId: string; optedIn: boolean; now?: Date },
  store: CalendarStore = getCalendarStore(),
): Promise<CalendarTripRecord | null> {
  const trips = await store.listTrips(input.travelerId);
  const trip = trips.find((t) => t.externalEventId === input.externalEventId);
  if (!trip) return null;
  const now = input.now ?? new Date();
  const anchor = trip.arriveAt ?? trip.departAt;
  const next: CalendarTripRecord = {
    ...trip,
    optedIn: input.optedIn,
    optedInAt: now,
    status: input.optedIn ? "upcoming" : "declined",
    retentionUntil: new Date(anchor.getTime() + 30 * 24 * 3600_000),
  };
  return store.saveTrip(next);
}

export async function calendarDisconnect(
  travelerId: string,
  store: CalendarStore = getCalendarStore(),
): Promise<{ kept: number; removed: number }> {
  const trips = await store.listTrips(travelerId);
  const drop = trips.filter((t) => !(t.optedIn && t.status === "upcoming")).map((t) => t.id);
  const kept = trips.length - drop.length;
  const removed = drop.length ? await store.deleteTrips(travelerId, drop) : 0;
  const link = await store.getLink(travelerId);
  if (link) {
    await store.saveLink({
      ...link,
      status: "disconnected",
      tokenCipher: null,
      refreshCipher: null,
      revokedAt: new Date(),
    });
  }
  return { kept, removed };
}

export async function calendarErase(
  travelerId: string,
  opts: { activeClaim?: boolean } = {},
  store: CalendarStore = getCalendarStore(),
): Promise<{ deletedTrips: number; keptForClaim: number }> {
  const trips = await store.listTrips(travelerId);
  const keepIds = new Set(
    opts.activeClaim ? trips.filter((t) => t.optedIn && t.status === "upcoming").map((t) => t.id) : [],
  );
  const drop = trips.filter((t) => !keepIds.has(t.id)).map((t) => t.id);
  const deletedTrips = drop.length ? await store.deleteTrips(travelerId, drop) : 0;
  await store.deleteLink(travelerId);
  return { deletedTrips, keptForClaim: keepIds.size };
}

export async function accessTokenFor(
  travelerId: string,
  store: CalendarStore = getCalendarStore(),
  now = Date.now(),
): Promise<string | null> {
  const link = await store.getLink(travelerId);
  if (!link || link.status !== "connected" || !link.tokenCipher) return null;
  const current = openSecret(link.tokenCipher);
  if (current && link.expiresAt && link.expiresAt.getTime() > now + 60_000) return current;
  if (!link.refreshCipher) return current;
  const refresh = openSecret(link.refreshCipher);
  if (!refresh || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return current;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return current;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return current;
  await store.saveLink({
    ...link,
    tokenCipher: sealSecret(json.access_token),
    expiresAt: new Date(now + (json.expires_in ?? 3600) * 1000),
  });
  return json.access_token;
}
