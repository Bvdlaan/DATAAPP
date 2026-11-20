// Statistics Sweden (SCB) PxWebApi v2 client, exposed to the model as tools.
// Docs: https://www.scb.se/en/services/open-data-api/
// Open data (CC0), no key. Limits: 30 calls / 10 s per IP, max 150,000 cells per request.

import { flattenJsonStat } from "./jsonstat.js";

const BASE = (process.env.SCB_API_BASE ?? "https://api.scb.se/OV0104/v2beta/api/v2").replace(/\/+$/, "");

type Lang = "en" | "sv";

interface Selection {
  variableCode: string;
  valueCodes: string[];
  codelist?: string;
}

async function scbFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SCB ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

export async function searchTables(query: string, lang: Lang = "en", pageSize = 10) {
  const q = new URLSearchParams({ lang, query, pageSize: String(Math.min(Math.max(pageSize, 1), 30)) });
  const json = await scbFetch(`/tables?${q}`);
  return (json.tables ?? []).map((t: any) => ({
    id: t.id,
    label: t.label,
    firstPeriod: t.firstPeriod,
    lastPeriod: t.lastPeriod,
    updated: t.updated,
  }));
}

/** Compact metadata: per variable its label and (a sample of) value codes/labels. */
export async function getTableMetadata(tableId: string, lang: Lang = "en", maxValues = 40) {
  const json = await scbFetch(`/tables/${encodeURIComponent(tableId)}/metadata?lang=${lang}&outputFormat=json-stat2`);
  const variables = (json.id as string[]).map((code) => {
    const dim = json.dimension[code];
    const index: Record<string, number> = dim.category.index ?? {};
    const labels: Record<string, string> = dim.category.label ?? {};
    const codes = Object.keys(index).sort((a, b) => index[a] - index[b]);
    const shown = code === "Tid" ? codes.slice(-maxValues) : codes.slice(0, maxValues);
    return {
      code,
      label: dim.label,
      role: Object.entries(json.role ?? {}).find(([, v]) => (v as string[]).includes(code))?.[0],
      valueCount: codes.length,
      values: shown.map((c) => ({ code: c, label: labels[c] ?? c })),
      truncated: codes.length > shown.length,
    };
  });
  return { id: tableId, label: json.label, updated: json.updated, source: json.source, variables };
}

export async function getDefaultSelection(tableId: string, lang: Lang = "en"): Promise<Selection[]> {
  const json = await scbFetch(`/tables/${encodeURIComponent(tableId)}/defaultselection?lang=${lang}`);
  return json.selection ?? [];
}

/**
 * Fetch data. Variables the caller omits are filled from the table's default selection,
 * so mandatory variables never cause a 400.
 */
export async function getData(tableId: string, selection: Selection[] = [], lang: Lang = "en") {
  const defaults = await getDefaultSelection(tableId, lang);
  const given = new Set(selection.map((s) => s.variableCode));
  const merged = [...selection, ...defaults.filter((d) => !given.has(d.variableCode))];

  const json = await scbFetch(`/tables/${encodeURIComponent(tableId)}/data?lang=${lang}&outputFormat=json-stat2`, {
    method: "POST",
    body: JSON.stringify({ selection: merged }),
  });
  return flattenJsonStat(json);
}

// ---- Tool definitions for Mistral function calling ----

export const scbTools = [
  {
    type: "function" as const,
    function: {
      name: "scb_search_tables",
      description: "Search Statistics Sweden (SCB) tables by keyword. Returns table ids, labels and period coverage.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search words, e.g. 'population', 'unemployment', 'CPI'." },
          lang: { type: "string", enum: ["en", "sv"], description: "Language (default en)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scb_get_table_metadata",
      description: "Get a table's variables and their value codes. Call this before scb_get_data to pick valid codes.",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string", description: "Table id, e.g. 'TAB6473'." },
          lang: { type: "string", enum: ["en", "sv"] },
        },
        required: ["tableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scb_get_data",
      description:
        "Fetch data from an SCB table. Give a selection per variable; omitted variables use the table's default selection. " +
        "Value codes support '*' wildcards and expressions like 'TOP(3)' (latest 3 periods).",
      parameters: {
        type: "object",
        properties: {
          tableId: { type: "string" },
          selection: {
            type: "array",
            items: {
              type: "object",
              properties: {
                variableCode: { type: "string" },
                valueCodes: { type: "array", items: { type: "string" } },
                codelist: { type: "string", description: "Optional codelist id, e.g. for region groupings." },
              },
              required: ["variableCode", "valueCodes"],
            },
          },
          lang: { type: "string", enum: ["en", "sv"] },
        },
        required: ["tableId"],
      },
    },
  },
];

export async function runScbTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "scb_search_tables":
      return searchTables(String(args.query ?? ""), args.lang);
    case "scb_get_table_metadata":
      return getTableMetadata(String(args.tableId), args.lang);
    case "scb_get_data":
      return getData(String(args.tableId), Array.isArray(args.selection) ? args.selection : [], args.lang);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
