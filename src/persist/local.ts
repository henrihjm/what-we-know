/**
 * Local JSONL event store: the same rows that go to RawTree are appended under state/events/<story>/<table>.jsonl.
 * It is the fallback data source for the dashboard and demo-stats when RawTree is not configured.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TableName } from "./rawtree.js";

const root = resolve(process.cwd(), "state", "events");
const safe = (s: string) => s.replace(/[^a-z0-9_-]/gi, "");

export function localAppend(table: TableName, story: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const dir = resolve(root, safe(story));
  mkdirSync(dir, { recursive: true });
  appendFileSync(resolve(dir, `${safe(table)}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function localRead<T = Record<string, unknown>>(table: TableName, story: string): T[] {
  const p = resolve(root, safe(story), `${safe(table)}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}
