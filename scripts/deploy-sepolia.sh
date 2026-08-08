#!/usr/bin/env bash
# Deploy HandoverEscrow to Base Sepolia (requires funded deployer ETH).
# Usage: from repo root — bash scripts/deploy-sepolia.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/settlement/contracts"
set -a
# shellcheck disable=SC1091
source .env.deploy
# shellcheck disable=SC1091
source .env
set +a

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
BAL="$(cast balance "$DEPLOYER" --rpc-url https://sepolia.base.org)"
if [[ "$BAL" == "0" ]]; then
  echo "Deployer $DEPLOYER has 0 Base Sepolia ETH."
  echo "Fund it (and OPERATOR/ATTESTOR for gas), then re-run."
  echo "  Deployer: $DEPLOYER"
  echo "  Operator: $OPERATOR"
  echo "  Attestor: $ATTESTOR"
  exit 1
fi

forge script script/Deploy.s.sol \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=84532" \
  -vvvv

echo
echo "Copy HandoverEscrow address into apps/api/.env as HANDOVER_ESCROW_ADDRESS"
echo "Set USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e SMOKE_USDC_MODE=transfer"
echo "Fund a USDC_FUNDER wallet with Circle faucet USDC for shopper top-ups."
