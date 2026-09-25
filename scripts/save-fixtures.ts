/** Fetch every non-Nimble fixed source once and save the parsed text under fixtures/<story>/ for --dry-run. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadStory } from "../src/config.js";
import { runFixedSource } from "../src/act/fixed/index.js";

const id = process.argv[2] || "noreaster";
const story = loadStory(id);
const dir = resolve("fixtures", id);
mkdirSync(dir, { recursive: true });
for (const s of story.fixed_sources.filter((s) => s.kind !== "nimble-extract")) {
  const o = await runFixedSource(story, s);
  if (o.ok) writeFileSync(resolve(dir, `${s.id}.txt`), o.text);
  console.log(`${o.ok ? "ok  " : "FAIL"} ${s.id} ${o.ok ? o.text.length + " chars" : o.error}`);
}
