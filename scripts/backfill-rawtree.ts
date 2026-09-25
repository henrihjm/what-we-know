/** Push rows from the local JSONL store into RawTree (used once after RawTree was configured mid-run). */
import "dotenv/config";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { localRead } from "../src/persist/local.js";
import { rawtreeInsert, TABLES, type TableName } from "../src/persist/rawtree.js";

const root = resolve("state", "events");
for (const story of readdirSync(root)) {
  for (const t of TABLES) {
    const rows = localRead(t as TableName, story);
    if (!rows.length) continue;
    for (let i = 0; i < rows.length; i += 500) await rawtreeInsert(t as TableName, rows.slice(i, i + 500));
    console.log(`${story}/${t}: ${rows.length} rows`);
  }
}
