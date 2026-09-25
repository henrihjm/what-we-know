export type ClaimType = "warning" | "number" | "event" | "forecast" | "statement";
export type ClaimStatus = "active" | "superseded" | "retracted";

export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  value: number | null;
  unit: string | null;
  confidence: number;
  status: ClaimStatus;
  sources: string[];
  first_seen: string;
  last_confirmed: string;
  ttl_minutes: number;
  supersedes: string | null;
  status_changed_at?: string | null;
}

export interface SourceHealth {
  id: string;
  url: string;
  kind: string;
  last_ok: string | null;
  fail_count: number;
  healthy: boolean;
  last_error?: string | null;
}

export interface Ledger {
  story: string;
  cycle: number;
  updated_at: string;
  summary: string;
  claims: Claim[];
  open_questions: string[];
  sources: SourceHealth[];
}

export interface Correction {
  claim_id: string;
  from_text: string;
  to_text: string;
  reason: string;
  source: string;
}

/** A fetched document. Raw text lives only inside one cycle and is discarded after OBSERVE. */
export interface Observation {
  url: string;
  kind: string; // nws-alerts | nws-obs | faa-status | mbta-alerts | nimble-search | nimble-extract
  source_id: string;
  fetched_at: string;
  ok: boolean;
  error?: string | null;
  text: string; // raw text, never persisted
  weight: number;
  ms: number;
}

export interface Snippet {
  id: string;
  text: string;
  url: string;
  source_id: string;
  kind: string;
  weight: number;
  fetched_at: string;
}

export type TriageLabel =
  | { kind: "new" }
  | { kind: "duplicate"; claimId: string }
  | { kind: "contradicts"; claimId: string }
  | { kind: "irrelevant" };

export interface TriagedSnippet extends Snippet {
  label: TriageLabel;
  labelRaw: string;
  model: string;
  ms: number;
}

export interface TokenUsage {
  step: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  ms: number;
  /** false for a local model (no cost); excluded from the per-cycle token budget. */
  billable?: boolean;
}

export interface FixedSourceConfig {
  id: string;
  kind: "nws-alerts" | "nws-obs" | "faa-status" | "mbta-alerts" | "nimble-extract";
  url: string;
  parser: string;
  resolved?: string;
}

export interface StoryConfig {
  id: string;
  title: string;
  timezone: string;
  keywords: string[];
  places: string[];
  latest_query: string;
  seed_open_questions: string[];
  fixed_sources: FixedSourceConfig[];
  source_weights: Record<string, number>;
  ttl_overrides: Partial<Record<ClaimType, number>>;
}

export interface CycleStats {
  story: string;
  cycle: number;
  started_at: string;
  ms: number;
  observations: number;
  observations_ok: number;
  snippets: number;
  triage_new: number;
  triage_contradict: number;
  triage_duplicate: number;
  triage_irrelevant: number;
  triage_model: string;
  claims_active: number;
  corrections: number;
  tokens: number;
  ledger_tokens: number;
  summary_by: string;
  card_path: string | null;
  budget_exceeded: boolean;
  error: string | null;
}
