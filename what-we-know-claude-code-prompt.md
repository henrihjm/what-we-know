# Project: What We Know

You are building a hackathon project from scratch today. Read this whole prompt before writing code. Then follow the build order at the end exactly, because a loop must be running on live data within the first 45 minutes and everything after that is improvement while it runs.

## Context

Event: Long Horizon Agents Hackathon (tokens&, AWS Builder Loft, San Francisco, 25 Sep 2026). Hacking ends 16:30 PT, hard deadline. Everything must be written today in this fresh repo. Submission is a public GitHub repo, a 3 minute demo video, a description of what was built and which sponsor tools were used, and team names and emails.

Theme: long-horizon agents break down because they accumulate observations, actions and stale context until the history slows them down, costs more and makes their own state unreliable. The fix is architectural: explicit mutable state instead of an ever-growing history, an agent that edits its own working context, and a clear split between what must persist and what can be discarded.

Judging criteria: Autonomy (acts on the web with real-time data, no manual intervention), Idea (real-world value), Technical implementation (architecture quality), Tool use (at least 3 sponsor tools; we use all of them), Presentation (3 minute demo).

Sponsors: OpenAI, AWS, Liquid AI, Nimble, Tinybird (their product for this event is RawTree), Black Forest Labs (FLUX), Broccoli.

## What we are building

One line: an agent that follows a developing news story for hours, keeps one small "what we know" document instead of a growing transcript, and corrects itself when sources disagree.

Two stories, same code, one config file each:

1. Main: the nor'easter hitting the US Northeast today (Friday 25 Sep) through Saturday. Story id `noreaster`. Strengthening now, worst Friday winds arrive this evening Eastern time, peak Saturday. Sources are scattered (NWS, FAA, transit, utilities, local news) and facts are numeric and get superseded fast (gusts, outages, cancellations, warning levels). Note: the FAA status feed already shows LaGuardia with wind delays right now, so there is live signal from minute one.
2. Second test: the Strait of Hormuz story. Story id `hormuz`. Iran's foreign minister has offered a seven-day proposal to reopen the strait and restart talks with the White House; the US Senate narrowly rejected a war-powers measure; the Houthis claimed strikes on Riyadh and Red Sea oil facilities; Saudi, Turkish and Pakistani military chiefs are meeting on mutual defense. Sources contradict each other, so source weighting matters.

The core object is the ledger: a small JSON document per story (target under 1,500 tokens) that is rewritten every cycle. Raw pages are never kept. The next cycle reads only the ledger.

## Architecture

```
every 5 min ──> PLAN ──> ACT ──> OBSERVE ──> SELF-CORRECT ──> PERSIST ──> RENDER ──> HEAL
                 │        │         │             │              │           │         │
             ledger    Nimble    Liquid         OpenAI        RawTree      FLUX     tickets
             (RawTree) + fixed   small model    big model     (all        (on       (Broccoli
                        sources  triage         merge          events)     major     or file)
                                                                          change)
                                       Bedrock writes the plain-language summary
```

Step by step, one cycle:

