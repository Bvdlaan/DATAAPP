// Usage limits for POST /api/chat, so a public deployment (iOS/Android app backend) can't run up the Mistral bill.
// In-memory: fine for a single server instance. With several instances, move these counters to Redis or similar.
//
// Configure in .env (defaults in brackets):
//   CHAT_LIMIT_PER_MINUTE  questions per user per minute   [6]
//   CHAT_LIMIT_PER_DAY     questions per user per day      [60]
//   CHAT_LIMIT_GLOBAL_DAY  questions per day, all users    [2000]
//   TRUST_PROXY=1          behind a hosting proxy/load balancer: identify users by X-Forwarded-For

import type { IncomingMessage } from "node:http";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const PER_MINUTE = num(process.env.CHAT_LIMIT_PER_MINUTE, 6);
const PER_DAY = num(process.env.CHAT_LIMIT_PER_DAY, 60);
const GLOBAL_DAY = num(process.env.CHAT_LIMIT_GLOBAL_DAY, 2000);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const MINUTE = 60_000;
const users = new Map<string, { recent: number[]; day: string; dayCount: number }>();
let global = { day: "", count: 0 };

const today = () => new Date().toISOString().slice(0, 10); // UTC day

/** Who is asking: the socket address, or the first X-Forwarded-For hop when running behind a trusted proxy. */
export function clientId(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export type LimitResult = { ok: true } | { ok: false; reason: "minute" | "day" | "global"; retryAfterSec: number; message: string };

const secondsUntilMidnightUtc = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.ceil((next - now.getTime()) / 1000);
};

/** Check and, if allowed, count one question for this user. */
export function takeChatQuota(id: string, now = Date.now()): LimitResult {
  const day = today();
  if (global.day !== day) global = { day, count: 0 };
  if (global.count >= GLOBAL_DAY) {
    return { ok: false, reason: "global", retryAfterSec: secondsUntilMidnightUtc(), message: "The app has reached its daily question limit. Please try again tomorrow." };
  }

  const u = users.get(id) ?? { recent: [], day, dayCount: 0 };
  if (u.day !== day) Object.assign(u, { day, dayCount: 0 });
  u.recent = u.recent.filter((t) => now - t < MINUTE);

  if (u.dayCount >= PER_DAY) {
    users.set(id, u);
    return { ok: false, reason: "day", retryAfterSec: secondsUntilMidnightUtc(), message: `You've asked ${PER_DAY} questions today, the daily maximum. Please try again tomorrow.` };
  }
  if (u.recent.length >= PER_MINUTE) {
    const wait = Math.max(1, Math.ceil((MINUTE - (now - u.recent[0])) / 1000));
    users.set(id, u);
    return { ok: false, reason: "minute", retryAfterSec: wait, message: `You're asking quickly. Please wait ${wait} seconds and try again.` };
  }

  u.recent.push(now);
  u.dayCount++;
  global.count++;
  users.set(id, u);
  return { ok: true };
}

// Drop idle users every 10 minutes so the map can't grow without bound.
setInterval(() => {
  const now = Date.now(), day = today();
  for (const [id, u] of users) if (u.day !== day || (u.recent.every((t) => now - t > MINUTE) && u.dayCount === 0)) users.delete(id);
}, 10 * MINUTE).unref();

export const limitsInfo = () => ({ perMinute: PER_MINUTE, perDay: PER_DAY, globalPerDay: GLOBAL_DAY, trustProxy: TRUST_PROXY });
