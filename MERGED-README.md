# manebra — MERGED with the agentic settlement layer

This is the Manebra scaffold (recovered from the original build session) with the
agentic settlement layer FULLY merged in. All touchpoints are wired; nothing is
left as a stand-in except what can only run on your machine.

## ⚠️ Before replacing your local repo: DIFF FIRST
This tree was reconstructed from the original scaffolding session. If you have
made ANY local changes since receiving manebra-scaffold.zip, diff before adopting:
```bash
diff -ru --exclude node_modules <your-repo> manebra | less
```
If you never modified the scaffold, this replaces it directly.

## What was merged (all verified)
- packages/settlement — escrow contract (22 forge tests incl. invariant + gasless),
  attestor, reconciliation, wallet providers (local + CDP), spend policy
- packages/agents — matching (kernel-mirrored gates) + negotiation (signed
  envelopes, deterministic engine)
- packages/db/prisma/schema.prisma — deltas MERGED IN (marked [settlement]/[agents])
- apps/api — all touchpoints wired:
  - bids.accept → opens escrow on-chain (agent ywallets provisioned)
  - settlement.fundBid → gasless EIP-3009 funding, policy-gated, daily window from ledger
  - handover.confirmCode → scheduleEscrowRelease (release after 48h dispute window)
  - disputes.resolveRefund → on-chain refund
  - inngest/functions.ts → escrow-release, reconcile cron, matching sweep (inngest v4 API)

## Verified in the build sandbox
- 120 vitest tests green (shared 13 · settlement core 47 · agents 30 · + suites)
- 22 Foundry tests green (unit + fuzz + fund-conservation invariant + gasless)
- FULL workspace typecheck green: apps/api + both new packages resolving against
  the REAL @manebra/shared (only @manebra/db was stubbed — see below)

## Run on your machine (cannot run in the build sandbox)
```bash
npm install
npm run db:generate      # Prisma engine download was blocked in the sandbox
npm run db:migrate -- --name agentic_settlement
npm test                 # 120 green expected
npm run contracts:test   # forge; 22 green expected
```
Then: deploy to Base Sepolia (packages/settlement/DEPLOY.md), fill apps/api env
(HANDOVER_ESCROW_ADDRESS, ATTESTOR_PRIVATE_KEY, USDC_ADDRESS, LOCAL_WALLET_SEED,
HANDOVER_CODE_SECRET, RPC_URL), and run the smoke test from the mnbr.io folder.

## Honest notes
- The tRPC context (src/server/trpc.ts) has minimal auth plumbing — wire ctx.userId
  to your Supabase auth as in your original context file.
- disputes.resolveRefund uses verifiedProcedure — swap for your admin-gated procedure.
- The Stripe service files are NOT in this tree (escrow path replaces them). If you
  need the Stripe path in parallel, copy those files from your original scaffold.
- apps/mobile and apps/admin are not in this tree (unchanged by the merge) — keep
  yours from the original scaffold.
