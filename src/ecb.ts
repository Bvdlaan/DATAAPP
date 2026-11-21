// European Central Bank Data Portal, SDMX REST API (SDMX 2.1), exposed to the model as tools.
// Entry point: https://data-api.ecb.europa.eu/service/  — no key. Docs: https://data.ecb.europa.eu/help/api/overview
// Data: GET /data/{dataset}/{key}?format=jsondata&startPeriod=&endPeriod=&lastNObservations=
// Key = dimension codes in the dataset's order joined by "."; "+" = several codes, empty position = all.
// Structure queries (dataflow, datastructure) only come as XML, so key orders for the main datasets are listed here,
// and ecb_find_series shows the order and codes of whatever a (wildcard) key matches.

import { flattenSdmx, sdmxDimensions } from "./sdmx.js";

const ROOT = (process.env.ECB_API_BASE ?? "https://data-api.ecb.europa.eu/service").replace(/\/+$/, "");
const MAX_OBS_PER_SERIES = 60;
const MAX_SERIES = 30;
const MAX_FIND = 40;
const MAX_BYTES = 6_000_000;
const KEEP_ATTRIBUTES = ["TITLE", "TITLE_COMPL", "UNIT", "UNIT_MULT", "COLLECTION"];

/** Main datasets, their key order and keys checked against the live API. */
export const DATASETS: Record<string, string> = {
  EXR: "Euro foreign exchange reference rates, units of foreign currency per 1 EUR. Key FREQ.CURRENCY.CURRENCY_DENOM.EXR_TYPE.EXR_SUFFIX, e.g. D.USD+GBP.EUR.SP00.A (daily), M.USD.EUR.SP00.A (monthly average)",
  FM: "ECB key interest rates. Key FREQ.REF_AREA.CURRENCY.PROVIDER_FM.INSTRUMENT_FM.PROVIDER_FM_ID.DATA_TYPE_FM: B.U2.EUR.4F.KR.DFR.LEV deposit facility rate, B.U2.EUR.4F.KR.MRR_FR.LEV main refinancing rate, B.U2.EUR.4F.KR.MLFR.LEV marginal lending rate (values are dated on the day a change took effect)",
  EST: "Euro short-term rate (€STR). Key FREQ.BENCHMARK_ITEM.DATA_TYPE_EST, e.g. B.EU000A2X2A25.WT",
  HICP: "Inflation (HICP), euro area and EU countries, current dataset. Key FREQ.REF_AREA.ADJUSTMENT.ICP_ITEM.DATA_PROVIDER.ICP_SUFFIX: M.U2.N.000000.4D0.ANR euro area annual inflation; country codes DE, FR, NL...; ICP_SUFFIX ANR annual rate, INX index. (The older dataset ICP stops in Dec 2025.)",
  YC: "Euro area government bond yield curve, estimated from the bonds of several euro area governments: never call it one country's (e.g. German Bund) yield. Key FREQ.REF_AREA.CURRENCY.PROVIDER_FM.INSTRUMENT_FM.PROVIDER_FM_ID.DATA_TYPE_FM, e.g. B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y (AAA-rated, 10-year spot rate; G_N_C = all issuers; SR_2Y, SR_5Y...)",
  IRS: "Long-term interest rates (10-year government bond yields) by EU country, monthly averages; use this for a country's 10-year yield (e.g. German Bund = DE). Key FREQ.REF_AREA.IR_TYPE.TR_TYPE.MATURITY_CAT.BS_COUNT_SECTOR.CURRENCY_TRANS.IR_BUS_COV.IR_FV_TYPE, e.g. M.DE+FR+IT.L.L40.CI.0000.EUR.N.Z",
  BSI: "Money and bank balance sheets, e.g. M3 annual growth M.U2.Y.V.M30.X.I.U2.2300.Z01.A (M1: M10, M2: M20)",
  MIR: "Bank interest rates (MFI interest rate statistics), e.g. M.U2.B.A2C.AM.R.A.2250.EUR.N (cost of borrowing for households for house purchase; use REF_AREA DE, FR... for countries)",
  SPF: "Survey of Professional Forecasters, quarterly. E.g. Q.U2.HICP.POINT..Q.AVG (average point forecast of HICP inflation; the 5th position is the target year, e.g. 2027; other variables: RGDP, UNEM)",
};

const cache = new Map<string, { until: number; data: unknown }>();

