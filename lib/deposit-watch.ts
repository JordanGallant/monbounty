// The crypto deposit rail's other half: watch the platform deposit address for
// incoming USDC and credit the matching open deposit's balance. Same idea as the
// x402 afterSettle correlation — an on-chain event is matched back to the row it
// paid for, here by exact amount (the deposit route hands out a unique expected
// amount so concurrent sends stay distinguishable).
//
// In-memory last-scanned block per network; on restart it re-scans a lookback
// window, which is safe because crediting is idempotent on the deposit's txId.
import { createPublicClient, http, parseAbiItem, type Hex } from "viem";
import {
  NETWORKS, ENABLED, PLATFORM_DEPOSIT_ADDRESS, DEPOSIT_POLL_MS, DEPOSIT_LOOKBACK_BLOCKS,
  CUSTODY_ENABLED, type MonadNet,
} from "./config";
import { listOpenDeposits, markDepositCredited } from "./db";
import { creditDeposit } from "./ledger";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const lastBlock: Record<string, bigint> = {};

async function scan(net: MonadNet): Promise<void> {
  const pub = createPublicClient({ transport: http(net.rpc) });
  const head = await pub.getBlockNumber();
  const from = lastBlock[net.key] ?? (head > DEPOSIT_LOOKBACK_BLOCKS ? head - DEPOSIT_LOOKBACK_BLOCKS : 0n);
  if (from > head) { lastBlock[net.key] = head; return; }

  const logs = await pub.getLogs({
    address: net.usdc as Hex,
    event: TRANSFER,
    args: { to: PLATFORM_DEPOSIT_ADDRESS as Hex },
    fromBlock: from,
    toBlock: head,
  });
  lastBlock[net.key] = head + 1n;
  if (logs.length === 0) return;

  const open = await listOpenDeposits("onchain");
  for (const log of logs) {
    const value = (log.args as { value?: bigint }).value;
    if (value === undefined) continue;
    // Match the earliest open deposit whose expected amount equals this transfer.
    const idx = open.findIndex((d) => BigInt(d.amount_atomic) === value && d.status === "open");
    if (idx === -1) continue;
    const dep = open[idx];
    open.splice(idx, 1); // don't reuse this row for another log in the same pass
    const txId = `onchain-deposit-${dep.id}`;
    try {
      const res = await creditDeposit(dep.owner_ref, value, "onchain", txId, `on-chain deposit ${dep.id}`);
      await markDepositCredited(dep.id, txId, log.transactionHash);
      if (res.posted) console.log(`[deposit-watch] credited ${dep.owner_ref} +${value} (dep ${dep.id}, tx ${log.transactionHash})`);
    } catch (e) {
      console.error(`[deposit-watch] credit failed for ${dep.id}:`, e instanceof Error ? e.message : e);
    }
  }
}

/** Start the polling loop. No-op unless custody is on and a deposit address is set. */
export function startDepositWatcher(): void {
  if (!CUSTODY_ENABLED) return;
  if (!/^0x[0-9a-fA-F]{40}$/.test(PLATFORM_DEPOSIT_ADDRESS)) {
    console.warn("[deposit-watch] PLATFORM_DEPOSIT_ADDRESS not set — crypto deposit rail idle");
    return;
  }
  const nets = ENABLED.length ? ENABLED : [NETWORKS.testnet];
  console.log(`[deposit-watch] watching ${PLATFORM_DEPOSIT_ADDRESS} on ${nets.map((n) => n.key).join(",")} every ${DEPOSIT_POLL_MS}ms`);
  const tick = async () => {
    for (const net of nets) {
      try { await scan(net); }
      catch (e) { console.error(`[deposit-watch] scan ${net.key} error:`, e instanceof Error ? e.message : e); }
    }
    setTimeout(tick, DEPOSIT_POLL_MS);
  };
  setTimeout(tick, DEPOSIT_POLL_MS);
}
