/**
 * One real call per sponsor. Prints a pass/fail table and never throws.
 * Usage: npm run check-env
 */
import "dotenv/config";
import { env, loadStory } from "../src/config.js";
import { fetchWithTimeout, errMsg } from "../src/util.js";

type Row = { sponsor: string; step: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
const rows: Row[] = [];
const push = (sponsor: string, step: string, status: Row["status"], detail: string) =>
  rows.push({ sponsor, step, status, detail: detail.slice(0, 90) });

async function checkOpenAI() {
  if (!env.OPENAI_API_KEY) return push("OpenAI", "merge model", "FAIL", "OPENAI_API_KEY missing");
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 20000 });
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id);
    const pick = pickOpenAIModel(ids);
    const r = await client.chat.completions.create({
      model: env.OPENAI_MODEL || pick,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_completion_tokens: 5,
    });
    push("OpenAI", "merge model", "PASS", `${r.model} answered '${r.choices[0]?.message.content?.trim()}'; default would be ${pick}`);
  } catch (e) {
    push("OpenAI", "merge model", "FAIL", errMsg(e));
  }
}

export function pickOpenAIModel(ids: string[]): string {
  const prefs = ["gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"];
  for (const p of prefs) {
    const exact = ids.find((i) => i === p);
    if (exact) return exact;
    const dated = ids.filter((i) => i.startsWith(p + "-") && !/mini|nano|realtime|audio|search|transcribe|tts|codex|pro|chat/.test(i)).sort().reverse();
    if (dated[0]) return dated[0];
  }
  return "gpt-4o";
}

async function checkNimble() {
  if (!env.NIMBLE_API_KEY) return push("Nimble", "search", "FAIL", "NIMBLE_API_KEY missing");
  try {
    const { default: Nimble } = await import("@nimble-way/nimble-js");
    const nimble = new Nimble({ apiKey: env.NIMBLE_API_KEY, timeout: 20000 });
    const r = await nimble.search({ query: "nor'easter Northeast latest", country: "US", search_depth: "lite", max_results: 3 });
    push("Nimble", "search", "PASS", `${r.results.length} results, first: ${r.results[0]?.url ?? "-"}`);
  } catch (e) {
    push("Nimble", "search", "FAIL", errMsg(e));
  }
}

async function checkRawTree() {
  if (!env.RAWTREE_API_KEY) return push("Tinybird RawTree", "insert+query", "FAIL", "RAWTREE_API_KEY missing");
  try {
    const { rawtreeInsert, rawtreeQuery } = await import("../src/persist/rawtree.js");
    await rawtreeInsert("healthchecks", [{ story: "check-env", cycle: 0, ts: new Date().toISOString(), ok: true }]);
    const r = await rawtreeQuery("SELECT count() AS n FROM healthchecks WHERE story = 'check-env' LIMIT 1");
    push("Tinybird RawTree", "insert+query", "PASS", `healthchecks rows: ${JSON.stringify(r[0])}`);
  } catch (e) {
    push("Tinybird RawTree", "insert+query", "FAIL", errMsg(e));
  }
}

async function checkTriage() {
  const base = env.TRIAGE_BASE_URL || (env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "http://localhost:11434/v1");
  try {
    const { triageOne, triageBackendName } = await import("../src/observe/triage.js");
    const r = await triageOne([{ id: "c1", text: "High wind warning in effect for Boston" }], "Boston is under a high wind warning until Saturday.");
    push("Liquid AI", "triage", r.model.includes("fallback") ? "FAIL" : "PASS", `${triageBackendName()} -> ${r.model} said '${r.labelRaw}' (${r.ms} ms)`);
  } catch (e) {
    push("Liquid AI", "triage", "FAIL", `${base}: ${errMsg(e)}`);
  }
}

async function checkBedrock() {
  if (!env.BEDROCK_MODEL_ID) return push("AWS Bedrock", "summary", "FAIL", "BEDROCK_MODEL_ID missing (also needs AWS creds)");
  try {
    const { bedrockSummary } = await import("../src/correct/summary.js");
    const r = await bedrockSummary(["High wind warning in effect for Boston through Saturday 8 PM ET", "LaGuardia has wind delays averaging 45 minutes"]);
    push("AWS Bedrock", "summary", "PASS", `${r.model}: ${r.text.slice(0, 60)}`);
  } catch (e) {
    push("AWS Bedrock", "summary", "FAIL", errMsg(e));
  }
}

async function checkBFL() {
  if (!env.BFL_API_KEY) return push("Black Forest Labs", "flux card", "FAIL", "BFL_API_KEY missing");
  try {
    // Cheap check: hit the endpoint with a bad body; a 422 proves auth works without spending credits.
    const r = await fetchWithTimeout("https://api.bfl.ai/v1/flux-2-pro", {
      method: "POST",
      headers: { "x-key": env.BFL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (r.status === 401 || r.status === 403) push("Black Forest Labs", "flux card", "FAIL", `auth rejected (${r.status})`);
    else push("Black Forest Labs", "flux card", "PASS", `endpoint reachable, auth accepted (HTTP ${r.status})`);
  } catch (e) {
    push("Black Forest Labs", "flux card", "FAIL", errMsg(e));
  }
}

async function checkBroccoli() {
  if (!env.BROCCOLI_API_URL || !env.BROCCOLI_API_KEY) return push("Broccoli", "tickets", "SKIP", "not configured; tickets go to tickets/*.md + RawTree");
  try {
    const r = await fetchWithTimeout(env.BROCCOLI_API_URL, { method: "GET", headers: { Authorization: `Bearer ${env.BROCCOLI_API_KEY}` } }, 10000);
    push("Broccoli", "tickets", r.ok ? "PASS" : "FAIL", `HTTP ${r.status}`);
  } catch (e) {
    push("Broccoli", "tickets", "FAIL", errMsg(e));
  }
}

async function checkFixedSources() {
  const story = loadStory("noreaster");
  const { runFixedSource } = await import("../src/act/fixed/index.js");
  for (const id of ["nws-alerts-MA", "nws-obs-KLGA", "faa-status", "mbta-alerts"]) {
    const src = story.fixed_sources.find((s) => s.id === id)!;
    const o = await runFixedSource(story, src);
    push("Public API", id, o.ok ? "PASS" : "FAIL", o.ok ? `${o.text.length} chars in ${o.ms} ms` : o.error ?? "?");
  }
}

async function main() {
  await Promise.all([checkOpenAI(), checkNimble(), checkRawTree(), checkTriage(), checkBedrock(), checkBFL(), checkBroccoli(), checkFixedSources()]);
  const order = ["OpenAI", "Nimble", "Tinybird RawTree", "Liquid AI", "AWS Bedrock", "Black Forest Labs", "Broccoli", "Public API"];
  rows.sort((a, b) => order.indexOf(a.sponsor) - order.indexOf(b.sponsor));
  console.log("\n" + pad("SPONSOR", 18) + pad("STEP", 16) + pad("STATUS", 8) + "DETAIL");
  console.log("-".repeat(120));
  for (const r of rows) console.log(pad(r.sponsor, 18) + pad(r.step, 16) + pad(r.status, 8) + r.detail);
  const missing = rows.filter((r) => r.status === "FAIL" && /missing/.test(r.detail)).map((r) => r.sponsor);
  console.log("\nMissing keys:", missing.length ? missing.join(", ") : "none");
}
const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
main();
