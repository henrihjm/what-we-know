/**
 * One cycle: PLAN -> ACT -> OBSERVE -> SELF-CORRECT -> PERSIST -> RENDER -> HEAL.
 * The only state carried between cycles is the ledger. Raw page text is discarded before PERSIST returns.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, Correction, CycleStats, Ledger, Observation, StoryConfig, TokenUsage, TriagedSnippet } from "./types.js";
import { env, sourceWeight, CARD_MIN_INTERVAL_MIN, UNHEALTHY_FAILS, ttlFor } from "./config.js";
import { planQueries } from "./plan.js";
import { nimbleSearch } from "./act/nimble.js";
import { runFixedSources } from "./act/fixed/index.js";
import { splitToSnippets } from "./observe/split.js";
import { triageSnippets, triageRetryBackend, triageBackendName } from "./observe/triage.js";
import { mergeLedger, openaiModel, applyInvariants } from "./correct/merge.js";
import { rewriteSummary } from "./correct/summary.js";
import { rawtreeInsertSafe, rawtreeEnabled } from "./persist/rawtree.js";
import { loadLedger, saveLedgerCache } from "./persist/state.js";
import { generateCard, cardPrompt, fluxConfigured } from "./render/flux.js";
import { writeTicket } from "./heal/tickets.js";
import { nowIso, log, warn, errMsg, estimateTokens, fmtEastern, minutesBetween } from "./util.js";

export interface CycleOptions {
  dryRun: boolean;
  sandbox: boolean;
}

const lastCardAt = new Map<string, number>();

export async function runCycle(story: StoryConfig, opts: CycleOptions): Promise<{ stats: CycleStats; ledger: Ledger }> {
  const startedAt = nowIso();
  const t0 = Date.now();
  const storyKey = opts.sandbox ? `${story.id}-sandbox` : opts.dryRun ? `${story.id}-dry` : story.id;
  const usage: TokenUsage[] = [];
  const tokensSoFar = () => usage.reduce((a, u) => a + u.prompt_tokens + u.completion_tokens, 0);
  const budgetLeft = () => tokensSoFar() < env.MAX_TOKENS_PER_CYCLE;

  // ---------- PLAN ----------
  const { ledger: prev, from } = await loadLedger(story, opts.dryRun ? storyKey : story.id);
  const cycle = prev.cycle + 1;
  const queries = planQueries(story, prev);
  log(`cycle ${cycle} | ${storyKey} | ledger from ${from} (cycle ${prev.cycle}, ${prev.claims.filter((c) => c.status === "active").length} active) | ${queries.length} queries`);
  const ts = () => nowIso();
  const row = (extra: Record<string, unknown>) => ({ story: storyKey, cycle, ts: ts(), ...extra });

  // ---------- ACT ----------
  let observations: Observation[] = [];
  if (opts.dryRun) {
    observations = loadFixtures(story);
  } else {
    const fixedP = runFixedSources(story, prev.sources, cycle, { skipNimble: !env.NIMBLE_API_KEY });
    const searchP = Promise.all(
      queries.map(async (q): Promise<Observation[]> => {
        const started = Date.now();
        if (!env.NIMBLE_API_KEY) return [{ url: `nimble://search?q=${encodeURIComponent(q)}`, kind: "nimble-search", source_id: "nimble-search", fetched_at: ts(), ok: false, error: "NIMBLE_API_KEY missing", text: "", weight: 0, ms: 0 }];
        try {
          const docs = await nimbleSearch(q);
          return docs.map((d) => ({ url: d.url, kind: "nimble-search", source_id: "nimble-search", fetched_at: ts(), ok: true, text: `${d.title}\n${d.text}`, weight: sourceWeight(story, d.url), ms: Date.now() - started }));
        } catch (e) {
          return [{ url: `nimble://search?q=${encodeURIComponent(q)}`, kind: "nimble-search", source_id: "nimble-search", fetched_at: ts(), ok: false, error: errMsg(e).slice(0, 300), text: "", weight: 0, ms: Date.now() - started }];
        }
      }),
    );
    const [fixed, searches] = await Promise.all([fixedP, searchP]);
    observations = [...fixed, ...searches.flat()];
  }
  // Source health update (fixed sources only).
  const sources = prev.sources.map((s) => ({ ...s }));
  for (const o of observations) {
    const s = sources.find((x) => x.id === o.source_id);
    if (!s) continue;
    if (o.ok) Object.assign(s, { last_ok: o.fetched_at, fail_count: 0, healthy: true, last_error: null });
    else Object.assign(s, { fail_count: s.fail_count + 1, last_error: o.error ?? "unknown", healthy: s.fail_count + 1 < UNHEALTHY_FAILS });
  }
  const obsOk = observations.filter((o) => o.ok).length;

  // ---------- OBSERVE ----------
  // Strongest sources first so the token budget, if hit, drops the weakest evidence.
  const snippets = splitToSnippets(observations, story).sort((a, b) => b.weight - a.weight);
  const compactClaims = prev.claims.filter((c) => c.status === "active").map((c) => ({ id: c.id, text: c.text }));
  let triaged: TriagedSnippet[];
  let skipped = 0;
  let triageErrors = 0;
  if (opts.dryRun) {
    triaged = snippets.map((s) => ({ ...s, label: { kind: "new" as const }, labelRaw: "new (stub)", model: "stub", ms: 0 }));
  } else {
    triageRetryBackend();
    const r = await triageSnippets(compactClaims, snippets, budgetLeft, (u) => usage.push(u));
    triaged = r.triaged;
    skipped = r.skipped;
    triageErrors = r.errors;
  }
  const counts = { new: 0, contradicts: 0, duplicate: 0, irrelevant: 0 };
  for (const t of triaged) counts[t.label.kind]++;
  // Contradictions first, then strongest sources; cap what the merge model sees.
  const surviving = triaged
    .filter((t) => t.label.kind === "new" || t.label.kind === "contradicts")
    .sort((a, b) => (b.label.kind === "contradicts" ? 1 : 0) - (a.label.kind === "contradicts" ? 1 : 0) || b.weight - a.weight)
    .slice(0, 80);
  const triageModel = triaged.find((t) => t.model !== "none")?.model ?? (opts.dryRun ? "stub" : triageBackendName());

  // ---------- SELF-CORRECT ----------
  let ledger: Ledger;
  let corrections: Correction[] = [];
  let mergeModel = "stub";
  let summaryBy = "stub";
  if (opts.dryRun || !env.OPENAI_API_KEY) {
    if (!opts.dryRun) warn("OPENAI_API_KEY missing: using stub merge (claims from snippets, no reasoning)");
    ledger = stubMerge(story, prev, surviving, cycle);
  } else {
    const m = await mergeLedger(story, { ...prev, sources }, surviving, cycle);
    ledger = m.ledger;
    corrections = m.corrections;
    mergeModel = m.model;
    usage.push(...m.usage);
    const activeTexts = ledger.claims.filter((c) => c.status === "active").map((c) => c.text);
    const s = await rewriteSummary(activeTexts, ledger.summary);
    ledger.summary = s.text;
    summaryBy = s.by;
    usage.push(...s.usage);
  }
  ledger.sources = sources;
  ledger.cycle = cycle;
  ledger.story = story.id;
  ledger.updated_at = ts();
  const active = ledger.claims.filter((c) => c.status === "active");
  const ledgerJson = JSON.stringify(ledger);
  // Headline size = what the next cycle's merge prompt sees (claims, questions, summary); source health is bookkeeping.
  const ledgerTokens = estimateTokens(JSON.stringify({ summary: ledger.summary, claims: ledger.claims, open_questions: ledger.open_questions }));
  const ledgerTokensFull = estimateTokens(ledgerJson);

  // ---------- PERSIST ----------
  const persist = !opts.dryRun && rawtreeEnabled();
  if (persist) {
    await Promise.all([
      rawtreeInsertSafe("observations", observations.map((o) => row({ url: o.url, kind: o.kind, source_id: o.source_id, fetched_at: o.fetched_at, text_length: o.text.length, ok: o.ok, error: o.error ?? "", weight: o.weight, ms: o.ms }))),
      rawtreeInsertSafe("triage", triaged.map((t) => row({ snippet_id: t.id, label: t.label.kind, claim_id: "claimId" in t.label ? t.label.claimId : "", label_raw: t.labelRaw, model: t.model, ms: t.ms, url: t.url, kind: t.kind, weight: t.weight, text_length: t.text.length }))),
      rawtreeInsertSafe("ledger_versions", [row({ json: ledgerJson, claims_total: ledger.claims.length, claims_active: active.length, claims_superseded: ledger.claims.filter((c) => c.status === "superseded").length, claims_retracted: ledger.claims.filter((c) => c.status === "retracted").length, open_questions: ledger.open_questions.length, ledger_tokens: ledgerTokens, ledger_tokens_full: ledgerTokensFull, summary: ledger.summary, summary_by: summaryBy })]),
      rawtreeInsertSafe("corrections", corrections.map((c) => row(c as unknown as Record<string, unknown>))),
      rawtreeInsertSafe("tokens", usage.map((u) => row(u as unknown as Record<string, unknown>))),
      rawtreeInsertSafe("source_health", sources.map((s) => row({ source_id: s.id, url: s.url, kind: s.kind, last_ok: s.last_ok ?? "", fail_count: s.fail_count, healthy: s.healthy, last_error: s.last_error ?? "" }))),
    ]);
  }
  saveLedgerCache(ledger, storyKey);
  // Discard raw text: the ledger is the only thing that survives this function.
  for (const o of observations) o.text = "";
  const snippetCount = snippets.length;
  snippets.length = 0;

  // ---------- RENDER ----------
  let cardPath: string | null = null;
  const change = detectMajorChange(prev, ledger);
  if (change.major && !opts.dryRun) {
    const last = lastCardAt.get(storyKey) ?? 0;
    if (!fluxConfigured()) log(`major change (${change.reason}) but BFL_API_KEY missing; no card`);
    else if (Date.now() - last < CARD_MIN_INTERVAL_MIN * 60000) log(`major change (${change.reason}) but card rate-limited`);
    else {
      try {
        const numbers = headlineNumbers(ledger);
        const prompt = cardPrompt(story.title, fmtEastern(new Date(), story.timezone), numbers);
        const c = await generateCard(storyKey, cycle, prompt);
        cardPath = c.path;
        lastCardAt.set(storyKey, Date.now());
        log(`card generated: ${c.path} (${c.model}, ${c.ms} ms)`);
        if (persist) await rawtreeInsertSafe("cards", [row({ path: c.path, model: c.model, ms: c.ms, reason: change.reason, numbers: numbers.join(" | "), prompt })]);
      } catch (e) {
        warn(`card generation failed: ${errMsg(e)}`);
      }
    }
  }

  // ---------- HEAL ----------
  let tickets = 0;
  if (!opts.dryRun) {
    for (const s of sources) {
      if (s.fail_count >= UNHEALTHY_FAILS) {
        s.healthy = false;
        await writeTicket(story, cycle, s, storyKey);
        tickets++;
      }
    }
  }

  const ms = Date.now() - t0;
  const stats: CycleStats = {
    story: storyKey,
    cycle,
    started_at: startedAt,
    ms,
    observations: observations.length,
    observations_ok: obsOk,
    snippets: snippetCount,
    triage_new: counts.new,
    triage_contradict: counts.contradicts,
    triage_duplicate: counts.duplicate,
    triage_irrelevant: counts.irrelevant,
    triage_model: triageModel,
    claims_active: active.length,
    corrections: corrections.length,
    tokens: tokensSoFar(),
    ledger_tokens: ledgerTokens,
    summary_by: summaryBy,
    card_path: cardPath,
    budget_exceeded: skipped > 0,
    error: null,
  };
  if (persist) await rawtreeInsertSafe("cycles", [row({ ...stats, merge_model: mergeModel, tickets, queries: queries.join(" || "), ledger_from: from, skipped_snippets: skipped, triage_errors: triageErrors })]);
  console.log(
    `cycle ${cycle} | obs ${stats.observations} (${obsOk} ok) | snippets ${stats.snippets} | triage new ${counts.new} contradict ${counts.contradicts} dup ${counts.duplicate} irr ${counts.irrelevant}${skipped ? ` skipped ${skipped} (budget)` : ""}${triageErrors ? ` errors ${triageErrors}` : ""} | claims ${active.length} active | corrections ${corrections.length} | tokens ${stats.tokens.toLocaleString()} | ledger ~${ledgerTokens} tok | ${Math.round(ms / 1000)} s`,
  );
  return { stats, ledger };
}

/** Major change: a warning changed, a headline number moved > 20 %, or a claim was retracted. */
export function detectMajorChange(prev: Ledger, next: Ledger): { major: boolean; reason: string } {
  const prevById = new Map(prev.claims.map((c) => [c.id, c]));
  const prevWarnings = new Set(prev.claims.filter((c) => c.type === "warning" && c.status === "active").map((c) => c.id));
  const nextWarnings = new Set(next.claims.filter((c) => c.type === "warning" && c.status === "active").map((c) => c.id));
  if ([...nextWarnings].some((id) => !prevWarnings.has(id))) return { major: true, reason: "new warning" };
  if ([...prevWarnings].some((id) => !nextWarnings.has(id))) return { major: true, reason: "warning ended or superseded" };
  for (const c of next.claims) {
    if (c.status === "retracted" && prevById.get(c.id)?.status !== "retracted") return { major: true, reason: `claim ${c.id} retracted` };
    if (c.type === "number" && c.value != null) {
      const old = c.supersedes ? prevById.get(c.supersedes) : prevById.get(c.id);
      if (old?.value != null && old.value !== 0 && Math.abs(c.value - old.value) / Math.abs(old.value) > 0.2) return { major: true, reason: `${c.id} moved ${old.value} -> ${c.value} ${c.unit ?? ""}` };
    }
  }
  return { major: false, reason: "" };
}

