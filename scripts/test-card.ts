/** Generate one FLUX situation card from the current ledger, outside the loop (for verifying the BFL key and for the demo). */
import "dotenv/config";
import { parseArgs, loadStory } from "../src/config.js";
import { loadLedger } from "../src/persist/state.js";
import { generateCard, cardPrompt } from "../src/render/flux.js";
import { headlineNumbers } from "../src/cycle.js";
import { persistRows } from "../src/persist/index.js";
import { fmtEastern } from "../src/util.js";

const { story: id } = parseArgs();
const story = loadStory(id);
const { ledger } = await loadLedger(story);
const numbers = headlineNumbers(ledger);
const prompt = cardPrompt(story.title, fmtEastern(new Date(), story.timezone), numbers);
console.log("prompt:", prompt);
const c = await generateCard(id, ledger.cycle, prompt);
console.log(`card: ${c.path} (${c.model}, ${c.ms} ms)`);
await persistRows("cards", id, [{ story: id, cycle: ledger.cycle, ts: new Date().toISOString(), path: c.path, model: c.model, ms: c.ms, reason: "manual test-card", numbers: numbers.join(" | "), prompt }]);
