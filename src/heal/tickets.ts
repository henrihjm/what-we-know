/**
 * Fix tickets: the hand-off point for a coding agent to repair a broken parser.
 * Always writes tickets/<story>-<sourceId>.md and a RawTree row. If Broccoli is configured, POSTs the ticket there too.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config.js";
import type { SourceHealth, StoryConfig } from "../types.js";
import { persistRows } from "../persist/index.js";
import { fetchWithTimeout, nowIso, warn, errMsg, log } from "../util.js";

export interface Ticket {
  story: string;
  cycle: number;
  source_id: string;
  title: string;
  url: string;
  last_error: string;
  parser: string;
  fail_count: number;
  ts: string;
  path: string;
  broccoli: string;
}

export async function writeTicket(story: StoryConfig, cycle: number, src: SourceHealth, storyKey: string): Promise<Ticket | null> {
  const cfg = story.fixed_sources.find((s) => s.id === src.id);
  const dir = resolve(process.cwd(), "tickets");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${storyKey}-${src.id}.md`);
  const fresh = !existsSync(file);
  const t: Ticket = {
    story: storyKey,
    cycle,
    source_id: src.id,
    title: `Fix source ${src.id} for story ${storyKey}`,
    url: src.url,
    last_error: src.last_error ?? "unknown",
    parser: cfg?.parser ?? "unknown",
    fail_count: src.fail_count,
    ts: nowIso(),
    path: `tickets/${storyKey}-${src.id}.md`,
    broccoli: "not-configured",
  };
  const md = `# ${t.title}

- **Story:** ${t.story}
- **Source id:** ${t.source_id}
- **Kind:** ${src.kind}
- **URL:** ${t.url}
- **Parser:** \`${t.parser}\`
- **Consecutive failures:** ${t.fail_count}
- **Last error:** ${t.last_error}
- **Opened / last updated:** ${t.ts} (cycle ${cycle})

## Task for the coding agent

The loop marked this source unhealthy and now polls it only every 6th cycle. Open the parser file above, reproduce the fetch
against the URL, fix the parsing or the URL, run \`npm run sandbox\` to confirm the source returns ok, then restart the loop.
When the source succeeds again the loop resets fail_count and marks it healthy automatically.
`;
  writeFileSync(file, md);
  if (env.BROCCOLI_API_URL && env.BROCCOLI_API_KEY) {
    try {
      const r = await fetchWithTimeout(env.BROCCOLI_API_URL, { method: "POST", headers: { Authorization: `Bearer ${env.BROCCOLI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: t.title, body: md, url: t.url, story: t.story, source_id: t.source_id }) }, 15000);
      t.broccoli = `HTTP ${r.status}`;
    } catch (e) {
      t.broccoli = `failed: ${errMsg(e).slice(0, 80)}`;
      warn(`broccoli ticket failed: ${errMsg(e)}`);
    }
  }
  if (fresh) log(`ticket written: ${t.path}`);
  await persistRows("tickets", storyKey, [{ ...t, fresh }]);
  return t;
}
