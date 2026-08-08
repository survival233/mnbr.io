import { router } from "../trpc.js";
import { bidsRouter } from "./bids.js";
import { handoverRouter } from "./handover.js";
import { settlementRouter } from "./settlement.js";
import { disputesRouter } from "./disputes.js";
import { tripsRouter } from "./trips.js";
import { notificationsRouter } from "./notifications.js";
import { itemsRouter } from "./items.js";
import { matchesRouter } from "./matches.js";

export const appRouter = router({
  bids: bidsRouter,
  handover: handoverRouter,
  settlement: settlementRouter,
  disputes: disputesRouter,
  trips: tripsRouter,
  notifications: notificationsRouter,
  items: itemsRouter,
  matches: matchesRouter,
});
export type AppRouter = typeof appRouter;
