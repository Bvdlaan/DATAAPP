// "Report a problem" on AI answers (Google Play requires in-app reporting for AI-generated content).
// Reports are appended as JSON lines to data/reports.jsonl (gitignored). No IP address or other personal data is stored;
// the client id is only used in memory for a per-user daily limit against spam.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = resolve(process.env.REPORTS_FILE ?? fileURLToPath(new URL("../data/reports.jsonl", import.meta.url)));
const PER_DAY = 20;
const REASONS = new Set(["wrong_figure", "wrong_source", "inappropriate", "other"]);

const counts = new Map<string, { day: string; n: number }>();
const today = () => new Date().toISOString().slice(0, 10);

export interface Report {
  reason: string;
  comment: string;
  question: string;
  answer: string;
  toolsUsed: string[];
}

/** Validate an incoming report body; returns null when invalid. */
export function parseReport(body: any): Report | null {
  if (!body || typeof body !== "object" || !REASONS.has(body.reason)) return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const question = str(body.question, 2000);
  const answer = str(body.answer, 8000);
  if (!question || !answer) return null;
  const toolsUsed = Array.isArray(body.toolsUsed) ? body.toolsUsed.filter((t: unknown) => typeof t === "string").slice(0, 40) : [];
  return { reason: body.reason, comment: str(body.comment, 1000), question, answer, toolsUsed };
}

/** Per-user daily limit for reports. */
export function takeReportQuota(id: string): boolean {
  const day = today();
  const c = counts.get(id);
  if (!c || c.day !== day) {
    counts.set(id, { day, n: 1 });
    return true;
  }
  if (c.n >= PER_DAY) return false;
  c.n++;
  return true;
}

export async function saveReport(r: Report) {
  await mkdir(dirname(FILE), { recursive: true });
  await appendFile(FILE, JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n", "utf8");
  console.log(`Report received (${r.reason}): "${r.question.slice(0, 80)}"`);
}
