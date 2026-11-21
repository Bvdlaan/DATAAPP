// Statistics Norway (SSB) StatBank PxWebApi v0 client, exposed to the model as tools.
// Docs: https://www.ssb.no/api/pxwebapi  — license CC BY 4.0 (credit "Statistics Norway").
// No key. Query = JSON POSTed to the table URL; max 800,000 cells per request, ~30 queries/min.

import { flattenJsonStat } from "./jsonstat.js";

const ROOT = (process.env.SSB_API_BASE ?? "https://data.ssb.no/api/v0").replace(/\/+$/, "");

type Lang = "en" | "no";

interface SsbVariable {
  code: string;
  text: string;
  values: string[];
  valueTexts: string[];
  elimination?: boolean;
  time?: boolean;
}

export interface SsbSelection {
  code: string;
  values: string[];
  filter?: "item" | "all" | "top" | "agg" | "vs";
}

async function ssbFetch(path: string, lang: Lang, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ROOT}/${lang}${path}`, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SSB ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const tableIdOf = (s: string) => s.match(/^\s*(\d{5})\s*:/)?.[1];

export async function searchTables(query: string, lang: Lang = "en", limit = 10) {
  const json: any[] = await ssbFetch(`/table/?query=${encodeURIComponent(query)}`, lang);
  const seen = new Set<string>();
  const out: { id: string; title: string; published?: string }[] = [];
  for (const t of json) {
    const id = tableIdOf(t.title ?? "");
    if (!id || seen.has(id)) continue; // same table can appear under several menu paths
    seen.add(id);
    out.push({ id, title: t.title, published: t.published });
    if (out.length >= limit) break;
  }
  return out;
}

async function rawMetadata(tableId: string, lang: Lang): Promise<{ title: string; variables: SsbVariable[] }> {
  return ssbFetch(`/table/${encodeURIComponent(tableId)}`, lang);
}

export async function getTableMetadata(tableId: string, lang: Lang = "en", maxValues = 40) {
  const meta = await rawMetadata(tableId, lang);
  return {
    id: tableId,
    title: meta.title,
    variables: meta.variables.map((v) => {
      const idx = v.values.map((_, i) => i);
      const shown = v.time ? idx.slice(-maxValues) : idx.slice(0, maxValues);
      return {
        code: v.code,
        label: v.text,
        isTime: !!v.time,
        optional: !!v.elimination, // may be omitted -> SSB aggregates over it
        valueCount: v.values.length,
        values: shown.map((i) => ({ code: v.values[i], label: v.valueTexts[i] })),
        truncated: v.values.length > shown.length,
      };
    }),
  };
}

/**
 * Fetch data. Omitted variables: optional ones are aggregated by SSB; mandatory ones default to
 * the latest period (time) or all values (e.g. ContentsCode), so the query never 400s on a missing variable.
 */
export async function getData(tableId: string, selection: SsbSelection[] = [], lang: Lang = "en") {
  const meta = await rawMetadata(tableId, lang);
  const given = new Map(selection.map((s) => [s.code, s]));
  const query = meta.variables.flatMap((v) => {
    const s = given.get(v.code);
    if (s) {
      const filter = s.filter ?? (s.values.some((x) => x.includes("*")) ? "all" : "item");
      return [{ code: v.code, selection: { filter, values: s.values } }];
    }
    if (v.elimination) return [];
    if (v.time) return [{ code: v.code, selection: { filter: "top", values: ["1"] } }];
    return [{ code: v.code, selection: { filter: "item", values: v.values } }];
  });

  const json = await ssbFetch(`/table/${encodeURIComponent(tableId)}`, lang, {
    method: "POST",
    body: JSON.stringify({ query, response: { format: "json-stat2" } }),
  });
  return flattenJsonStat(json);
}

// ---- Tool definitions for Mistral function calling ----

export const ssbTools = [
  {
    type: "function" as const,
    function: {
      name: "ssb_search_tables",
      description: "Search Statistics Norway (SSB, StatBank) tables by keyword. Returns 5-digit table ids and titles. English ranking is weak: if results look off, retry with Norwegian terms and lang 'no' (e.g. 'folkemengde' = population, 'arbeidsledighet' = unemployment, 'konsumprisindeks' = CPI). Well-known tables: 07459 population by region/sex/age/year.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search words, e.g. 'population', 'unemployment', 'CPI'." },
          lang: { type: "string", enum: ["en", "no"], description: "Language (default en)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ssb_get_table_metadata",
      description:
        "Get an SSB table's variables and value codes. Variables marked optional can be omitted (SSB sums over them). Call before ssb_get_data.",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string", description: "5-digit table id, e.g. '07459'." },
          lang: { type: "string", enum: ["en", "no"] },
        },
        required: ["tableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ssb_get_data",
      description:
        "Fetch data from an SSB table. Omitted mandatory variables default to the latest period / all contents. " +
        "filter: 'item' (exact codes, default), 'all' (wildcards like '*'), 'top' (values ['3'] = latest 3 periods).",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          selection: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: { type: "string", description: "Variable code, e.g. 'Region', 'Tid'." },
                values: { type: "array", items: { type: "string" } },
                filter: { type: "string", enum: ["item", "all", "top"] },
              },
              required: ["code", "values"],
            },
          },
          lang: { type: "string", enum: ["en", "no"] },
        },
        required: ["tableId"],
      },
    },
  },
];

export async function runSsbTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "ssb_search_tables":
      return searchTables(String(args.query ?? ""), args.lang);
    case "ssb_get_table_metadata":
      return getTableMetadata(String(args.tableId), args.lang);
    case "ssb_get_data":
      return getData(String(args.tableId), Array.isArray(args.selection) ? args.selection : [], args.lang);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
