// @ts-nocheck
/* THE INFINITY STUDIO MATRIX ON THE HANDS - ComfyUI with its weights on this service (Mel Briggs 2026-10-08: "comfy UI will map in
 * LiveKit. You can install it in LiveKit. Or Playwright"; 10-04: "the weights for comfy UI never made it to Playwright"; 2026-10-16:
 * "help set up the ComfyUI sprites and Playwright"). Open source only, no paid runs: partner nodes are off at launch, and the setup
 * refuses any weight whose licence is not on the open list.
 *   boot          scripts/comfyui-setup.sh in the background at the lowest priority (idempotent: it fills the weights home on the
 *                 volume and writes extra_model_paths.yaml, the one file ComfyUI finds its weights through); READY -> the server
 *   POST /comfy-setup   run the setup again (after the MAA's list on the volume changes)
 *   the server    ComfyUI on 127.0.0.1 only (it has no lock of its own), CPU, restarted if it falls (at most 5 times in 10 minutes)
 *   /comfy/*      the ComfyUI API (/object_info, /prompt, /history/<id>, /view, /queue, /system_stats, /upload/image ...) on the lock
 *   GET /comfy    setup and server state, READY.json, the last lines of each log
 * The graphs are the MAA's (control_store.comfyui_workflows); the studio node tool `comfy` (scripts/infinity_comfy.py) runs one. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lockOk } from "./hands";

export function makeComfy(opts: { modelsHome: string; log: (...a: any[]) => void }) {
  const C = path.join(opts.modelsHome, "comfyui");
  const READY = path.join(C, "READY.json");
  const PORT = Number(process.env.COMFYUI_PORT || 8188);
  const BASE = `http://127.0.0.1:${PORT}`;
  const S: any = { setup: "idle", server: "off", pid: null, started_at: null, exits: [] as number[], last_exit: null };

  const tail = (file: string, n = 12) => { try { return fs.readFileSync(file, "utf8").split("\n").slice(-n - 1).join("\n"); } catch { return ""; } };
  const ready = () => { try { return JSON.parse(fs.readFileSync(READY, "utf8")); } catch { return null; } };

  function runSetup() {
    if (S.setup === "running") return false;
    fs.mkdirSync(C, { recursive: true });
    const out = fs.openSync(path.join(C, "setup.log"), "a");
    const p = spawn("nice", ["-n", "19", "sh", "/app/scripts/comfyui-setup.sh"], { stdio: ["ignore", out, out], env: { ...process.env, MODELS_HOME: opts.modelsHome } });
    S.setup = "running";
    S.setup_started_at = new Date().toISOString();
    /* a missing binary must never take the service (and its credit walks) down with it */
    p.on("error", (e) => { S.setup = "failed to start: " + String(e?.message || e).slice(0, 120); opts.log("[COMFY] setup", S.setup); });
    p.on("exit", (code) => {
      S.setup = code === 0 && ready() ? "ready" : `failed (exit ${code}) - see ${path.join(C, "setup.log")}`;
      opts.log("[COMFY] setup", S.setup);
      if (S.setup === "ready" && !S.pid) startServer();
    });
    return true;
  }

  function startServer() {
    if (S.pid) return;
    const py = path.join(C, ".venv", "bin", "python");
    const args = [path.join(C, "ComfyUI", "main.py"), "--listen", "127.0.0.1", "--port", String(PORT), "--cpu", "--disable-api-nodes",
      "--disable-auto-launch", "--preview-method", "none", "--output-directory", path.join(C, "out"), "--input-directory", path.join(C, "in"),
      "--user-directory", path.join(C, "user"), "--extra-model-paths-config", path.join(C, "extra_model_paths.yaml")];
    const out = fs.openSync(path.join(C, "server.log"), "a");
    const p = spawn("nice", ["-n", "10", py, ...args], { stdio: ["ignore", out, out], cwd: path.join(C, "ComfyUI") });
    S.server = "starting"; S.pid = p.pid; S.started_at = new Date().toISOString();
    p.on("error", (e) => { S.server = "failed to start: " + String(e?.message || e).slice(0, 120); S.pid = null; opts.log("[COMFY] server", S.server); });
    p.on("exit", (code) => {
      S.server = "off"; S.pid = null; S.last_exit = code;
      const now = Date.now();
      S.exits = [...S.exits.filter((t: number) => now - t < 600000), now];
      if (S.exits.length > 5) { S.server = `stopped - fell ${S.exits.length} times in 10 minutes; see ${path.join(C, "server.log")}`; return; }
      setTimeout(startServer, 5000 * S.exits.length).unref?.();
    });
  }

  function boot() {
    if (String(process.env.COMFYUI || "").toLowerCase() === "off") { S.setup = "off (COMFYUI=off)"; return; }
    /* the server comes up on what is already on the volume; the setup still runs (idempotent) so a changed list is filled */
    if (ready()) startServer();
    runSetup();
  }

  async function up() {
    try { const r = await fetch(BASE + "/system_stats", { signal: AbortSignal.timeout(3000) }); if (r.ok) { S.server = "up"; return await r.json(); } } catch {}
    return null;
  }

  function routes(app: any) {
    app.get("/comfy", async (c: any) => {
      if (!lockOk(c.req.header("x-memelli-lock"))) return c.json({ ok: false, error: "the lock" }, 401);
      const stats = await up();
      return c.json({ ok: true, home: C, setup: S.setup, server: S.server, pid: S.pid, started_at: S.started_at, last_exit: S.last_exit,
        system_stats: stats, ready: ready(), setup_log: tail(path.join(C, "setup.log")), server_log: tail(path.join(C, "server.log")) });
    });
    /* fill the weights home again (after the MAA's list on the volume, $C/weights.tsv, changes) */
    app.post("/comfy-setup", (c: any) => {
      if (!lockOk(c.req.header("x-memelli-lock"))) return c.json({ ok: false, error: "the lock" }, 401);
      return c.json({ ok: true, started: runSetup(), setup: S.setup, log: path.join(C, "setup.log") });
    });
    /* the ComfyUI API on the lock; the body passes through untouched (uploads are multipart) */
    app.all("/comfy/*", async (c: any) => {
      if (!lockOk(c.req.header("x-memelli-lock"))) return c.json({ ok: false, error: "the lock" }, 401);
      const u = new URL(c.req.url);
      const to = BASE + u.pathname.replace(/^\/comfy/, "") + u.search;
      const h = new Headers();
      for (const k of ["content-type", "accept"]) { const v = c.req.header(k); if (v) h.set(k, v); }
      try {
        const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.raw.arrayBuffer();
        const r = await fetch(to, { method: c.req.method, headers: h, body, signal: AbortSignal.timeout(120000) });
        const rh = new Headers();
        for (const k of ["content-type", "content-length", "content-disposition"]) { const v = r.headers.get(k); if (v) rh.set(k, v); }
        return new Response(r.body, { status: r.status, headers: rh });
      } catch {
        return c.json({ ok: false, error: "ComfyUI is not up here yet", setup: S.setup, server: S.server }, 503);
      }
    });
  }

  return { boot, routes, status: () => ({ setup: S.setup, server: S.server, ready: !!ready() }) };
}