export function headlineNumbers(ledger: Ledger): string[] {
  return ledger.claims
    .filter((c) => c.status === "active" && c.type === "number" && c.value != null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 4)
    .map((c) => `${c.value?.toLocaleString()} ${c.unit ?? ""}: ${c.text.slice(0, 50)}`);
}

/** Dry-run / no-key merge: turn surviving snippets into claims without any model. */
function stubMerge(story: StoryConfig, prev: Ledger, evidence: TriagedSnippet[], cycle: number): Ledger {
  const now = nowIso();
  let n = prev.claims.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
  const claims: Claim[] = prev.claims.map((c) => ({ ...c }));
  for (const s of evidence.slice(0, 10)) {
    const num = s.text.match(/(\d[\d,]*\.?\d*)\s*(mph|customers|flights|percent|%|feet|ft|inches)/i);
    claims.push({ id: `c${++n}`, text: s.text.slice(0, 140), type: num ? "number" : "statement", value: num ? Number(num[1].replace(/,/g, "")) : null, unit: num ? num[2] : null, confidence: Math.min(0.9, 0.5 + s.weight / 2), status: "active", sources: [s.url], first_seen: now, last_confirmed: now, ttl_minutes: ttlFor(story, num ? "number" : "statement"), supersedes: null });
  }
  const out = { summary: `Stub summary at cycle ${cycle}: ${claims.filter((c) => c.status === "active").length} active claims.`, claims, open_questions: prev.open_questions, corrections: [] };
  return applyInvariants(story, prev, out, cycle, now);
}

function loadFixtures(story: StoryConfig): Observation[] {
  const dir = resolve(process.cwd(), "fixtures", story.id);
  if (!existsSync(dir)) {
    warn(`no fixtures at ${dir}; dry run has no observations`);
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => {
      const id = f.replace(/\.txt$/, "");
      const cfg = story.fixed_sources.find((s) => s.id === id);
      const url = cfg?.url ?? `fixture://${id}`;
      return { url, kind: cfg?.kind ?? (id.startsWith("nimble-search") ? "nimble-search" : "fixture"), source_id: id, fetched_at: nowIso(), ok: true, text: readFileSync(resolve(dir, f), "utf8"), weight: sourceWeight(story, url), ms: 0 };
    });
}