1. PLAN. Load the latest ledger for the story from RawTree (fallback: local cache file). Build 3 to 6 search queries: one "latest" query from the story config, one per open question (max 3), one per active claim whose `last_confirmed` is older than its `ttl_minutes` (max 2, oldest first).
2. ACT. Run the queries through Nimble search with `full_content: true`. Poll every fixed source in the story config (NWS, FAA, MBTA, and Nimble extract for pages without an API). Each fetch is wrapped in a timeout (20 s) and try/catch. A failing source never stops the cycle; it increments `fail_count` for that source.
3. OBSERVE. Turn every fetched document into candidate snippets with a heuristic splitter (split into sentences, keep sentences that contain a number, a date/time, a place name from the story config, or a keyword from the story config; cap 40 snippets per document, 300 per cycle). Then the small Liquid model labels every snippet with exactly one of: `new`, `duplicate:<claimId>`, `contradicts:<claimId>`, `irrelevant`. It sees only the compact claim list (id + text) and one snippet at a time. Only `new` and `contradicts` snippets survive.
4. SELF-CORRECT. One call to the big OpenAI model with: the current ledger, the surviving snippets (with source URL, source weight, fetched time), the current time, and the merge rules below. Structured output: the full new ledger plus a `corrections` array. Then one call to Bedrock that rewrites `summary` as three to four plain sentences from the new claims (if Bedrock is not configured, the OpenAI call writes the summary).
5. PERSIST. Insert into RawTree: every observation (url, kind, fetched_at, text length, ok), every triage label, the new ledger version (full JSON plus counts), every correction, token usage per model call, and source health. Save the ledger to the local cache file as well. Then discard all raw text from memory.
6. RENDER. If the cycle produced a major change (a warning level changed, a headline number moved more than 20 percent, or a claim was retracted), generate a situation card image with FLUX: a clean poster with the story title, the time in Eastern, and up to four headline numbers. Save under `out/cards/<story>/<cycle>.jpg` and record the path in RawTree. Rate limit: at most one card per 15 minutes per story.
7. HEAL. If any fixed source has `fail_count >= 3`, write a fix ticket (title, url, last error, the parser file path) to `tickets/<story>-<sourceId>.md` and to RawTree, and mark the source unhealthy so it is polled only every 6th cycle. If Broccoli is configured (env `BROCCOLI_*`), also send the ticket there; otherwise the file is the ticket.

Invariants:

- The ledger has at most 60 active claims. Superseded and retracted claims are removed from the ledger 30 minutes after their status changed; they live on in RawTree.
- Cycle number is `last ledger cycle + 1`. A crashed cycle writes no ledger version, so a restart simply redoes it. Killing the process and restarting must continue from the last ledger in RawTree with no manual step.
- No raw page text ever goes into the ledger or into the next cycle's prompts.
- Every model call logs prompt tokens, completion tokens, model name and milliseconds to RawTree.
- Per cycle budget: if total tokens for the cycle exceed `MAX_TOKENS_PER_CYCLE` (default 60,000), skip the remaining snippets and note it in the cycle log.

## Ledger schema

```json
{
  "story": "noreaster",
  "cycle": 37,
  "updated_at": "2026-09-25T20:05:00Z",
  "summary": "Three to four plain sentences, rewritten every cycle.",
  "claims": [
    {
      "id": "c12",
      "text": "High wind warning in effect for Boston through Saturday 8 PM ET",
      "type": "warning",
      "value": null,
      "unit": null,
      "confidence": 0.9,
      "status": "active",
      "sources": ["https://api.weather.gov/alerts/..."],
      "first_seen": "2026-09-25T18:10:00Z",
      "last_confirmed": "2026-09-25T20:05:00Z",
      "ttl_minutes": 60,
      "supersedes": null
    }
  ],
  "open_questions": ["How many customers are without power in Massachusetts right now?"],
  "sources": [
    {"id": "nws-alerts-MA", "url": "https://api.weather.gov/alerts/active?area=MA", "kind": "nws", "last_ok": "2026-09-25T20:05:00Z", "fail_count": 0, "healthy": true}
  ]
}
```

`type` is one of `warning`, `number`, `event`, `forecast`, `statement`. `status` is one of `active`, `superseded`, `retracted`. For `number` claims, `value` and `unit` are filled so the dashboard can chart them and the render step can detect a 20 percent move.

Default TTLs by type: number 30 min, warning 60 min, event 180 min, forecast 120 min, statement 240 min. Story configs can override.

## Merge rules (put these in the big-model system prompt)

- You maintain a ledger of what is known about one developing story. You receive the current ledger and new evidence. Output the complete new ledger and a list of corrections.
- A claim is a single verifiable statement. Keep claims short. Prefer numbers with units and times in UTC.
- New evidence that confirms an active claim: update `last_confirmed`, raise confidence toward 0.95, add the source if new.
- New evidence that contradicts a claim: if the new source is newer and its weight is equal or higher, create a new claim with `supersedes` set to the old id, mark the old one `superseded`, and add a correction with the reason. If the new source is weaker, keep the old claim, lower its confidence by 0.1 to 0.2, and add the disagreement as an open question.
- A claim contradicted by two independent sources with no confirmation is `retracted`, with a correction.
- Claims past their TTL with no reconfirmation lose 0.1 confidence per cycle; below 0.4 they become `retracted` with a correction "expired without reconfirmation".
- Never keep two active claims that say the same thing. Merge them.
- Open questions are things a reader would ask next that the ledger cannot answer. Keep at most 6. Remove a question once a claim answers it.
- Rewrite the summary from the active claims only. Never include anything that is not in a claim.
- Keep the total ledger under 60 active claims. If over, drop the lowest-confidence `statement` claims first.
- Output JSON only, matching the schema. Corrections: `{claim_id, from_text, to_text, reason, source}`.

