/**
 * Tinybird RawTree client over plain HTTP.
 * Insert: POST {base}/v1/tables/{table}  body = JSON array. Tables are created on first insert.
 * Query:  POST {base}/v1/query           body = {"sql": "..."}  (read-only)
 * Database scoping: the official SDK/MCP send ?database=<name> as a query parameter. We send both
 * the query parameter and the x-rawtree-database header so either server variant is satisfied.
 */
import { env } from "../config.js";
import { fetchWithTimeout, errMsg, warn } from "../util.js";

export const TABLES = ["observations", "triage", "ledger_versions", "corrections", "tokens", "source_health", "cards", "tickets", "cycles", "healthchecks"] as const;
export type TableName = (typeof TABLES)[number];

let insertedRows = 0;
export const rawtreeRowsInserted = () => insertedRows;
export const rawtreeEnabled = () => Boolean(env.RAWTREE_API_KEY);

function url(path: string) {
  const u = new URL(path, env.RAWTREE_BASE_URL);
  if (env.RAWTREE_DATABASE) u.searchParams.set("database", env.RAWTREE_DATABASE);
  return u.toString();
}
function headers() {
  const h: Record<string, string> = {
    Authorization: `Bearer ${env.RAWTREE_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.RAWTREE_DATABASE) h["x-rawtree-database"] = env.RAWTREE_DATABASE;
  return h;
}

export async function rawtreeInsert(table: TableName, rows: Record<string, unknown>[]): Promise<number> {
  if (!rows.length) return 0;
  if (!TABLES.includes(table)) throw new Error(`table not allowlisted: ${table}`);
  if (!rawtreeEnabled()) return 0;
  const r = await fetchWithTimeout(url(`/v1/tables/${table}`), { method: "POST", headers: headers(), body: JSON.stringify(rows) }, 20000);
  if (!r.ok) throw new Error(`rawtree insert ${table} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  insertedRows += rows.length;
  return rows.length;
}

/** Insert that never throws; logs and returns 0 on failure. */
export async function rawtreeInsertSafe(table: TableName, rows: Record<string, unknown>[]): Promise<number> {
  try {
    return await rawtreeInsert(table, rows);
  } catch (e) {
    warn(`rawtree insert ${table} failed: ${errMsg(e)}`);
    return 0;
  }
}

/** Read-only SQL. Only interpolate allowlisted values (story ids, table names) into sql. */
export async function rawtreeQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  if (!rawtreeEnabled()) return [];
  const r = await fetchWithTimeout(url("/v1/query"), { method: "POST", headers: headers(), body: JSON.stringify({ sql }) }, 20000);
  if (!r.ok) throw new Error(`rawtree query HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { data?: T[]; rows?: T[] | number };
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.rows)) return j.rows;
  return [];
}

/** Safe story id for SQL. */
export function sqlStory(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad story id ${id}`);
  return `'${id}'`;
}
