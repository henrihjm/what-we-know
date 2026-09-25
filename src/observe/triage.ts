/**
 * Liquid AI triage behind an OpenAI-compatible chat endpoint (OpenRouter). No model ever runs locally.
 * Each snippet is labeled with exactly one of: new | duplicate:<id> | contradicts:<id> | irrelevant.
 * Resolution order: TRIAGE_BASE_URL (+ TRIAGE_API_KEY) -> OPENROUTER_API_KEY -> OpenAI mini model.
 * A configured Liquid backend that goes down mid-run falls back to the OpenAI mini model with a loud warning.
 */
import OpenAI from "openai";
import { env } from "../config.js";
import type { Snippet, TriageLabel, TriagedSnippet, TokenUsage } from "../types.js";
import { pLimit, warn, errMsg, sleep } from "../util.js";

export interface CompactClaim { id: string; text: string }

const SYSTEM = `You label one snippet of news text against a list of known claims. Answer with exactly one line and nothing else:
new            -> the snippet states a fact not in the list
duplicate:cN   -> the snippet restates claim cN with the same meaning and numbers
contradicts:cN -> the snippet disagrees with claim cN (different number, status, time or outcome)
irrelevant     -> not a factual statement about the story, or boilerplate
Prefer contradicts over duplicate when a number or status differs. Prefer new over irrelevant when the snippet contains a specific fact.`;

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_LIQUID_MODEL = "liquid/lfm-2.5-2.6b:free"; // only Liquid id OpenRouter lists as of 2026-09-25
const MINI_MODEL = process.env.TRIAGE_FALLBACK_MODEL || "gpt-4.1-mini";
const LOCAL_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|:11434\b/i;

type Backend =
  | { kind: "liquid"; baseURL: string; apiKey: string; model: string; name: string }
  | { kind: "openai-mini"; model: string; name: string; reason: string };

function resolveBackend(): Backend {
  const base = env.TRIAGE_BASE_URL;
  if (base && LOCAL_RE.test(base)) {
    warn(`TRIAGE_BASE_URL=${base} points at a local model server; local models are disabled -> ignoring it`);
  } else if (base) {
    const host = new URL(base).hostname;
    const key = env.TRIAGE_API_KEY;
    if (key || host !== "openrouter.ai") return { kind: "liquid", baseURL: base, apiKey: key || "none", model: env.TRIAGE_MODEL || OPENROUTER_LIQUID_MODEL, name: `liquid@${host}` };
    warn(`TRIAGE_BASE_URL=${base} but no TRIAGE_API_KEY/OPENROUTER_API_KEY -> triage runs on OpenAI ${MINI_MODEL}`);
    return { kind: "openai-mini", model: MINI_MODEL, name: `openai-mini (no OpenRouter key)`, reason: "no OpenRouter key" };
  }
  if (env.OPENROUTER_API_KEY) return { kind: "liquid", baseURL: OPENROUTER_URL, apiKey: env.OPENROUTER_API_KEY, model: env.TRIAGE_MODEL || OPENROUTER_LIQUID_MODEL, name: "liquid@openrouter" };
  return { kind: "openai-mini", model: MINI_MODEL, name: `openai-mini (no triage backend configured)`, reason: "no triage backend configured" };
}
const backend = resolveBackend();
const TRIAGE_TIMEOUT = 45000;
/** OpenRouter's Liquid endpoint forces a reasoning phase (cannot be disabled), so it needs room to think and is slower; cap how many snippets per cycle it handles. */
const LIQUID_MAX_TOKENS = 1500;
export const LIQUID_MAX_PER_CYCLE = Number(process.env.LIQUID_MAX_PER_CYCLE || 40);
const TRIAGE_CONCURRENCY = Number(process.env.TRIAGE_CONCURRENCY || 8);
export const triageBackendName = () => backend.name;
export const triageBackendModel = () => backend.model;
export const triageUsesLiquid = () => backend.kind === "liquid";
let triageClient: OpenAI | null = null;
let fallbackClient: OpenAI | null = null;
let backendDown = false;
let consecutiveFailures = 0;

export function parseLabel(raw: string): TriageLabel {
  const s = raw.toLowerCase();
  const m = s.match(/(contradicts|duplicate)\s*[:\-]?\s*(c\d+)/);
  if (m) return { kind: m[1] as "contradicts" | "duplicate", claimId: m[2] };
  if (/\bnew\b/.test(s)) return { kind: "new" };
  if (/irrelevant/.test(s)) return { kind: "irrelevant" };
  return { kind: "irrelevant" };
}