Source weights come from the story config (0.0 to 1.0). Default for an unknown domain is 0.5.

## Story configs

`stories/noreaster.json`:

- title: "Nor'easter, US Northeast, 25 to 27 Sep 2026"
- timezone for display: America/New_York
- keywords: nor'easter, noreaster, wind, gust, mph, outage, power, flood, tide, surge, cancel, delay, warning, watch, advisory, closed, evacuat, Logan, JFK, LaGuardia, Newark, MBTA, Amtrak, NJ Transit, Eversource, National Grid, PSEG, Con Edison
- places: Boston, Providence, New York, Long Island, New Jersey, Jersey Shore, Delaware, Maryland, Delmarva, Virginia, Outer Banks, Cape Cod, Nantucket, Connecticut, Rhode Island, Massachusetts
- latest query: "nor'easter Northeast latest"
- seed open questions: current strongest gust and where; customers without power by state; flight cancellations at BOS, JFK, LGA, EWR; active high wind and coastal flood warnings; transit suspensions; injuries or deaths reported
- fixed sources (kind, id, url, parser):
  - nws-alerts: `https://api.weather.gov/alerts/active?area=XX` for MA, RI, CT, NY, NJ, DE, MD, VA, NC. JSON. Set header `User-Agent: what-we-know-hackathon (contact email)`. Extract event, headline, severity, areaDesc, effective, expires.
  - nws-obs: `https://api.weather.gov/stations/KBOS/observations/latest` and KJFK, KLGA, KEWR, KPVD, KPHL. JSON. Extract windSpeed, windGust (convert m/s or km/h to mph), timestamp.
  - faa-status: `https://nasstatus.faa.gov/api/airport-status-information`. XML. Parse with fast-xml-parser. Extract ground delay programs, general delays, closures per airport. Verified working at 12:00 PT today and already showing LGA wind delays.
  - mbta-alerts: `https://api-v3.mbta.com/alerts?filter[activity]=BOARD,EXIT,RIDE`. JSON, no key needed for low volume. Extract header, effect, severity, active_period.
  - nimble-extract pages (render: true): PowerOutage.us state pages for MA, RI, CT, NY, NJ; FlightAware cancellations page `https://www.flightaware.com/live/cancelled/`; weather.com nor'easter coverage; Boston Globe, NBC Boston, NY1, NJ.com storm pages. Put the exact URLs in the config; if one is unknown, find it with a Nimble search at startup and cache it in the config's `resolved` field.
- source weights: api.weather.gov 1.0, nasstatus.faa.gov 1.0, api-v3.mbta.com 0.95, poweroutage.us 0.9, flightaware.com 0.85, weather.com 0.8, bostonglobe.com 0.8, nbcboston.com 0.75, ny1.com 0.75, nj.com 0.7, everything else 0.5, social 0.3

`stories/hormuz.json`:

