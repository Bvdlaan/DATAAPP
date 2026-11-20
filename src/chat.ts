import { Mistral } from "@mistralai/mistralai";
import type { ChatCompletionRequestMessage as Messages } from "@mistralai/mistralai/models/components";
import { scbTools, runScbTool } from "./scb.js";
import { ssbTools, runSsbTool } from "./ssb.js";
import { eurostatTools, runEurostatTool } from "./eurostat.js";

const MODEL = "mistral-small-latest";
const MAX_TOOL_ROUNDS = 10;

const TOOLS = [...scbTools, ...ssbTools, ...eurostatTools];
const runTool = (name: string, args: any) =>
  name.startsWith("ssb_") ? runSsbTool(name, args) : name.startsWith("eurostat_") ? runEurostatTool(name, args) : runScbTool(name, args);

const SYSTEM_PROMPT = `You are a helpful assistant with live access to official open data from
Statistics Sweden (SCB, tools scb_*), Statistics Norway (SSB, tools ssb_*) and Eurostat (tools eurostat_*).
Which source to use:
- Sweden only: SCB (most detailed, often more recent). Norway only: SSB.
- Other European countries, the EU/euro area, or comparisons across countries: Eurostat, because its definitions
  are harmonised so figures are comparable. Eurostat also covers Sweden and Norway (geo codes SE, NO).
Workflow: search, inspect metadata to choose valid codes, then fetch data.
Prefer the most recent period unless asked otherwise. Always state the source, table/dataset id and period you used.
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
    const res = await mistral.chat.complete({
      model: MODEL,
      messages,
      tools: TOOLS,
      toolChoice: round === MAX_TOOL_ROUNDS ? "none" : "auto",
    });

    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error("Empty response from Mistral");

    const calls = msg.toolCalls ?? [];
    if (calls.length === 0) return { reply: asText(msg.content), toolsUsed };

    messages.push({ ...msg, role: "assistant" });

    for (const call of calls) {
      const name = call.function.name;
      toolsUsed.push(name);
      let result: unknown;
      try {
        const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments || "{}") : call.function.arguments;
        result = await runTool(name, args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      messages.push({ role: "tool", name, toolCallId: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: "Sorry, I couldn't finish looking that up.", toolsUsed };
}
