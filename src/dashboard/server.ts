/** Dashboard API + static page. Every number comes from RawTree SQL; keys never reach the browser. */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, ALLOWED_STORIES } from "../config.js";
import { rawtreeQuery, sqlStory, rawtreeEnabled } from "../persist/rawtree.js";
import { cachePath } from "../persist/state.js";
import { errMsg } from "../util.js";
import { localStatus, localLedger, localCorrections, localSeries, localHealth, localCards, localSponsors } from "../persist/stats.js";

const app = new Hono();
const html = readFileSync(resolve(process.cwd(), "src/dashboard/index.html"), "utf8");

const STORY_KEYS = [...ALLOWED_STORIES, ...ALLOWED_STORIES.map((s) => `${s}-sandbox`), ...ALLOWED_STORIES.map((s) => `${s}-dry`)];
function storyOf(c: { req: { query: (k: string) => string | undefined } }) {
  const s = c.req.query("story") || "noreaster";
  if (!STORY_KEYS.includes(s)) throw new Error("unknown story");
  return s;
}
/** RawTree returns DateTime64 as "2026-09-25 22:07:55.852000000"; make it ISO so the browser can parse it. */
function fixTs<T>(rows: T[]): T[] {
  for (const r of rows as Record<string, unknown>[]) for (const k of ["ts", "since", "last_ts", "last_ok", "fetched_at"]) {
    const v = r[k];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) r[k] = v.replace(" ", "T").replace(/(\.\d{3})\d*$/, "$1") + "Z";
  }
  return rows;
}
async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  try {
    return fixTs(await rawtreeQuery<T>(sql));
  } catch (e) {
    console.warn("query failed:", errMsg(e), "\n", sql);
    return [];
  }
}

app.get("/", (c) => c.html(html));
app.get("/api/stories", (c) => c.json({ stories: STORY_KEYS, rawtree: rawtreeEnabled() }));

app.get("/api/status", async (c) => {
  const key = storyOf(c);
  if (!rawtreeEnabled()) return c.json({ ...localStatus(key), rawtree: false, source: "local" });
  const s = sqlStory(key);
  const [agg] = await q<{ cycles: number; since: string; last_ts: string }>(`SELECT count() AS cycles, min(ts) AS since, max(ts) AS last_ts FROM cycles WHERE story = ${s} AND cycle > 0 AND ts > now() - INTERVAL 7 DAY LIMIT 1`);
  const [last] = await q(`SELECT cycle, ts, ms, observations, snippets, claims_active, corrections, tokens, ledger_tokens, triage_model, summary_by, merge_model, budget_exceeded FROM cycles WHERE story = ${s} AND cycle > 0 ORDER BY cycle DESC LIMIT 1`);
  return c.json({ ...agg, last: last ?? null, rawtree: rawtreeEnabled() });
});

app.get("/api/ledger", async (c) => {
  const key = storyOf(c);
  if (!rawtreeEnabled()) {
    const l = localLedger(key);
    if (l) return c.json({ from: "local", ledger: l });
  }
  const rows = await q<{ json: string }>(`SELECT json FROM ledger_versions WHERE story = ${sqlStory(key)} ORDER BY cycle DESC LIMIT 1`);
  if (rows[0]?.json) return c.json({ from: "rawtree", ledger: JSON.parse(rows[0].json) });
  const p = cachePath(key);
  if (existsSync(p)) return c.json({ from: "cache", ledger: JSON.parse(readFileSync(p, "utf8")) });
  return c.json({ from: "none", ledger: null });
});

app.get("/api/corrections", async (c) => {
  if (!rawtreeEnabled()) return c.json({ corrections: localCorrections(storyOf(c)) });
  const s = sqlStory(storyOf(c));
  const rows = await q(`SELECT cycle, ts, claim_id, from_text, to_text, reason, source FROM corrections WHERE story = ${s} AND ts > now() - INTERVAL 7 DAY ORDER BY ts DESC LIMIT 40`);
  return c.json({ corrections: rows });
});