- title: "Strait of Hormuz proposal and regional escalation, Sep 2026"
- keywords: Hormuz, Iran, Araghchi, ceasefire, proposal, seven-day, talks, White House, Senate, war powers, Houthi, Riyadh, Aramco, tanker, strait, Saudi, Pakistan, Turkey, Netanyahu, sanctions, oil, Brent
- places: Tehran, Riyadh, Washington, Jeddah, Muscat, Doha, Bandar Abbas, Red Sea, Gulf of Oman
- latest query: "Strait of Hormuz Iran proposal latest"
- seed open questions: has the White House responded to the seven-day proposal; is shipping moving through the strait; confirmed damage from Houthi strikes; outcome of the Saudi, Turkey, Pakistan meeting; Brent crude move today
- fixed sources via Nimble extract: Reuters world page, AP top news, Al Jazeera Middle East, Times of Israel liveblog for today, Just Security Early Edition, IRNA English, Press TV, Saudi Press Agency English, White House briefing room, Defense.gov news. Plus Nimble search each cycle.
- source weights: reuters.com 1.0, apnews.com 1.0, defense.gov 0.95, whitehouse.gov 0.95, aljazeera.com 0.85, timesofisrael.com 0.75, justsecurity.org 0.8, irna.ir 0.6, presstv.ir 0.5, spa.gov.sa 0.7, everything else 0.5, social 0.25
- TTL overrides: statement 360 min, event 240 min

## Sponsor integrations (each must do real work; log which model or service handled each step)

**Nimble** (`npm install @nimble-way/nimble-js`, env `NIMBLE_API_KEY`).
`const nimble = new Nimble({ apiKey })`. Search: `nimble.search({ query, country: "US", search_depth: "standard", full_content: true })`. Page extract: `nimble.extract.run({ url, render: true })` returns a task id; poll until the result is ready and take the markdown or text. Wrap both in a small client with retries, a 20 s timeout and concurrency 4 (rate limits are unknown; back off on 429). Every Nimble call is logged as an observation with kind `nimble-search` or `nimble-extract`. Also install their MCP server or agent-skills only if it costs no time; the SDK is enough.

**Tinybird / RawTree** (env `RAWTREE_API_KEY`, optional `RAWTREE_DATABASE`). Use plain HTTP, no SDK needed.
Insert: `POST https://api.rawtree.com/v1/tables/{tableName}` with `Authorization: Bearer $RAWTREE_API_KEY`, `Content-Type: application/json`, body is a JSON array of objects. Tables are created on first insert, no schema. Add header `x-rawtree-database: <name>` if `RAWTREE_DATABASE` is set.
Query: `POST https://api.rawtree.com/v1/query` with the same auth and body `{"sql":"SELECT ..."}`. Read-only SQL. No parameters: build the SQL string yourself and only ever interpolate values from an allowlist (story ids, table names). Nested fields use dot notation; cast with `::Float64` where needed. Always use LIMIT and time windows.
Tables: `observations`, `triage`, `ledger_versions`, `corrections`, `tokens`, `source_health`, `cards`, `tickets`, `cycles`. Every row carries `story`, `cycle`, `ts` (ISO UTC).
Loading the latest ledger: `SELECT json FROM ledger_versions WHERE story = 'noreaster' ORDER BY cycle DESC LIMIT 1`. Keep a local cache at `state/<story>.json` and prefer RawTree when it answers.

**Liquid AI** (triage model). Implement `TriageModel` behind an OpenAI-compatible chat client with a configurable base URL, so the same code runs against Ollama locally (`http://localhost:11434/v1`) or OpenRouter (`https://openrouter.ai/api/v1`, env `OPENROUTER_API_KEY`). Env `TRIAGE_BASE_URL`, `TRIAGE_MODEL`, `TRIAGE_API_KEY`. Model identifiers to try: on Hugging Face the family is `LiquidAI/LFM2.5-1.2B-Instruct` (also 350M, 2.6B); on Ollama check `ollama list` and the Ollama library for the lfm2.5 tag; on OpenRouter check `https://openrouter.ai/liquid` for the exact id. Write `scripts/check-env.ts` so it prints which triage backend answered. The triage prompt must be tiny: system prompt with the label rules, user message with the compact claim list and one snippet, and the model must answer with one line. Parse leniently (regex for `new|duplicate:c\d+|contradicts:c\d+|irrelevant`). Run snippets with concurrency 8. If the triage backend is down, fall back to the OpenAI mini-class model and print a loud warning; never stop the loop. Log the model name on every triage row so the demo can show the count of snippets handled by the Liquid model.

