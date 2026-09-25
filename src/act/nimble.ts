/**
 * Nimble client: search (full_content) + page extract, with timeout, retries, concurrency 4, 429 backoff.
 * Verified against @nimble-way/nimble-js 1.5.0: `extract.run` is synchronous and returns `data.markdown`
 * directly (no task id polling needed); `extract.async` is the polled variant.
 */
import Nimble from "@nimble-way/nimble-js";
import { env } from "../config.js";
import { pLimit, sleep, withTimeout, errMsg } from "../util.js";

const TIMEOUT = 20000;
const limit = pLimit(4);
let client: Nimble | null = null;
function nimble(): Nimble {
  if (!env.NIMBLE_API_KEY) throw new Error("NIMBLE_API_KEY missing");
  return (client ??= new Nimble({ apiKey: env.NIMBLE_API_KEY, timeout: TIMEOUT, maxRetries: 0 }));
}

async function retrying<T>(fn: () => Promise<T>, label: string, tries = 2): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await withTimeout(fn(), TIMEOUT + 2000, label);
    } catch (e) {
      last = e;
      const m = errMsg(e);
      if (/429|rate/i.test(m)) await sleep(2000 * (i + 1));
      else if (i < tries - 1) await sleep(500);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface SearchDoc {
  url: string;
  title: string;
  text: string;
}

export async function nimbleSearch(query: string, maxResults = 6): Promise<SearchDoc[]> {
  return limit(() =>
    retrying(async () => {
      const r = await nimble().search({ query, country: "US", search_depth: "standard", full_content: true, max_results: maxResults, output_format: "plain_text" });
      return r.results.map((x) => ({ url: x.url, title: x.title, text: (x.content || x.description || "").slice(0, 20000) }));
    }, `nimble.search(${query})`),
  );
}

export async function nimbleExtract(url: string): Promise<string> {
  return limit(() =>
    retrying(async () => {
      const r = await nimble().extract.run({ url, render: true, formats: ["markdown"], markdown_backend: "main_content", request_timeout: 15 } as never);
      if (r.status !== "success") throw new Error(`extract status ${r.status}`);
      const text = r.data.markdown ?? r.data.html ?? "";
      if (!text) throw new Error("extract returned no markdown");
      return text.slice(0, 40000);
    }, `nimble.extract(${url})`),
  );
}
