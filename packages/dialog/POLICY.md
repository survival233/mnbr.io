# Dialog policy

Owner: **conversation**. Both Shopper and Traveler import `@manebra/dialog`. Do not copy this protocol into an agent.

Voice: [PERSONA.md](./PERSONA.md). Import `HOSPITALITY_PERSONA`.

## Persist before ask

Flush session state before the agent asks. A restart must re-ask the same open slot. Use `persistBeforeAsk`.

## Classify against state, not famous phrases

`classifyTurn(session, { text, hasPhoto })` is the only inbound classifier.

Order: **META → REPAIR → CONTINUE → NEW → REASK**.

- **META** — cancel / status / wait. Wins over an open slot.
- **REPAIR** — change an already-filled slot while another question is open.
- **CONTINUE** — answer the open question.
- **NEW** — unmistakable new job. Search / new-trip only after NEW.
- **REASK** — ambiguous while a slot or stay is open. Never search.

A gap in time does not change the act. Same utterance + same persisted state → same act.

Invalid / missing model act → REASK, never NEW.

Do not add rules named after particular guest lines.

## Act-first

After classify, `composeHostReply` acknowledges the act, then the next slot if needed. Never let the next empty field be the whole message. Matching / wait can run in the background while the text is maintenance.

## Memory

The stay (`StayMemory`) persists with the session: last item, last quote, last counterparty, last offer, wait clock, last question. Inject `llmStayBlock` + recent both-role turns into every LLM call. Coming back is load memory, not a new job.