**OpenAI** (merge model, env `OPENAI_API_KEY`, `OPENAI_MODEL`). Use the official `openai` package with structured outputs (JSON schema for the ledger plus corrections). Default `OPENAI_MODEL` to the newest general model the key can access; `scripts/check-env.ts` lists available models and picks a sensible default if the env is empty. Temperature low. One call per cycle. Retry once on schema failure with the validation error appended.

**AWS** (env `AWS_REGION`, standard AWS credentials, `BEDROCK_MODEL_ID`). Use `@aws-sdk/client-bedrock-runtime` Converse API to rewrite `summary` from the active claims. If credentials are missing, skip and let OpenAI write the summary; log which one did it. Add a `Dockerfile` and `deploy/ec2.md` with the exact commands to run the loop on a small EC2 instance (install Node, clone, `.env`, `npm run loop` under `nohup` or a systemd unit). The goal is that the loop can run on AWS from mid-afternoon while laptops are used for the dashboard and demo.

**Black Forest Labs** (env `BFL_API_KEY`). `POST https://api.bfl.ai/v1/flux-2-pro-preview` with header `x-key`, body `{prompt, width: 1024, height: 1024}` (a 3:2 card like 1536x1024 is fine if allowed). The response has `id` and `polling_url`; poll `polling_url` with the same header every 2 s until `status` is `Ready`, then download `result.sample` immediately (signed URLs expire in 10 minutes). Prompt template: "Minimal news situation card, flat design, large legible text. Title: {title}. Time: {time ET}. Numbers: {up to four short number lines}. No people, no logos." Save the JPG locally and insert a `cards` row with the path and the numbers used. Stretch goal only if everything else is done: one short FLUX video recap at the end of the day.

**Broccoli**. Unverified sponsor. Implement `src/heal/tickets.ts` that writes a markdown ticket file and a RawTree row. If `BROCCOLI_API_URL` and `BROCCOLI_API_KEY` exist, POST the ticket there in a try/catch; otherwise do nothing more. The README states that tickets are the hand-off point for a coding agent to fix a broken parser.

## Repo layout

```
what-we-know/
  README.md
  .env.example
  package.json            # type: module, scripts below
  tsconfig.json
  Dockerfile
  deploy/ec2.md
  stories/noreaster.json
  stories/hormuz.json
  src/
    config.ts             # env + story config loading, zod validated
    types.ts              # Ledger, Claim, Snippet, Observation, Correction
    cycle.ts              # runs one cycle: plan, act, observe, correct, persist, render, heal
    run.ts                # loop: per-story lock file, interval, graceful SIGINT, status line per cycle
    plan.ts
    act/
      nimble.ts           # search + extract client with timeout and retries
      fixed/
        nws.ts            # alerts + observations
        faa.ts            # XML status
        mbta.ts
        page.ts           # generic Nimble extract
      index.ts            # runs all fixed sources for a story, never throws
    observe/
      split.ts            # heuristic snippet splitter
      triage.ts           # Liquid model labeling
    correct/
      merge.ts            # OpenAI structured merge
      summary.ts          # Bedrock summary rewrite with OpenAI fallback
      prompts.ts
    persist/
      rawtree.ts          # insert + query helpers
      state.ts            # load/save latest ledger (RawTree first, local cache second)
    render/
      flux.ts             # situation card
    heal/
      tickets.ts
    dashboard/
      server.ts           # Hono or Express; serves index.html and /api/* that query RawTree
      index.html          # single page, auto-refresh 30 s, story switcher
  scripts/
    check-env.ts          # one real call per sponsor, prints a pass/fail table
    demo-stats.ts         # prints the headline numbers for the pitch
  fixtures/               # saved sample responses for --dry-run
  state/                  # local ledger cache (gitignored)
  out/cards/              # generated cards (gitignored)
  tickets/                # generated tickets (committed, they are part of the story)
```

Scripts in package.json:

- `check-env`: `tsx scripts/check-env.ts`
- `cycle`: `tsx src/run.ts --once --story noreaster`
- `loop`: `tsx src/run.ts --story noreaster --interval 300`
- `loop:hormuz`: `tsx src/run.ts --story hormuz --interval 300`
- `dashboard`: `tsx src/dashboard/server.ts` (port 3000)
- `demo-stats`: `tsx scripts/demo-stats.ts --story noreaster`
- `dry`: `tsx src/run.ts --once --story noreaster --dry-run` (fixtures only, no network, no model calls beyond a stub; used to develop without spending credits)

