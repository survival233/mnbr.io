/** Open question the user must answer. Survives reconnect via session persist. */
export type DialogPendingSlot = {
  slot:
    | "product"
    | "shopping_city"
    | "delivery_city"
    | "need_by"
    | "delivery_fee"
    | "listing"
    | "traveler"
    | "pay"
    | "brief"
    | "origin"
    | "destination"
    | "departure_date"
    | "flight"
    | "carry";
  proposed: string | number | null;
  kind: "date" | "choice" | "money" | "text" | "bool";
  prompt: string;
  options?: { id: string; label: string }[];
};

/** Structural session view for classifyTurn. Agent Session types must satisfy this. */
export type DialogSession = {
  step: string;
  searchQuery?: string;
  shoppingCity?: string;
  deliveryCity?: string;
  deadline?: Date;
  maxFeeCents?: number;
  listings?: Array<{
    productTitle: string;
    storeName: string;
    priceCents: number;
    variants?: Array<{ productTitle: string; priceCents: number; color?: string; storage?: string; size?: string }>;
  }>;
  selected?: { productTitle?: string } | null;
  ranked?: Array<{ name: string; departs?: string }>;
  chosenTravelerId?: string;
  offer?: unknown;
  pending?: DialogPendingSlot | null;
  stay?: StayMemory;
  turns?: Array<{ role: "user" | "assistant"; text: string }>;
  totalCents?: number;
};

export type TurnAct = "META" | "REPAIR" | "CONTINUE" | "NEW" | "REASK";

export type StayMemory = {
  lastItem?: string;
  lastQuoteCents?: number;
  lastTravelerName?: string;
  lastTravelerId?: string;
  lastOfferId?: string;
  waitingSince?: number;
  lastQuestion?: string;
  lastAct?: TurnAct;
  openedAt?: number;
};

export type ClassifiedTurn = {
  act: TurnAct;
  meta?: "cancel" | "status" | "wait";
  slot?: DialogPendingSlot["slot"] | "product";
  value?: string | number;
  optionIndex?: number;
  query?: string;
};
