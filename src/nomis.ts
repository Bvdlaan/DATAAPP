// Nomis (UK official labour market & census statistics from ONS) API v01 client, exposed to the model as tools.
// Docs: https://www.nomisweb.co.uk/api/v01/help
// No key needed (guests: 25,000 cells per request). Optional NOMIS_UID raises that limit; it is a secret, server-side only.
// Licence: Crown Copyright, reusable under the Open Government Licence (credit "Source: ONS, via Nomis").

import { flattenJsonStat } from "./jsonstat.js";

const ROOT = (process.env.NOMIS_API_BASE ?? "https://www.nomisweb.co.uk/api/v01").replace(/\/+$/, "");
const UID = process.env.NOMIS_UID?.trim();
const DAY = 24 * 3_600_000;

async function getJson(path: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${ROOT}${path}${UID ? `${sep}uid=${encodeURIComponent(UID)}` : ""}`);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Nomis ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json?.error) throw new Error(`Nomis ${res.status}: ${json?.error ?? text.slice(0, 300)}`);
  return json;
}

const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// ---------- dataset list (~1,600 datasets, 5.5 MB, cached 24 h) ----------

interface DatasetInfo {
  id: string;
  name: string;
  description: string;
  keywords: string;
  status: string;
  lastUpdated: string;
  dimensions: string[]; // concept refs, e.g. GEOGRAPHY, SEX, ITEM, MEASURES
}
let list: { at: number; items: DatasetInfo[] } | null = null;
let loading: Promise<DatasetInfo[]> | null = null;

async function loadList(): Promise<DatasetInfo[]> {
  if (list && Date.now() - list.at < DAY) return list.items;
  loading ??= (async () => {
    try {
      const json = await getJson("/dataset/def.sdmx.json");
      const items = asArray<any>(json.structure?.keyfamilies?.keyfamily).map((k) => {
        const ann = new Map(asArray<any>(k.annotations?.annotation).map((a) => [a.annotationtitle, String(a.annotationtext ?? "")]));
        return {
          id: k.id,
          name: k.name?.value ?? k.id,
          description: k.description?.value ?? "",
          keywords: ann.get("Keywords") ?? "",
          status: ann.get("Status") ?? "",
          lastUpdated: ann.get("LastUpdated") ?? "",
          dimensions: asArray<any>(k.components?.dimension).map((d) => String(d.conceptref)),
        };
      });
      list = { at: Date.now(), items };
      return items;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Start downloading the dataset list in the background (called at server start). */
export function prewarmNomis() {
  loadList().catch((e) => console.warn("Nomis prewarm failed:", e instanceof Error ? e.message : e));
}

export async function searchDatasets(query: string, limit = 12) {
  const words = query.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 1);
  const need = Math.max(1, Math.ceil(words.length / 2));
  const items = await loadList();
  return items
    .map((d) => {
      const name = d.name.toLowerCase();
      const hay = `${name} ${d.keywords} ${d.description} ${d.id}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      if (hits < need) return null;
      const score =
        hits * 20 +
        words.filter((w) => name.includes(w)).length * 10 +
        (/^current/i.test(d.status) ? 15 : 0) +
        (words.includes(d.id.toLowerCase()) ? 100 : 0) -
        name.length / 30;
      return { d, score };
    })
    .filter((x): x is { d: DatasetInfo; score: number } => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ d }) => ({ id: d.id, name: d.name, status: d.status, lastUpdated: d.lastUpdated, description: d.description.slice(0, 200) }));
}

// ---------- structure: dimensions and their codes ----------

async function codes(dataset: string, dimension: string, search?: string) {
  const dim = dimension.toLowerCase();
  const q = search ? `?search=${encodeURIComponent(`*${search.replace(/\*/g, "")}*`)}` : "";
  const json = await getJson(`/dataset/${encodeURIComponent(dataset)}/${encodeURIComponent(dim)}.def.sdmx.json${q}`);
  return asArray<any>(json.structure?.codelists?.codelist?.[0]?.code).map((c) => ({
    code: String(c.value),
    label: c.description?.value ?? String(c.value),
  }));
}

// Bigger, more commonly asked-about area types first; tiny statistical areas last.
function geoRank(type: string) {
  const t = type.toLowerCase();
  if (/international territorial/.test(t)) return 6; // EU-style statistical areas (ITL), rarely what people mean
  if (/countr|\bnations?\b/.test(t)) return 0;
  if (/region/.test(t) && !/parliament/.test(t)) return 1;
  if (/combined authorit|county/.test(t)) return 2;
  if (/local authorit/.test(t)) return /2023|current|latest/.test(t) ? 3 : 4;
  if (/constituenc/.test(t)) return 5;
  if (/built-up|towns and cities/.test(t)) return 6;
  if (/super output|output area|ward|jobcentre|grid/.test(t)) return 9;
  return 7;
}

/** Search the dataset's full geography codelist (all area types), returning GSS codes where available. */
async function searchGeography(dataset: string, search: string) {
  const cl = `CL_${dataset.replace(/^NM_/i, "")}_GEOGRAPHY`;
  const json = await getJson(`/codelist/${encodeURIComponent(cl)}.def.sdmx.json?search=${encodeURIComponent(`*${search.replace(/\*/g, "")}*`)}`);
  return asArray<any>(json.structure?.codelists?.codelist?.[0]?.code)
    .map((c) => {
      const ann = new Map(asArray<any>(c.annotations?.annotation).map((a) => [a.annotationtitle, String(a.annotationtext ?? "")]));
      const gss = ann.get("GeogCode") ?? "";
      const type = ann.get("TypeName") ?? "";
      return { code: /^[EKNSW]\d{8}$/.test(gss) ? gss : String(c.value), label: c.description?.value ?? "", type, rank: geoRank(type) };
    })
    .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length)
    .filter((g, i, all) => all.findIndex((x) => x.code === g.code) === i) // same area listed per boundary year
    .map(({ rank, ...rest }) => rest);
}

