// @ts-nocheck
/* PLAYWRIGHT IS THE HANDS (Mel Briggs, 2026-10-16: "ALL OF THE LIVEKIT EGRESS AND ROOMS SHOULD BE GOING TO PLAYWRIGHT AS THE HANDS").
 * LiveKit's gate verifies every webhook the way LiveKit signs it and forwards it here whole, on the lock. This module is what the
 * hands do with it:
 *   POST   /hands/livekit   every room, participant, track, egress and ingress event -> counted, kept on the volume (one ndjson a day)
 *   POST   /hands/egress    {room} or {url}: open an RTMP listener HERE, then ask LiveKit Egress to stream that room (or page) INTO it.
 *                           The stream lands on this volume as one mp4 - no S3, no outside store; the hands hold the film.
 *   DELETE /hands/egress    {egress_id}: LiveKit StopEgress; the listener closes when the stream ends
 *   GET    /hands           what the hands hold: counts by event and room, the last events, the live and landed egresses, the slots
 * Which rooms go to the hands ON THEIR OWN is the MAA's row (HANDS_RULES_KEY, default runtime.unit.plan.livekit_hands_20261016:
 * {rooms:[{match:"name" | "prefix*", egress:"room_composite", layout, preset, audio_only, video_only, studio:"studio.<contract>"}],
 * max_live}). No row = nothing is recorded on its own; every event is still received. Nothing about a room is typed here.
 * Slots, never typed names: LIVEKIT_INTERNAL_URL (the LiveKit gate on the private line), RAILWAY_PRIVATE_DOMAIN (this service's own
 * private name, set by Railway), LIVEKIT_KEYS (read in memory, never printed or stored). An egress that LiveKit started elsewhere and
 * wrote to a file is fetched here too when its location is an http(s) address. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export function lockOk(header: string | undefined) {
  const h = Buffer.from(String(header || ""));
  if (!h.length) return false;
  for (const want of [process.env.A, process.env.B]) {
    const w = Buffer.from(String(want || ""));
    if (w.length === h.length && timingSafeEqual(h, w)) return true;
  }
  return false;
}

function lkKeys() {
  const pairs = String(process.env.LIVEKIT_KEYS || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const i = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
    return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  });
  const hit = pairs.find(([k, v]) => k && v);
  return hit ? { key: hit[0], secret: hit[1] } : null;
}

function lkJwt(video: any) {
  const k = lkKeys();
  if (!k) throw new Error("no LiveKit keys here (LIVEKIT_KEYS)");
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: k.key, sub: "memelli-hands", nbf: now - 10, exp: now + 600, video })).toString("base64url");
  return head + "." + body + "." + createHmac("sha256", k.secret).update(head + "." + body).digest("base64url");
}

const lkUrl = () => String(process.env.LIVEKIT_INTERNAL_URL || "").trim().replace(/^ws/, "http").replace(/\/$/, "");

async function twirp(service: string, method: string, body: any, video: any) {
  const base = lkUrl();
  if (!base) throw new Error("no LiveKit address slot here (LIVEKIT_INTERNAL_URL)");
  const r = await fetch(`${base}/twirp/livekit.${service}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + lkJwt(video) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${service}.${method} ${r.status} ${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch { return {}; }
}

const matchRoom = (rule: any, room: string) => {
  const m = String(rule?.match || "");
  if (!m || !room) return false;
  return m.endsWith("*") ? room.startsWith(m.slice(0, -1)) : room === m;
};

const DONE = new Set(["EGRESS_COMPLETE", "EGRESS_FAILED", "EGRESS_ABORTED", "EGRESS_LIMIT_REACHED", 3, 4, 5, 6]);

/* LiveKit may write its JSON with proto names (egress_info) or camelCase (egressInfo); the hands read one shape */
const snake = (v: any): any => Array.isArray(v) ? v.map(snake)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()), snake(x)]))
  : v;

