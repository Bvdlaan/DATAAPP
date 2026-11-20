// Eurostat dissemination API client, exposed to the model as tools.
// Docs: https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started
// No key. Data: Statistics API (JSON-stat 2.0). Search: catalogue table of contents. Structure: SDMX 2.1.
// Reuse is free with acknowledgement of the source ("Source: Eurostat").

import { flattenJsonStat } from "./jsonstat.js";

const ROOT = (process.env.EUROSTAT_API_BASE ?? "https://ec.europa.eu/eurostat/api/dissemination").replace(/\/+$/, "");
const DAY = 24 * 3_600_000;

async function getText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url); // fetch negotiates and decompresses gzip itself
  return { status: res.status, text: await res.text() };
}

// ---------- catalogue search (table of contents, ~2 MB, cached 24 h) ----------

interface TocEntry {
  title: string;
  code: string;
  type: string;
  updated: string;
  start: string;
  end: string;
}
let toc: { at: number; entries: TocEntry[] } | null = null;

async function loadToc(): Promise<TocEntry[]> {
  if (toc && Date.now() - toc.at < DAY) return toc.entries;
  const { status, text } = await getText(`${ROOT}/catalogue/toc/txt?lang=en`);
  if (status !== 200) throw new Error(`Eurostat catalogue ${status}`);
  const unq = (s = "") => s.replace(/^"|"$/g, "").trim();
  const entries = text
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t").map(unq))
    .filter((c) => c.length >= 7 && c[2] !== "folder")
    .map((c) => ({ title: c[0], code: c[1], type: c[2], updated: c[3], start: c[5], end: c[6] }));
  // Datasets often appear in several folders.
  const unique = [...new Map(entries.map((e) => [e.code, e])).values()];
  toc = { at: Date.now(), entries: unique };
  return unique;
}

export async function searchDatasets(query: string, limit = 12) {
  const words = query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
  const need = Math.max(1, Math.ceil(words.length / 2));
  const entries = await loadToc();
  return entries
    .map((e) => {
      const hay = `${e.title} ${e.code}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits < need) return null;
      const current = isCurrent(e);
      // More matching words first; then exact code hits, current data, main datasets, shorter titles.
      const score =
        hits * 20 +
        (words.includes(e.code.toLowerCase()) ? 100 : 0) +
        (current ? 25 : -40) +
        (/vtg|vintage/i.test(e.code + e.title) ? -10 : 0) -
        e.title.length / 20;
      return { e, score, current };
    })
    .filter((x): x is { e: TocEntry; score: number; current: boolean } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e, current }) => ({
      code: e.code,
      title: e.title,
      type: e.type,
      dataStart: e.start,
      dataEnd: e.end,
      updated: e.updated,
      ...(current ? {} : { note: "Not updated any more (historical/discontinued). Prefer a current dataset." }),
    }));
}

/**
 * Is this dataset still being updated? Eurostat freezes replaced datasets and gives them a closed year range in the
 * title, e.g. "HICP - monthly data (annual rate of change) (1997-2025)". Monthly/quarterly data should also be recent.
 */
function isCurrent(e: TocEntry, now = new Date()): boolean {
  const year = now.getFullYear();
  const closed = e.title.match(/\((\d{4})\s*-\s*(\d{4})\)\s*$/);
  if (closed && Number(closed[2]) < year) return false;
  const m = e.end.match(/^(\d{4})(?:-(\d{2})|-?Q(\d))?/);
  if (!m) return true;
  const endYear = Number(m[1]);
  if (m[2] || m[3]) {
    const endMonth = m[2] ? Number(m[2]) : Number(m[3]) * 3;
    const monthsOld = (year - endYear) * 12 + (now.getMonth() + 1 - endMonth);
    return monthsOld <= 9;
  }
  return endYear >= year - 2; // annual data lags; 2 years back is still current
}

// ---------- structure (dimensions + codes actually used by the dataset) ----------

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

interface Dim {
  code: string;
  values: { code: string; label: string }[];
}
const structCache = new Map<string, { at: number; title: string; dims: Dim[] }>();

async function structure(dataset: string) {
  const key = dataset.toLowerCase();
  const hit = structCache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit;

  const { status, text } = await getText(
    `${ROOT}/sdmx/2.1/dataflow/ESTAT/${encodeURIComponent(dataset)}?references=descendants&detail=referencepartial`,
  );
  if (status !== 200) throw new Error(`Eurostat structure ${status}: unknown dataset '${dataset}'?`);

  const title = decode(text.match(/<s:Dataflow [\s\S]*?<c:Name xml:lang="en">([^<]*)<\/c:Name>/)?.[1] ?? dataset);

  const codelists = new Map<string, { code: string; label: string }[]>();
  for (const m of text.matchAll(/<s:Codelist [^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/s:Codelist>/g)) {
    const codes = [...m[2].matchAll(/<s:Code id="([^"]+)"[^>]*>[\s\S]*?<c:Name xml:lang="en">([^<]*)<\/c:Name>/g)].map((c) => ({
      code: c[1],
      label: decode(c[2]),
    }));
    codelists.set(m[1], codes);
  }

  const dims: Dim[] = [];
  for (const m of text.matchAll(/<s:Dimension id="([^"]+)" position="(\d+)"[\s\S]*?<\/s:Dimension>/g)) {
    const cl = m[0].match(/class="Codelist" id="([^"]+)"/)?.[1];
    dims.push({ code: m[1], values: (cl && codelists.get(cl)) || [] });
  }

  const entry = { at: Date.now(), title, dims };
  structCache.set(key, entry);
  return entry;
}

export async function getDatasetMetadata(dataset: string, maxValues = 60) {
  const s = await structure(dataset);
  return {
    code: dataset,
    title: s.title,
    note: "Filter with these dimension codes in eurostat_get_data. Time is filtered with lastTimePeriod/sinceTimePeriod.",
    dimensions: s.dims.map((d) => ({
      code: d.code,
      valueCount: d.values.length,
      values: d.values.slice(0, maxValues),
      truncated: d.values.length > maxValues,
    })),
  };
}

// ---------- data ----------

export interface EurostatFilter {
  dimension: string;
  values: string[];
}

/**
 * Fetch data. Dimensions without a filter that have exactly one value are fine; for larger omitted
 * dimensions Eurostat returns all values, so callers should filter at least geo. Time defaults to the latest period.
 */
export async function getData(
  dataset: string,
  filters: EurostatFilter[] = [],
  opts: { lastTimePeriod?: number; sinceTimePeriod?: string; untilTimePeriod?: string } = {},
) {
  const q = new URLSearchParams({ format: "JSON", lang: "EN" });
  for (const f of filters) {
    if (/^time(_period)?$/i.test(f.dimension)) {
      for (const v of f.values) q.append("time", v);
      continue;
    }
    for (const v of f.values) q.append(f.dimension.toLowerCase(), v);
  }
  const explicitTime = !!(q.has("time") || opts.sinceTimePeriod || opts.untilTimePeriod || opts.lastTimePeriod);
  if (opts.sinceTimePeriod) q.set("sinceTimePeriod", opts.sinceTimePeriod);
  if (opts.untilTimePeriod) q.set("untilTimePeriod", opts.untilTimePeriod);
  if (opts.lastTimePeriod || !explicitTime) q.set("lastTimePeriod", String(Math.min(Math.max(opts.lastTimePeriod ?? 1, 1), 40)));

  const fetchOnce = async (params: URLSearchParams) => {
    const { status, text } = await getText(`${ROOT}/statistics/1.0/data/${encodeURIComponent(dataset)}?${params}`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Eurostat ${status}: ${text.slice(0, 300)}`);
    }
    if (status !== 200 || json.error) {
      const e = Array.isArray(json.error) ? json.error[0] : json.error;
      throw new Error(`Eurostat ${status}: ${e?.label ?? JSON.stringify(e ?? json).slice(0, 300)}`);
    }
    return flattenJsonStat(json);
  };

  let result = await fetchOnce(q);
  // The newest period is often published for some countries before others. If the default
  // "latest period" is empty for this selection, look back a few periods instead.
  if (result.rows.length === 0 && !explicitTime) {
    q.set("lastTimePeriod", "6");
    result = await fetchOnce(q);
    if (result.rows.length) return { ...result, note: "Latest period had no values for this selection; showing the last 6 periods." };
  }
  if (result.rows.length === 0) {
    return { ...result, note: "No values. Check codes with eurostat_get_dataset_metadata (e.g. geo, unit) or widen the time range." };
  }
  return result;
}

