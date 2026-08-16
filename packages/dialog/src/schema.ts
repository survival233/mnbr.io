/** Agents register one of these. They do not own voice or turn order. */

export type SlotKind = "date" | "choice" | "money" | "text" | "bool";

export type SlotDef = { id: string; kind: SlotKind };

export const SHOPPER_SLOT_SCHEMA: readonly SlotDef[] = [
  { id: "shopping_city", kind: "text" },
  { id: "delivery_city", kind: "text" },
  { id: "need_by", kind: "date" },
  { id: "delivery_fee", kind: "money" },
  { id: "listing", kind: "choice" },
  { id: "traveler", kind: "choice" },
  { id: "pay", kind: "bool" },
  { id: "brief", kind: "bool" },
];

export const TRAVELER_SLOT_SCHEMA: readonly SlotDef[] = [
  { id: "origin", kind: "text" },
  { id: "destination", kind: "text" },
  { id: "departure_date", kind: "date" },
  { id: "flight", kind: "choice" },
  { id: "carry", kind: "bool" },
];