async function ask(client: OpenAI, model: string, claims: CompactClaim[], snippet: string, liquid = false) {
  const claimList = claims.length ? claims.map((c) => `${c.id}: ${c.text.length > 90 ? c.text.slice(0, 88) + "…" : c.text}`).join("\n") : "(no claims yet)";
  const r = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_tokens: liquid ? LIQUID_MAX_TOKENS : 12,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Claims:\n${claimList}\n\nSnippet: ${snippet}\n\nLabel:` },
      ],
    },
    { timeout: TRIAGE_TIMEOUT },
  );
  const msg = r.choices[0]?.message as (OpenAI.ChatCompletionMessage & { reasoning?: string | null }) | undefined;
  let text = (msg?.content ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (!text && msg?.reasoning) {
    // The model ran out of tokens while reasoning: take the last label it named in its reasoning.
    const all = [...msg.reasoning.matchAll(/(contradicts?|duplicates?|new|irrelevant)\s*[:\-]?\s*(c\d+)?/gi)];
    const last = all.at(-1);
    text = last ? `${last[1].toLowerCase().replace(/s$/, "").replace("contradict", "contradicts")}${last[2] ? ":" + last[2] : ""} (from reasoning)` : "";
  }
  return { text, usage: r.usage, model: r.model || model };
}

export async function triageOne(claims: CompactClaim[], snippet: string, allowLiquid = true): Promise<{ label: TriageLabel; labelRaw: string; model: string; ms: number; usage: TokenUsage }> {
  const started = Date.now();
  if (backend.kind === "liquid" && !backendDown && allowLiquid) {
    try {
      triageClient ??= new OpenAI({ baseURL: backend.baseURL, apiKey: backend.apiKey, maxRetries: 0 });
      const r = await ask(triageClient, backend.model, claims, snippet, true);
      consecutiveFailures = 0;
      const ms = Date.now() - started;
      return { label: parseLabel(r.text), labelRaw: r.text, model: r.model, ms, usage: { step: "triage", provider: "liquid", model: r.model, prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0, ms, billable: false } };
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3 && !backendDown) {
        backendDown = true;
        warn(`!!!!! TRIAGE BACKEND ${backend.name} (${backend.model}) IS DOWN: ${errMsg(e)} -> falling back to OpenAI ${MINI_MODEL} for the rest of this cycle !!!!!`);
      }
    }
  }
  const isFallback = backend.kind === "liquid" && allowLiquid;
  if (!env.OPENAI_API_KEY) throw new Error(`triage backend ${backend.name} unavailable and no OPENAI_API_KEY for the mini model`);
  fallbackClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
  const model = MINI_MODEL;
  let r: Awaited<ReturnType<typeof ask>> | null = null;
  for (let i = 0; i < 4; i++) {
    try {
      r = await ask(fallbackClient, model, claims, snippet);
      break;
    } catch (e) {
      if (!/429|rate limit/i.test(errMsg(e)) || i === 3) throw e;
      await sleep(1500 * (i + 1) + Math.random() * 1000);
    }
  }
  if (!r) throw new Error("triage on OpenAI mini failed");
  const ms = Date.now() - started;
  return { label: parseLabel(r.text), labelRaw: r.text, model: isFallback ? `${r.model} (fallback)` : r.model, ms, usage: { step: "triage", provider: isFallback ? "openai-fallback" : "openai-mini", model: r.model, prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0, ms } };
}

/** Reset the down flag once per cycle so a recovered backend gets used again. */
export function triageRetryBackend() {
  backendDown = false;
  consecutiveFailures = 0;
}

export async function triageSnippets(claims: CompactClaim[], snippets: Snippet[], budgetLeft: () => boolean, onUsage: (u: TokenUsage) => void = () => {}): Promise<{ triaged: TriagedSnippet[]; usage: TokenUsage[]; skipped: number; errors: number }> {
  const limit = pLimit(TRIAGE_CONCURRENCY);
  const usage: TokenUsage[] = [];
  let skipped = 0;
  let errors = 0;
  const triaged = await Promise.all(
    snippets.map((s, i) =>
      limit(async (): Promise<TriagedSnippet | null> => {
        if (!budgetLeft()) {
          skipped++;
          return null;
        }
        try {
          const r = await triageOne(claims, s.text, i < LIQUID_MAX_PER_CYCLE);
          usage.push(r.usage);
          onUsage(r.usage);
          return { ...s, label: r.label, labelRaw: r.labelRaw, model: r.model, ms: r.ms };
        } catch (e) {
          errors++;
          if (errors <= 3) warn(`triage failed for ${s.id}: ${errMsg(e).slice(0, 120)}`);
          return { ...s, label: { kind: "irrelevant" }, labelRaw: "error", model: "none", ms: 0 };
        }
      }),
    ),
  );
  return { triaged: triaged.filter((t): t is TriagedSnippet => t !== null), usage, skipped, errors };
}
