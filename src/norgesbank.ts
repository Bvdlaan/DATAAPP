// Norges Bank (Norway's central bank) open data, SDMX REST API, exposed to the model as tools.
// Base: https://data.norges-bank.no/api  (query builder: https://query.norges-bank.no/en). No key.
// Data: GET /data/{flow}/{key}?format=sdmx-json&startPeriod=&endPeriod=&lastNObservations=&locale=en
// Key = dimension codes joined by "." in the flow's dimension order; "+" = several codes, empty = all.
// Exchange rates are NOK per 1 or per 100 units of the foreign currency (attribute UNIT_MULT).

import { flattenSdmx, sdmxDimensions } from "./sdmx.js";

const ROOT = (process.env.NORGESBANK_API_BASE ?? "https://data.norges-bank.no/api").replace(/\/+$/, "");
const MAX_OBS_PER_SERIES = 60;
const MAX_SERIES = 30;

// Datasets worth offering in a chat. Large transaction-level flows (MONEY_MARKET, GOVT_IRS, CBC_*, ...) are left out.
export const FLOWS: Record<string, string> = {
  EXR: "Exchange rates: NOK per unit of foreign currency (key FREQ.BASE_CUR.QUOTE_CUR.TENOR, e.g. B.EUR+USD.NOK.SP; BASE_CUR TWI/I44 = krone indices)",
  IR: "Policy rate and related key rates (key FREQ.INSTRUMENT_TYPE.TENOR.UNIT_MEASURE, e.g. B.KPRA.SD.R; TENOR SD policy rate, RR reserve rate, OL overnight lending rate)",
  SHORT_RATES: "NOWA (Norwegian Overnight Weighted Average) and NOWA averages (key FREQ.INSTRUMENT_TYPE.TENOR.UNIT_MEASURE, e.g. B.NOWA.ON.R)",
  GOVT_GENERIC_RATES: "Norwegian government bond and treasury bill generic yields (key FREQ.TENOR.INSTRUMENT_TYPE, e.g. B.10Y.GBON)",
  GOVT_ZEROCOUPON: "Norwegian government zero-coupon yields by maturity (key FREQ.TENOR, e.g. B.10Y)",
  GOVT_KEYFIGURES: "Key government debt figures",
  FINANCIAL_INDICATORS: "Financial indicators",
  REGNET: "Regional Network survey (business conditions by region and sector)",
};

const cache = new Map<string, { until: number; data: unknown }>();

