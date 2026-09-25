/**
 * Black Forest Labs FLUX situation card.
 * Verified endpoint: POST https://api.bfl.ai/v1/flux-2-pro (header x-key). Response {id, polling_url};
 * poll polling_url (GET, same header) every 2 s until status === "Ready", then download result.sample at once.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config.js";
import { fetchWithTimeout, sleep } from "../util.js";

export const fluxConfigured = () => Boolean(env.BFL_API_KEY);

export function cardPrompt(title: string, timeEt: string, numbers: string[]) {
  return `Minimal news situation card, flat design, large legible text. Title: ${title}. Time: ${timeEt}. Numbers: ${numbers.slice(0, 4).join("; ")}. No people, no logos.`;
}

export async function generateCard(story: string, cycle: number, prompt: string): Promise<{ path: string; model: string; ms: number }> {
  if (!fluxConfigured()) throw new Error("BFL_API_KEY missing");
  const started = Date.now();
  const headers = { "x-key": env.BFL_API_KEY, "Content-Type": "application/json", Accept: "application/json" };
  let model = "flux-2-pro";
  let r = await fetchWithTimeout(`https://api.bfl.ai/v1/${model}`, { method: "POST", headers, body: JSON.stringify({ prompt, width: 1536, height: 1024, output_format: "jpeg" }) }, 20000);
  if (r.status === 404) {
    model = "flux-pro-1.1";
    r = await fetchWithTimeout(`https://api.bfl.ai/v1/${model}`, { method: "POST", headers, body: JSON.stringify({ prompt, width: 1440, height: 960, output_format: "jpeg" }) }, 20000);
  }
  if (!r.ok) throw new Error(`bfl submit HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { id: string; polling_url: string };
  const pollUrl = j.polling_url;
  let sample = "";
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const p = await fetchWithTimeout(pollUrl, { headers: { "x-key": env.BFL_API_KEY, Accept: "application/json" } }, 15000);
    const pj = (await p.json()) as { status: string; result?: { sample?: string }; error?: string };
    if (pj.status === "Ready" && pj.result?.sample) {
      sample = pj.result.sample;
      break;
    }
    if (/Error|Failed|Moderated|Request Moderated|Content Moderated/.test(pj.status)) throw new Error(`bfl status ${pj.status} ${pj.error ?? ""}`);
  }
  if (!sample) throw new Error("bfl timed out waiting for Ready");
  const img = await fetchWithTimeout(sample, {}, 30000);
  if (!img.ok) throw new Error(`bfl download HTTP ${img.status}`);
  const buf = Buffer.from(await img.arrayBuffer());
  const dir = resolve(process.cwd(), "out", "cards", story);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${cycle}.jpg`);
  writeFileSync(path, buf);
  return { path: `out/cards/${story}/${cycle}.jpg`, model, ms: Date.now() - started };
}
