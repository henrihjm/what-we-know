/** Aggregates over the local JSONL store; mirrors the RawTree SQL used by the dashboard and demo-stats. */
import { localRead } from "./local.js";

type Row = Record<string, any>;
const num = (v: unknown) => Number(v ?? 0);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

export function localStatus(story: string) {
  const cycles = localRead<Row>("cycles", story).filter((c) => num(c.cycle) > 0);
  const last = cycles.sort((a, b) => num(a.cycle) - num(b.cycle)).at(-1) ?? null;
  return { cycles: cycles.length, since: cycles[0]?.ts ?? null, last_ts: last?.ts ?? null, last };
}

export function localLedger(story: string): Row | null {
  const v = localRead<Row>("ledger_versions", story).sort((a, b) => num(a.cycle) - num(b.cycle)).at(-1);
  return v?.json ? JSON.parse(v.json) : null;
}

export function localCorrections(story: string, limit = 40) {
  return localRead<Row>("corrections", story).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit);
}

export function localSeries(story: string) {
  const obsBy = new Map<number, number>();
  for (const o of localRead<Row>("observations", story)) obsBy.set(num(o.cycle), (obsBy.get(num(o.cycle)) ?? 0) + 1);
  let cum = 0;
  const observations = [...obsBy.entries()].sort((a, b) => a[0] - b[0]).map(([cycle, n]) => ({ cycle, n, cumulative: (cum += n) }));
  const claims = localRead<Row>("ledger_versions", story).sort((a, b) => num(a.cycle) - num(b.cycle)).map((v) => ({ cycle: num(v.cycle), active: num(v.claims_active), ledger_tokens: num(v.ledger_tokens) }));
  const tokBy = new Map<string, number>();
  for (const t of localRead<Row>("tokens", story)) {
    const k = `${num(t.cycle)}|${t.provider}`;
    tokBy.set(k, (tokBy.get(k) ?? 0) + num(t.prompt_tokens) + num(t.completion_tokens));
  }
  const tokens = [...tokBy.entries()].map(([k, tokens]) => ({ cycle: Number(k.split("|")[0]), provider: k.split("|")[1], tokens })).sort((a, b) => a.cycle - b.cycle);
  return { observations, claims, tokens };
}

export function localHealth(story: string) {
  const rows = localRead<Row>("source_health", story);
  const maxCycle = Math.max(0, ...rows.map((r) => num(r.cycle)));
  return rows.filter((r) => num(r.cycle) === maxCycle).sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)));
}

export function localCards(story: string) {
  return localRead<Row>("cards", story).sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 5);
}

export function localSponsors(story: string) {
  const triage = localRead<Row>("triage", story);
  const tokens = localRead<Row>("tokens", story);
  const tables = ["observations", "triage", "ledger_versions", "corrections", "tokens", "source_health", "cards", "tickets", "cycles"] as const;
  const rows = tables.reduce((a, t) => a + localRead<Row>(t, story).length, 0);
  return {
    liquid_triaged: triage.filter((t) => t.model !== "none" && !String(t.model).includes("fallback") && String(t.model).includes("lfm")).length,
    openai_fallback_triaged: triage.filter((t) => String(t.model).includes("fallback") || (!String(t.model).includes("lfm") && t.model !== "none")).length,
    openai_merges: tokens.filter((t) => t.step === "merge").length,
    bedrock_summaries: tokens.filter((t) => t.provider === "bedrock").length,
    nimble_pages: localRead<Row>("observations", story).filter((o) => String(o.kind).startsWith("nimble") && o.ok).length,
    rawtree_rows: rows,
    flux_cards: localRead<Row>("cards", story).length,
    tickets: localRead<Row>("tickets", story).filter((t) => t.fresh).length,
  };
}

export function localDemoStats(story: string) {
  const cycles = localRead<Row>("cycles", story).filter((c) => num(c.cycle) > 0);
  const obs = localRead<Row>("observations", story);
  const triage = localRead<Row>("triage", story);
  const byModel = new Map<string, number>();
  for (const t of triage) byModel.set(String(t.model), (byModel.get(String(t.model)) ?? 0) + 1);
  const led = localRead<Row>("ledger_versions", story).sort((a, b) => num(a.cycle) - num(b.cycle)).at(-1);
  const cor = localCorrections(story, 3);
  const tokens = localRead<Row>("tokens", story);
  const byProv = new Map<string, { calls: number; t: number }>();
  for (const t of tokens) {
    const p = byProv.get(String(t.provider)) ?? { calls: 0, t: 0 };
    p.calls++;
    p.t += num(t.prompt_tokens) + num(t.completion_tokens);
    byProv.set(String(t.provider), p);
  }
  const health = localHealth(story);
  const summaryBy = new Map<string, number>();
  for (const v of localRead<Row>("ledger_versions", story)) summaryBy.set(String(v.summary_by), (summaryBy.get(String(v.summary_by)) ?? 0) + 1);
  return {
    since: cycles[0]?.ts ?? null,
    cycles: cycles.length,
    median_ms: median(cycles.map((c) => num(c.ms))),
    median_tokens: median(cycles.map((c) => num(c.tokens))),
    median_ledger: median(cycles.map((c) => num(c.ledger_tokens))),
    observations: obs.length,
    observations_ok: obs.filter((o) => o.ok).length,
    triaged: triage.length,
    triage_by_model: [...byModel.entries()].sort((a, b) => b[1] - a[1]),
    claims_active: num(led?.claims_active),
    claims_total: num(led?.claims_total),
    ledger_cycle: num(led?.cycle),
    corrections: localRead<Row>("corrections", story).length,
    corrections_recent: cor,
    tokens_by_provider: [...byProv.entries()].sort((a, b) => b[1].t - a[1].t),
    summary_by: [...summaryBy.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["-", 0],
    healthy: health.filter((h) => h.healthy).length,
    unhealthy: health.filter((h) => !h.healthy).length,
    cards: localRead<Row>("cards", story).length,
  };
}
