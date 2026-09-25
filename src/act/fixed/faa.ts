import { XMLParser } from "fast-xml-parser";
import { fetchWithTimeout } from "../../util.js";

const AIRPORTS = new Set(["BOS", "JFK", "LGA", "EWR", "PVD", "PHL", "BDL", "DCA", "IAD", "BWI", "TEB", "HPN", "ISP", "ACK", "ORH", "MHT"]);

/** FAA NAS status XML -> one line per airport event (ground stop, ground delay, delay, closure). */
export async function fetchFaaStatus(url: string): Promise<string> {
  const r = await fetchWithTimeout(url, { headers: { Accept: "application/xml,text/xml" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => ["Delay_type", "Ground_Stop", "Ground_Delay", "Arrival_Departure", "Airport", "Airport_Closure", "Program"].includes(name) });
  const doc = parser.parse(xml);
  const lines: string[] = [];
  const updated = doc?.AIRPORT_STATUS_INFORMATION?.Update_Time ?? "";
  const dts = doc?.AIRPORT_STATUS_INFORMATION?.Delay_type ?? [];
  const walk = (node: any, path: string[] = []) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, path));
    const arpt = node.ARPT ?? node.Airport ?? node.Arpt;
    if (typeof arpt === "string") {
      const code = arpt.toUpperCase();
      const reason = node.Reason ?? node.Reason_Text ?? "";
      const avg = node.Avg ?? node.Average ?? "";
      const min = node.Min ?? "";
      const max = node.Max ?? "";
      const end = node.End_Time ?? node.End ?? "";
      const type = node.Type ?? path.filter((p) => /Ground|Delay|Closure|Program|Arrival|Departure/.test(p)).join("/");
      const joined = path.join("/"); const kind = /Ground_Stop/.test(joined) ? "ground stop" : /Ground_Delay/.test(joined) ? "ground delay program" : /Closure/.test(joined) ? "closure" : "delay";
      const detail = [type && `type ${type}`, avg && `average ${avg}`, min && max && `range ${min} to ${max}`, end && `until ${end}`, reason && `reason: ${reason}`].filter(Boolean).join(", ");
      const hit = AIRPORTS.has(code);
      if (hit) lines.push(`FAA: ${code} ${kind} as of ${updated}: ${detail}.`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(dts);
  if (!lines.length) return `FAA NAS status as of ${updated}: no delays, ground stops or closures reported at Northeast airports (BOS, JFK, LGA, EWR, PVD, PHL).`;
  return lines.join("\n");
}
