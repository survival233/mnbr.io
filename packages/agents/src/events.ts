/**
 * Event sender for the agents package. The Inngest id MUST match the id
 * used by apps/api's client so events land in the same app. Sending only —
 * function REGISTRATION (crons/handlers) happens in apps/api (see MERGE-GUIDE).
 */
import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "manebra" });
