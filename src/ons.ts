// Office for National Statistics (ONS, UK) beta API client, exposed to the model as tools.
// Docs: https://developer.ons.gov.uk/  — base https://api.beta.ons.gov.uk/v1, open, no key.
// Licence: Crown Copyright, Open Government Licence (credit "Source: Office for National Statistics").
// Note: datasets here are updated at very different speeds; always report the release date.

const ROOT = (process.env.ONS_API_BASE ?? "https://api.beta.ons.gov.uk/v1").replace(/\/+$/, "");
const DAY = 24 * 3_600_000;

// ONS asks automated clients to identify themselves (https://developer.ons.gov.uk/bots/). No personal data here.
// Limits: 120 requests / 10 s and 200 / min; 429 with Retry-After when exceeded.
const HEADERS = { "User-Agent": "StatsGenius/0.1 (open data chat app)" };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url.startsWith("http") ? url : `${ROOT}${url}`, { headers: HEADERS });
  if (res.status === 429) throw new Error(`ONS rate limit hit; retry after ${res.headers.get("retry-after") ?? "a while"} s`);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ONS ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`ONS ${res.status}: ${json?.errors?.[0] ?? json?.message ?? text.slice(0, 300)}`);
  return json;
}

// ---------- dataset list (cached 24 h) ----------

interface DatasetInfo {
  id: string;
  title: string;
  description: string;
  keywords: string;
  latestVersion: string; // URL
  lastUpdated: string;
  nextRelease: string;
  releaseFrequency: string;
  type: string; // e.g. "cantabular_table" for Census 2021 flexible tables
}
let list: { at: number; items: DatasetInfo[] } | null = null;

async function loadList(): Promise<DatasetInfo[]> {
  if (list && Date.now() - list.at < DAY) return list.items;
  const json = await getJson("/datasets?limit=1000");
  const items: DatasetInfo[] = (json.items ?? [])
    .filter((d: any) => d.state === "published" && d.links?.latest_version?.href)
    .map((d: any) => ({
      id: d.id,
      title: d.title ?? d.id,
      description: d.description ?? "",
      keywords: (d.keywords ?? []).join(" "),
      latestVersion: d.links.latest_version.href,
      lastUpdated: (d.last_updated ?? "").slice(0, 10),
      nextRelease: String(d.next_release ?? ""),
      releaseFrequency: String(d.release_frequency ?? ""),
      type: String(d.type ?? ""),
    }));
  list = { at: Date.now(), items };
  return items;
}

