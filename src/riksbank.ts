// Sveriges Riksbank open APIs, exposed to the model as tools:
//  - SWEA (interest rates and exchange rates): https://api.riksbank.se/swea/v1
//  - SWESTR (the Swedish krona short-term rate; portal id "tora-api"): https://api.riksbank.se/swestr/v1
//  - Monetary Policy Data (forecasts in the Monetary Policy Report): https://api.riksbank.se/monetary_policy_data/v1
// Portal: https://developer.api.riksbank.se — no key needed, but without one access is limited to about
// 5 requests per minute (per IP, shared across these APIs). Set RIKSBANK_API_KEY (a free subscription key from the
// portal) for higher limits. Credit "Source: Sveriges Riksbank".

const ROOT = (process.env.RIKSBANK_API_BASE ?? "https://api.riksbank.se").replace(/\/+$/, "");
const MAX_ROWS = 120;

export const riksbankHasKey = () => !!process.env.RIKSBANK_API_KEY;

// ---- fetch with cache and short 429 retries ----

const cache = new Map<string, { until: number; data: unknown }>();
const LIST_TTL = 12 * 3600_000;
const DATA_TTL = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rbFetch(path: string, ttl = DATA_TTL): Promise<any> {
  const url = `${ROOT}${path}`;
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) return hit.data;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.RIKSBANK_API_KEY) headers["Ocp-Apim-Subscription-Key"] = process.env.RIKSBANK_API_KEY;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (res.status === 429) {
      const wait = Number(text.match(/in (\d+) seconds?/)?.[1] ?? res.headers.get("retry-after") ?? 60);
      if (attempt < 2 && wait <= 20) {
        await sleep((wait + 1) * 1000);
        continue;
      }
      throw new Error(
        `Riksbank API rate limit reached (without an API key only about 5 requests per minute are allowed). ` +
          `Try again in about ${wait} seconds.`,
      );
    }
    if (res.status === 204 || (res.ok && !text.trim())) return null;
    if (!res.ok) throw new Error(`Riksbank ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    cache.set(url, { until: Date.now() + ttl, data });
    return data;
  }
}

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);

/** Keep the newest rows when a series is long, and say so. */
function trimRows<T>(rows: T[], max = MAX_ROWS) {
  return rows.length > max
    ? { rows: rows.slice(-max), note: `Showing the latest ${max} of ${rows.length} rows; use a shorter period or an aggregate for more.` }
    : { rows };
}

// ---- catalogue: SWEA series + SWESTR + forecast series ----

interface SweaSeries {
  seriesId: string;
  source: string;
  shortDescription: string;
  midDescription: string;
  longDescription: string;
  groupId: number;
  observationMaxDate: string;
  observationMinDate: string;
  seriesClosed: boolean;
}

interface CatalogueEntry {
  id: string;
  api: "swea" | "swestr" | "forecast";
  name: string;
  group: string;
  description?: string;
  unit?: string;
  from?: string;
  to?: string;
  closed?: boolean;
  source?: string;
}

/** Group names come from SWEA's /Groups tree; flatten it to groupId -> "Parent > Child". */
function flattenGroups(node: any, path: string[] = [], out = new Map<number, string>()) {
  if (!node) return out;
  const here = node.name && node.groupId !== 1 ? [...path, node.name] : path;
  if (typeof node.groupId === "number") out.set(node.groupId, here.join(" > "));
  for (const child of node.childGroups ?? []) flattenGroups(child, here, out);
  return out;
}

const SWESTR_ENTRIES: Omit<CatalogueEntry, "api">[] = [
  { id: "SWESTR", name: "SWESTR", group: "SWESTR (Swedish krona short-term rate)", description: "Overnight reference rate (transaction-based), published by the Riksbank each banking day at 08:00 for the previous day", unit: "Per cent" },
  { id: "SWESTRAVG1W", name: "SWESTR compounded average 1 week", group: "SWESTR (Swedish krona short-term rate)", unit: "Per cent" },
  { id: "SWESTRAVG1M", name: "SWESTR compounded average 1 month", group: "SWESTR (Swedish krona short-term rate)", unit: "Per cent" },
  { id: "SWESTRAVG2M", name: "SWESTR compounded average 2 months", group: "SWESTR (Swedish krona short-term rate)", unit: "Per cent", from: "2021-11-01" },
  { id: "SWESTRAVG3M", name: "SWESTR compounded average 3 months", group: "SWESTR (Swedish krona short-term rate)", unit: "Per cent", from: "2021-12-01" },
  { id: "SWESTRAVG6M", name: "SWESTR compounded average 6 months", group: "SWESTR (Swedish krona short-term rate)", unit: "Per cent", from: "2022-03-01" },
  { id: "SWESTRINDEX", name: "SWESTR index", group: "SWESTR (Swedish krona short-term rate)", unit: "Index" },
];

let catalogue: { until: number; entries: CatalogueEntry[] } | null = null;

async function getCatalogue(): Promise<CatalogueEntry[]> {
  if (catalogue && catalogue.until > Date.now()) return catalogue.entries;
  const [series, groups, forecasts] = await Promise.all([
    rbFetch("/swea/v1/Series", LIST_TTL) as Promise<SweaSeries[]>,
    rbFetch("/swea/v1/Groups", LIST_TTL).catch(() => null),
    rbFetch("/monetary_policy_data/v1/forecasts/series_ids", LIST_TTL).catch(() => ({ data: [] })),
  ]);
  const groupName = flattenGroups(groups);
  const entries: CatalogueEntry[] = [
    ...series.map((s) => ({
      id: s.seriesId,
      api: "swea" as const,
      name: s.shortDescription.trim(),
      group: groupName.get(s.groupId) ?? `group ${s.groupId}`,
      description: s.midDescription === s.longDescription ? s.midDescription : `${s.midDescription}. ${s.longDescription}`.trim(),
      from: s.observationMinDate,
      to: s.observationMaxDate,
      closed: s.seriesClosed,
      source: s.source,
    })),
    ...SWESTR_ENTRIES.map((e) => ({ ...e, api: "swestr" as const })),
    ...(forecasts?.data ?? []).map((f: any) => ({
      id: f.series_id,
      api: "forecast" as const,
      name: f.metadata?.description,
      group: "Monetary Policy Report forecasts and outcomes",
      description: f.metadata?.note,
      unit: f.metadata?.unit,
      from: f.metadata?.start_date,
      source: f.metadata?.source_agency,
    })),
  ];
  catalogue = { until: Date.now() + LIST_TTL, entries };
  return entries;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Common words people use that don't appear in the Riksbank's own descriptions.
const SYNONYMS: Record<string, string[]> = {
  repo: ["policy rate"], styrranta: ["policy rate"], "key rate": ["policy rate"], interest: ["rate"],
  krona: ["sek"], kronor: ["sek"], fx: ["exchange rate"], currency: ["exchange rate"], valuta: ["exchange rate"],
  euro: ["eur"], dollar: ["usd"], pound: ["gbp"], sterling: ["gbp"], yen: ["jpy"], franc: ["chf"],
  bond: ["gvb", "government bond"], yield: ["gvb", "government bond"], "treasury bill": ["tb"], mortgage: ["mb"],
  inflation: ["cpif", "cpi"], unemployment: ["unemployment rate"], wages: ["hourly wage"], forecast: ["forecasts"],
  overnight: ["swestr"], "short-term rate": ["swestr"],
};

export async function searchSeries(query: string, includeClosed = false, limit = 15) {
  const entries = (await getCatalogue()).filter((e) => includeClosed || !e.closed);
  let q = norm(query.trim());
  for (const [word, extra] of Object.entries(SYNONYMS)) if (q.includes(word)) q += " " + extra.join(" ");
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (words.length === 0) {
    const groups = new Map<string, number>();
    for (const e of entries) groups.set(`${e.api}: ${e.group}`, (groups.get(`${e.api}: ${e.group}`) ?? 0) + 1);
    return { note: "No search words given. These are the available groups; search with words from them.", groups: Object.fromEntries(groups) };
  }
  const scored = entries
    .map((e) => {
      const hay = norm(`${e.id} ${e.name} ${e.group} ${e.description ?? ""} ${e.unit ?? ""}`);
      const name = norm(`${e.id} ${e.name}`);
      let score = 0;
      for (const w of words) {
        if (new RegExp(`\\b${w}\\b`).test(name)) score += 3;
        else if (hay.includes(w)) score += 1;
      }
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e }) => ({
      id: e.id,
      kind: e.api === "forecast" ? "forecast (use riksbank_get_forecast)" : "observed (use riksbank_get_rates)",
      name: e.name,
      group: e.group,
      ...(e.description ? { description: e.description.slice(0, 200) } : {}),
      ...(e.unit ? { unit: e.unit } : {}),
      ...(e.from || e.to ? { available: `${e.from ?? "?"} to ${e.to ?? "now"}` } : {}),
      ...(e.closed ? { closed: true } : {}),
    }));
  return { results: scored };
}

// ---- observed rates: SWEA + SWESTR ----

type Aggregate = "D" | "W" | "M" | "Q" | "Y";

async function sweaRates(id: string, from?: string, to?: string, aggregate?: Aggregate) {
  const entry = (await getCatalogue()).find((e) => e.id === id && e.api === "swea");
  if (!entry) throw new Error(`Unknown Riksbank series '${id}'. Use riksbank_search_series to find a valid id.`);
  const info: Record<string, unknown> = { id, name: entry.name, group: entry.group, description: entry.description };
  if (entry.group.toLowerCase().includes("exchange rate") && /^SEK[A-Z]{3}PMI$/.test(id)) {
    info.unit = `SEK per 1 ${id.slice(3, 6)}`; // all Riksbank rates are per 1 unit (checked: JPY 0.064, IDR 0.00056)
    info.note = "Riksbank exchange rates are indicative mid-rates, published for information only.";
  }
  if (entry.closed) info.closed = `Series discontinued; last value ${entry.to}.`;

  if (!from) {
    const latest = await rbFetch(`/swea/v1/Observations/Latest/${encodeURIComponent(id)}`);
    return { ...info, latest };
  }
  const end = to ?? today();
  if (aggregate && aggregate !== "D") {
    const rows = (await rbFetch(`/swea/v1/ObservationAggregates/${encodeURIComponent(id)}/${aggregate}/${from}/${end}`)) ?? [];
    const out = rows.map((r: any) => ({ from: r.from, to: r.to, average: r.average, min: r.min, max: r.max, endOfPeriod: r.ultimo, observations: r.observationCount }));
    return { ...info, aggregate, ...trimRows(out) };
  }
  const rows = (await rbFetch(`/swea/v1/Observations/${encodeURIComponent(id)}/${from}/${end}`)) ?? [];
  return { ...info, ...trimRows(rows) };
}

async function swestrRates(id: string, from?: string) {
  const isAvg = id.startsWith("SWESTRAVG");
  const isIndex = id === "SWESTRINDEX";
  const base = isAvg ? "/swestr/v1/avg" : isIndex ? "/swestr/v1/index" : "/swestr/v1";
  const meta = SWESTR_ENTRIES.find((e) => e.id === id);
  const info = { id, name: meta?.name ?? id, unit: meta?.unit, source: "Sveriges Riksbank, SWESTR" };
  // Keep the value, date and publication details; drop fields the model doesn't need.
  const slim = (r: any) => {
    const { pctl12_5, pctl87_5, alternativeCalculationReason, numberOfAgents, ...rest } = r ?? {};
    return rest;
  };
  if (!from) return { ...info, latest: slim(await rbFetch(`${base}/latest/${encodeURIComponent(id)}`)) };
  const raw = (await rbFetch(`${base}/${encodeURIComponent(id)}?fromDate=${from}`)) ?? [];
  return { ...info, ...trimRows((Array.isArray(raw) ? raw : [raw]).map(slim)) };
}

export async function getRates(ids: string[], from?: string, to?: string, aggregate?: Aggregate) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("Give at least one series id.");
  if (from && !isDate(from)) throw new Error("from must be a date like 2025-01-01.");
  if (to && !isDate(to)) throw new Error("to must be a date like 2025-12-31.");
  const unique = [...new Set(ids.map((s) => String(s).trim().toUpperCase()))].slice(0, 4);
  // One at a time: the API allows only a few requests per minute without a key.
  const out = [];
  for (const id of unique) {
    try {
      out.push(id.startsWith("SWESTR") || id === "PRESWESTR" ? await swestrRates(id, from) : await sweaRates(id, from, to, aggregate));
    } catch (err) {
      out.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { source: "Sveriges Riksbank", series: out };
}

// ---- Monetary Policy Report forecasts ----

export async function getForecast(seriesId: string, policyRound?: string, history = 8) {
  const id = String(seriesId).trim().toUpperCase();
  const rounds: string[] = (await rbFetch("/monetary_policy_data/v1/forecasts/policy_rounds", 6 * 3600_000))?.data ?? [];
  const round = policyRound?.trim() || rounds.at(-1);
  if (!round) throw new Error("No policy rounds available from the Riksbank.");
  if (rounds.length && !rounds.includes(round)) {
    throw new Error(`Unknown policy round '${round}'. Available: ${rounds.slice(-8).join(", ")} (newest last).`);
  }

  // The API answers 404 to an encoded ":" in the round name, so keep it literal.
  const roundParam = encodeURIComponent(round).replace(/%3A/gi, ":");
  const json = await rbFetch(`/monetary_policy_data/v1/forecasts?series=${encodeURIComponent(id)}&policy_round_name=${roundParam}`);
  const item = json?.data?.[0];
  if (!item) throw new Error(`No forecast data for '${id}' in round ${round}. Use riksbank_search_series to find a valid id.`);
  const vintage = Array.isArray(item.vintages) ? item.vintages.at(-1) : item.vintages;
  const cutoff: string | undefined = vintage?.metadata?.forecast_cutoff_date;
  const obs: { dt: string; value: number }[] = vintage?.observations ?? [];
  const outcomes = cutoff ? obs.filter((o) => o.dt <= cutoff) : obs;
  const forecast = cutoff ? obs.filter((o) => o.dt > cutoff) : [];

  return {
    source: "Sveriges Riksbank, Monetary Policy Report data",
    id,
    name: item.metadata?.description,
    unit: item.metadata?.unit,
    note: item.metadata?.note,
    sourceAgency: item.metadata?.source_agency,
    policyRound: round,
    published: vintage?.metadata?.policy_round_end_dtm,
    forecastCutoffDate: cutoff,
    explanation:
      "Values dated up to the forecast cut-off date were known when the forecast was made (outcomes as published then, " +
      "which can since have been revised); values after it are the Riksbank's forecast.",
    outcomesBeforeCutoff: outcomes.slice(-Math.max(1, Math.min(Number(history) || 8, 40))),
    forecast,
    newerRounds: rounds.slice(rounds.indexOf(round) + 1),
  };
}

// ---- Tool definitions for Mistral function calling ----

export const riksbankTools = [
  {
    type: "function" as const,
    function: {
      name: "riksbank_search_series",
      description:
        "Search Sveriges Riksbank (Sweden's central bank) series: the policy rate and other key rates, SWESTR, Swedish " +
        "treasury bill, government and mortgage bond yields, international market rates and government bond yields, SEK " +
        "exchange rates (SEK per foreign currency, plus the KIX index), and the forecasts in the Monetary Policy Report " +
        "(GDP, CPIF, CPI, unemployment, policy rate path, wages, KIX). Well-known ids: SECBREPOEFF policy rate, SWESTR, " +
        "SEKEURPMI / SEKUSDPMI exchange rates, SEGVB10YC Swedish 10-year government bond, SEMCPIFNAYNA CPIF forecast, " +
        "SEQRATENAYNA policy rate forecast.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search words, e.g. 'policy rate', 'EUR', '10 year bond', 'CPIF'. Empty lists the groups." },
          includeClosed: { type: "boolean", description: "Also return discontinued series (default false)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "riksbank_get_rates",
      description:
        "Fetch observed values of Riksbank interest rate, exchange rate or SWESTR series (up to 4 ids at once). " +
        "Without 'from' it returns the latest published value. With 'from' (and optional 'to') it returns daily values, " +
        "or period averages/min/max/end-of-period when 'aggregate' is W, M, Q or Y (use that for long periods). " +
        "To convert between two foreign currencies, fetch both SEK rates and divide.",
      parameters: {
        type: "object",
        properties: {
          seriesIds: { type: "array", items: { type: "string" }, description: "e.g. ['SECBREPOEFF'] or ['SEKEURPMI','SEKUSDPMI']" },
          from: { type: "string", description: "Start date YYYY-MM-DD (optional)." },
          to: { type: "string", description: "End date YYYY-MM-DD (optional, default today). Not used for SWESTR ids." },
          aggregate: { type: "string", enum: ["D", "W", "M", "Q", "Y"], description: "Period for averages (SWEA series only)." },
        },
        required: ["seriesIds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "riksbank_get_forecast",
      description:
        "Fetch the Riksbank's own forecast for a Monetary Policy Report series (ids from riksbank_search_series, kind " +
        "'forecast'). Uses the newest policy round unless 'policyRound' (e.g. '2026:2') is given; returns the publication " +
        "date, the forecast cut-off date, recent outcomes and the forecast values. For actual published Swedish statistics " +
        "(e.g. the latest CPI or unemployment), use SCB instead; use this for what the Riksbank expects.",
      parameters: {
        type: "object",
        properties: {
          seriesId: { type: "string", description: "e.g. 'SEMCPIFNAYNA' (CPIF, annual % change), 'SEQRATENAYNA' (policy rate)." },
          policyRound: { type: "string", description: "Policy round like '2026:3' (optional, default newest)." },
          history: { type: "number", description: "How many outcome values before the cut-off to include (default 8)." },
        },
        required: ["seriesId"],
      },
    },
  },
];

export async function runRiksbankTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "riksbank_search_series":
      return searchSeries(String(args.query ?? ""), !!args.includeClosed);
    case "riksbank_get_rates":
      return getRates(Array.isArray(args.seriesIds) ? args.seriesIds : [args.seriesIds].filter(Boolean), args.from, args.to, args.aggregate);
    case "riksbank_get_forecast":
      return getForecast(String(args.seriesId ?? ""), args.policyRound, args.history);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
