import { fetchWithTimeout } from "../../util.js";

/** MBTA v3 alerts -> one line per alert with header, effect, severity, active period. */
export async function fetchMbtaAlerts(url: string): Promise<string> {
  const r = await fetchWithTimeout(url, { headers: { Accept: "application/vnd.api+json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ attributes: Record<string, any> }> };
  const lines = (j.data ?? [])
    .map((a) => a.attributes)
    .filter((a) => a.severity >= 3 || /storm|wind|weather|suspend|flood/i.test(`${a.header} ${a.cause}`))
    .slice(0, 60)
    .map((a) => {
      const ap = a.active_period?.[0] ?? {};
      return `MBTA alert: ${a.header} | effect ${a.effect} | severity ${a.severity} | cause ${a.cause} | active ${ap.start ?? "?"} to ${ap.end ?? "ongoing"}.`;
    });
  return lines.length ? lines.join("\n") : "MBTA: no weather-related or severe service alerts currently active.";
}