export async function getDatasetMetadata(dataset: string, opts: { dimension?: string; search?: string } = {}, maxValues = 40) {
  // Look up codes within one dimension, e.g. geography 'manchester' or variable 'unemployment rate'.
  if (opts.dimension?.toLowerCase() === "geography" && opts.search) {
    const found = await searchGeography(dataset, opts.search);
    return { dataset, dimension: "geography", search: opts.search, values: found.slice(0, 25), truncated: found.length > 25 };
  }
  if (opts.dimension) {
    const found = await codes(dataset, opts.dimension, opts.search);
    return { dataset, dimension: opts.dimension, search: opts.search, values: found.slice(0, 80), truncated: found.length > 80 };
  }

  const info = (await loadList()).find((d) => d.id.toLowerCase() === dataset.toLowerCase());
  if (!info) throw new Error(`Unknown Nomis dataset '${dataset}'. Use nomis_search_datasets first.`);
  const dims = await Promise.all(
    info.dimensions
      .filter((d) => d !== "FREQ")
      .map(async (d) => {
        const vals = await codes(dataset, d).catch(() => []);
        return { code: d.toLowerCase(), valueCount: vals.length, values: vals.slice(0, maxValues), truncated: vals.length > maxValues };
      }),
  );
  return {
    id: info.id,
    name: info.name,
    description: info.description,
    status: info.status,
    lastUpdated: info.lastUpdated,
    dimensions: dims,
    tips:
      "Geography accepts GSS codes: K02000001 UK, K03000001 Great Britain, E92000001 England, W92000004 Wales, " +
      "S92000003 Scotland, N92000002 Northern Ireland, E12000007 London (regions E12000001-E12000009). " +
      "To find a local area, call this tool with dimension 'geography' and search, e.g. 'manchester'. " +
      "Omitted dimensions use Nomis's 'default' code (usually the total).",
  };
}

// ---------- data ----------

export interface NomisFilter {
  dimension: string;
  values: string[];
}

/** Fetch data as JSON-stat. Defaults: geography = UK, time = latest, other omitted dimensions = 'default'. */
export async function getData(dataset: string, filters: NomisFilter[] = [], time?: string) {
  const info = (await loadList()).find((d) => d.id.toLowerCase() === dataset.toLowerCase());
  const params = new URLSearchParams();
  for (const f of filters) {
    const dim = f.dimension.toLowerCase();
    if (dim === "time" || dim === "date") {
      time ??= f.values.join(",");
      continue;
    }
    params.set(dim, f.values.join(","));
  }
  params.set("date", time || "latest");
  if (!params.has("geography")) params.set("geography", "K02000001");
  for (const d of info?.dimensions ?? []) {
    const dim = d.toLowerCase();
    if (dim !== "geography" && dim !== "freq" && !params.has(dim)) params.set(dim, "default");
  }

  const json = await getJson(`/dataset/${encodeURIComponent(dataset)}.jsonstat.json?${params}`);
  const result = flattenJsonStat(json);
  if (result.rows.length === 0) {
    return { ...result, note: "No values. Check codes with nomis_get_dataset_metadata, or try another date (e.g. 'latestMINUS1')." };
  }
  return result;
}

// ---------- Tool definitions for Mistral function calling ----------

export const nomisTools = [
  {
    type: "function" as const,
    function: {
      name: "nomis_search_datasets",
      description:
        "Search Nomis, the UK's official labour market and census statistics from ONS (UK, England, Wales, Scotland, " +
        "Northern Ireland, regions, local authorities). Use for UK employment, unemployment, claimant count, earnings, " +
        "jobs, population estimates and Census 2021. Examples: NM_162_1 claimant count, NM_59_1 Labour Force Survey " +
        "headline indicators, NM_17_5 Annual Population Survey percentages, NM_30_1 earnings (ASHE), NM_2002_1 population estimates.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "English keywords, e.g. 'claimant count', 'earnings', 'labour force survey'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "nomis_get_dataset_metadata",
      description:
        "Get a Nomis dataset's dimensions and codes. To look up codes in one large dimension (e.g. a local area, or an " +
        "APS 'variable'), pass dimension plus search text.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string", description: "Dataset id, e.g. 'NM_162_1'." },
          dimension: { type: "string", description: "Optional: one dimension to look up, e.g. 'geography' or 'variable'." },
          search: { type: "string", description: "Optional search text within that dimension, e.g. 'manchester'." },
        },
        required: ["dataset"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "nomis_get_data",
      description:
        "Fetch Nomis data. Filters: dimension + codes (several codes allowed). Geography defaults to the UK (K02000001); " +
        "use GSS codes like E92000001, or 'TYPE480' for all regions. Omitted dimensions use the default (usually total). " +
        "date: 'latest' (default), 'latestMINUS12' (a year earlier for monthly data), or a range like 'latestMINUS11-latest'.",
      parameters: {
        type: "object",
        properties: {
          dataset: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string", description: "Dimension code, e.g. 'geography', 'gender', 'measures', 'item'." },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["dimension", "values"],
            },
          },
          date: { type: "string", description: "Time selection, default 'latest'." },
        },
        required: ["dataset"],
      },
    },
  },
];

export async function runNomisTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "nomis_search_datasets":
      return searchDatasets(String(args.query ?? ""));
    case "nomis_get_dataset_metadata":
      return getDatasetMetadata(String(args.dataset), { dimension: args.dimension, search: args.search });
    case "nomis_get_data":
      return getData(String(args.dataset), Array.isArray(args.filters) ? args.filters : [], args.date);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
