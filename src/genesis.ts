// Destatis GENESIS-Online (Germany) RESTful/JSON API client, exposed to the model as tools.
// Base: https://genesis.destatis.de/genesisWS/rest/2020/  — POST only (GET was switched off on 30 June 2025).
// Auth: personal API token in the request header as `username`, with an empty `password` (server-side only).
// The token is read-only: no queued jobs (job=true), so requests are limited to 40,000 values in dialog mode.
// Endpoint parameters per the OpenAPI spec: https://genesis.destatis.de/genesisWS/rest/2020/GOJsonApi.json
// © Statistisches Bundesamt (Destatis). Reuse allowed with source: "Source: Destatis, GENESIS-Online".

import { inflateRawSync } from "node:zlib";

const BASE = (process.env.DESTATIS_API_BASE ?? "https://genesis.destatis.de/genesisWS/rest/2020").replace(/\/+$/, "");
const token = () => process.env.DESTATIS_API_TOKEN?.trim() ?? "";

export const genesisEnabled = () => token().length > 0;

async function post(path: string, data: Record<string, string>): Promise<{ status: number; type: string; body: Buffer }> {
  if (!genesisEnabled()) throw new Error("Germany (Destatis) is not configured: add DESTATIS_API_TOKEN to .env.");
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", username: token(), password: "" },
    body: new URLSearchParams({ language: "en", ...data }),
  });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: Buffer.from(await res.arrayBuffer()) };
}

/** GENESIS answers errors as JSON with Status.Code != 0, often with HTTP 200. */
function checkStatus(json: any) {
  const code = Number(json?.Status?.Code ?? 0);
  // 0 = OK, 22 = OK with notes (e.g. some values unavailable)
  if (code !== 0 && code !== 22) throw new Error(`Destatis ${code}: ${json?.Status?.Content ?? "error"}`);
}

