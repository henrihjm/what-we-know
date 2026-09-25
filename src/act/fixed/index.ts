import type { FixedSourceConfig, Observation, StoryConfig, SourceHealth } from "../../types.js";
import { sourceWeight, UNHEALTHY_POLL_EVERY } from "../../config.js";
import { nowIso, withTimeout, errMsg, pLimit } from "../../util.js";
import { fetchNwsAlerts, fetchNwsObs } from "./nws.js";
import { fetchFaaStatus } from "./faa.js";
import { fetchMbtaAlerts } from "./mbta.js";
import { fetchPage } from "./page.js";

const limit = pLimit(6);

export async function runFixedSource(story: StoryConfig, src: FixedSourceConfig): Promise<Observation> {
  const url = src.resolved ?? src.url;
  const started = Date.now();
  const base = { url, kind: src.kind, source_id: src.id, fetched_at: nowIso(), weight: sourceWeight(story, url) };
  try {
    const fetcher =
      src.kind === "nws-alerts" ? fetchNwsAlerts : src.kind === "nws-obs" ? fetchNwsObs : src.kind === "faa-status" ? fetchFaaStatus : src.kind === "mbta-alerts" ? fetchMbtaAlerts : fetchPage;
    const text = await withTimeout(fetcher(url), 25000, src.id);
    return { ...base, ok: true, text, ms: Date.now() - started };
  } catch (e) {
    return { ...base, ok: false, error: errMsg(e).slice(0, 300), text: "", ms: Date.now() - started };
  }
}

/** Poll all fixed sources. Unhealthy sources are polled only every 6th cycle. Never throws. */
export async function runFixedSources(story: StoryConfig, health: SourceHealth[], cycle: number, opts: { skipNimble?: boolean } = {}): Promise<Observation[]> {
  const byId = new Map(health.map((h) => [h.id, h]));
  const due = story.fixed_sources.filter((s) => {
    const h = byId.get(s.id);
    if (h && !h.healthy && cycle % UNHEALTHY_POLL_EVERY !== 0) return false;
    if (opts.skipNimble && s.kind === "nimble-extract") return false;
    return true;
  });
  return Promise.all(due.map((s) => limit(() => runFixedSource(story, s))));
}
