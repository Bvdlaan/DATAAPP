import { Mistral } from "@mistralai/mistralai";
import type { ChatCompletionRequestMessage as Messages } from "@mistralai/mistralai/models/components";
import { scbTools, runScbTool } from "./scb.js";
import { ssbTools, runSsbTool } from "./ssb.js";
import { eurostatTools, runEurostatTool } from "./eurostat.js";
import { nomisTools, runNomisTool } from "./nomis.js";
import { onsTools, runOnsTool } from "./ons.js";

const MODEL = "mistral-small-latest";
const MAX_TOOL_ROUNDS = 16;

const TOOLS = [...scbTools, ...ssbTools, ...eurostatTools, ...nomisTools, ...onsTools];
const RUNNERS: [string, (name: string, args: any) => Promise<unknown>][] = [
  ["scb_", runScbTool],
  ["ssb_", runSsbTool],
  ["eurostat_", runEurostatTool],
  ["nomis_", runNomisTool],
  ["ons_", runOnsTool],
];
const runTool = (name: string, args: any) => {
  const runner = RUNNERS.find(([prefix]) => name.startsWith(prefix))?.[1];
  if (!runner) throw new Error(`Unknown tool: ${name}`);
  return runner(name, args);
};

const SYSTEM_PROMPT = `You are a helpful assistant with live access to official open data from
Statistics Sweden (SCB, tools scb_*), Statistics Norway (SSB, tools ssb_*), Eurostat (tools eurostat_*)
Nomis, the UK's official labour market and census statistics (tools nomis_*), and the UK Office for National
Statistics API (tools ons_*).
Which source to use:
- Sweden only: SCB (most detailed, often more recent). Norway only: SSB.
- United Kingdom jobs, unemployment, claimants, earnings, population and Census, incl. local areas: Nomis.
- United Kingdom headline economics (inflation, GDP growth, unemployment/employment rate): ONS time series first
  (ons_search_timeseries / ons_get_timeseries, e.g. L55O CPIH annual rate, D7G7 CPI annual rate, MGSX unemployment
  rate, IHYQ GDP growth). They are current and state their release date.
- Detailed UK breakdowns (CPIH by product group, GDP by industry, retail sales, trade, deaths, wellbeing, house prices):
  ONS datasets (ons_search_datasets / ons_get_dataset_metadata / ons_get_data). These are updated at different speeds:
  always state the release date and say so when data is old. Index series need the % change computed; say you did.
- Eurostat has no current UK data (only up to 2020).
- Other European countries, the EU/euro area, or comparisons across EU/EEA countries: Eurostat, because its
  definitions are harmonised so figures are comparable. Eurostat also covers Sweden and Norway (geo codes SE, NO).
- Comparing the UK with other countries: use Nomis for the UK and Eurostat for the rest, and mention that
  definitions or periods may differ slightly.
Workflow: search, inspect metadata to choose valid codes, then fetch data.
Report each figure's period exactly as it appears in the data rows; never relabel or guess a period. If the newest
data is older than expected, say so. Only describe data with properties the tool results show (e.g. never call a series seasonally adjusted unless
the metadata says so). Prefer the most recent period unless asked otherwise. Always state the source, table/dataset id and period you used.
When rows contain several periods, present them as a small markdown table.
Answer in the user's language. Be concise.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

let client: Mistral | null = null;
function getClient(): Mistral {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new MissingKeyError();
  client ??= new Mistral({ apiKey });
  return client;
}

export class MissingKeyError extends Error {
  constructor() {
    super("MISTRAL_API_KEY is not set. Copy .env.example to .env and add your key.");
  }
}

/** Remove tool-call JSON a model sometimes writes into its text (e.g. {"cdid": "L55O", ...} or [TOOL_CALLS]...). */
function cleanReply(text: string): string {
  return text
    .replace(/\[TOOL_CALLS\][\s\S]*$/, "")
    .replace(/\{\s*"(?:cdid|dataset|tableId|query|filters|selection)"\s*:[^{}]*\}/g, "")
    .trim();
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

export async function chat(history: ChatTurn[]): Promise<{ reply: string; toolsUsed: string[] }> {
  const mistral = getClient();
  const messages: Messages[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((t) => ({ role: t.role, content: t.content }) as Messages),
  ];
  const toolsUsed: string[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const last = round === MAX_TOOL_ROUNDS;
    if (last) {
      // Out of tool budget: make the model answer from what it has instead of writing a tool call as text.
      messages.push({
        role: "user",
        content:
          "(Note from the app: no more data lookups are possible. Write your final answer now, using only the tool " +
          "results above. If something could not be found, say so briefly.)",
      });
    }
    const res = await mistral.chat.complete({
      model: MODEL,
      messages,
      tools: TOOLS,
      toolChoice: last ? "none" : "auto",
    });

    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error("Empty response from Mistral");

    const calls = msg.toolCalls ?? [];
    if (calls.length === 0) return { reply: cleanReply(asText(msg.content)), toolsUsed };

    messages.push({ ...msg, role: "assistant" });

    // Independent lookups in one round run in parallel.
    const results = await Promise.all(
      calls.map(async (call) => {
        const name = call.function.name;
        toolsUsed.push(name);
        try {
          const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : call.function.arguments;
          return { call, result: await runTool(name, args) };
        } catch (err) {
          return { call, result: { error: err instanceof Error ? err.message : String(err) } };
        }
      }),
    );
    for (const { call, result } of results) {
      messages.push({ role: "tool", name: call.function.name, toolCallId: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: "Sorry, I couldn't finish looking that up.", toolsUsed };
}
