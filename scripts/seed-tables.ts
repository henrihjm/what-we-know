/** Create the rarely-written RawTree tables (cards, tickets) with one seed row so dashboard queries never hit "Table not found". */
import "dotenv/config";
import { rawtreeInsert } from "../src/persist/rawtree.js";
const ts = new Date().toISOString();
await rawtreeInsert("cards", [{ story: "seed", cycle: 0, ts, path: "", model: "", ms: 0, reason: "table seed", numbers: "", prompt: "" }]);
await rawtreeInsert("tickets", [{ story: "seed", cycle: 0, ts, source_id: "", title: "table seed", url: "", last_error: "", parser: "", fail_count: 0, path: "", broccoli: "", fresh: false }]);
console.log("seeded cards + tickets");