app.get("/api/series", async (c) => {
  if (!rawtreeEnabled()) return c.json(localSeries(storyOf(c)));
  const s = sqlStory(storyOf(c));
  const [obs, claims, tokens] = await Promise.all([
    q<{ cycle: number; n: number }>(`SELECT cycle, count() AS n FROM observations WHERE story = ${s} AND ts > now() - INTERVAL 7 DAY GROUP BY cycle ORDER BY cycle LIMIT 2000`),
    q<{ cycle: number; claims_active: number; ledger_tokens: number }>(`SELECT cycle, claims_active, ledger_tokens FROM ledger_versions WHERE story = ${s} AND ts > now() - INTERVAL 7 DAY ORDER BY cycle LIMIT 2000`),
    q<{ cycle: number; provider: string; t: number }>(`SELECT cycle, provider, sum(prompt_tokens + completion_tokens) AS t FROM tokens WHERE story = ${s} AND ts > now() - INTERVAL 7 DAY GROUP BY cycle, provider ORDER BY cycle LIMIT 5000`),
  ]);
  let cum = 0;
  const observations = obs.map((r) => ({ cycle: Number(r.cycle), n: Number(r.n), cumulative: (cum += Number(r.n)) }));
  return c.json({ observations, claims: claims.map((r) => ({ cycle: Number(r.cycle), active: Number(r.claims_active), ledger_tokens: Number(r.ledger_tokens) })), tokens: tokens.map((r) => ({ cycle: Number(r.cycle), provider: r.provider, tokens: Number(r.t) })) });
});

app.get("/api/health", async (c) => {
  if (!rawtreeEnabled()) return c.json({ sources: localHealth(storyOf(c)) });
  const s = sqlStory(storyOf(c));
  const rows = await q(`SELECT source_id, url, kind, healthy, fail_count, last_ok, last_error FROM source_health WHERE story = ${s} AND cycle = (SELECT max(cycle) FROM source_health WHERE story = ${s}) ORDER BY source_id LIMIT 200`);
  return c.json({ sources: rows });
});

app.get("/api/cards", async (c) => {
  if (!rawtreeEnabled()) return c.json({ cards: localCards(storyOf(c)) });
  const s = sqlStory(storyOf(c));
  const rows = await q(`SELECT cycle, ts, path, reason, numbers, model FROM cards WHERE story = ${s} ORDER BY ts DESC LIMIT 5`);
  return c.json({ cards: rows });
});

app.get("/api/sponsors", async (c) => {
  if (!rawtreeEnabled()) return c.json(localSponsors(storyOf(c)));
  const s = sqlStory(storyOf(c));
  const one = async (sql: string) => Number((await q<{ n: number }>(sql))[0]?.n ?? 0);
  const [liquid, fallback, merges, bedrock, nimble, cards, tickets, ...rows] = await Promise.all([
    one(`SELECT count() AS n FROM triage WHERE story = ${s} AND model LIKE '%lfm%'`),
    one(`SELECT count() AS n FROM triage WHERE story = ${s} AND model NOT LIKE '%lfm%' AND model != 'none'`),
    one(`SELECT count() AS n FROM tokens WHERE story = ${s} AND step = 'merge'`),
    one(`SELECT count() AS n FROM tokens WHERE story = ${s} AND provider = 'bedrock'`),
    one(`SELECT count() AS n FROM observations WHERE story = ${s} AND kind LIKE 'nimble%' AND ok = true`),
    one(`SELECT count() AS n FROM cards WHERE story = ${s}`),
    one(`SELECT count() AS n FROM tickets WHERE story = ${s} AND fresh = true`),
    ...["observations", "triage", "ledger_versions", "corrections", "tokens", "source_health", "cards", "tickets", "cycles"].map((t) => one(`SELECT count() AS n FROM ${t} WHERE story = ${s}`)),
  ]);
  const rawtreeRows = rows.reduce((a, b) => a + b, 0);
  return c.json({ liquid_triaged: liquid, openai_fallback_triaged: fallback, openai_merges: merges, bedrock_summaries: bedrock, nimble_pages: nimble, rawtree_rows: rawtreeRows, flux_cards: cards, tickets });
});

app.use("/cards/*", serveStatic({ root: "./out", rewriteRequestPath: (p) => p }));

serve({ fetch: app.fetch, port: env.DASHBOARD_PORT }, (info) => console.log(`dashboard on http://localhost:${info.port}  (rawtree ${rawtreeEnabled() ? "on" : "OFF"})`));
