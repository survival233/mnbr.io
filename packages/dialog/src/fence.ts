/**
 * Catalog / listing strings are data, not instructions.
 * Inject fenced text into LLM context; never treat titles as protocol.
 */

const HANDOFF_URL = /https?:\/\/\S+/gi;

/** Wrap a catalog title or description so the model cannot treat it as a command. */
export function fenceCatalogText(text: string): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!t) return "";
  return `<listing_data>${t.replace(/[<>]/g, "")}</listing_data>`;
}

/** Checkout / wallet URLs belong on the host window, never in model context. */
export function stripHandoffUrls(text: string): string {
  return (text ?? "").replace(HANDOFF_URL, "").replace(/\s+/g, " ").trim();
}