async function postJson(path: string, data: Record<string, string>): Promise<any> {
  const { status, body } = await post(path, data);
  const text = body.toString("utf8");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Destatis ${status}: ${text.slice(0, 300)}`);
  }
  if (status === 401 || status === 403) throw new Error("Destatis rejected the token (check DESTATIS_API_TOKEN).");
  checkStatus(json);
  return json;
}

// ---------- tiny ZIP reader (GENESIS returns one CSV per ZIP) ----------

function unzipFirst(buf: Buffer): Buffer {
  // End of central directory record, searched from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Destatis: invalid ZIP response");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("Destatis: invalid ZIP directory");
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`Destatis: unsupported ZIP compression ${method}`);
}

// ---------- search ----------

export async function searchTables(query: string, limit = 12) {
  const json = await postJson("find/find", { term: query, category: "tables", pagelength: String(Math.min(Math.max(limit, 1), 50)) });
  return (json.Tables ?? []).slice(0, limit).map((t: any) => ({ code: t.Code, title: t.Content, time: t.Time }));
}

// ---------- metadata ----------

/** Codes of one variable (e.g. CC13A5 product groups, DLAND federal states), optionally filtered by label text. */
export async function getVariableValues(variable: string, search?: string) {
  const json = await postJson("catalogue/values2variable", {
    name: variable,
    selection: search ? `*${search.replace(/\*/g, "")}*` : "*",
    searchcriterion: search ? "Content" : "Code",
    pagelength: "100",
  });
  return (json.List ?? []).map((v: any) => ({ code: v.Code, label: v.Content }));
}

export async function getTableMetadata(table: string, opts: { variable?: string; search?: string } = {}) {
  if (opts.variable) {
    const values = await getVariableValues(opts.variable, opts.search);
    return { variable: opts.variable, search: opts.search, values: values.slice(0, 80), truncated: values.length > 80 };
  }
  const json = await postJson("metadata/table", { name: table });
  const o = json.Object ?? {};
  // Keep the structure (variables and their codes) compact for the model.
  const vars = (x: any) =>
    (Array.isArray(x) ? x : x ? [x] : []).map((v: any) => ({ code: v.Code, label: v.Content, type: v.Type, values: v.Values }));
  return {
    code: o.Code ?? table,
    title: o.Content,
    time: o.Time,
    // "Updated" is when the table's structure last changed, not when data was added: never report it as a release date.
    structureChanged: o.Updated,
    structure: {
      head: vars(o.Structure?.Head),
      columns: vars(o.Structure?.Columns),
      rows: vars(o.Structure?.Rows),
      subtitles: vars(o.Structure?.Subtitel ?? o.Structure?.Subtitles),
    },
    tips:
      "Filter with up to 5 classifying variables + keys ('*' wildcards, several keys comma-separated). Look up codes " +
      "by calling this tool with variable (+ optional search). Pick one measure with 'contents' (a value variable code). " +
      "and regionalvariable/regionalkey (e.g. DLAND with a Land code like 09 for Bavaria). Time via startyear/endyear.",
  };
}

// ---------- data ----------

const MISSING = new Set(["...", ".", "-", "/", "x", ""]);

const MONTHS = "january february march april may june july august september october november december".split(" ");

/** Sortable time key from row labels like ["2026", "October"], ["2026", "2nd quarter"] or ["2025"]. */
function timeKey(labels: string[]): string | null {
  // Reference dates such as "2025-12-31" or "31.12.2025".
  for (const l of labels) {
    const iso = l.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const de = l.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (de) return `${de[3]}-${de[2]}-${de[1]}`;
  }
  const year = labels.find((l) => /^\d{4}$/.test(l));
  if (!year) return null;
  const lower = labels.map((l) => l.toLowerCase());
  const month = lower.findIndex((l) => MONTHS.includes(l));
  if (month >= 0) return `${year}-${String(MONTHS.indexOf(lower[month]) + 1).padStart(2, "0")}`;
  const q = lower.map((l) => l.match(/^([1-4])(?:st|nd|rd|th) quarter$/)?.[1]).find(Boolean);
  if (q) return `${year}-Q${q}`;
  return `${year}`;
}

function toNumber(raw: string): { value: number | null; flag?: string } {
  const v = raw.trim();
  if (MISSING.has(v)) return { value: null };
  // English output: "+2.1", "-0.3", "83,577,140", sometimes with a trailing quality flag letter ("1.9 p").
  const m = v.replace(/\s/g, "").match(/^([+-]?[\d,]*\.?\d+)([a-z]*)$/i);
  if (!m) return { value: null };
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? { value: n, ...(m[2] ? { flag: m[2] } : {}) } : { value: null };
}

/**
 * Parse GENESIS "datencsv" (the table layout): title lines, header line(s) whose first k cells are empty
 * (k = number of row-label columns) naming the measures, then data lines, then "__________" and footnotes.
 * The flat "ffcsv" format was not used because it truncates measure names (e.g. two different rates both called "in").
 */
function parseDatencsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const cells = (l: string) => l.split(";").map((c) => c.replace(/^"|"$/g, "").trim());
  const title = cells(lines[1] ?? "")[0] ?? "";
  const endIdx = lines.findIndex((l) => /^_{5,}/.test(l));
  const body = lines.slice(0, endIdx < 0 ? undefined : endIdx);
  const notes = endIdx < 0 ? "" : lines.slice(endIdx + 1).filter((l) => l.trim() && !/^©|^created:/i.test(l)).join(" ").replace(/"/g, "").trim();

  // Header lines start with one or more empty cells; data lines start with a label.
  const firstHeader = body.findIndex((l, i) => i > 0 && /^;/.test(l) && cells(l).some((c) => c));
  type Parsed = { key: string | null; row: Record<string, string | number | null> };
  if (firstHeader < 0) return { title, context: "", notes, rows: [] as Parsed[] };
  // Lines between the title and the header describe the selection, e.g. "Consumer price index (2020=100)".
  const context = body
    .slice(2, firstHeader)
    .map((l) => cells(l)[0])
    .filter(Boolean)
    .join(" · ");
  let k = 0;
  const h0 = cells(body[firstHeader]);
  while (k < h0.length && h0[k] === "") k++;
  let firstData = firstHeader;
  while (firstData < body.length && /^;/.test(body[firstData])) firstData++;
  const headers = body.slice(firstHeader, firstData).map(cells);
  // The last header line usually holds units (e.g. "2020=100", "in (%)"), the others the measure names.
  const unitLine = headers.length > 1 ? headers[headers.length - 1] : [];
  const nameLines = headers.length > 1 ? headers.slice(0, -1) : headers;
  const width = Math.max(...headers.map((h) => h.length));
  const colName = (j: number) => nameLines.map((h) => h[j]).filter(Boolean).join(" · ");

  const rows: { key: string | null; row: Record<string, string | number | null> }[] = [];
  const carry: string[] = [];
  for (const line of body.slice(firstData)) {
    if (!line.trim()) continue;
    const c = cells(line);
    for (let i = 0; i < k; i++) if (c[i]) carry[i] = c[i]; // empty label cell = same as the line above
    const labels = carry.slice(0, k).filter(Boolean);
    const key = timeKey(labels);
    for (let j = k; j < width; j++) {
      const { value, flag } = toNumber(c[j] ?? "");
      if (value === null) continue;
      rows.push({
        key,
        row: { row: labels.join(" "), measure: colName(j), unit: unitLine[j] || null, value, ...(flag ? { flag } : {}) },
      });
    }
  }
  return { title, context, notes, rows };
}

export interface GenesisFilter {
  variable: string;
  keys: string[];
}

export async function getData(
  table: string,
  opts: {
    startyear?: string;
    endyear?: string;
    timeslices?: number;
    contents?: string;
    filters?: GenesisFilter[];
    regionalvariable?: string;
    regionalkey?: string;
    periods?: number;
  } = {},
) {
  const year = new Date().getFullYear();
  const data: Record<string, string> = {
    name: table,
    format: "datencsv",
    compress: "false",
  };
  if (opts.timeslices) data.timeslices = String(opts.timeslices);
  else data.startyear = opts.startyear ?? String(year - 2); // enough for a year-on-year comparison
  if (opts.contents) data.contents = opts.contents;
  if (opts.endyear) data.endyear = opts.endyear;
  (opts.filters ?? []).slice(0, 5).forEach((f, i) => {
    data[`classifyingvariable${i + 1}`] = f.variable;
    data[`classifyingkey${i + 1}`] = f.keys.join(",");
  });
  if (opts.regionalvariable) data.regionalvariable = opts.regionalvariable;
  if (opts.regionalkey) data.regionalkey = opts.regionalkey;

  const { status, body } = await post("data/tablefile", data);
  let csv: string;
  if (body.subarray(0, 2).toString() === "PK") csv = unzipFirst(body).toString("utf8");
  else {
    const text = body.toString("utf8");
    if (text.trimStart().startsWith("{")) {
      const json = JSON.parse(text);
      checkStatus(json);
      throw new Error(`Destatis ${status}: unexpected JSON response`);
    }
    csv = text;
  }

  const parsed = parseDatencsv(csv);
  // Keep the newest `periods` time points (default 13: enough for a year-on-year change). Rows without values
  // (not yet published, "...") are already dropped, so they don't use up the window.
  const keys = [...new Set(parsed.rows.map((r) => r.key).filter((k): k is string => !!k))].sort();
  const keep = new Set(keys.slice(-Math.max(1, Math.min(opts.periods ?? 13, 60))));
  const kept = parsed.rows.filter((r) => !r.key || keep.has(r.key));
  const latest = kept.map((r) => r.row);

  // Newest value per series (row labels without the time part + measure), so the model doesn't have to find it.
  const newest = new Map<string, { key: string; row: Record<string, string | number | null> }>();
  for (const r of kept) {
    if (!r.key) continue;
    const series = `${String(r.row.row).replace(/\b\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\b|\b[1-4](st|nd|rd|th) quarter\b/gi, "").trim()}|${r.row.measure}`;
    const prev = newest.get(series);
    if (!prev || r.key > prev.key) newest.set(series, { key: r.key, row: r.row });
  }
  const latestValues = [...newest.values()].map(({ row }) => ({ period: row.row, measure: row.measure, unit: row.unit, value: row.value }));

  return {
    table,
    title: parsed.title,
    latest: latestValues.slice(0, 30),
    ...(parsed.context ? { context: parsed.context } : {}),
    source: "Destatis, GENESIS-Online",
    totalRows: latest.length,
    truncated: latest.length > 250,
    rows: latest.slice(-250),
    ...(parsed.notes ? { notes: parsed.notes.slice(0, 600) } : {}),
  };
}

// ---------- Tool definitions for Mistral function calling ----------

export const genesisTools = [
  {
    type: "function" as const,
    function: {
      name: "destatis_search_tables",
      description:
        "Search Destatis GENESIS-Online, Germany's official statistics (federal and Länder level). Returns table codes " +
        "like '61111-0002'. Known tables: 61111-0002 consumer price index monthly (with annual rate of change), " +
        "12411-0001 population, 13211-0002 unemployment (BA) monthly, 81000-0002 GDP. English or German keywords.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords, e.g. 'consumer price index' or 'Verbraucherpreisindex'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "destatis_get_table_metadata",
      description:
        "Get a Destatis table's structure: variables usable as filters, measures and time coverage. To find codes of one " +
        "variable, also pass variable (e.g. 'CC13A5', 'DLAND') and optional search text.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table code, e.g. '61111-0002'." },
          variable: { type: "string" },
          search: { type: "string", description: "Text to find in the variable's value labels, e.g. 'Bayern'." },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "destatis_get_data",
      description:
        "Fetch data from a Destatis table (flat rows). Defaults to the last 2 years and the latest 13 periods. Optional " +
        "filters: up to 5 classifying variables with keys ('*' wildcards allowed), a regional variable/key, and " +
        "'contents' to pick one measure (e.g. the annual rate of change). timeslices limits to the newest N time slices.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          startyear: { type: "string" },
          endyear: { type: "string" },
          timeslices: { type: "number" },
          contents: { type: "string", description: "Value variable code (a measure) from the metadata." },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: { variable: { type: "string" }, keys: { type: "array", items: { type: "string" } } },
              required: ["variable", "keys"],
            },
          },
          regionalvariable: { type: "string", description: "e.g. 'DLAND' (federal states)." },
          regionalkey: { type: "string", description: "e.g. '09' (Bavaria), '11' (Berlin), '*' for all." },
          periods: { type: "number", description: "Most recent periods to keep (default 13)." },
        },
        required: ["table"],
      },
    },
  },
];

export async function runGenesisTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case "destatis_search_tables":
      return searchTables(String(args.query ?? ""));
    case "destatis_get_table_metadata":
      return getTableMetadata(String(args.table), { variable: args.variable, search: args.search });
    case "destatis_get_data":
      return getData(String(args.table), {
        startyear: args.startyear,
        endyear: args.endyear,
        timeslices: args.timeslices,
        contents: args.contents,
        filters: Array.isArray(args.filters) ? args.filters : [],
        regionalvariable: args.regionalvariable,
        regionalkey: args.regionalkey,
        periods: args.periods,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
