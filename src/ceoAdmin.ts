// @ts-nocheck
/* THE HANDS OPEN ON MEL'S CEO ADMIN (Mel Briggs, 2026-10-16: "my CEO master variable pulls the entire twenty-container chain" ·
 * "My login lives in the infinity database ... That's where my CEO admin lives"). His CEO admin is infinity.ceo.admin.id in the
 * Infinity database; every container's CEO_AUTH_ADMIN_MEL_BRIGGS points at it, and the door mints the live stamp key:A=B from it
 * every 30 s, naming his person - the same stamp /mixer/signout already trusts. The hands, the egress and the matrix (/hands, /comfy)
 * open ONLY while that stamp is live, and only to a container of his chain carrying his lock (x-memelli-lock = A or B, the two sides
 * of A=[0*1]=B). His own login as a door of its own is not in this cut.
 * No live stamp, nothing opens. The person always comes from the stamp, never from the request; nothing about him is typed here. */
import { timingSafeEqual } from "node:crypto";

const STAMP_KEY = "key:A=B";
const BIND = "A=[0*1]=B";
let redis: any = null;
let stamp = { at: 0, v: null as any };

async function liveStamp() {
  if (Date.now() - stamp.at < 10000) return stamp.v;
  let v: any = null;
  try {
    if (!redis && process.env.REDIS_URL) redis = new (Bun as any).RedisClient(process.env.REDIS_URL);
    const raw = redis ? await redis.get(STAMP_KEY) : null;
    const j = raw ? JSON.parse(raw) : null;
    v = j && j.key === BIND && j.person_id ? j : null;
  } catch { v = null; }
  stamp = { at: Date.now(), v };
  return v;
}

function lockMatch(header: string) {
  const got = Buffer.from(String(header || ""));
  if (!got.length) return false;
  for (const want of [process.env.A, process.env.B]) {
    const w = Buffer.from(String(want || ""));
    if (w.length === got.length && timingSafeEqual(w, got)) return true;
  }
  return false;
}

/* (the mio_sess cookie reader is kept for his login door when it comes) */
function cookie(header: string, name: string) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); } }
  }
  return "";
}

export function makeCeoAdmin(pool: any) {
  async function open(c: any) {
    const s = await liveStamp();
    if (!s) return { ok: false, why: "his CEO admin is not live (no key:A=B stamp)" };
    if (lockMatch(c.req.header("x-memelli-lock"))) return { ok: true, by: "his chain", person: String(s.person_id) };
    return { ok: false, why: "not his CEO admin" };
  }
  const gate = async (c: any, next: any) => {
    const o = await open(c);
    if (!o.ok) return c.json({ ok: false, error: o.why }, 401);
    return next();
  };
  return { open, gate, liveStamp };
}
