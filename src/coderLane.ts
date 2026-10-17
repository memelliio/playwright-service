// @ts-nocheck
/* THE ONE CLAUDE-LOCAL CODER LANE (Mel Briggs, 2026-10-17: "one line in Playwright ... a clear claude local coder line non
 * mistakable ... one line in and out"). The coder has exactly ONE way to reach the system: this labeled lane in Playwright.
 * Everything that rides it is stamped source="claude-local-coder" - the system can never mistake it for the MAA, Mel, or a client.
 * The coder SENDS a request IN; the MAA/Mel reads it, acts, and the answer comes back OUT on the same lane. The coder NEVER writes
 * a rail row and NEVER reads the MAA's tree here - requests only, with a visible state (open/taken/done) so a request that sits is
 * seen by Mel, never a silent dead letter. Entries are kept on this service's own volume; nothing is written into jessica/ or the rail.
 *   POST /coder/in     {kind, title, body}        -> a stamped request, state "open"
 *   GET  /coder/log                                -> every request + its state (for Mel and the MAA to read)
 *   POST /coder/take   {id, by}                    -> the MAA/Mel marks it taken
 *   POST /coder/out    {id, answer, state?}        -> the answer rides back out; state done
 * On the lock the service already carries (x-memelli-lock = A or B). Labeled, logged, one lane, in and out. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

const SOURCE = "claude-local-coder";

function lockOk(header: string | undefined) {
  const got = Buffer.from(String(header || ""));
  if (!got.length) return false;
  for (const want of [process.env.A, process.env.B]) {
    const w = Buffer.from(String(want || ""));
    if (w.length === got.length && timingSafeEqual(w, got)) return true;
  }
  return false;
}

export function makeCoderLane(opts: { root: string; log: (...a: any[]) => void }) {
  const dir = path.join(opts.root, "coder-lane");
  const file = path.join(dir, "lane.ndjson");
  fs.mkdirSync(dir, { recursive: true });

  const readAll = () => {
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const append = (rec: any) => { try { fs.appendFileSync(file, JSON.stringify(rec) + "\n"); } catch (e) { opts.log("[CODER-LANE]", String(e?.message || e)); } };
  // the current state of each request = the latest record for its id
  const byId = () => { const m = new Map(); for (const r of readAll()) m.set(r.id, { ...(m.get(r.id) || {}), ...r }); return m; };

  function routes(app: any) {
    const gate = (c: any, next: any) => (lockOk(c.req.header("x-memelli-lock")) ? next() : c.json({ ok: false, error: "the lock" }, 401));

    app.post("/coder/in", gate, async (c: any) => {
      const b = await c.req.json().catch(() => ({}));
      const id = "coder-" + randomUUID().slice(0, 12);
      const rec = { id, source: SOURCE, kind: String(b.kind || "request").slice(0, 60), title: String(b.title || "").slice(0, 200),
        body: String(b.body || "").slice(0, 20000), state: "open", by: null, answer: null, at: new Date().toISOString() };
      append(rec);
      return c.json({ ok: true, id, source: SOURCE, state: "open" });
    });

    app.get("/coder/log", gate, (c: any) => {
      const items = [...byId().values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return c.json({ ok: true, source: SOURCE, open: items.filter((x) => x.state === "open").length, items });
    });

    app.post("/coder/take", gate, async (c: any) => {
      const { id, by } = await c.req.json().catch(() => ({}));
      const cur = byId().get(String(id));
      if (!cur) return c.json({ ok: false, error: "no such request" }, 404);
      append({ id: String(id), source: SOURCE, state: "taken", by: String(by || "maa").slice(0, 60), at: new Date().toISOString() });
      return c.json({ ok: true, id, state: "taken" });
    });

    app.post("/coder/out", gate, async (c: any) => {
      const { id, answer, state } = await c.req.json().catch(() => ({}));
      const cur = byId().get(String(id));
      if (!cur) return c.json({ ok: false, error: "no such request" }, 404);
      append({ id: String(id), source: SOURCE, state: String(state || "done"), answer: String(answer || "").slice(0, 20000), at: new Date().toISOString() });
      return c.json({ ok: true, id, state: String(state || "done") });
    });
  }

  return { routes };
}