export async function searchDatasets(query: string, limit = 12) {
  const words = query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
  const need = Math.max(1, Math.ceil(words.length / 2));
  return (await loadList())
    .map((d) => {
      const title = d.title.toLowerCase();
      const hay = `${title} ${d.keywords} ${d.description} ${d.id}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits < need) return null;
      const score =
        hits * 20 +
        words.filter((w) => title.includes(w)).length * 10 +
        (d.lastUpdated >= "2026" ? 10 : 0) +
        (/^cantabular/i.test(d.type) ? -30 : 0) - // Census flexible tables: use Nomis instead
        title.length / 30;
      return { d, score };
    })
    .filter((x): x is { d: DatasetInfo; score: number } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ d }) => ({
      id: d.id,
      title: d.title,
      lastUpdated: d.lastUpdated,
      releaseFrequency: d.releaseFrequency || undefined,
      nextRelease: d.nextRelease || undefined,
      ...(/^cantabular/i.test(d.type) ? { note: "Census 2021 flexible table: query Census 2021 via Nomis instead" } : {}),
      description: d.description.slice(0, 200),
    }));
}

// ---------- version structure (dimensions + options), cached per version URL ----------

interface Option {
  code: string;
  label: string;
}
interface Version {
  url: string;
  title: string;
  edition: string;
  version: string;
  releaseDate: string;
  dims: { name: string; label: string; options: Option[] }[];
}
const versionCache = new Map<string, { at: number; v: Version }>();

async function version(dataset: string): Promise<Version> {
  const info = (await loadList()).find((d) => d.id.toLowerCase() === dataset.toLowerCase());
  if (!info) throw new Error(`Unknown ONS dataset '${dataset}'. Use ons_search_datasets first.`);
  if (/^cantabular/i.test(info.type)) {
    throw new Error(`'${dataset}' is a Census 2021 flexible table, which this API client doesn't query. Use Nomis (nomis_search_datasets) for Census 2021 data.`);
  }
  const hit = versionCache.get(info.latestVersion);
  if (hit && Date.now() - hit.at < DAY) return hit.v;

  const v = await getJson(info.latestVersion);
  const dims = await Promise.all(
    (v.dimensions ?? []).map(async (d: any) => {
      const options: Option[] = [];
      for (let offset = 0; offset < 5000; offset += 1000) {
        const page = await getJson(`${info.latestVersion}/dimensions/${encodeURIComponent(d.name)}/options?limit=1000&offset=${offset}`);
        for (const o of page.items ?? []) options.push({ code: String(o.option), label: String(o.label ?? o.option) });
        if ((page.items ?? []).length < 1000) break;
      }
      return { name: String(d.name), label: String(d.label ?? d.name), options };
    }),
  );
  const result: Version = {
    url: info.latestVersion,
    title: info.title,
    edition: String(v.edition ?? ""),
    version: String(v.version ?? ""),
    releaseDate: String(v.release_date ?? "").slice(0, 10),
    dims,
  };
  versionCache.set(info.latestVersion, { at: Date.now(), v: result });
  return result;
}

const isTime = (name: string) => /^time$/i.test(name);

/** Sortable key for ONS time labels like "Jan-26", "2024", "2024 Q1", "2024-Q1", "Jan 2024", "2024-01". */
function timeKey(label: string): string {
  const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
  const s = label.trim().toLowerCase();
  let m = s.match(/^([a-z]{3})[-\s](\d{2}|\d{4})$/);
  if (m && months.includes(m[1])) {
    // Two-digit years: ONS series start in the 1980s, so 50-99 means 19xx and 00-49 means 20xx.
    const y = m[2].length === 2 ? (Number(m[2]) >= 50 ? 1900 : 2000) + Number(m[2]) : Number(m[2]);
    return `${y}-${String(months.indexOf(m[1]) + 1).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})[-\s]?q([1-4])$/);
  if (m) return `${m[1]}-q${m[2]}`;
  m = s.match(/^(\d{4})(?:-(\d{2}))?/);
  if (m) return `${m[1]}-${m[2] ?? "00"}`;
  return s;
}

export async function getDatasetMetadata(dataset: string, opts: { dimension?: string; search?: string } = {}, maxValues = 40) {
  const v = await version(dataset);
  if (opts.dimension) {
    const d = v.dims.find((x) => x.name.toLowerCase() === opts.dimension!.toLowerCase());
    if (!d) throw new Error(`No dimension '${opts.dimension}'. Dimensions: ${v.dims.map((x) => x.name).join(", ")}`);
    const q = (opts.search ?? "").toLowerCase();
    const found = d.options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.code.toLowerCase().includes(q));
    return { dataset, dimension: d.name, values: found.slice(0, 80), truncated: found.length > 80 };
  }
  return {
    id: dataset,
    title: v.title,
    releaseDate: v.releaseDate,
    edition: v.edition,
    version: v.version,
    dimensions: v.dims.map((d) => {
      const opts = isTime(d.name) ? [...d.options].sort((a, b) => timeKey(b.label).localeCompare(timeKey(a.label))) : d.options;
      return {
        code: d.name,
        label: d.label,
        valueCount: d.options.length,
        values: opts.slice(0, maxValues),
        truncated: d.options.length > maxValues,
        ...(isTime(d.name) ? { note: "newest first" } : {}),
      };
    }),
    tips:
      "Every dimension needs one code; omitted ones default to UK / total-like options. Time defaults to the latest 13 " +
      "periods (enough for a year-on-year change). Index series (e.g. CPIH) need the % change computed from the index.",
  };
}

// ---------- data ----------

export interface OnsFilter {
  dimension: string;
  values: string[];
}

function defaultOption(options: Option[]): Option | undefined {
  if (options.length <= 1) return options[0];
  return (
    options.find((o) => o.code === "K02000001") ??
    options.find((o) => /^(total|all\b|overall|united kingdom|uk\b|persons|all persons)/i.test(o.label)) ??
    options.find((o) => /total|all /i.test(o.label)) ??
    options[0]
  );
}

/**
 * Fetch observations. The ONS API takes one code per dimension, with '*' allowed on one dimension:
 * time is the wildcard unless the caller fixes it. Several codes for a dimension run as separate requests (max 12).
 */
export async function getData(dataset: string, filters: OnsFilter[] = [], periods = 13) {
  const v = await version(dataset);
  const chosen = new Map<string, string[]>();
  for (const f of filters) {
    const d = v.dims.find((x) => x.name.toLowerCase() === f.dimension.toLowerCase());
    if (!d) throw new Error(`No dimension '${f.dimension}'. Dimensions: ${v.dims.map((x) => x.name).join(", ")}`);
    chosen.set(d.name, f.values);
  }

  const timeDim = v.dims.find((d) => isTime(d.name));
  const wildcard = timeDim && !chosen.has(timeDim.name) ? timeDim.name : undefined;
  const base: Record<string, string[]> = {};
  for (const d of v.dims) {
    if (d.name === wildcard) continue;
    const vals = chosen.get(d.name);
    if (vals?.length) base[d.name] = vals;
    else {
      const def = defaultOption(d.options);
      if (!def) throw new Error(`Dimension '${d.name}' has no options.`);
      base[d.name] = [def.code];
    }
  }

  // Cartesian product over dimensions given several codes.
  let combos: Record<string, string>[] = [{}];
  for (const [name, vals] of Object.entries(base)) combos = combos.flatMap((c) => vals.map((val) => ({ ...c, [name]: val })));
  if (combos.length > 12) throw new Error("Too many combinations (max 12). Pick fewer codes.");

  const labelOf = (dim: string, code: string) => v.dims.find((d) => d.name === dim)?.options.find((o) => o.code === code)?.label ?? code;
  const rows: Record<string, string | number | null>[] = [];
  for (const combo of combos) {
    const params = new URLSearchParams(combo);
    if (wildcard) params.set(wildcard, "*");
    const json = await getJson(`${v.url}/observations?${params}`);
    const fixed = Object.fromEntries(Object.entries(combo).map(([k, code]) => [k, labelOf(k, code)]));
    let obs: Record<string, string | number | null>[] = (json.observations ?? []).map((o: any) => {
      const wild = Object.values(o.dimensions ?? {})[0] as any;
      const num = Number(o.observation);
      return { ...fixed, ...(wildcard ? { [wildcard]: wild?.label ?? wild?.id ?? "" } : {}), value: Number.isFinite(num) ? num : o.observation };
    });
    if (wildcard && isTime(wildcard)) {
      obs = obs.sort((a, b) => timeKey(String(a[wildcard])).localeCompare(timeKey(String(b[wildcard])))).slice(-Math.max(1, Math.min(periods, 60)));
    }
    rows.push(...obs);
  }

  return {
    title: v.title,
    releaseDate: v.releaseDate,
    source: "Office for National Statistics",
    rows: rows.slice(0, 300),
    ...(rows.length === 0 ? { note: "No observations. Check codes with ons_get_dataset_metadata." } : {}),
  };
}

// ---------- time series (CDID): ONS headline figures, updated on release day ----------

const SITE = (process.env.ONS_SITE_BASE ?? "https://www.ons.gov.uk").replace(/\/+$/, "");

export async function searchTimeseries(query: string, limit = 10) {
  const q = query.trim();
  const params = new URLSearchParams({ q, content_type: "timeseries", limit: String(Math.min(Math.max(limit, 1), 25)) });
  if (/^[A-Za-z0-9]{4}$/.test(q)) params.set("cdids", q.toUpperCase()); // looks like a CDID
  const json = await getJson(`/search?${params}`);
  return (json.items ?? []).map((i: any) => ({
    cdid: i.cdid,
    dataset: i.dataset_id,
    title: i.title,
    releaseDate: String(i.release_date ?? "").slice(0, 10),
  }));
}

export async function getTimeseries(cdid: string, dataset?: string, periods = 13, frequency?: "months" | "quarters" | "years") {
  const code = cdid.trim().toUpperCase();
  const params = new URLSearchParams({ q: code, cdids: code, content_type: "timeseries", limit: "10" });
  const hits: any[] = (await getJson(`/search?${params}`)).items ?? [];
  const hit = hits.find((i) => !dataset || String(i.dataset_id).toUpperCase() === dataset.toUpperCase()) ?? hits[0];
  if (!hit?.uri) throw new Error(`Time series '${code}' not found. Use ons_search_timeseries.`);

  const res = await fetch(`${SITE}${hit.uri}/data`, { headers: HEADERS });
  if (!res.ok) throw new Error(`ONS ${res.status} for time series ${code}`);
  const ts = await res.json();
  const freq = frequency ?? (["months", "quarters", "years"] as const).find((f) => ts[f]?.length);
  const points: any[] = (freq && ts[freq]) || [];
  return {
    cdid: code,
    dataset: hit.dataset_id,
    title: ts.description?.title,
    unit: [...new Set([ts.description?.preUnit, ts.description?.unit].filter(Boolean))].join(" "),
    releaseDate: String(ts.description?.releaseDate ?? "").slice(0, 10),
    nextRelease: ts.description?.nextRelease,
    frequency: freq,
    source: "Office for National Statistics",
    rows: points.slice(-Math.max(1, Math.min(periods, 120))).map((p) => ({ period: p.label ?? p.date, value: Number(p.value) })),
  };
}

// ---------- Tool definitions for Mistral function calling ----------

export const onsTools = [
  {
    type: "function" as const,
    function: {
      name: "ons_search_timeseries",
      description:
        "Search ONS headline time series (each has a 4-character CDID and a dataset, e.g. MM23). These are updated on " +
        "release day and are the most current UK figures. Known CDIDs: L55O CPIH annual rate (MM23), D7G7 CPI annual " +
        "rate (MM23), MGSX unemployment rate 16+ SA (LMS), LF24 employment rate 16-64 SA (LMS), IHYQ GDP quarter-on-" +
        "quarter growth (QNA), ABMI GDP level (QNA).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords or a CDID, e.g. 'cpih annual rate' or 'L55O'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ons_get_timeseries",
      description: "Fetch an ONS time series by CDID: latest values with release date and next release. Prefer this for UK headline figures.",
      parameters: {
        type: "object",
        properties: {
          cdid: { type: "string", description: "e.g. 'L55O'." },
          dataset: { type: "string", description: "Optional dataset id when a CDID exists in several, e.g. 'MM23'." },
          periods: { type: "number", description: "Most recent periods to return (default 13)." },
          frequency: { type: "string", enum: ["months", "quarters", "years"], description: "Default: the most frequent available." },
        },
        required: ["cdid"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ons_search_datasets",
      description:
        "Search the UK Office for National Statistics (ONS) API datasets: e.g. CPIH inflation (cpih01), GDP " +
        "(gdp-to-four-decimal-places), retail sales, trade, weekly deaths, wellbeing, house prices, regional GDP, " +
        "population estimates, Census 2021. Datasets are updated at different speeds: check lastUpdated.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "English keywords, e.g. 'inflation', 'gdp', 'retail sales'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ons_get_dataset_metadata",
      description:
        "Get an ONS dataset's release date, dimensions and codes. For a large dimension, pass dimension plus search " +
        "text (e.g. dimension 'aggregate', search 'food').",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset id, e.g. 'cpih01'." },
          dimension: { type: "string" },
          search: { type: "string" },
        },
        required: ["dataset"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ons_get_data",
      description:
        "Fetch ONS observations. Give codes per dimension (several codes allowed, max 12 combinations). Omitted " +
        "dimensions default to the UK / total option; time defaults to the latest `periods` (13) periods.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string", description: "Dimension name, e.g. 'aggregate', 'geography', 'time'." },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["dimension", "values"],
            },
          },
          periods: { type: "number", description: "How many most recent periods to return (default 13, max 60)." },
        },
        required: ["dataset"],
      },
    },
  },
];

export async function runOnsTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "ons_search_timeseries":
      return searchTimeseries(String(args.query ?? ""));
    case "ons_get_timeseries":
      return getTimeseries(String(args.cdid ?? ""), args.dataset, args.periods, args.frequency);
    case "ons_search_datasets":
      return searchDatasets(String(args.query ?? ""));
    case "ons_get_dataset_metadata":
      return getDatasetMetadata(String(args.dataset), { dimension: args.dimension, search: args.search });
    case "ons_get_data":
      return getData(String(args.dataset), Array.isArray(args.filters) ? args.filters : [], args.periods);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
