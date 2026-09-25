import type { Observation, Snippet, StoryConfig } from "../types.js";
import { MAX_SNIPPETS_PER_CYCLE, MAX_SNIPPETS_PER_DOC } from "../config.js";

const TIME_RE = /\b(\d{1,2}(:\d{2})?\s?(am|pm|a\.m\.|p\.m\.)|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(today|tonight|tomorrow|this (morning|afternoon|evening)|overnight)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\bET\b|\bEDT\b|\bUTC\b|\bGMT\b)/i;
const NUM_RE = /\d/;

function cleanMarkdown(t: string): string {
  return t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>|`]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitToSnippets(obs: Observation[], story: StoryConfig): Snippet[] {
  const kw = story.keywords.map((k) => k.toLowerCase());
  const places = story.places.map((p) => p.toLowerCase());
  const seen = new Set<string>();
  const out: Snippet[] = [];
  let n = 0;
  for (const o of obs) {
    if (!o.ok || !o.text) continue;
    const text = o.kind.startsWith("nimble") ? cleanMarkdown(o.text) : o.text;
    // Sentences: split on newline or sentence punctuation followed by space + capital/digit.
    const sentences = text.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim());
    let perDoc = 0;
    for (const s of sentences) {
      if (s.length < 40 || s.length > 400) continue;
      const low = s.toLowerCase();
      const relevant = NUM_RE.test(s) || TIME_RE.test(s) || places.some((p) => low.includes(p)) || kw.some((k) => low.includes(k));
      if (!relevant) continue;
      // Structured sources always carry keywords; for free text require at least a keyword or place to cut boilerplate.
      if (o.kind.startsWith("nimble") && !(places.some((p) => low.includes(p)) || kw.some((k) => low.includes(k)))) continue;
      if (/cookie|subscribe|sign in|privacy policy|advertis|newsletter|all rights reserved|terms of (use|service)/i.test(s)) continue;
      const key = low.replace(/[^a-z0-9]+/g, " ").slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `s${++n}`, text: s, url: o.url, source_id: o.source_id, kind: o.kind, weight: o.weight, fetched_at: o.fetched_at });
      if (++perDoc >= MAX_SNIPPETS_PER_DOC) break;
      if (out.length >= MAX_SNIPPETS_PER_CYCLE) return out;
    }
  }
  return out;
}
