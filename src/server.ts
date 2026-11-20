import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MistralError } from "@mistralai/mistralai/models/errors";
import { chat, MissingKeyError, type ChatTurn } from "./chat.js";
import { getData as scbData } from "./scb.js";
import { getData as ssbData } from "./ssb.js";
import { prewarmNomis } from "./nomis.js";
import { genesisEnabled } from "./genesis.js";
import { clientId, takeChatQuota, limitsInfo } from "./limits.js";

// Latest total population of Sweden (SCB TAB6473, monthly) and Norway (SSB 07459, yearly). Cached 1 hour.
let headlineCache: { at: number; data: unknown } | null = null;
async function headline() {
  if (headlineCache && Date.now() - headlineCache.at < 3_600_000) return headlineCache.data;
  const [se, no] = await Promise.all([
    scbData("TAB6473", [
      { variableCode: "Region", valueCodes: ["00"] },
      { variableCode: "Kon", valueCodes: ["TotSa"] },
      { variableCode: "Forandringar", valueCodes: ["100"] },
    ]),
    ssbData("07459", []),
  ]);
  const pick = (d: { rows: Record<string, unknown>[] }) => {
    const row = d.rows[d.rows.length - 1];
    const period = Object.entries(row).find(([k]) => /^(month|year|tid|år|måned)$/i.test(k))?.[1];
    return { value: Number(row.value), period: String(period ?? "") };
  };
  const data = { sweden: pick(se), norway: pick(no) };
  headlineCache = { at: Date.now(), data };
  return data;
}

const PORT = Number(process.env.PORT ?? 3000);
const INDEX = fileURLToPath(new URL("../public/index.html", import.meta.url));
const MAX_BODY = 200_000;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validHistory(x: unknown): x is ChatTurn[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.length <= 50 &&
    x.every((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.length <= 8000)
  );
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(INDEX));
      return;
    }

    if (req.method === "GET" && req.url === "/api/status") {
      return send(res, 200, { destatis: genesisEnabled() }); // only a yes/no, never the token
    }

    if (req.method === "GET" && req.url === "/api/headline") {
      try {
        return send(res, 200, await headline());
      } catch (err) {
        console.error("headline:", err instanceof Error ? err.message : err);
        return send(res, 502, { error: "Could not load headline data" });
      }
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      if (!validHistory(body?.messages)) return send(res, 400, { error: "Expected { messages: [{ role, content }] }" });

      // Usage limits: per user per minute/day, plus a global daily cap that protects the Mistral bill.
      const quota = takeChatQuota(clientId(req));
      if (!quota.ok) {
        res.setHeader("Retry-After", String(quota.retryAfterSec));
        return send(res, 429, { error: quota.message, reason: quota.reason, retryAfterSec: quota.retryAfterSec });
      }

      try {
        return send(res, 200, await chat(body.messages));
      } catch (err) {
        if (err instanceof MissingKeyError) return send(res, 500, { error: err.message });
        if (err instanceof MistralError) {
          console.error(`Mistral API error ${err.statusCode}`);
          // Temporary errors were already retried with backoff; show a human message instead of a code.
          const busy = err.statusCode === 429 || err.statusCode >= 500;
          return send(res, 502, {
            error: busy ? "The AI service is busy right now. Please try again in a minute." : `AI service error (${err.statusCode}).`,
          });
        }
        throw err;
      }
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    if (!res.headersSent) send(res, 500, { error: "Internal server error" });
  }
});

// Default: only reachable from this computer. Set HOST=0.0.0.0 when hosting the backend for the mobile app.
const HOST = process.env.HOST?.trim() || "127.0.0.1";

server.listen(PORT, HOST, () => {
  console.log(`DATAAPP running on http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
  const l = limitsInfo();
  console.log(`Limits: ${l.perMinute}/min and ${l.perDay}/day per user, ${l.globalPerDay}/day in total${l.trustProxy ? " (behind proxy)" : ""}`);
  if (!process.env.MISTRAL_API_KEY) console.warn("Warning: MISTRAL_API_KEY is not set (see .env.example)");
  prewarmNomis(); // the Nomis dataset list takes ~8 s to download; fetch it before the first UK question
});
