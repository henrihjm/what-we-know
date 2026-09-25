# Fix source nj-com for story noreaster

- **Story:** noreaster
- **Source id:** nj-com
- **Kind:** nimble-extract
- **URL:** https://www.nj.com/weather/
- **Parser:** `src/act/fixed/page.ts`
- **Consecutive failures:** 3
- **Last error:** nj-com timed out after 25000 ms
- **Opened / last updated:** 2026-09-25T22:32:59.746Z (cycle 11)

## Task for the coding agent

The loop marked this source unhealthy and now polls it only every 6th cycle. Open the parser file above, reproduce the fetch
against the URL, fix the parsing or the URL, run `npm run sandbox` to confirm the source returns ok, then restart the loop.
When the source succeeds again the loop resets fail_count and marks it healthy automatically.
