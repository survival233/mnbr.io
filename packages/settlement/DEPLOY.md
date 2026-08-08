# Deploy to Base Sepolia (the sandbox)

Step 3. This deploys `HandoverEscrow` against Circle's testnet USDC and wires the
`apps/api` attestor + reconciliation job to the live contract.

## Verified constants (confirm on first-party docs before deploying)
| | value | source |
|---|---|---|
| Chain | Base Sepolia, id **84532** | docs.base.org |
| USDC | **0x036CbD53842c5426634e7929541eC2318f3dCF7e** (6 dp, FiatTokenProxy) | Circle developer docs |
| Dev RPC | https://sepolia.base.org (use Alchemy/QuickNode/CDP for real load) | docs.base.org |

Testnet USDC and ETH come from official Base Sepolia / Circle faucets. Always
re-verify the USDC address at developers.circle.com/stablecoins/usdc-contract-addresses —
testnet addresses do change, and fakes exist.

## Roles you must set (they become the constructor args)
- `OWNER` — admin that can rotate roles; **make this a Safe multisig** before mainnet.
- `OPERATOR` — backend key that calls `open()`.
- `ATTESTOR` — backend key that signs release/refund (dev: env key; prod: KMS).
- `TREASURY` — Manebra commission sink.

## Deploy
```bash
cd foundry
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0

export PRIVATE_KEY=0x...            # deployer/owner, funded with Base Sepolia ETH
export USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export TREASURY=0x... OPERATOR=0x... ATTESTOR=0x... OWNER=0x...
export ETHERSCAN_API_KEY=        # for --verify; a unified Etherscan key (Basescan's
                                    # own V1 API was retired Aug 2025 — one etherscan.io
                                    # key now covers Base via chainid 84532)

forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast --verify
```
If verification complains about a deprecated V1 endpoint, append
`--verifier-url "https://api.etherscan.io/v2/api?chainid=84532"`.
The script prints the deployed address. (Verified locally: the same script broadcasts
successfully to a live chain at id 84532.)

## Wire apps/api to the deployment
Set in `apps/api/.env` (see `.env.example`):
```
CHAIN_ENV=testnet
RPC_URL=https://sepolia.base.org
HANDOVER_ESCROW_ADDRESS=0x<deployed>
ATTESTOR_PRIVATE_KEY=0x<attestor key>     # must match the ATTESTOR address above
```
The address/attestor must match the constructor args, or `release()` will reject every
attestation with `BadAttestation`.

## Smoke-test the live sandbox
1. `open()` a bid (operator), `fund()` from a USDC-holding test wallet.
2. Confirm the handover code → attestor signs → `release()`; verify payee + treasury balances.
3. Walk refund and timeout-`reclaim()` once each.

## Monitoring seam: reconciliation
`reconcile.cron.ts` runs `reconcileEscrows()` every 5 minutes:
- reads on-chain `stateOf` for every non-terminal escrow (batched via Multicall3,
  which is live on Base Sepolia),
- compares to `bid.escrowState` using the exhaustively-tested `classifyDrift`,
- **heals** benign forward drift (a missed/late event) toward the chain,
- **escalates** anomalies (mirror leading the chain, or terminal states disagreeing)
  via `settlement/anomaly.detected` — these must page, never auto-heal.

This is the first concrete piece of the settlement-agent monitoring seam from the A2A
plan: an autonomous check that the money mirror never diverges from chain truth.
Run it in the sandbox against deliberately-induced drift (kill the event indexer for a
few minutes) to confirm it heals and alerts as expected before mainnet.

## Before mainnet
Audit the contract; get the legal opinion; move `OWNER` to a Safe multisig.

## Step 4 addendum — agent wallets + gasless funding
The contract now has `fundWithAuthorization` (EIP-3009): the shopper's agent wallet signs
offline and any relayer submits — **users never hold ETH**. Native USDC on Base supports
EIP-3009; read the token's EIP-712 domain on-chain (EIP-5267 / name+version), never hardcode.

Env additions (apps/api):
```
WALLET_PROVIDER=local              # local (dev/sandbox) | cdp (production)
LOCAL_WALLET_SEED=...              # local only; >=16 chars, dev secrets manager
CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=...   # cdp only
SPEND_MAX_PER_TX_CENTS=50000       # $500 — converted via centsToUsdc
SPEND_DAILY_CAP_CENTS=100000      # $1000
```
Policy allowlist is always exactly `[HANDOVER_ESCROW_ADDRESS]`.

Defense in depth for CDP: mirror the same caps as a CDP server-side account policy so the
guardrail holds even if the app process is compromised. Gas: the operator relays
`fundWithAuthorization` and `release` (platform pays); at scale, route relaying through
CDP's paymaster on Base for sponsored gas instead of a hot operator key.

Note: contract changed — redeploy to Base Sepolia and update HANDOVER_ESCROW_ADDRESS.