async function ecbFetch(path: string, ttl = 10 * 60_000): Promise<any> {
  const url = `${ROOT}${path}`;
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.data;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null; // "No Series was returned for the query"
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("This query matches too much data. Fix more key positions or use a shorter period.");
  const text = await res.text();
  if (res.status === 400) {
    const order = DATASETS[path.split("/")[2]]?.match(/Key ([A-Z_.]+)/)?.[1];
    throw new Error(`ECB rejected the query (400): the key is not valid for this dataset${order ? `; key order is ${order}` : ""}. Check the number of positions and the codes with ecb_find_series.`);
  }
  if (!res.ok) throw new Error(`ECB ${res.status}: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  if (text.length > MAX_BYTES) throw new Error("This query matches too much data. Fix more key positions or use a shorter period.");
  const data = JSON.parse(text);
  cache.set(url, { until: Date.now() + ttl, data });
  return data;
}

function checkArgs(dataset: string, key: string) {
  const d = String(dataset ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,12}$/.test(d)) throw new Error(`Invalid ECB dataset id '${dataset}'.`);
  const k = String(key ?? "").trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_+.\-]*$/.test(k)) throw new Error("Key may only contain codes, '.', '+' and '_'.");
  return { d, k };
}

function readable(s: ReturnType<typeof flattenSdmx>[number]) {
  const a = s.attributes;
  return {
    key: s.key,
    title: a.TITLE_COMPL ?? a.TITLE,
    ...(a.UNIT ? { unit: a.UNIT } : {}),
    ...(a.UNIT_MULT && a.UNIT_MULT !== "Units" ? { unitMultiplier: a.UNIT_MULT } : {}),
    ...(a.COLLECTION ? { collection: a.COLLECTION } : {}),
  };
}

/** Which series a (wildcard) key matches, with the key order, codes and each series' latest value. */
export async function findSeries(dataset: string, key = "") {
  const { d, k } = checkArgs(dataset, key);
  if (!k.replace(/\./g, "")) {
    return { dataset: d, note: "Give a key with at least one position fixed (e.g. the frequency 'M').", knownDatasets: DATASETS[d] ?? DATASETS };
  }
  const json = await ecbFetch(`/data/${d}/${k}?format=jsondata&lastNObservations=1&detail=full`, 6 * 3600_000);
  if (!json) return { dataset: d, key: k, series: [], note: "No series match this key. Check the key order and codes." };
  const all = flattenSdmx(json, { maxObs: 1, keepAttributes: ["TITLE", "TITLE_COMPL", "UNIT"] });
  return {
    dataset: d,
    key: k,
    keyOrder: sdmxDimensions(json).map((x) => x.id).join("."),
    codesInResult: sdmxDimensions(json).map((x) => ({ id: x.id, codes: x.codes.slice(0, 40), more: Math.max(0, x.codes.length - 40) })),
    matches: all.length,
    series: all.slice(0, MAX_FIND).map((s) => ({ key: s.key, title: s.attributes.TITLE, unit: s.attributes.UNIT, latest: s.observations[0] })),
    ...(all.length > MAX_FIND ? { note: `Showing ${MAX_FIND} of ${all.length} series; fix more key positions.` } : {}),
  };
}

export async function getData(dataset: string, key: string, startPeriod?: string, endPeriod?: string, lastN?: number) {
  const { d, k } = checkArgs(dataset, key);
  if (!k) throw new Error("Give a key (use ecb_find_series to explore one).");
  const params = new URLSearchParams({ format: "jsondata" });
  if (startPeriod) params.set("startPeriod", startPeriod);
  if (endPeriod) params.set("endPeriod", endPeriod);
  if (!startPeriod && !endPeriod) params.set("lastNObservations", String(Math.min(Math.max(Number(lastN) || 1, 1), MAX_OBS_PER_SERIES)));
  else if (lastN) params.set("lastNObservations", String(Math.min(Number(lastN), MAX_OBS_PER_SERIES)));

  const json = await ecbFetch(`/data/${d}/${k}?${params}`);
  if (!json) return { dataset: d, key: k, series: [], note: "No data for this key and period. Check the key with ecb_find_series." };
  const all = flattenSdmx(json, { maxObs: MAX_OBS_PER_SERIES, keepAttributes: KEEP_ATTRIBUTES });
  return {
    source: "European Central Bank (ECB Data Portal)",
    dataset: d,
    key: k,
    ...(all.length > MAX_SERIES ? { note: `Showing ${MAX_SERIES} of ${all.length} series; narrow the key.` } : {}),
    series: all.slice(0, MAX_SERIES).map((s) => ({
      ...readable(s),
      observations: s.observations,
      ...(s.totalObservations > MAX_OBS_PER_SERIES
        ? { note: `Showing the latest ${MAX_OBS_PER_SERIES} of ${s.totalObservations} values; use a shorter period or a lower frequency.` }
        : {}),
    })),
  };
}

// ---- Tool definitions for Mistral function calling ----

const DATASET_HELP = Object.entries(DATASETS).map(([id, t]) => `${id}: ${t}`).join(" | ");

export const ecbTools = [
  {
    type: "function" as const,
    function: {
      name: "ecb_find_series",
      description:
        "Explore European Central Bank (ECB Data Portal) series: returns the dataset's key order, the codes present and " +
        "matching series with titles and latest values. Use '+' for several codes and an empty position as a wildcard " +
        "(e.g. 'M.U2.N..4D0.ANR'); fix as many positions as you can, broad keys can match thousands of series. " +
        "Main datasets: " + DATASET_HELP,
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset id, e.g. 'HICP', 'EXR', 'FM', 'EST', 'YC', 'IRS', 'BSI', 'MIR', 'SPF'." },
          key: { type: "string", description: "Series key, possibly with empty positions, e.g. 'D..EUR.SP00.A'." },
        },
        required: ["dataset", "key"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ecb_get_data",
      description:
        "Fetch ECB data for a series key (see ecb_find_series for key orders). Without startPeriod it returns the latest " +
        "'lastN' values (default 1). Periods: '2025-01-01' (daily), '2025-01' (monthly), '2025-Q1', '2025'. " +
        "Known keys: euro area inflation HICP M.U2.N.000000.4D0.ANR; deposit facility rate FM B.U2.EUR.4F.KR.DFR.LEV; " +
        "€STR EST B.EU000A2X2A25.WT; EUR/USD EXR D.USD.EUR.SP00.A (USD per EUR); 10-year AAA yield YC " +
        "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y; M3 growth BSI M.U2.Y.V.M30.X.I.U2.2300.Z01.A.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string" },
          key: { type: "string" },
          startPeriod: { type: "string" },
          endPeriod: { type: "string" },
          lastN: { type: "number", description: "Number of latest values per series (max 60)." },
        },
        required: ["dataset", "key"],
      },
    },
  },
];

export async function runEcbTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "ecb_find_series":
      return findSeries(args.dataset, args.key);
    case "ecb_get_data":
      return getData(args.dataset, args.key, args.startPeriod, args.endPeriod, args.lastN);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
