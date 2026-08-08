#!/usr/bin/env bash
# List Linq webhook subscriptions and optionally delete stale laptop relays.
# Usage:
#   bash apps/linq-agent/scripts/webhook-hygiene.sh
#   bash apps/linq-agent/scripts/webhook-hygiene.sh --delete-localhost
set -euo pipefail

DELETE_LOCAL=0
if [[ "${1:-}" == "--delete-localhost" ]]; then
  DELETE_LOCAL=1
fi

if ! command -v linq >/dev/null 2>&1; then
  echo "linq CLI not found. Install/login first." >&2
  exit 1
fi

echo "== Linq webhooks =="
linq webhooks list --json 2>/dev/null || linq webhooks list

if [[ "$DELETE_LOCAL" -eq 1 ]]; then
  echo
  echo "== Deleting subscriptions whose URL contains localhost / 127.0.0.1 =="
  # Best-effort parse; CLI JSON shape may vary
  if command -v jq >/dev/null 2>&1; then
    ids=$(linq webhooks list --json 2>/dev/null | jq -r '
      (if type=="array" then . else (.webhooks // .data // .items // []) end)
      | .[]
      | select((.url // .endpoint // "") | test("localhost|127\\.0\\.0\\.1"))
      | (.id // .webhook_id // empty)
    ' || true)
    if [[ -z "${ids}" ]]; then
      echo "No localhost webhooks found (or list JSON unparseable). Delete manually:"
      echo "  linq webhooks delete <id>"
    else
      while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        echo "Deleting $id …"
        linq webhooks delete "$id" || true
      done <<< "$ids"
    fi
  else
    echo "Install jq for auto-delete, or run: linq webhooks delete <id>"
  fi
fi

echo
echo "Keep one permanent hosted URL only, e.g.:"
echo "  linq webhooks create --url \"https://YOUR_HOST/webhooks/linq?version=2026-02-03\" --events message.received --json"
echo "Then set LINQ_WEBHOOK_SECRET on the host and stop laptop 'linq webhooks listen'."
