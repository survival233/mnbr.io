#!/usr/bin/env bash
# Interactive Linq Shared-Line setup for Manebra iMessage demo.
# Usage: bash scripts/linq-imessage-setup.sh
set -euo pipefail

echo "=== Manebra × Linq setup ==="
if ! command -v linq >/dev/null; then
  echo "Installing @linqapp/cli@latest (needs Node 22+)…"
  npm install -g @linqapp/cli@latest
fi
echo "CLI: $(linq --version)"

if ! linq whoami >/dev/null 2>&1; then
  echo
  echo "Not logged in. Either:"
  echo "  A) New account:  linq signup --email YOU@EMAIL"
  echo "                   (then) linq signup --email YOU@EMAIL --code XXXXXX --name \"Your Name\""
  echo "  B) Existing:     linq login --token linq_xxx"
  echo
  exit 1
fi

linq whoami
echo
read -r -p "Your personal phone (E.164, e.g. +14155551234): " PHONE
linq contacts add "$PHONE" || true
echo
echo "Shared Line is inbound-first: open Messages and text your Linq Number first (say hi)."
echo "In another terminal run:  linq webhooks listen"
echo "When message.received appears, continue."
echo
echo "Then put in apps/agent-cli/.env:"
echo "  DEMO_TRANSPORT=linq"
echo "  LINQ_TO_PHONE=$PHONE"
echo
echo "Run:  npm run demo:linq"
