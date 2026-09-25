/**
 * Loop runner. Per-story lock file, fixed interval, graceful SIGINT, one status line per cycle.
 * Restart continues from the last ledger in RawTree (or the local cache) with no manual step.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, loadStory, env } from "./config.js";
import { runCycle } from "./cycle.js";
import { rawtreeInsertSafe, rawtreeEnabled } from "./persist/rawtree.js";
import { log, warn, errMsg, sleep, nowIso } from "./util.js";

const args = parseArgs();
const story = loadStory(args.story);
const storyKey = args.sandbox ? `${story.id}-sandbox` : args.dryRun ? `${story.id}-dry` : story.id;
const lockPath = resolve(process.cwd(), "state", `${storyKey}.lock`);

function acquireLock() {
  mkdirSync(resolve(process.cwd(), "state"), { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) {
      console.error(`another loop for ${storyKey} is running (pid ${pid}); remove ${lockPath} if that is stale`);
      process.exit(2);
    }
    warn(`stale lock from pid ${pid}; taking over`);
  }
  writeFileSync(lockPath, String(process.pid));
}
function releaseLock() {
  try {
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  } catch {}
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  log("SIGINT: finishing current cycle, then exiting (press again to force)");
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  acquireLock();
  const startedAt = nowIso();
  log(`what-we-know | story ${storyKey} | ${args.once ? "once" : `every ${args.interval} s`}${args.dryRun ? " | DRY RUN (fixtures, stub models)" : ""}${args.sandbox ? " | SANDBOX (writes under " + storyKey + ")" : ""}`);
  log(`openai ${env.OPENAI_API_KEY ? "on" : "OFF"} | nimble ${env.NIMBLE_API_KEY ? "on" : "OFF"} | rawtree ${rawtreeEnabled() ? "on" : "OFF"} | bedrock ${env.BEDROCK_MODEL_ID ? "on" : "OFF"} | flux ${env.BFL_API_KEY ? "on" : "OFF"}`);
  let cycles = 0;
  try {
    while (!stopping) {
      const t0 = Date.now();
      try {
        await runCycle(story, { dryRun: args.dryRun, sandbox: args.sandbox });
        cycles++;
      } catch (e) {
        warn(`cycle crashed (no ledger version written, will be redone): ${errMsg(e)}`);
        if (!args.dryRun) await rawtreeInsertSafe("cycles", [{ story: storyKey, cycle: -1, ts: nowIso(), error: errMsg(e).slice(0, 500), ms: Date.now() - t0 }]);
      }
      if (args.once) break;
      const wait = Math.max(5000, args.interval * 1000 - (Date.now() - t0));
      log(`next cycle in ${Math.round(wait / 1000)} s (running since ${startedAt}, ${cycles} cycles)`);
      for (let w = 0; w < wait && !stopping; w += 1000) await sleep(1000);
    }
  } finally {
    releaseLock();
    log(`stopped after ${cycles} cycles`);
  }
}
main();
