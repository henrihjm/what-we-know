/** Headline numbers for the pitch, all from RawTree. Usage: npm run demo-stats -- --story noreaster */
import "dotenv/config";
import { parseArgs } from "../src/config.js";
import { rawtreeQuery, sqlStory, rawtreeEnabled } from "../src/persist/rawtree.js";

const { story } = parseArgs();
const s = sqlStory(story);
const one = async <T = Record<string, unknown>>(sql: string) => (await rawtreeQuery<T>(sql))[0] ?? ({} as T);
const n = (v: unknown) => Number(v ?? 0);

if (!rawtreeEnabled()) {
  console.log("RAWTREE_API_KEY missing: no stats available");
  process.exit(0);
}
const cyc = await one<{ cycles: number; since: string; median_ms: number; median_tokens: number; median_ledger: number }>(`SELECT count() AS cycles, min(ts) AS since, median(ms) AS median_ms, median(tokens) AS median_tokens, median(ledger_tokens) AS median_ledger FROM cycles WHERE story = ${s} AND cycle > 0 LIMIT 1`);
const obs = await one(`SELECT count() AS n, countIf(ok = true) AS ok FROM observations WHERE story = ${s} LIMIT 1`);
const tri = await rawtreeQuery<{ model: string; n: number }>(`SELECT model, count() AS n FROM triage WHERE story = ${s} GROUP BY model ORDER BY n DESC LIMIT 10`);
const led = await one(`SELECT claims_active, claims_total, cycle FROM ledger_versions WHERE story = ${s} ORDER BY cycle DESC LIMIT 1`);
const cor = await one(`SELECT count() AS n FROM corrections WHERE story = ${s} LIMIT 1`);
const cor3 = await rawtreeQuery<{ claim_id: string; from_text: string; to_text: string; reason: string }>(`SELECT claim_id, from_text, to_text, reason FROM corrections WHERE story = ${s} ORDER BY ts DESC LIMIT 3`);
const hea = await one(`SELECT countIf(healthy = true) AS ok, countIf(healthy = false) AS bad FROM source_health WHERE story = ${s} AND cycle = (SELECT max(cycle) FROM source_health WHERE story = ${s}) LIMIT 1`);
const cards = await one(`SELECT count() AS n FROM cards WHERE story = ${s} LIMIT 1`);
const tok = await rawtreeQuery<{ provider: string; calls: number; t: number }>(`SELECT provider, count() AS calls, sum(prompt_tokens + completion_tokens) AS t FROM tokens WHERE story = ${s} GROUP BY provider ORDER BY t DESC LIMIT 10`);
const sum = await one(`SELECT summary_by, count() AS n FROM ledger_versions WHERE story = ${s} GROUP BY summary_by ORDER BY n DESC LIMIT 1`);

console.log(`\nWHAT WE KNOW — ${story}`);
console.log(`running since        ${cyc.since ?? "-"}`);
console.log(`cycles               ${n(cyc.cycles)}   (median ${Math.round(n(cyc.median_ms) / 1000)} s)`);
console.log(`observations         ${n(obs.n)} fetched, ${n(obs.ok)} ok`);
console.log(`snippets triaged     ${tri.reduce((a, t) => a + n(t.n), 0)}`);
for (const t of tri) console.log(`  by ${t.model.padEnd(40)} ${n(t.n)}`);
console.log(`active claims now    ${n(led.claims_active)} of ${n(led.claims_total)} in ledger (cycle ${n(led.cycle)})`);
console.log(`corrections          ${n(cor.n)}`);
for (const c of cor3) console.log(`  ${c.claim_id}: "${c.from_text}" -> "${c.to_text}" (${c.reason})`);
console.log(`tokens per cycle     median ${Math.round(n(cyc.median_tokens)).toLocaleString()}`);
for (const t of tok) console.log(`  ${t.provider.padEnd(16)} ${n(t.calls)} calls, ${n(t.t).toLocaleString()} tokens`);
console.log(`ledger size          median ~${Math.round(n(cyc.median_ledger))} tokens (target < 1500)`);
console.log(`summaries written by ${sum.summary_by ?? "-"} (${n(sum.n)})`);
console.log(`sources              ${n(hea.ok)} healthy, ${n(hea.bad)} unhealthy`);
console.log(`cards generated      ${n(cards.n)}\n`);
