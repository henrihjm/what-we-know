import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { StoryConfig, ClaimType } from "./types.js";

export const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "",
  NIMBLE_API_KEY: process.env.NIMBLE_API_KEY || "",
  RAWTREE_API_KEY: process.env.RAWTREE_API_KEY || "",
  RAWTREE_DATABASE: process.env.RAWTREE_DATABASE || "",
  RAWTREE_BASE_URL: process.env.RAWTREE_BASE_URL || "https://api.rawtree.com",
  TRIAGE_BASE_URL: process.env.TRIAGE_BASE_URL || "",
  TRIAGE_MODEL: process.env.TRIAGE_MODEL || "",
  TRIAGE_API_KEY: process.env.TRIAGE_API_KEY || process.env.OPENROUTER_API_KEY || "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "",
  AWS_PROFILE: process.env.AWS_PROFILE || "",
  BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID || "",
  BFL_API_KEY: process.env.BFL_API_KEY || "",
  BROCCOLI_API_URL: process.env.BROCCOLI_API_URL || "",
  BROCCOLI_API_KEY: process.env.BROCCOLI_API_KEY || "",
  MAX_TOKENS_PER_CYCLE: Number(process.env.MAX_TOKENS_PER_CYCLE || 60000),
  CYCLE_INTERVAL_SECONDS: Number(process.env.CYCLE_INTERVAL_SECONDS || 300),
  CONTACT_EMAIL: process.env.CONTACT_EMAIL || "what-we-know@example.com",
  DASHBOARD_PORT: Number(process.env.DASHBOARD_PORT || 3000),
};

export const DEFAULT_TTL: Record<ClaimType, number> = {
  number: 30,
  warning: 60,
  event: 180,
  forecast: 120,
  statement: 240,
};

export const MAX_ACTIVE_CLAIMS = 60;
export const LEDGER_TOKEN_TARGET = 1500;
export const FETCH_TIMEOUT_MS = 20000;
export const MAX_SNIPPETS_PER_DOC = 40;
export const MAX_SNIPPETS_PER_CYCLE = 300;
export const CARD_MIN_INTERVAL_MIN = 15;
export const UNHEALTHY_FAILS = 3;
export const UNHEALTHY_POLL_EVERY = 6;
export const PRUNE_AFTER_MIN = 30;

const StorySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  timezone: z.string().default("America/New_York"),
  keywords: z.array(z.string()),
  places: z.array(z.string()),
  latest_query: z.string(),
  seed_open_questions: z.array(z.string()),
  fixed_sources: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["nws-alerts", "nws-obs", "faa-status", "mbta-alerts", "nimble-extract"]),
      url: z.string(),
      parser: z.string(),
      resolved: z.string().optional(),
    }),
  ),
  source_weights: z.record(z.number().min(0).max(1)),
  ttl_overrides: z.record(z.number()).default({}),
});

export const ALLOWED_STORIES = ["noreaster", "hormuz"] as const;
export type StoryId = (typeof ALLOWED_STORIES)[number];

export function storyPath(id: string) {
  return resolve(process.cwd(), "stories", `${id}.json`);
}

export function loadStory(id: string): StoryConfig {
  if (!ALLOWED_STORIES.includes(id as StoryId)) throw new Error(`Unknown story '${id}'. Allowed: ${ALLOWED_STORIES.join(", ")}`);
  const p = storyPath(id);
  if (!existsSync(p)) throw new Error(`Story config missing: ${p}`);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const parsed = StorySchema.parse({ id, ...raw });
  return parsed as StoryConfig;
}

/** Persist a resolved URL into the story config (used when a page URL is discovered at startup). */
export function saveResolvedUrl(id: string, sourceId: string, resolved: string) {
  const p = storyPath(id);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  for (const s of raw.fixed_sources ?? []) if (s.id === sourceId) s.resolved = resolved;
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");
}

export function sourceWeight(story: StoryConfig, url: string): number {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return 0.5;
  }
  const social = ["x.com", "twitter.com", "facebook.com", "reddit.com", "tiktok.com", "instagram.com", "threads.net", "bsky.app"];
  if (social.some((s) => host === s || host.endsWith("." + s))) return story.source_weights["social"] ?? 0.3;
  for (const [domain, w] of Object.entries(story.source_weights)) {
    if (domain === "social" || domain === "default") continue;
    if (host === domain || host.endsWith("." + domain)) return w;
  }
  return story.source_weights["default"] ?? 0.5;
}

export function ttlFor(story: StoryConfig, type: ClaimType): number {
  return story.ttl_overrides[type] ?? DEFAULT_TTL[type];
}

export interface RunArgs {
  story: string;
  once: boolean;
  dryRun: boolean;
  sandbox: boolean;
  interval: number;
}

export function parseArgs(argv = process.argv.slice(2)): RunArgs {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    story: get("--story") || "noreaster",
    once: argv.includes("--once"),
    dryRun: argv.includes("--dry-run"),
    sandbox: argv.includes("--sandbox"),
    interval: Number(get("--interval") || env.CYCLE_INTERVAL_SECONDS),
  };
}
