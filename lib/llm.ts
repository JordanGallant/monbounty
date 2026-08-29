/**
 * Provider-agnostic tool-calling loop for the agents.
 *
 * The toolkits (agent/tools.ts, agent/company-tools.ts) are just functions; the
 * agent loop is just "call model, run the tools it asks for, feed results back".
 * Nothing about that needs Claude. This module runs that loop against either:
 *
 *   - a cheaper OpenAI-compatible inference gateway (default when
 *     CHEAPER_INFERENCE_API_KEY is set), or
 *   - the Anthropic API (when ANTHROPIC_API_KEY is set).
 *
 * Tools are authored once in Anthropic's shape (`input_schema`); this file
 * converts them to OpenAI's `function` shape when talking to the gateway, so a
 * single set of tool specs drives both providers.
 */
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "openai-compatible" | "anthropic";

export interface LlmConfig {
  provider: Provider;
  apiKey: string;
  baseURL: string;
  model: string;
  workspaceId?: string;  // required header for identity-linked Anthropic keys
}

/** Minimal Anthropic-shaped tool spec (what the agent files already export). */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Resolve provider + endpoint from the environment. The cheaper gateway wins
 * when its key is present, so setting CHEAPER_INFERENCE_API_KEY is all it takes
 * to move the agents off Anthropic. URL and model are overridable — confirm
 * them for your gateway (see .env.example).
 */
export function llmConfig(opts?: { prefer?: Provider }): LlmConfig {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const cheap = process.env.CHEAPER_INFERENCE_API_KEY;
  const anthropic = (): LlmConfig => ({
    provider: "anthropic",
    apiKey: anthropicKey ?? "",
    baseURL: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    model: process.env.ANTHROPIC_MODEL ?? process.env.INFERENCE_MODEL ?? "claude-opus-5",
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || undefined,
  });
  // Company/triager agents ask for Anthropic explicitly; hunter defaults to the
  // cheaper gateway when its key is set.
  if (opts?.prefer === "anthropic" && anthropicKey) return anthropic();
  if (cheap) {
    return {
      provider: "openai-compatible",
      apiKey: cheap,
      baseURL: (process.env.INFERENCE_BASE_URL ?? "https://api.inference.net/v1").replace(/\/$/, ""),
      model: process.env.INFERENCE_MODEL ?? "",
    };
  }
  return anthropic();
}

export function describeLlm(cfg = llmConfig()): string {
  return `${cfg.provider} model=${cfg.model || "(unset!)"} @ ${cfg.baseURL}`;
}

export interface AgentLoopOptions {
  system: string;
  userText: string;
  tools: ToolSpec[];
  /** Execute one tool call; return any JSON-serializable result. */
  runTool: (name: string, input: any) => Promise<unknown> | unknown;
  maxTurns?: number;
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: any) => void;
  cfg?: LlmConfig;
}

const asString = (out: unknown) =>
  typeof out === "string" ? out : JSON.stringify(out);

/** Anthropic tool spec -> OpenAI function tool. */
function toOpenAITools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const cfg = opts.cfg ?? llmConfig();
  if (!cfg.apiKey) throw new Error("No inference API key set (CHEAPER_INFERENCE_API_KEY or ANTHROPIC_API_KEY).");
  if (!cfg.model) throw new Error("No model set. Export INFERENCE_MODEL (see .env.example).");
  const maxTurns = opts.maxTurns ?? 16;
  if (cfg.provider === "anthropic") return runAnthropic(cfg, opts, maxTurns);
  return runOpenAICompatible(cfg, opts, maxTurns);
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function runAnthropic(cfg: LlmConfig, opts: AgentLoopOptions, maxTurns: number) {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL,
    defaultHeaders: cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : undefined });
  const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as any;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.userText }];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.messages.create({
      model: cfg.model, max_tokens: 8000, system: opts.system, tools, messages,
    });
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) opts.onText?.(b.text.trim());

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      opts.onToolCall?.(tu.name, tu.input);
      const out = await safeRun(opts.runTool, tu.name, tu.input);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: asString(out).slice(0, 8000) });
    }
    messages.push({ role: "user", content: results });
  }
}

// ── OpenAI-compatible gateway ─────────────────────────────────────────────────

async function runOpenAICompatible(cfg: LlmConfig, opts: AgentLoopOptions, maxTurns: number) {
  const tools = toOpenAITools(opts.tools);
  const messages: any[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.userText },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: "auto", max_tokens: 8000 }),
    });
    if (!res.ok) throw new Error(`inference gateway ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error(`unexpected gateway response: ${JSON.stringify(data).slice(0, 400)}`);
    messages.push(msg);
    if (msg.content && String(msg.content).trim()) opts.onText?.(String(msg.content).trim());

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return;

    for (const call of calls) {
      let input: any = {};
      try { input = JSON.parse(call.function?.arguments ?? "{}"); } catch { input = {}; }
      opts.onToolCall?.(call.function?.name, input);
      const out = await safeRun(opts.runTool, call.function?.name, input);
      messages.push({ role: "tool", tool_call_id: call.id, content: asString(out).slice(0, 8000) });
    }
  }
}

async function safeRun(runTool: AgentLoopOptions["runTool"], name: string, input: any) {
  try { return await runTool(name, input); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
