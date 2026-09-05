#!/usr/bin/env bash
# Self-contained web3 security demo — the on-chain analog of the web2 Acme Pay
# demo. Two rock-solid steps, no external funds, no network writes:
#
#   1. A company SUBMITS a contract (address or ABI). monbounty verifies the
#      address is really deployed on-chain (has bytecode) before it can scope a
#      bounty — the "if verified" gate.
#   2. A hunter PROVES the exploit. A Foundry PoC runs the vulnerable contract in
#      a real EVM and drains it; the ImpactProof harness observes what moved and
#      classifies the band (theft-user-funds → CRITICAL). The hunter writes only
#      exploit(); every assertion lives in code the company reads first.
#
set -euo pipefail
cd "$(dirname "$0")/../.."
MONBOUNTY=${MONBOUNTY_URL:-http://127.0.0.1:3044}
# A real deployed contract to demonstrate the "verify a submitted address" gate.
SUBMIT_ADDR=${SUBMIT_ADDR:-0x534b2f3A21130d7a60830c2Df862319e593943A3}
SUBMIT_RPC=${SUBMIT_RPC:-https://testnet-rpc.monad.xyz}

echo "════════════════════════════════════════════════════════════════"
echo " monbounty — web3 security demo"
echo "════════════════════════════════════════════════════════════════"

echo
echo "▶ 1/2  Company submits a contract → monbounty verifies it's deployed"
echo "        address: $SUBMIT_ADDR"
curl -s -X POST "$MONBOUNTY/api/web3/verify-contract" -H 'content-type: application/json' \
  -d "{\"address\":\"$SUBMIT_ADDR\",\"rpc\":\"$SUBMIT_RPC\"}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("        →",("DEPLOYED ✓" if d.get("deployed") else "not deployed ✗"),"| codeSize",d.get("codeSizeBytes"),"bytes | chainId",d.get("chainId"));print("        →",d.get("verdict"))'
echo "        (an EOA or wrong chain returns deployed:false — it cannot be scoped)"

echo
echo "▶ 2/2  Hunter PoC → prove the exploit against the vulnerable contract"
echo "        target: LeakyVault (unprotected rescueTo() drains the vault)"
( cd contracts/poc && FOUNDRY_PROFILE=poc forge test --match-contract LeakyTheft -vv 2>&1 \
    | grep -iE "PROVEN_IMPACT|VALUE_MOVED|\[PASS\]|Suite result" | sed 's/^/        /' )

echo
echo "════════════════════════════════════════════════════════════════"
echo " Result: submitted contract verified deployed, and the hunter's PoC"
echo " proved theft-user-funds (CRITICAL) — measured, not argued."
echo " The same flow scopes a real bounty: POST /api/web3/verify-contract,"
echo " then the ImpactProof harness grades any submitted PoC on-chain."
echo "════════════════════════════════════════════════════════════════"