async function nbFetch(path: string, ttl = 10 * 60_000): Promise<any> {
  const url = `${ROOT}${path}`;
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/vnd.sdmx.data+json, application/json" } });
  const text = await res.text();
  if (res.status === 404 || /NoRecordsFound|No Results Found/i.test(text.slice(0, 300))) return null;
  if (!res.ok) throw new Error(`Norges Bank ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  cache.set(url, { until: Date.now() + ttl, data });
  return data;
}

function checkFlow(flow: string) {
  const f = String(flow ?? "").trim().toUpperCase();
  if (!FLOWS[f]) throw new Error(`Unknown or unsupported Norges Bank dataset '${flow}'. Use one of: ${Object.keys(FLOWS).join(", ")}.`);
  return f;
}

/** SDMX-JSON data message -> one readable object per series (dimension labels, attributes, unit, values). */
function flatten(json: any, maxObs = MAX_OBS_PER_SERIES) {
  const all = flattenSdmx(json, { maxObs });
  const series = all.map((s) => {
    const out: Record<string, unknown> = { key: s.key, ...s.dimensions, ...s.attributes };
    const cur = s.key.split(".")[Object.keys(s.dimensions).indexOf("BASE_CUR")];
    if ("BASE_CUR" in s.dimensions && s.attributes.UNIT_MULT) out.unit = `NOK per ${s.attributes.UNIT_MULT === "Hundreds" ? 100 : 1} ${cur}`;
    out.observations = s.observations;
    if (s.totalObservations > maxObs) out.note = `Showing the latest ${maxObs} of ${s.totalObservations} values; ask for a shorter period or a lower frequency (M or A).`;
    return out;
  });
  return { series: series.slice(0, MAX_SERIES), totalSeries: series.length };
}

export async function getStructure(flow: string) {
  const f = checkFlow(flow);
  // The latest value of every series is small for these flows and shows which code combinations really exist.
  const json = await nbFetch(`/data/${f}/?format=sdmx-json&lastNObservations=1&locale=en`, 12 * 3600_000);
  const dims = sdmxDimensions(json);
  if (!dims.length) throw new Error(`No structure returned for ${f}.`);
  const { series, totalSeries } = flatten(json, 1);
  return {
    dataset: f,
    description: FLOWS[f],
    keyOrder: dims.map((d) => d.id).join("."),
    dimensions: dims,
    seriesCount: totalSeries,
    exampleSeries: series.slice(0, 15).map((s) => ({ key: s.key, latest: (s.observations as any[])[0], ...(s.unit ? { unit: s.unit } : {}) })),
  };
}

export async function getData(flow: string, key = "", startPeriod?: string, endPeriod?: string, lastN?: number) {
  const f = checkFlow(flow);
  const k = String(key ?? "").trim().replace(/\s+/g, "");
  if (k && !/^[A-Za-z0-9_+.\-]*$/.test(k)) throw new Error("Key may only contain codes, '.', '+' and '_'.");
  const params = new URLSearchParams({ format: "sdmx-json", locale: "en" });
  if (startPeriod) params.set("startPeriod", startPeriod);
  if (endPeriod) params.set("endPeriod", endPeriod);
  if (!startPeriod && !endPeriod) params.set("lastNObservations", String(Math.min(Math.max(Number(lastN) || 1, 1), MAX_OBS_PER_SERIES)));
  else if (lastN) params.set("lastNObservations", String(Math.min(Number(lastN), MAX_OBS_PER_SERIES)));

  const json = await nbFetch(`/data/${f}/${k}?${params}`);
  if (!json) return { dataset: f, key: k, series: [], note: "No data for this key and period. Check the key with norgesbank_get_structure." };
  const { series, totalSeries } = flatten(json);
  return {
    source: "Norges Bank",
    dataset: f,
    key: k,
    ...(totalSeries > MAX_SERIES ? { note: `Showing ${MAX_SERIES} of ${totalSeries} series; narrow the key.` } : {}),
    series,
  };
}

// ---- Tool definitions for Mistral function calling ----

export const norgesbankTools = [
  {
    type: "function" as const,
    function: {
      name: "norgesbank_get_structure",
      description:
        "Show a Norges Bank (Norway's central bank) dataset's dimensions, valid codes, key order and example series with " +
        "their latest values. Datasets: " + Object.entries(FLOWS).map(([id, d]) => `${id}: ${d}`).join("; ") + ".",
      parameters: {
        type: "object",
        properties: { dataset: { type: "string", enum: Object.keys(FLOWS) } },
        required: ["dataset"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "norgesbank_get_data",
      description:
        "Fetch Norges Bank data with an SDMX key: dimension codes in the dataset's key order joined by '.', several codes " +
        "joined by '+', an empty position = all. Frequency first: B = business day, M = monthly, A = annual. Without " +
        "startPeriod it returns the latest 'lastN' values (default 1). Known keys: policy rate IR B.KPRA.SD.R; NOWA " +
        "SHORT_RATES B.NOWA.ON.R; EUR/NOK and USD/NOK EXR B.EUR+USD.NOK.SP; 10-year government bond yield " +
        "GOVT_GENERIC_RATES B.10Y.GBON. Exchange rates state per 1 or per 100 units in 'unit'.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", enum: Object.keys(FLOWS) },
          key: { type: "string", description: "SDMX key, e.g. 'B.EUR+USD.NOK.SP'." },
          startPeriod: { type: "string", description: "e.g. '2025-01-01', '2025-01' (monthly) or '2020' (annual)." },
          endPeriod: { type: "string" },
          lastN: { type: "number", description: "Number of latest values per series (max 60)." },
        },
        required: ["dataset", "key"],
      },
    },
  },
];

export async function runNorgesbankTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "norgesbank_get_structure":
      return getStructure(args.dataset);
    case "norgesbank_get_data":
      return getData(args.dataset, args.key, args.startPeriod, args.endPeriod, args.lastN);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
