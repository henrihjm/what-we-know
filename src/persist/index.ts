/** Persist rows to the local JSONL store always, and to RawTree when configured. Never throws. */
import { rawtreeInsertSafe, type TableName } from "./rawtree.js";
import { localAppend } from "./local.js";
import { warn, errMsg } from "../util.js";

export async function persistRows(table: TableName, story: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  try {
    localAppend(table, story, rows);
  } catch (e) {
    warn(`local append ${table} failed: ${errMsg(e)}`);
  }
  await rawtreeInsertSafe(table, rows);
}
