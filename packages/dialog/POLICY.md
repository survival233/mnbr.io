# Dialog policy

Owner: **conversation**. Both Shopper and Traveler import `@manebra/dialog`. Do not copy this protocol into an agent.

## Persist before ask

Flush session state before the agent asks. A restart must re-ask the same open slot. Use `persistBeforeAsk`.

## Classify against state, not famous phrases

`classifyTurn(session, { text, hasPhoto })` is the only inbound classifier.

Order: **META → REPAIR → CONTINUE → NEW → REASK**.

- **META** — cancel / status / wait. Wins over an open slot.
- **REPAIR** — change an already-filled slot (`actually Friday`) while another question is open.
- **CONTINUE** — answer the open question (typos, fragments, “ok”, option labels).
- **NEW** — unmistakable new item (photo or “get me X instead”). Search only after NEW.
- **REASK** — ambiguous fragment while a slot is open. Never search.

A gap in time does not change the act. Same utterance + same persisted state → same act.

Invalid / missing model act → REASK, never NEW.
