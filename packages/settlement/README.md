# @manebra/settlement

Escrow-based, country-agnostic settlement for the agentic marketplace: USDC held on
Base, released by an EIP-712 attestation the backend signs after the handover code is
confirmed. One workspace package in the `mnbr/manebra` monorepo.

## Layout

```
packages/settlement/
  src/
    core/      pure logic — no keys, no chain writes, no db. Safe to import anywhere.
      units.ts         cents ⇄ USDC base units (the only crossing point)
      escrow-id.ts     bidId → bytes32 escrow id (keccak256, collision-safe)
      attestation.ts   EIP-712 HandoverAttestation builder (no signing key)
      escrow-state.ts  on-chain⇄mirror mapping + classifyDrift (reconciliation core)
      abi.ts           generated HandoverEscrow ABI (as const)
    server/    backend only — holds keys, writes chain, touches db/inngest.
      config.ts        zod-validated env; fails fast at boot
      attestor.ts      signs release/refund; key here only (KMS-swappable)
      handover-seam.ts confirmed handover → escrow release/refund (the seam)
      reconcile.ts     on-chain vs mirror reconciliation (settlement-agent seam)
      reconcile.cron.ts 5-min Inngest schedule; pages on anomalies
  contracts/   Foundry project: HandoverEscrow.sol + tests + deploy script
```

## Exports (subpath-scoped so pure code never pulls in server deps)

```ts
import { centsToUsdc, classifyDrift, bidIdToEscrowId } from "@manebra/settlement";        // core
import { reconcileEscrows, confirmHandover } from "@manebra/settlement/server";           // backend
import { HandoverEscrowAbi } from "@manebra/settlement/abi";
```

## Depends on (already in the monorepo)
- `@manebra/shared` → `assertTransition` (bid state machine), `verifyHandoverCode`
- `@manebra/db` → the Prisma client + `Bid` / `BidEvent` (after applying the schema delta)

## Test
```bash
pnpm --filter @manebra/settlement test            # vitest: 41 core tests
pnpm --filter @manebra/settlement contracts:test  # forge: 15 tests incl. fund-conservation invariant
```

## Verified
- Contract: 15 Foundry tests (unit + fuzz@512 + invariant 128×32, 0 reverts). Compiles clean.
- Core: 41 vitest tests (units, escrow-id, and the full 5×5 drift-classifier matrix).
- Types: core + server typecheck against real viem/zod (shared deps stubbed here; real in-repo).
- Deploy script broadcasts successfully to a live chain at Base Sepolia's id.

See `DEPLOY.md` for the Base Sepolia runbook and the reconciliation monitoring seam.
