import { env } from "../../config.js";
import { fetchWithTimeout } from "../../util.js";

const headers = () => ({ "User-Agent": `what-we-know-hackathon (${env.CONTACT_EMAIL})`, Accept: "application/geo+json, application/json" });

/** NWS active alerts -> one line per alert. */
export async function fetchNwsAlerts(url: string): Promise<string> {
  const r = await fetchWithTimeout(url, { headers: headers() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { features?: Array<{ properties: Record<string, unknown> }> };
  const area = new URL(url).searchParams.get("area") ?? "";
  const lines = (j.features ?? []).map((f) => {
    const p = f.properties;
    return `NWS alert (${area}): ${p.event} | severity ${p.severity} | ${p.headline ?? ""} | areas: ${String(p.areaDesc ?? "").slice(0, 160)} | effective ${p.effective} | expires ${p.expires}.`;
  });
  return lines.length ? lines.join("\n") : `NWS alerts (${area}): no active alerts at this time.`;
}

const toMph = (v: number | null | undefined, unit: string | undefined): number | null => {
  if (v == null) return null;
  if (!unit) return Math.round(v);
  if (/km_h-1|km\/h/.test(unit)) return Math.round(v * 0.621371);
  if (/m_s-1|m\/s/.test(unit)) return Math.round(v * 2.23694);
  if (/mph|mi_h/.test(unit)) return Math.round(v);
  return Math.round(v);
};

/** NWS latest station observation -> one line with wind speed/gust in mph. */
export async function fetchNwsObs(url: string): Promise<string> {
  const r = await fetchWithTimeout(url, { headers: headers() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { properties: Record<string, any> };
  const p = j.properties;
  const station = url.match(/stations\/([A-Z0-9]+)/)?.[1] ?? "?";
  const wind = toMph(p.windSpeed?.value, p.windSpeed?.unitCode);
  const gust = toMph(p.windGust?.value, p.windGust?.unitCode);
  const pressure = p.barometricPressure?.value != null ? Math.round(p.barometricPressure.value / 100) : null;
  const desc = p.textDescription ?? "";
  const gustPart = gust != null ? `gust ${gust} mph` : "no gust reported in this observation (steady wind)";
  const windPart = wind != null ? `sustained wind ${wind} mph` : "wind not reported";
  return `NWS observation at ${station} at ${p.timestamp}: ${windPart}, ${gustPart}, pressure ${pressure ?? "unknown"} hPa, ${desc}.`;
}
