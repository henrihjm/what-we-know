/**
 * Liquid AI triage behind an OpenAI-compatible chat endpoint (Ollama or OpenRouter).
 * Each snippet is labeled with exactly one of: new | duplicate:<id> | contradicts:<id> | irrelevant.
 * Falls back to an OpenAI mini-class model with a loud warning if the triage backend is down.
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

function resolveBackend() {
  if (env.TRIAGE_BASE_URL) return { baseURL: env.TRIAGE_BASE_URL, apiKey: env.TRIAGE_API_KEY || "none", model: env.TRIAGE_MODEL || "lfm2.5", name: `liquid@${new URL(env.TRIAGE_BASE_URL).hostname}` };
  if (env.OPENROUTER_API_KEY) return { baseURL: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY, model: env.TRIAGE_MODEL || "liquid/lfm-2.5-1.2b-instruct", name: "liquid@openrouter" };
  return { baseURL: "http://localhost:11434/v1", apiKey: "ollama", model: env.TRIAGE_MODEL || "lfm2.5", name: "liquid@ollama" };
}
const backend = resolveBackend();
export const triageBackendName = () => backend.name;
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

async function ask(client: OpenAI, model: string, claims: CompactClaim[], snippet: string) {
  const claimList = claims.length ? claims.map((c) => `${c.id}: ${c.text.length > 90 ? c.text.slice(0, 88) + "…" : c.text}`).join("\n") : "(no claims yet)";
  const r = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_tokens: 12,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Claims:\n${claimList}\n\nSnippet: ${snippet}\n\nLabel:` },
      ],
    },
    { timeout: 20000 },
  );
  return { text: r.choices[0]?.message.content?.trim() ?? "", usage: r.usage, model: r.model || model };
}

export async function triageOne(claims: CompactClaim[], snippet: string): Promise<{ label: TriageLabel; labelRaw: string; model: string; ms: number; usage: TokenUsage }> {
  const started = Date.now();
  if (!backendDown) {
    try {
      triageClient ??= new OpenAI({ baseURL: backend.baseURL, apiKey: backend.apiKey, maxRetries: 0 });
      const r = await ask(triageClient, backend.model, claims, snippet);
      consecutiveFailures = 0;
      const ms = Date.now() - started;
      return { label: parseLabel(r.text), labelRaw: r.text, model: r.model, ms, usage: { step: "triage", provider: "liquid", model: r.model, prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0, ms } };
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3 && !backendDown) {
        backendDown = true;
        warn(`!!!!! TRIAGE BACKEND ${backend.name} (${backend.model}) IS DOWN: ${errMsg(e)} -> falling back to OpenAI mini for the rest of this process !!!!!`);
      }
    }
  }
  if (!env.OPENAI_API_KEY) throw new Error(`triage backend ${backend.name} unavailable and no OPENAI_API_KEY for fallback`);
  fallbackClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
  const model = "gpt-4.1-mini";
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
  if (!r) throw new Error("triage fallback failed");
  const ms = Date.now() - started;
  return { label: parseLabel(r.text), labelRaw: r.text, model: `${r.model} (fallback)`, ms, usage: { step: "triage", provider: "openai-fallback", model: r.model, prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0, ms } };
}

/** Reset the down flag once per cycle so a recovered backend gets used again. */
export function triageRetryBackend() {
  backendDown = false;
  consecutiveFailures = 0;
}

export async function triageSnippets(claims: CompactClaim[], snippets: Snippet[], budgetLeft: () => boolean, onUsage: (u: TokenUsage) => void = () => {}): Promise<{ triaged: TriagedSnippet[]; usage: TokenUsage[]; skipped: number; errors: number }> {
  const limit = pLimit(8);
  const usage: TokenUsage[] = [];
  let skipped = 0;
  let errors = 0;
  const triaged = await Promise.all(
    snippets.map((s) =>
      limit(async (): Promise<TriagedSnippet | null> => {
        if (!budgetLeft()) {
          skipped++;
          return null;
        }
        try {
          const r = await triageOne(claims, s.text);
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
