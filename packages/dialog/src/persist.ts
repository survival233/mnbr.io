/**
 * Persist form state before the agent asks.
 * Never ask from unsaved pending — a restart must re-ask the same slot.
 */
export function persistBeforeAsk(persist: () => void): void {
  persist();
}
