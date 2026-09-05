// Chain context: the web3 analog of lib/deployment-context.ts. For a smart
// contract, exploitability is code × VM — a class that is real on the EVM can be
// structurally impossible on Move or Solana (reentrancy on Move, delegatecall
// storage-collision anywhere but the EVM, silent integer overflow on Solidity
// >=0.8 or Move). And a web3 target is ingested differently from a repo: the
// company hands over an ABI, or points at a deployed+verified contract, or a
// source package (Foundry / Anchor / a Move package).
//
// This module holds:
//   1. the VM / language vocabulary,
//   2. how the target's source is available (verified-onchain | abi-only | repo)
//      and what that lets verification do,
//   3. a curated "not applicable on this VM" matrix -> suggested scopeOut lines,
//      plus the VM-specific classes a company SHOULD make sure it prices.
//
// Verification for these runs in `onchain-fork` mode (fork the chain at a block,
// point a PoC / invariant harness at the contract) — this module is the
// ONBOARDING half: capture the target correctly and pre-seed VM-appropriate
// scope. As with the web2 matrix, every line is a proposal the company confirms,
// hash-committed and shown to hunters once accepted — never an auto-rejection.

export type Ecosystem =
  | "evm"          // Ethereum, Monad, Base, L2s …
  | "solana"
  | "aptos"        // Move
  | "sui"          // Move
  | "cosmwasm"     // Cosmos, Rust
  | "polkadot"     // ink!, Rust
  | "unknown";

export type ContractLang = "solidity" | "vyper" | "move" | "rust";

/** The VM class we match the not-applicable matrix against. */
export type VmClass = "evm" | "move" | "solana" | "cosmwasm" | "ink";

export interface EcosystemInfo {
  id: Ecosystem;
  label: string;
  vm: VmClass;
  langs: ContractLang[];
}

export const ECOSYSTEMS: Record<Ecosystem, EcosystemInfo> = {
  evm: { id: "evm", label: "EVM", vm: "evm", langs: ["solidity", "vyper"] },
  solana: { id: "solana", label: "Solana", vm: "solana", langs: ["rust"] },
  aptos: { id: "aptos", label: "Aptos (Move)", vm: "move", langs: ["move"] },
  sui: { id: "sui", label: "Sui (Move)", vm: "move", langs: ["move"] },
  cosmwasm: { id: "cosmwasm", label: "CosmWasm", vm: "cosmwasm", langs: ["rust"] },
  polkadot: { id: "polkadot", label: "Polkadot / ink!", vm: "ink", langs: ["rust"] },
  unknown: { id: "unknown", label: "Unspecified chain", vm: "evm", langs: ["solidity"] },
};

export function normalizeEcosystem(v: string | null | undefined): Ecosystem {
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (s in ECOSYSTEMS) return s as Ecosystem;
  // aliases: chains, L2s and languages people actually type
  if (["ethereum", "eth", "monad", "base", "arbitrum", "optimism", "op", "polygon", "bnb", "bsc", "avalanche", "avax", "l2"].includes(s)) return "evm";
  if (["sol"].includes(s)) return "solana";
  if (["move-aptos"].includes(s)) return "aptos";
  if (["move-sui", "mysten"].includes(s)) return "sui";
  if (["cosmos", "cw", "wasmd", "injective", "osmosis"].includes(s)) return "cosmwasm";
  if (["ink", "substrate", "dot"].includes(s)) return "polkadot";
  return "unknown";
}

/** Infer a sensible ecosystem from the language alone when the chain isn't given. */
export function ecosystemFromLang(lang: ContractLang): Ecosystem {
  switch (lang) {
    case "solidity":
    case "vyper": return "evm";
    case "move": return "aptos";      // Move spans Aptos/Sui; default Aptos, override with chain
    case "rust": return "solana";     // Rust spans Solana/CosmWasm/ink!; default Solana, override
  }
}

// How the target's source is available to the verifier, and what that permits.
export type SourceMode = "verified-onchain" | "abi-only" | "repo";

export interface Web3Contract {
  address?: string;        // deployed address (for verified-onchain / on a fork)
  name?: string;
  verified?: boolean;      // source verified on the explorer / Sourcify
  abiProvided?: boolean;   // company handed over an ABI/IDL
}

/** The web3 target profile a company commits alongside the (onchain-fork) recipe. */
export interface Web3Target {
  ecosystem: Ecosystem;
  language: ContractLang;
  network?: string;        // chain id / cluster / testnet name
  forkBlock?: number;      // block to fork at for reproducible PoCs
  sourceMode: SourceMode;
  contracts: Web3Contract[];
  repo?: string;           // when sourceMode === "repo": Foundry/Anchor/Move package
  notes?: string;
}

// ── the not-applicable matrix ────────────────────────────────────────────────
//
// Classes that are structurally impossible (or, conditionally, neutralised) on a
// given VM. `naVms` = the VMs on which the class does not apply. `conditional`
// entries only fire when the extra predicate holds (e.g. Solidity >= 0.8).

export interface NaRule {
  id: string;
  title: string;
  naVms: VmClass[];
  reason: string;
  /** Optional extra gate on language/version, evaluated against the target. */
  conditional?: (t: Pick<Web3Target, "language"> & { solidityGte08?: boolean }) => boolean;
}

