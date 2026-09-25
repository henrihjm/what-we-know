/** OpenAI structured merge: one call per cycle, retry once on schema failure with the validation error appended. */
import OpenAI from "openai";
import { z } from "zod";
import { env, DEFAULT_TTL, MAX_ACTIVE_CLAIMS, ttlFor } from "../config.js";
import type { Ledger, Correction, TriagedSnippet, StoryConfig, TokenUsage, Claim } from "../types.js";
import { MERGE_SYSTEM } from "./prompts.js";
import { nowIso, warn, errMsg } from "../util.js";

const ClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(["warning", "number", "event", "forecast", "statement"]),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  confidence: z.number(),
  status: z.enum(["active", "superseded", "retracted"]),
  sources: z.array(z.string()),
  first_seen: z.string(),
  last_confirmed: z.string(),
  ttl_minutes: z.number(),
  supersedes: z.string().nullable(),
});
const MergeOutput = z.object({
  summary: z.string(),
  claims: z.array(ClaimSchema),
  open_questions: z.array(z.string()),
  corrections: z.array(z.object({ claim_id: z.string(), from_text: z.string(), to_text: z.string(), reason: z.string(), source: z.string() })),
});
export type MergeOutput = z.infer<typeof MergeOutput>;

// JSON schema for OpenAI structured outputs (strict mode requires additionalProperties:false and all keys in required).
const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "claims", "open_questions", "corrections"],
  properties: {
    summary: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "type", "value", "unit", "confidence", "status", "sources", "first_seen", "last_confirmed", "ttl_minutes", "supersedes"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          type: { type: "string", enum: ["warning", "number", "event", "forecast", "statement"] },
          value: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          confidence: { type: "number" },
          status: { type: "string", enum: ["active", "superseded", "retracted"] },
          sources: { type: "array", items: { type: "string" } },
          first_seen: { type: "string" },
          last_confirmed: { type: "string" },
          ttl_minutes: { type: "number" },
          supersedes: { type: ["string", "null"] },
        },
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim_id", "from_text", "to_text", "reason", "source"],
        properties: { claim_id: { type: "string" }, from_text: { type: "string" }, to_text: { type: "string" }, reason: { type: "string" }, source: { type: "string" } },
      },
    },
  },
} as const;

let client: OpenAI | null = null;
export function openaiModel() {
  return env.OPENAI_MODEL || "gpt-5.2";
}

function ledgerForPrompt(ledger: Ledger) {
  // Only what the model needs: no source health, no ttl bookkeeping beyond the claim fields.
  return { story: ledger.story, cycle: ledger.cycle, updated_at: ledger.updated_at, summary: ledger.summary, claims: ledger.claims, open_questions: ledger.open_questions };
}

export interface MergeResult {
  ledger: Ledger;
  corrections: Correction[];
  usage: TokenUsage[];
  model: string;
}

export async function mergeLedger(story: StoryConfig, ledger: Ledger, evidence: TriagedSnippet[], nextCycle: number): Promise<MergeResult> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 1, timeout: 120000 });
  const model = openaiModel();
  const now = nowIso();
  const ttls = Object.fromEntries((Object.keys(DEFAULT_TTL) as Array<keyof typeof DEFAULT_TTL>).map((t) => [t, ttlFor(story, t)]));
  const evidenceLines = evidence.map((s) => `- [${s.label.kind}${"claimId" in s.label ? ":" + s.label.claimId : ""}] (weight ${s.weight.toFixed(2)}, fetched ${s.fetched_at}, ${s.url}) ${s.text}`).join("\n");
  const user = `Current time: ${now}\nStory: ${story.title}\nDefault TTL minutes by type: ${JSON.stringify(ttls)}\nThis will be cycle ${nextCycle}.\n\nCURRENT LEDGER:\n${JSON.stringify(ledgerForPrompt(ledger))}\n\nNEW EVIDENCE (${evidence.length} snippets, each pre-labeled by a triage model):\n${evidenceLines || "(none this cycle: only apply TTL decay, dedup and question cleanup)"}`;

  const usage: TokenUsage[] = [];
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: MERGE_SYSTEM },
      { role: "user", content: attempt === 0 ? user : `${user}\n\nYour previous output failed validation: ${lastErr}. Fix it and output the full ledger again.` },
    ];
    const r = await client.chat.completions.create({
      model,
      ...(model.startsWith("gpt-5") ? {} : { temperature: 0.1 }),
      messages,
      response_format: { type: "json_schema", json_schema: { name: "ledger_merge", strict: true, schema: jsonSchema as never } },
    });
    const ms = Date.now() - started;
    usage.push({ step: "merge", provider: "openai", model: r.model || model, prompt_tokens: r.usage?.prompt_tokens ?? 0, completion_tokens: r.usage?.completion_tokens ?? 0, ms });
    const raw = r.choices[0]?.message.content ?? "";
    try {
      const parsed = MergeOutput.parse(JSON.parse(raw));
      const merged = applyInvariants(story, ledger, parsed, nextCycle, now);
      return { ledger: merged, corrections: parsed.corrections, usage, model: r.model || model };
    } catch (e) {
      lastErr = errMsg(e).slice(0, 500);
      warn(`merge output invalid (attempt ${attempt + 1}): ${lastErr}`);
    }
  }
  throw new Error(`merge failed twice: ${lastErr}`);
}

/** Deterministic guard rails on top of the model's output. */
export function applyInvariants(story: StoryConfig, prev: Ledger, out: MergeOutput, cycle: number, now: string): Ledger {
  const prevById = new Map(prev.claims.map((c) => [c.id, c]));
  let claims: Claim[] = out.claims.map((c) => {
    const p = prevById.get(c.id);
    const statusChanged = !p || p.status !== c.status;
    return { ...c, confidence: Math.max(0, Math.min(1, c.confidence)), status_changed_at: statusChanged ? now : (p?.status_changed_at ?? null) };
  });
  // Dedup ids (keep first).
  const seen = new Set<string>();
  claims = claims.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  // Prune superseded/retracted claims 30 min after their status changed (they live on in RawTree).
  claims = claims.filter((c) => c.status === "active" || !c.status_changed_at || (Date.now() - new Date(c.status_changed_at).getTime()) / 60000 < 30);
  // Cap active claims: drop lowest-confidence statements first, then lowest confidence overall.
  const active = claims.filter((c) => c.status === "active");
  if (active.length > MAX_ACTIVE_CLAIMS) {
    const ranked = [...active].sort((a, b) => (a.type === "statement" ? 0 : 1) - (b.type === "statement" ? 0 : 1) || a.confidence - b.confidence);
    const drop = new Set(ranked.slice(0, active.length - MAX_ACTIVE_CLAIMS).map((c) => c.id));
    claims = claims.filter((c) => !drop.has(c.id));
  }
  return {
    story: story.id,
    cycle,
    updated_at: now,
    summary: out.summary,
    claims,
    open_questions: out.open_questions.slice(0, 6),
    sources: prev.sources,
  };
}
