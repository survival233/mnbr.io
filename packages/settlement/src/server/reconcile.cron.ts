/**
 * MOVED: function registration now lives in apps/api (crons and event handlers
 * must register on the app's own Inngest client). See MERGE-GUIDE.md Phase 5.
 * This file remains only so old imports fail loudly with a pointer.
 */
export const reconcileCron: never = (() => {
  throw new Error("Register the reconcile cron in apps/api — see MERGE-GUIDE.md Phase 5");
})();
