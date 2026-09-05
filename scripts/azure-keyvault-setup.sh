#!/usr/bin/env bash
# monbounty — provision the platform Key Vault + a scoped backend identity.
#
# Creates ONE shared vault for the whole platform (the backend mints one key per
# agent-account inside it later — NOT one vault per agent), plus a service
# principal the backend uses to create + sign keys in ONLY this vault.
#
# Prereq: `az login` (run it yourself — it is interactive):
#     ! az login
# Then:
#     ! bash /opt/bounty402/scripts/azure-keyvault-setup.sh
#
# Override any of these with env vars, e.g.  LOCATION=eastus bash ...setup.sh
set -euo pipefail

LOCATION="${LOCATION:-westeurope}"
RESOURCE_GROUP="${RESOURCE_GROUP:-monbounty-rg}"
APP_NAME="${APP_NAME:-monbounty-backend}"
# Vault names are GLOBALLY unique, 3-24 chars. Override VAULT_NAME to reuse one.
VAULT_NAME="${VAULT_NAME:-monbounty-kv-$(head -c3 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
OUT="${OUT:-/tmp/claude-0/-root/c497e3fc-e00c-48a6-8988-efc5a112fba6/scratchpad/azure-monbounty.env}"

echo "→ checking az login…"
if ! az account show -o none 2>/dev/null; then
  echo "✗ not logged in. Run:  ! az login   then re-run this script." >&2
  exit 1
fi
SUB=$(az account show --query name -o tsv)
echo "  using subscription: $SUB"

echo "→ resource group: $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --only-show-errors -o none

echo "→ Key Vault: $VAULT_NAME (Premium = HSM-backed keys, RBAC auth)"
az keyvault create --name "$VAULT_NAME" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" \
  --sku premium --enable-rbac-authorization true --only-show-errors -o none
VAULT_URI=$(az keyvault show --name "$VAULT_NAME" --query "properties.vaultUri" -o tsv)
VAULT_ID=$(az keyvault show --name "$VAULT_NAME" --query id -o tsv)

echo "→ service principal for the backend (scoped to this vault only)"
SP_TSV=$(az ad sp create-for-rbac --name "$APP_NAME" --years 1 \
  --query "[appId,password,tenant]" -o tsv --only-show-errors)
APP_ID=$(echo "$SP_TSV" | cut -f1)
PASSWORD=$(echo "$SP_TSV" | cut -f2)
TENANT=$(echo "$SP_TSV" | cut -f3)

echo "→ granting 'Key Vault Crypto Officer' on the vault (create + sign keys)"
az role assignment create --assignee "$APP_ID" --role "Key Vault Crypto Officer" \
  --scope "$VAULT_ID" --only-show-errors -o none

# Write the values monbounty needs (review, then copy into /opt/bounty402/.env)
mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
AZURE_KEY_VAULT_URL=$VAULT_URI
AZURE_TENANT_ID=$TENANT
AZURE_CLIENT_ID=$APP_ID
AZURE_CLIENT_SECRET=$PASSWORD
EOF
chmod 600 "$OUT"

echo
echo "==== DONE — values written to $OUT (chmod 600) ===="
echo "     AZURE_KEY_VAULT_URL=$VAULT_URI"
echo "     AZURE_TENANT_ID=$TENANT"
echo "     AZURE_CLIENT_ID=$APP_ID"
echo "     AZURE_CLIENT_SECRET=<hidden — see $OUT>"
echo
echo "Notes:"
echo " • The client secret is a bearer credential — treat it like TREASURY_PRIVATE_KEY."
echo "   It is shown ONLY now; rotate to a certificate before production."
echo " • RBAC role assignments take ~1-2 min to propagate; the first key op may 403 briefly."
echo " • This SP can create/sign keys in THIS vault only — nothing else in your subscription."