export const NA_RULES: NaRule[] = [
  {
    id: "reentrancy-move",
    title: "Reentrancy",
    naVms: ["move"],
    reason:
      "Move's linear resource model and lack of dynamic dispatch mean a callee cannot re-enter a " +
      "caller mid-execution the way it can on the EVM, so classic reentrancy does not apply.",
  },
  {
    id: "delegatecall-storage-collision",
    title: "delegatecall / proxy storage-slot collision",
    naVms: ["move", "solana", "cosmwasm", "ink"],
    reason:
      "delegatecall and shared storage-slot layout are EVM proxy constructs. Non-EVM VMs have no " +
      "delegatecall and a different state model, so storage-collision / uninitialised-proxy classes " +
      "do not apply.",
  },
  {
    id: "evm-low-level-quirks",
    title: "EVM-specific quirks (tx.origin auth, selfdestruct, signature malleability, gas-griefing via .call)",
    naVms: ["move", "solana", "cosmwasm", "ink"],
    reason:
      "These depend on EVM opcodes / semantics (tx.origin, SELFDESTRUCT, ecrecover malleability, raw " +
      ".call gas forwarding) that do not exist on this VM.",
  },
  {
    id: "integer-overflow-checked",
    title: "Silent integer overflow / underflow",
    naVms: ["move"],
    reason:
      "Move aborts the transaction on arithmetic overflow, so a silent wrap that an exploit relies on " +
      "does not occur.",
    // Also neutralised on Solidity >= 0.8 (checked arithmetic by default); fired
    // via the conditional below rather than a blanket VM entry, because EVM
    // contracts on older compilers / with `unchecked` blocks ARE affected.
    conditional: (t) => t.solidityGte08 === true,
  },
];

// VM-specific classes a company should make sure it PRICES (the mirror of the
// not-applicable list — surfaced so scope isn't accidentally too narrow).
export const VM_IN_SCOPE_HINTS: Record<VmClass, string[]> = {
  evm: [
    "Reentrancy (single-function, cross-function, read-only)",
    "Access-control / missing-modifier on privileged functions",
    "Oracle / price manipulation, sandwichable flows",
    "Unchecked arithmetic in `unchecked {}` blocks or pre-0.8 code",
  ],
  solana: [
    "Missing signer check (an instruction that trusts an unsigned account)",
    "Missing owner check / account substitution (type confusion between accounts)",
    "Missing rent-exemption / account re-initialisation",
    "Arithmetic overflow (Rust release builds wrap unless overflow-checks / checked_* are used)",
    "CPI / privilege-escalation via unchecked cross-program invocation",
  ],
  move: [
    "Resource / capability leakage (a capability handed to the wrong module)",
    "Access-control on public entry functions",
    "Logic errors in arithmetic (overflow aborts, but wrong formulas still pay out incorrectly)",
    "Type-safety edge cases in generics / phantom types",
  ],
  cosmwasm: [
    "Missing sender/admin checks on execute messages",
    "Reply / submessage handling and message-ordering assumptions",
    "Arithmetic overflow (checked in debug, must use checked_* in release)",
  ],
  ink: [
    "Access-control on messages",
    "Reentrancy via cross-contract calls (ink! does allow re-entrant calls)",
    "Arithmetic overflow (must use checked_* in release)",
  ],
};

export interface NaHit {
  id: string;
  title: string;
  reason: string;
  scopeOutLine: string;
}

/** Classes not applicable on the target's VM → suggested scopeOut lines. */
export function notApplicableFor(
  target: Pick<Web3Target, "ecosystem" | "language"> & { solidityGte08?: boolean },
): NaHit[] {
  const eco = ECOSYSTEMS[target.ecosystem] ?? ECOSYSTEMS.unknown;
  const vm = eco.vm;
  const hits: NaHit[] = [];
  for (const rule of NA_RULES) {
    const vmMatch = rule.naVms.includes(vm);
    const condMatch = rule.conditional ? rule.conditional({ language: target.language, solidityGte08: target.solidityGte08 }) : false;
    if (!vmMatch && !condMatch) continue;
    const where = vmMatch ? eco.label : "this compiler configuration";
    hits.push({
      id: rule.id,
      title: rule.title,
      reason: rule.reason,
      scopeOutLine: `Out of scope on ${where}: ${rule.title} — ${rule.reason}`,
    });
  }
  return hits;
}

/**
 * How verification can proceed given how the source was provided, and how
 * complete a verdict it can yield. Mirrors describeSurface() on the web2 side.
 */
export function describeSource(target: Pick<Web3Target, "sourceMode" | "contracts" | "repo">): {
  approach: string;
  complete: boolean;   // can we reason about the code, or only the interface?
  note: string;
} {
  switch (target.sourceMode) {
    case "verified-onchain":
      return {
        approach: "Fork the chain at the committed block, point the PoC/invariant harness at the verified on-chain contract.",
        complete: true,
        note: "Strongest: verified source + real deployed state. A proven invariant break is directly payable.",
      };
    case "repo":
      return {
        approach: "Build the source package (Foundry / Anchor / Move) in a sandbox and run the PoC against a local deploy or a fork.",
        complete: true,
        note: "Full source available; equivalent strength to verified-onchain, but against a fresh deploy rather than live state.",
      };
    case "abi-only":
      return {
        approach: "Black-box only: the ABI/IDL gives the callable interface, so a PoC can call functions on a fork, but the internal logic cannot be read or invariant-checked.",
        complete: false,
        note: "Weakest: interface without source. Prefer a verified deployment or a source repo before opening a high-value pool — an ABI-only target limits what a verdict can prove.",
      };
  }
}
