import type { Ledger, StoryConfig } from "./types.js";
import { minutesBetween, nowIso } from "./util.js";

/** 3 to 6 search queries: latest, open questions (max 3), stale active claims (max 2, oldest first). */
export function planQueries(story: StoryConfig, ledger: Ledger): string[] {
  const q: string[] = [story.latest_query];
  const topic = story.id === "noreaster" ? "nor'easter" : "Hormuz";
  for (const oq of ledger.open_questions.slice(0, 3)) q.push(`${topic} ${oq.replace(/\?$/, "")}`);
  const now = nowIso();
  const stale = ledger.claims
    .filter((c) => c.status === "active" && minutesBetween(c.last_confirmed, now) > c.ttl_minutes)
    .sort((a, b) => a.last_confirmed.localeCompare(b.last_confirmed))
    .slice(0, 2);
  for (const c of stale) q.push(`${topic} ${c.text.slice(0, 80)}`);
  return [...new Set(q)].slice(0, 6);
}