export function makeHands(opts: {
  root: string;
  recordings: string;
  loadHotloadValue: (key: string) => Promise<any>;
  queueStudio?: (contract: string, input: any, reason: string) => Promise<string | null>;
  log: (...a: any[]) => void;
}) {
  const HANDS_DIR = path.join(opts.root, "hands");
  const EGRESS_DIR = path.join(opts.recordings, "egress");
  const RULES_KEY = process.env.HANDS_RULES_KEY || "runtime.unit.plan.livekit_hands_20261016";
  const PORT_FIRST = Number(process.env.HANDS_RTMP_PORT_FIRST || 19350);
  const PORT_COUNT = Number(process.env.HANDS_RTMP_PORT_COUNT || 20);
  const BIND = process.env.HANDS_RTMP_BIND || "[::]";
  const FETCH_MAX = Number(process.env.HANDS_FETCH_MAX_BYTES || 2 * 1024 ** 3);
  fs.mkdirSync(HANDS_DIR, { recursive: true });
  fs.mkdirSync(EGRESS_DIR, { recursive: true });

  const S = {
    since: new Date().toISOString(),
    received: 0,
    deduped: 0,
    by_event: {} as Record<string, number>,
    by_room: {} as Record<string, number>,
    last: [] as any[],
    errors: [] as any[],
  };
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const live = new Map<string, any>(); // key -> listener + egress
  const landed: any[] = [];
  let rules = { at: 0, v: null as any };

  const note = (list: any[], x: any, max = 20) => { list.unshift({ at: new Date().toISOString(), ...x }); if (list.length > max) list.length = max; };
  const err = (where: string, e: any) => { note(S.errors, { where, error: String(e?.message || e).slice(0, 240) }); opts.log("[HANDS]", where, String(e?.message || e)); };

  async function rulesNow() {
    if (Date.now() - rules.at < 60000) return rules.v;
    try { rules = { at: Date.now(), v: await opts.loadHotloadValue(RULES_KEY) }; } catch (e) { err("rules", e); rules = { at: Date.now(), v: rules.v }; }
    return rules.v;
  }

  function freePort() {
    const used = new Set([...live.values()].map((x) => x.port));
    for (let p = PORT_FIRST; p < PORT_FIRST + PORT_COUNT; p++) if (!used.has(p)) return p;
    return 0;
  }

  /* the listener: one ffmpeg in RTMP listen mode per egress, copying the stream (no re-encode) into a fragmented mp4, so a cut
   * stream is still a playable file */
  function listen(key: string, port: number, dir: string) {
    const file = path.join(dir, "stream.mp4");
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-timeout", String(Number(process.env.HANDS_RTMP_WAIT_S || 90)),
      "-i", `rtmp://${BIND}:${port}/hands/${key}`, "-c", "copy", "-f", "mp4",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-y", file], { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    ff.stderr.on("data", (d) => { tail = (tail + d).slice(-600); });
    ff.on("error", (e) => { tail = "ffmpeg did not start: " + String(e?.message || e); }); // never crash the service
    return { ff, file, tail: () => tail };
  }

  async function finish(entry: any, why: string) {
    if (entry.finished) return;
    entry.finished = true;
    live.delete(entry.key);
    const size = (() => { try { return fs.statSync(entry.file).size; } catch { return 0; } })();
    const out = { key: entry.key, egress_id: entry.egress_id, room: entry.room, url: entry.url, file: size ? entry.file : null, bytes: size,
      started_at: entry.started_at, ended_at: new Date().toISOString(), why, error: size ? null : (entry.tail() || "no stream arrived").slice(-300) };
    try { fs.writeFileSync(path.join(entry.dir, "egress.json"), JSON.stringify(out, null, 1)); } catch {}
    note(landed, out, 50);
    if (size && entry.studio && opts.queueStudio) {
      try { out.next_work_id = await opts.queueStudio(entry.studio, { path: entry.file }, `the hands landed egress ${entry.egress_id || entry.key}`); }
      catch (e) { err("studio " + entry.studio, e); }
    }
  }

  async function startEgress(req: any) {
    const room = String(req.room || "").trim(), url = String(req.url || "").trim();
    if (!room && !url) throw new Error("say which: {room} or {url}");
    const r = (await rulesNow()) || {};
    const maxLive = Number(r.max_live || process.env.HANDS_MAX_LIVE || 2);
    if (live.size >= maxLive) throw new Error(`the hands already hold ${live.size} live egress (max_live ${maxLive})`);
    if (room && [...live.values()].some((x) => x.room === room)) throw new Error(`room ${room} is already going to the hands`);
    const self = String(process.env.RAILWAY_PRIVATE_DOMAIN || "").trim();
    if (!self) throw new Error("no private name for this service (RAILWAY_PRIVATE_DOMAIN)");
    const port = freePort();
    if (!port) throw new Error("no free listener port");
    const key = "h_" + randomUUID().replace(/-/g, "").slice(0, 12);
    const dir = path.join(EGRESS_DIR, key);
    fs.mkdirSync(dir, { recursive: true });
    const l = listen(key, port, dir);
    const entry: any = { key, port, dir, file: l.file, ff: l.ff, tail: l.tail, room: room || null, url: url || null, studio: req.studio || null,
      why: req.why || "asked", started_at: new Date().toISOString(), egress_id: null, finished: false };
    live.set(key, entry);
    l.ff.on("exit", (code) => { finish(entry, "listener closed (" + code + ")").catch((e) => err("finish", e)); });
    await new Promise((res) => setTimeout(res, 400)); // the listener binds before LiveKit dials it
    const stream_outputs = [{ protocol: "RTMP", urls: [`rtmp://${self}:${port}/hands/${key}`] }];
    const common: any = { audio_only: !!req.audio_only, video_only: !!req.video_only, stream_outputs };
    if (req.preset) common.preset = String(req.preset);
    try {
      const info = room
        ? await twirp("Egress", "StartRoomCompositeEgress", { room_name: room, layout: String(req.layout || "grid"), ...common }, { roomRecord: true, room })
        : await twirp("Egress", "StartWebEgress", { url, ...common }, { roomRecord: true });
      entry.egress_id = snake(info).egress_id || null;
      try { fs.writeFileSync(path.join(dir, "start.json"), JSON.stringify({ key, port, room: entry.room, url: entry.url, egress_id: entry.egress_id, why: entry.why, at: entry.started_at }, null, 1)); } catch {}
      return { ok: true, key, egress_id: entry.egress_id, room: entry.room, url: entry.url, port, lands_at: l.file };
    } catch (e) {
      try { l.ff.kill("SIGINT"); } catch {}
      live.delete(key);
      throw e;
    }
  }

  async function stopEgress(egressId: string) {
    const entry = [...live.values()].find((x) => x.egress_id === egressId);
    let stopped = null;
    try { stopped = await twirp("Egress", "StopEgress", { egress_id: egressId }, { roomRecord: true }); } catch (e) { err("stop " + egressId, e); }
    if (entry) setTimeout(() => { if (!entry.finished) try { entry.ff.kill("SIGINT"); } catch {} }, 20000).unref?.();
    return { ok: true, egress_id: egressId, held: !!entry, livekit: stopped ? (stopped.status || "stopping") : "not reached" };
  }

  /* an egress LiveKit wrote to a file somewhere else: if its location is an http(s) address, the hands fetch it */
  async function fetchFiles(info: any) {
    const files = [...(info.file_results || []), ...(info.file ? [info.file] : [])];
    for (const f of files) {
      const loc = String(f.location || "");
      if (!/^https?:\/\//i.test(loc)) {
        const why = "not fetchable here: " + (loc.split(":")[0] || "no location") + " " + String(f.filename || "");
        if (loc || f.filename) note(landed, { egress_id: info.egress_id, room: info.room_name, file: null, why }, 50);
        continue;
      }
      const dir = path.join(EGRESS_DIR, String(info.egress_id || randomUUID()).replace(/[^\w-]/g, "_"));
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(new URL(loc).pathname) || "egress.mp4";
      const out = path.join(dir, name.replace(/[^\w.-]/g, "_"));
      try {
        const r = await fetch(loc, { signal: AbortSignal.timeout(600000) });
        if (!r.ok) throw new Error("fetch " + r.status);
        const len = Number(r.headers.get("content-length") || 0);
        if (len > FETCH_MAX) throw new Error(`too big (${len} bytes; HANDS_FETCH_MAX_BYTES ${FETCH_MAX})`);
        const buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(out, buf);
        note(landed, { egress_id: info.egress_id, room: info.room_name, file: out, bytes: buf.length, why: "fetched from its location" }, 50);
      } catch (e) { err("fetch " + info.egress_id, e); }
    }
  }

  async function act(ev: any) {
    const name = String(ev.event || ""), room = String(ev.room?.name || ev.egress_info?.room_name || "");
    if (name.startsWith("egress_")) {
      const info = ev.egress_info || {};
      const entry = [...live.values()].find((x) => x.egress_id && x.egress_id === info.egress_id);
      if (entry && DONE.has(info.status)) setTimeout(() => { if (!entry.finished) try { entry.ff.kill("SIGINT"); } catch {} }, 15000).unref?.();
      if (!entry && name === "egress_ended") await fetchFiles(info);
      return;
    }
    const r = await rulesNow();
    const rule = (Array.isArray(r?.rooms) ? r.rooms : []).find((x: any) => matchRoom(x, room));
    if (!rule) return;
    if (name === "room_finished") {
      for (const x of live.values()) if (x.room === room && x.egress_id) await stopEgress(x.egress_id);
      return;
    }
    const who = String(ev.participant?.identity || "");
    if (name === "track_published" && !who.startsWith("EG_") && ![...live.values()].some((x) => x.room === room)) {
      try {
        const res = await startEgress({ room, layout: rule.layout, preset: rule.preset, audio_only: rule.audio_only, video_only: rule.video_only, studio: rule.studio, why: "rule " + rule.match });
        note(S.last, { event: "hands_egress_started", room, egress_id: res.egress_id });
      } catch (e) { err("rule " + rule.match, e); }
    }
  }

  async function onEvent(raw: any) {
    const ev = snake(raw);
    const id = String(ev?.id || "");
    if (id && seenSet.has(id)) { S.deduped++; return { deduped: true }; }
    if (id) { seen.push(id); seenSet.add(id); if (seen.length > 2000) seenSet.delete(seen.shift()!); }
    S.received++;
    const name = String(ev?.event || "unknown"), room = String(ev?.room?.name || ev?.egress_info?.room_name || "");
    S.by_event[name] = (S.by_event[name] || 0) + 1;
    if (room && (S.by_room[room] || Object.keys(S.by_room).length < 5000)) S.by_room[room] = (S.by_room[room] || 0) + 1;
    note(S.last, { event: name, room: room || null, who: ev?.participant?.identity || null, track: ev?.track?.type || null, egress_id: ev?.egress_info?.egress_id || null, status: ev?.egress_info?.status ?? null });
    try { fs.appendFileSync(path.join(HANDS_DIR, `livekit-${new Date().toISOString().slice(0, 10)}.ndjson`), JSON.stringify({ got: new Date().toISOString(), ...raw }) + "\n"); }
    catch (e) { err("keep", e); }
    act(ev).catch((e) => err("act " + name, e));
    return { kept: true };
  }

  function status() {
    const top = Object.entries(S.by_room).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([room, n]) => ({ room, events: n }));
    return {
      ok: true,
      hands: "LiveKit rooms and egress -> Playwright (Mel Briggs 2026-10-16)",
      since: S.since, received: S.received, deduped: S.deduped, by_event: S.by_event, rooms_seen: Object.keys(S.by_room).length, top_rooms: top,
      last: S.last,
      live: [...live.values()].map((x) => ({ key: x.key, egress_id: x.egress_id, room: x.room, url: x.url, port: x.port, started_at: x.started_at, why: x.why, bytes: (() => { try { return fs.statSync(x.file).size; } catch { return 0; } })() })),
      landed: landed.slice(0, 20),
      errors: S.errors,
      rules: { key: RULES_KEY, loaded: !!rules.v, rooms: Array.isArray(rules.v?.rooms) ? rules.v.rooms.length : 0 },
      slots: { livekit: !!lkUrl(), private_name: !!String(process.env.RAILWAY_PRIVATE_DOMAIN || "").trim(), keys: !!lkKeys(), lock: !!(process.env.A || process.env.B) },
      kept_at: HANDS_DIR, lands_at: EGRESS_DIR,
    };
  }

  function routes(app: any) {
    const gate = async (c: any, next: any) => (lockOk(c.req.header("x-memelli-lock")) ? next() : c.json({ ok: false, error: "the lock" }, 401));
    app.post("/hands/livekit", gate, async (c: any) => {
      const ev = await c.req.json().catch(() => null);
      if (!ev || typeof ev !== "object") return c.json({ ok: false, error: "bad json" }, 400);
      return c.json({ ok: true, ...(await onEvent(ev)) });
    });
    app.post("/hands/egress", gate, async (c: any) => {
      try { return c.json(await startEgress(await c.req.json().catch(() => ({})))); }
      catch (e: any) { return c.json({ ok: false, error: String(e?.message || e) }, 409); }
    });
    app.delete("/hands/egress", gate, async (c: any) => {
      const { egress_id } = await c.req.json().catch(() => ({}));
      if (!egress_id) return c.json({ ok: false, error: "egress_id" }, 400);
      return c.json(await stopEgress(String(egress_id)));
    });
    app.get("/hands", gate, (c: any) => c.json(status()));
  }

  return { onEvent, startEgress, stopEgress, status, routes };
}
