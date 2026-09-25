import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ledger, StoryConfig } from "../types.js";
import { rawtreeQuery, sqlStory, rawtreeEnabled } from "./rawtree.js";
import { nowIso, warn, errMsg, log } from "../util.js";

const stateDir = resolve(process.cwd(), "state");
export const cachePath = (story: string) => resolve(stateDir, `${story}.json`);

export function emptyLedger(story: StoryConfig): Ledger {
  return {
    story: story.id,
    cycle: 0,
    updated_at: nowIso(),
    summary: "",
    claims: [],
    open_questions: [...story.seed_open_questions],
    sources: story.fixed_sources.map((s) => ({ id: s.id, url: s.resolved ?? s.url, kind: s.kind, last_ok: null, fail_count: 0, healthy: true })),
  };
}

/** RawTree first, local cache second, empty ledger last. Returns which source answered. */
export async function loadLedger(story: StoryConfig, storyKey = story.id): Promise<{ ledger: Ledger; from: "rawtree" | "cache" | "empty" }> {
  if (rawtreeEnabled()) {
    try {
      const rows = await rawtreeQuery<{ json: string }>(`SELECT json FROM ledger_versions WHERE story = ${sqlStory(storyKey)} ORDER BY cycle DESC LIMIT 1`);
      if (rows[0]?.json) {
        const ledger = JSON.parse(rows[0].json) as Ledger;
        return { ledger: reconcileSources(story, ledger), from: "rawtree" };
      }
    } catch (e) {
      warn(`loadLedger from RawTree failed, using cache: ${errMsg(e)}`);
    }
  }
  const p = cachePath(storyKey);
  if (existsSync(p)) {
    try {
      const ledger = JSON.parse(readFileSync(p, "utf8")) as Ledger;
      return { ledger: reconcileSources(story, ledger), from: "cache" };
    } catch (e) {
      warn(`cache ${p} unreadable: ${errMsg(e)}`);
    }
  }
  return { ledger: emptyLedger(story), from: "empty" };
}

export function saveLedgerCache(ledger: Ledger, storyKey = ledger.story) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(cachePath(storyKey), JSON.stringify(ledger, null, 2));
}

/** Make sure every configured fixed source has a health row (configs can gain sources between restarts). */
function reconcileSources(story: StoryConfig, ledger: Ledger): Ledger {
  const known = new Map(ledger.sources.map((s) => [s.id, s]));
  for (const s of story.fixed_sources) {
    if (!known.has(s.id)) ledger.sources.push({ id: s.id, url: s.resolved ?? s.url, kind: s.kind, last_ok: null, fail_count: 0, healthy: true });
  }
  ledger.story = story.id;
  ledger.claims ??= [];
  ledger.open_questions ??= [];
  return ledger;
}
