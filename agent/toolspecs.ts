/**
 * Anthropic tool-use schemas for the hunter toolkit. One entry per function in
 * tools.ts. Kept separate so the same toolkit can be driven by other frameworks
 * without pulling in these schemas.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_SPECS: Anthropic.Tool[] = [
  {
    name: "check_wallet",
    description:
      "Check the agent's own wallet: USDC and MON balances per Monad network. " +
      "Bonds are paid in USDC; call this before submitting to know if you can afford it.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_wallet",
    description:
      "Generate a fresh wallet for this session and return its address + privateKey. Do this first if you have " +
      "no wallet. Keep the privateKey — it signs your x402 bonds. Then ask the human to fund the address with USDC.",
    input_schema: { type: "object", properties: { network: { type: "string", enum: ["testnet", "mainnet"] } }, additionalProperties: false },
  },
  {
    name: "list_programs",
    description: "List the bug bounty programs open for submissions, their scope, and the bond each charges.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_scope",
    description:
      "Get the full scope of one program before planning: in-scope and out-of-scope items, the impacts " +
      "that pay (and which are provable by an executable proof-of-concept), the payout per severity, the " +
      "submission price, and whether the rules are the committed on-chain ones. Call this AFTER the human " +
      "chooses a program from list_programs, and plan your finding against what it returns.",
    input_schema: {
      type: "object",
      properties: { slug: { type: "string", description: "Program slug from list_programs." } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "get_my_reputation",
    description:
      "Get the agent's track record: reports submitted, ruled valid vs slop, signal rate, USD paid out, " +
      "current tier and the bond multiplier it earns. A good record lowers your bond; slop raises it.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "register_identity",
    description:
      "Register an ERC-8004 identity on Monad — a portable on-chain identity (ERC-721) owned by your wallet, " +
      "with your agent card as its tokenURI. Optional but recommended: companies read your identity's on-chain " +
      "reputation when deciding whether to accept your submissions. This is an on-chain transaction and needs MON " +
      "for gas; if the wallet is empty it returns needsGas with the address to fund.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "draft_writeup",
    description:
      "Validate and normalise a finding into the exact submission shape WITHOUT paying or sending anything. " +
      "Use this to catch a too-short summary or bad severity before spending a bond. Returns ok:false with " +
      "problems to fix, or ok:true with the cleaned finding.",
    input_schema: {
      type: "object",
      properties: {
        program: { type: "string" },
        title: { type: "string", description: ">= 8 chars" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"] },
        summary: { type: "string", description: ">= 80 chars; describe the bug, impact, and where it is" },
        asset: { type: "string", description: "file/contract/endpoint affected" },
        poc: { type: "string", description: "optional proof of concept, >= 40 chars" },
      },
      required: ["program", "title", "severity", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "request_funding",
    description:
      "Ask a human to fund the wallet when it cannot cover a bond. Provide the USD needed and why. " +
      "This does not move money; a person decides whether to send USDC to the wallet address.",
    input_schema: {
      type: "object",
      properties: {
        needUsd: { type: "number", description: "USDC needed to proceed" },
        reason: { type: "string", description: "why you need it — reference the finding" },
        program: { type: "string" },
      },
      required: ["needUsd"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_funding",
    description:
      "After request_funding, poll the wallet until it can cover needUsd (or timeout). " +
      "Confirms the funding request when the money arrives.",
    input_schema: {
      type: "object",
      properties: {
        needUsd: { type: "number" },
        requestId: { type: "string", description: "id returned by request_funding" },
        timeoutSec: { type: "number", description: "default 600" },
      },
      required: ["needUsd"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_finding",
    description:
      "Submit a vulnerability finding and PAY THE BOND over x402 in the same call. Only submit findings you " +
      "believe are real and in scope — the bond is slashed for slop. If the wallet is short, this returns " +
      "paid:false with the quoted price; call request_funding then wait_for_funding and retry.",
    input_schema: {
      type: "object",
      properties: {
        program: { type: "string" },
        title: { type: "string" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"] },
        summary: { type: "string" },
        asset: { type: "string" },
      },
      required: ["program", "title", "severity", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_poc",
    description:
      "Pay the second gate to attach a proof of concept to a submitted report. This is the step that gets the " +
      "report queued for a human triager. Same wallet, same network as the bond.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "report id from submit_finding" },
        poc: { type: "string", description: "the proof of concept, >= 40 chars" },
      },
      required: ["id", "poc"],
      additionalProperties: false,
    },
  },
  {
    name: "check_report",
    description: "Check the status of a report the agent submitted (awaiting_poc / triaging / valid / slop / ...).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
