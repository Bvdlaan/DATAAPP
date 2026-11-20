import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MistralError } from "@mistralai/mistralai/models/errors";
import { chat, MissingKeyError, type ChatTurn } from "./chat.js";

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

    if (req.method === "POST" && req.url === "/api/chat") {
      let body: any;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      if (!validHistory(body?.messages)) return send(res, 400, { error: "Expected { messages: [{ role, content }] }" });

      try {
        return send(res, 200, await chat(body.messages));
      } catch (err) {
        if (err instanceof MissingKeyError) return send(res, 500, { error: err.message });
        if (err instanceof MistralError) {
          console.error(`Mistral API error ${err.statusCode}`);
          return send(res, 502, { error: `Mistral API error (${err.statusCode})` });
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

server.listen(PORT, () => {
  console.log(`DATAAPP running on http://localhost:${PORT}`);
  if (!process.env.MISTRAL_API_KEY) console.warn("Warning: MISTRAL_API_KEY is not set (see .env.example)");
});
