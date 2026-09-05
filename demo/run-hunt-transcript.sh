#!/usr/bin/env bash
# Autonomous hunter agent session — the full curl→bounty flow, captured verbatim.
set -uo pipefail
cd /opt/bounty402
LOG="${1:-/tmp/hunter-transcript.log}"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

BASE_PUB="https://monbounty.xyz"
PROG="acme-pay-demo"
HUNTER="0x89f2f755c3a67126ff88d62767ef07bf114dcc9d"

echo "┌────────────────────────────────────────────────────────────────┐"
echo "│  monbounty · autonomous hunter agent                           │"
echo "│  operator-authorized: spend up to \$6 USDC on ${PROG}     │"
echo "└────────────────────────────────────────────────────────────────┘"
echo
echo "\$ # step 1 — knock on the bounty. no wallet, no payment yet."
echo "\$ curl -sS -X POST '${BASE_PUB}/api/v1/reports?program=${PROG}' \\"
echo "       -H 'content-type: application/json' -d '{\"title\":\"IDOR\",\"severity\":\"high\"}'"
echo "  → HTTP 402 Payment Required"
echo "  → the server hands back an x402 challenge (Payment-Required header):"
HDR=$(mktemp)
curl -sS -D "$HDR" -o /dev/null -X POST "${BASE_PUB}/api/v1/reports?program=${PROG}" \
     -H 'content-type: application/json' -d '{"title":"IDOR","severity":"high"}'
CH=$(grep -i '^payment-required:' "$HDR" | sed 's/^[Pp]ayment-[Rr]equired: //' | tr -d '\r')
JQ=$(mktemp); echo "$CH" | base64 -d > "$JQ" 2>/dev/null; rm -f "$HDR"
DEC=$(mktemp); cat > "$DEC" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
labels={"eip155:10143":"Monad testnet","eip155:143":"Monad",
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1":"Solana devnet"}
print("      resource :", d["resource"]["url"])
print("      pay      : 0.60 USDC refundable bond  (one triage ticket)")
for a in d["accepts"]:
    net=a["network"]; lab=labels.get(net,net)
    print("      accepts  : {:14s} payTo {}...  ({})".format(lab, a["payTo"][:10], net))
PY
python3 "$DEC" "$JQ"; rm -f "$JQ" "$DEC"
echo
echo "\$ # the agent will NOT pay a URL on its say-so. it pays because its"
echo "\$ # operator authorized a \$6 budget in this session. now: wallet + pay."
echo
echo "\$ bun run demo/test-web2.ts"
echo "────────────────────────────────────────────────────────────────────"
BOUNTY402_URL="http://127.0.0.1:3044" bun run demo/test-web2.ts
echo "────────────────────────────────────────────────────────────────────"
echo "done · $(date -u '+%Y-%m-%d %H:%M:%SZ')"