// ---------- Tool definitions for Mistral function calling ----------

export const eurostatTools = [
  {
    type: "function" as const,
    function: {
      name: "eurostat_search_datasets",
      description:
        "Search Eurostat (EU statistics, all EU/EEA countries incl. Sweden and Norway) datasets by English keywords. " +
        "All words must match the title. Returns dataset codes, e.g. 'une_rt_m' (unemployment, monthly), " +
        "'demo_pjan' (population), 'nama_10_gdp' (GDP). Inflation (HICP, current): 'prc_hicp_minr' with unit RCH_A " +
        "(annual rate) and coicop18 TOTAL; the older prc_hicp_manr/aind stop at 2025. Results marked 'Not updated any " +
        "more' are frozen: prefer current datasets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords, e.g. 'unemployment rate monthly'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "eurostat_get_dataset_metadata",
      description: "Get a Eurostat dataset's dimensions and valid codes (geo, unit, sex, age, ...). Call before eurostat_get_data.",
      parameters: {
        type: "object",
        properties: { dataset: { type: "string", description: "Dataset code, e.g. 'une_rt_m'." } },
        required: ["dataset"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "eurostat_get_data",
      description:
        "Fetch Eurostat data. Always filter geo (country codes like SE, NO, DE, FR, EU27_2020) and pick one value for " +
        "dimensions like unit/sex/age/s_adj where possible, or results get large. Defaults to the latest period; " +
        "use lastTimePeriod for the last N periods or sinceTimePeriod (e.g. '2020' or '2024-01').",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string", description: "Dimension code, e.g. 'geo', 'unit', 'sex'." },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["dimension", "values"],
            },
          },
          lastTimePeriod: { type: "number", description: "Number of most recent periods (default 1, max 40)." },
          sinceTimePeriod: { type: "string" },
          untilTimePeriod: { type: "string" },
        },
        required: ["dataset"],
      },
    },
  },
];

export async function runEurostatTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "eurostat_search_datasets":
      return searchDatasets(String(args.query ?? ""));
    case "eurostat_get_dataset_metadata":
      return getDatasetMetadata(String(args.dataset));
    case "eurostat_get_data":
      return getData(String(args.dataset), Array.isArray(args.filters) ? args.filters : [], {
        lastTimePeriod: args.lastTimePeriod,
        sinceTimePeriod: args.sinceTimePeriod,
        untilTimePeriod: args.untilTimePeriod,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
