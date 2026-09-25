# Fix source ny1 for story noreaster

- **Story:** noreaster
- **Source id:** ny1
- **Kind:** nimble-extract
- **URL:** https://ny1.com/nyc/all-boroughs/weather
- **Parser:** `src/act/fixed/page.ts`
- **Consecutive failures:** 3
- **Last error:** ny1 timed out after 25000 ms
- **Opened / last updated:** 2026-09-25T22:56:39.000Z (cycle 15)

## Task for the coding agent

The loop marked this source unhealthy and now polls it only every 6th cycle. Open the parser file above, reproduce the fetch
against the URL, fix the parsing or the URL, run `npm run sandbox` to confirm the source returns ok, then restart the loop.
When the source succeeds again the loop resets fail_count and marks it healthy automatically.
