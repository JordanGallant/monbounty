#!/usr/bin/env bash
# Demo watcher: whenever a report is sitting in `triaging`, run the company
# verify + payout pass automatically. Makes the loop feel autonomous on stage —
# the agent submits, and within a few seconds it's verified and paid.
#
#   bash scripts/watch-triage.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
INTERVAL="${WATCH_INTERVAL:-8}"
BASE="${BOUNTY402_URL:-https://monbounty.xyz}"
TOK="$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2)"

echo "watch-triage: polling ${BASE} every ${INTERVAL}s — auto verify+payout on triaging reports"
while true; do
  n=$(curl -s -H "Authorization: Bearer $TOK" "$BASE/api/admin/reports?status=triaging" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.reports||j||[]).length||0)}catch{console.log(0)}})' 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt 0 ]; then
    echo "[$(date +%H:%M:%S)] $n report(s) triaging → running company verify + payout"
    bun run scripts/triager-flow.ts --network "${MONBOUNTY_NETWORK:-testnet}" 2>&1 \
      | grep -vE '^\[' | grep -E 'verify:|VERDICT|refund:|award:|slop|✓' || true
  fi
  sleep "$INTERVAL"
done