Stack: Node 20+, TypeScript, tsx, zod, openai, @nimble-way/nimble-js, @aws-sdk/client-bedrock-runtime, fast-xml-parser, hono (or express), dotenv. Keep dependencies minimal. No database other than RawTree. No framework for the dashboard: one HTML file with fetch calls and Chart.js from a CDN.

## Dashboard (one page)

Top: story switcher, cycle number, "running since", cycles completed, last cycle duration.
Left: summary; claims table sorted by confidence with type, value, last confirmed (relative time), source count; open questions.
Right: corrections feed (newest first, with reason and source); two charts: cumulative observations vs active claims per cycle (this is the picture of the whole idea: one line climbs, the other stays flat), and tokens per cycle by model; source health grid; latest situation card.
Bottom: sponsor strip listing which service handled which step, with live counts (snippets triaged by Liquid, merges by OpenAI, summaries by Bedrock, pages by Nimble, rows in RawTree, cards by FLUX, tickets written).

All numbers come from RawTree SQL through `/api/*` routes. Never expose keys to the browser.

## Demo helpers

`scripts/demo-stats.ts` prints: running since, cycles, observations, snippets triaged and by which model, active claims now, corrections count with the three most recent, tokens per cycle (median), ledger size in tokens (median), sources healthy/unhealthy, cards generated.

Kill-and-restart check: document in the README how to `kill` the loop and start it again, and show in the log that it resumes at `cycle N+1` from the RawTree ledger.

## Build order (follow this, and keep the loop running once it starts)

Phase 0 (15 min). Scaffold the repo, `.env.example` with every variable above, `scripts/check-env.ts` that makes one real call per sponsor and prints a table. Stop and report which keys are missing. Do not wait for missing keys; every integration must degrade gracefully.

Phase 1 (30 min, target: loop running by 12:45 PT). Types and story configs. Fixed sources for the nor'easter: NWS alerts, NWS observations, FAA XML, MBTA. Nimble search and extract. Snippet splitter. Big-model merge with structured output. RawTree persist and state load. `run.ts` loop with lock file and status line. Run `npm run cycle` once, inspect the ledger, fix obvious problems, then start `npm run loop` in a separate terminal and leave it running for the rest of the day. From here on, new features are added behind flags and tested with `--once --story noreaster --sandbox`, which reads the real ledger but writes every row under story `noreaster-sandbox` and never advances the main ledger, so the running loop is never broken; when a feature is ready, restart the loop once.

Phase 2 (45 min). Liquid triage in front of the merge. Source health and fail counts. Corrections table. Token logging. Bedrock summary.

Phase 3 (45 min). Dashboard with the two charts and the corrections feed. `demo-stats.ts`.

Phase 4 (45 min). Hormuz story config, run it in a second loop. FLUX situation card on major change. Dockerfile and `deploy/ec2.md`; deploy the nor'easter loop to EC2 if credentials exist.

Phase 5 (30 min). Tickets and heal step. Kill-and-restart test, documented. Trim ledger size if it drifts above 1,500 tokens.

Phase 6 (30 min, must start by 15:45 PT). README: what it is, the architecture diagram, how each sponsor tool is used with the live counts from `demo-stats`, how to run, team. Commit everything. Make sure `.env` is gitignored and no key is in the repo.

## Working rules

- Small commits with clear messages. Commit after every phase at minimum.
- Never write raw page text into the ledger, the prompts of later cycles, or git.
- Every external call has a timeout and is wrapped so a failure is logged and skipped.
- Print one status line per cycle: `cycle 37 | obs 48 | snippets 212 | triage new 9 contradict 2 | claims 41 active | corrections 1 | tokens 18,400 | 41 s`.
- If something in this prompt turns out to be wrong about an API, check the official docs, fix it, and note the fix in the README. Do not stall.
- Ask me only if a decision would cost more than 15 minutes to reverse. Otherwise choose the simplest option and continue.

Start with Phase 0 now.
