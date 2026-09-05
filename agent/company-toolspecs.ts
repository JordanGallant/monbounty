/**
 * Anthropic tool-use schemas for the company toolkit. One entry per function in
 * company-tools.ts. Kept separate so the toolkit can be driven by other
 * frameworks without these schemas.
 */
import type Anthropic from "@anthropic-ai/sdk";

const IMPACT_NOTE =
  "Impact ids come from GET /api/severity (list_impacts). The severity band follows from the " +
  "impact — you do not pick a number, you pick what the finding does.";

export const COMPANY_TOOL_SPECS: Anthropic.Tool[] = [
  {
    name: "read_target",
    description: "Read the code or system the bounty will cover, so you can write accurate scope. Pass a file path or inline text.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_impacts",
    description:
      "Get the impact catalogue and payout presets. Each impact has a fixed severity band and a flag for whether a " +
      "proof-of-concept can prove it by execution (machineCheckable). Read this before proposing payouts or scope.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "assess_deployment",
    description:
      "Assess WHERE the target runs before writing scope — exploitability is code × deployment, not code alone. " +
      "Given the production platform (e.g. vercel, cloudflare-workers, aws-lambda, node, docker) and framework " +
      "(e.g. nextjs), returns a deployment profile to commit with the verification recipe plus suggested scopeOut " +
      "lines for classes commonly neutralised on that platform (e.g. Next.js middleware auth bypass is dead on " +
      "Vercel). The company confirms the lines; fold accepted ones into scopeOut. Call this after read_target and " +
      "before draft_bounty.",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", description: "Production host: vercel | netlify | cloudflare-workers | aws-lambda | node | docker | kubernetes." },
        framework: { type: "string", description: "App framework, e.g. nextjs, express, django." },
        frameworkVersion: { type: "string" },
        runtime: { type: "string", description: "e.g. nodejs20.x" },
        waf: { type: "boolean", description: "Is a WAF in front in production?" },
        notes: { type: "string", description: "Anything about the deployment a sandbox run can't capture." },
      },
      required: ["platform"],
      additionalProperties: false,
    },
  },
  {
    name: "assess_web3",
    description:
      "Assess a SMART CONTRACT target before writing scope — the web3 counterpart of assess_deployment. " +
      "Exploitability is code × VM: reentrancy is impossible on Move, delegatecall/storage-collision only on the " +
      "EVM, silent overflow is neutralised on Solidity >=0.8 and Move. Covers Solidity/Vyper (EVM), Move (Aptos/Sui) " +
      "and Rust (Solana/CosmWasm/ink). The target is ingested as a deployed+verified contract, a source repo " +
      "(Foundry/Anchor/Move), or an ABI/IDL only. Returns a target profile for the onchain-fork recipe, scopeOut " +
      "lines for classes not applicable on that VM, and the VM-specific classes to make sure you price. Call after " +
      "read_target, before draft_bounty, for contract targets.",
    input_schema: {
      type: "object",
      properties: {
        ecosystem: { type: "string", description: "evm | solana | aptos | sui | cosmwasm | polkadot. Inferred from language if omitted." },
        language: { type: "string", description: "solidity | vyper | move | rust." },
        sourceMode: { type: "string", enum: ["verified-onchain", "abi-only", "repo"], description: "How the code is provided: a deployed+verified contract, an ABI/IDL only, or a source package." },
        contracts: {
          type: "array",
          description: "The contracts in scope.",
          items: {
            type: "object",
            properties: {
              address: { type: "string" }, name: { type: "string" },
              verified: { type: "boolean" }, abiProvided: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        repo: { type: "string", description: "Source package URL when sourceMode is 'repo'." },
        network: { type: "string", description: "Chain id / cluster / testnet name." },
        forkBlock: { type: "number", description: "Block to fork at for reproducible PoCs." },
        solidityGte08: { type: "boolean", description: "EVM only: is the target on Solidity >=0.8 (checked arithmetic by default)?" },
        notes: { type: "string" },
      },
      required: ["language", "sourceMode"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_payouts",
    description:
      "Build a payout table from a preset ('onchain' or 'web2') or a TVL, with optional per-severity overrides. " +
      "The human sets the final prices; this only checks the table is monotonic and payable. Show the result to the human.",
    input_schema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["onchain", "web2"] },
        tvlUsd: { type: "number", description: "Total value at risk; sizes the critical tier if given." },
        overrides: { type: "object", description: "Per-severity USD overrides, e.g. {\"high\": 15000}." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "draft_bounty",
    description:
      "Validate a full bounty draft WITHOUT creating it. Catches a non-monotonic payout table, an unknown impact id, " +
      "or a bad slug before anything is committed, and returns the rulesHash the create step will lock in. " +
      "Always draft before create_bounty. " + IMPACT_NOTE,
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "3-40 chars, [a-z0-9-]" },
        name: { type: "string" },
        target: { type: "string", description: "Contract path, address, or URL the hunter attacks." },
        scopeIn: { type: "array", items: { type: "string" } },
        scopeOut: { type: "array", items: { type: "string" } },
        acceptedImpacts: { type: "array", items: { type: "string" }, description: "Impact ids from list_impacts." },
        payouts: { type: "object", description: "USD per severity: critical/high/medium/low/informational." },
        slaSeconds: { type: "number", description: "Verdict deadline; >= 3600." },
        bondUsd: { type: "number", description: "The hunter's step-1 bond. Keep small (default 1)." },
        tvlUsd: { type: "number" },
      },
      required: ["slug", "name", "target", "scopeIn", "acceptedImpacts", "payouts"],
      additionalProperties: false,
    },
  },
  {
    name: "provision_wallet",
    description:
      "Provision the company's wallet — the address that will grade submissions and fund the reward pool. " +
      "Uses Circle if configured, otherwise the deployment's env wallet. Call this before create_bounty.",
    input_schema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "create_bounty",
    description:
      "Create the bounty. This commits the rulesHash so the scope and payout table can no longer move, and makes the " +
      "bounty discoverable to hunters. Use the exact draft you validated. " + IMPACT_NOTE,
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string" }, name: { type: "string" }, target: { type: "string" },
        scopeIn: { type: "array", items: { type: "string" } },
        scopeOut: { type: "array", items: { type: "string" } },
        acceptedImpacts: { type: "array", items: { type: "string" } },
        payouts: { type: "object" }, slaSeconds: { type: "number" },
        bondUsd: { type: "number" }, tvlUsd: { type: "number" },
      },
      required: ["slug", "name", "target", "scopeIn", "acceptedImpacts", "payouts"],
      additionalProperties: false,
    },
  },
  {
    name: "fund_pool",
    description:
      "Fund the reward pool. Set confirmed:true once the USDC is actually sent (or fiat has settled). A hunter checks " +
      "the funded pool covers a critical award before spending a bond, so an unfunded bounty gets no submissions.",
    input_schema: {
      type: "object",
      properties: { amountUsd: { type: "number" }, confirmed: { type: "boolean" } },
      required: ["amountUsd"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_bounty",
    description: "Confirm the created bounty is hash-verified and solvent. Call this last to check your work.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];
