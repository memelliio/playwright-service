// @ts-nocheck
import { Hono } from "hono";
import pg from "pg";

const app = new Hono();
const { Client } = pg;

const port = Number(process.env.PORT) || 3000;
const sessions = new Map<string, any>();
const SPAWN_CHANNEL = process.env.SPAWN_WAKE_CHANNEL || "agent_lane_wake";
const RAIL =
  process.env.MEMELLI_CONTROL_INTERNAL ||
  process.env.MEMELLI_SHARED_INTERNAL_URL ||
  process.env.MEMELLI_BAR_CONTROL_INTERNAL_URL ||
  process.env.INFINITY_OS_INTERNAL_URL ||
  process.env.INFINITY_OS_PUBLIC_URL ||
  process.env.NEXT_PUBLIC_INFINITY_OS_URL ||
  "https://memelli-io-infinity-os.up.railway.app";
const KEY =
  process.env.MEMELLI_RUNTIME_TOKEN ||
  process.env.INFINITY_OS_ADMIN_KEY ||
  process.env.MEMELLI_INTERNAL_BEARER ||
  process.env.RAIL_KEY ||
  process.env.MEMELLI_ADMIN_KEY ||
  process.env.DEV_AUTH_TOKEN ||
  "";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.PGDATABASE_URL ||
  process.env.POSTGRES_URL ||
  "";
const WORKER_NAME = process.env.SPAWN_WORKER_NAME || "playwright_bureau_monitor";
const HANDLER_CONFIG_KEY = process.env.SPAWN_HANDLER_CONFIG_KEY || "spawn.worker.handler_registry";
const START_GUARD_MS = Math.max(15000, Number(process.env.SPAWN_GUARD_MS || "30000"));
let draining = false;

// Owner gate middleware
const ownerGate = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const ownerKey = c.req.header("X-Owner-Key");

  if (ownerKey !== "1604" && !authHeader?.includes("1604")) {
    return c.json({ error: "Unauthorized: owner_key 1604 required" }, 401);
  }

  await next();
};

function log(...args: any[]) {
  console.log("[PLAYWRIGHT-SERVICE]", ...args);
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return {};
  const candidate = text.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}

async function railPost(path: string, body: any) {
  const response = await fetch(`${RAIL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
      "x-owner-key": KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, parse_error: text.slice(0, 500) };
  }
  if (!response.ok || json?.ok === false) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function runtimeSql(sql: string) {
  const json = await railPost("/api/memelli/runtime/exec", {
    command: "sql",
    admin_key: KEY,
    actor_lane: "playwright-service",
    writer_path: "playwright-service/src/index.ts",
    source_proof: "spawn worker runtime execution",
    args: { sql },
  });
  return Array.isArray(json?.result?.rows) ? json.result.rows : Array.isArray(json?.rows) ? json.rows : [];
}

function sqlText(value: string | null | undefined) {
  if (value == null) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function loadHandlerRegistry() {
  const rows = await runtimeSql(
    `select value from control_store.memelli_hotload_config where config_key=${sqlText(HANDLER_CONFIG_KEY)} and status='active' order by version desc limit 1`
  );
  return rows[0]?.value || {};
}

async function claimWork() {
  const rows = await runtimeSql(`
with candidate as (
  select id
  from control_store.spawn_work
  where status='pending'
    and (
      work_class='executor_credit_monitoring'
      or lane='credit_monitoring'
      or instruction ilike '%"required_worker": "playwright_bureau_monitor"%'
      or instruction ilike '%"required_worker":"playwright_bureau_monitor"%'
    )
  order by priority desc nulls last, created_at asc
  limit 1
)
update control_store.spawn_work sw
set status='running',
    claimed_at=now(),
    updated_at=now(),
    attempt_count=coalesce(sw.attempt_count,0)+1
from candidate
where sw.id=candidate.id
returning sw.id, sw.topic, sw.instruction, sw.work_class, sw.lane, sw.status, sw.dedupe_key;
`);
  return rows[0] || null;
}

async function finishWork(id: string, status: "done" | "error", resultJson: any, resultText: string) {
  const resultJsonSql = sqlText(JSON.stringify(resultJson));
  await runtimeSql(`
update control_store.spawn_work
set status=${sqlText(status)},
    result=${sqlText(resultText)},
    result_json=${resultJsonSql}::jsonb,
    model_used=${sqlText(WORKER_NAME)},
    ran_at=now(),
    updated_at=now()
where id=${sqlText(id)};
`);
}

async function handleCreditMonitoring(work: any, registry: any) {
  const payload = extractJsonObject(String(work.instruction || ""));
  const workerConfig = registry?.workers?.[WORKER_NAME] || {};
  const handler = workerConfig?.handlers?.[payload.contract] || {};
  const route = handler.route || "/api/client_credit_pull";
  const body: Record<string, any> = {};
  const bodyMap = handler.body_from_instruction || { customer_id: "customer_id" };
  for (const [target, source] of Object.entries(bodyMap)) {
    body[target] = payload[source as string];
  }
  if (!body.customer_id && payload.customer_id) body.customer_id = payload.customer_id;
  if (!body.customer_id) throw new Error("missing customer_id in queued instruction payload");
  const result = await railPost(route, body);
  return { route, body, result };
}

async function executeWork(work: any) {
  const registry = await loadHandlerRegistry();
  const payload = extractJsonObject(String(work.instruction || ""));
  const requiredWorker = payload.required_worker || "";
  if (requiredWorker && requiredWorker !== WORKER_NAME) {
    throw new Error(`work requires ${requiredWorker}, not ${WORKER_NAME}`);
  }
  switch (payload.contract) {
    case "credit_weekly_refresh_bureau_check_v1":
      return await handleCreditMonitoring(work, registry);
    default:
      throw new Error(`no hotloaded handler for contract ${payload.contract || "(missing)"}`);
  }
}

async function drainOnce() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const work = await claimWork();
      if (!work) break;
      log("claimed", work.id, work.work_class, work.lane);
      try {
        const result = await executeWork(work);
        await finishWork(work.id, "done", { ok: true, worker: WORKER_NAME, ...result }, `done:${work.id}`);
        log("done", work.id);
      } catch (error: any) {
        await finishWork(
          work.id,
          "error",
          { ok: false, worker: WORKER_NAME, error: String(error?.message || error) },
          `error:${String(error?.message || error).slice(0, 400)}`
        );
        log("error", work.id, String(error?.message || error));
      }
    }
  } finally {
    draining = false;
  }
}

async function startSpawnWorker() {
  if (!DATABASE_URL || !KEY) {
    log("spawn worker disabled: missing DATABASE_URL or admin key");
    return;
  }
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`listen ${SPAWN_CHANNEL}`);
  client.on("notification", () => {
    void drainOnce();
  });
  client.on("error", (error) => {
    console.error("[PLAYWRIGHT-SERVICE] spawn listener error", error);
  });
  log(`spawn worker listening on ${SPAWN_CHANNEL} via ${WORKER_NAME}`);
  void drainOnce();
  setInterval(() => void drainOnce(), START_GUARD_MS);
}

// Health check
app.get("/health", (c) => c.json({ status: "ok", type: "playwright-service" }));
app.get("/worker/health", async (c) => {
  try {
    const rows = await runtimeSql(
      `select count(*)::int as pending from control_store.spawn_work where status='pending' and (work_class='executor_credit_monitoring' or lane='credit_monitoring')`
    );
    return c.json({ ok: true, worker: WORKER_NAME, rail: RAIL, pending: rows[0]?.pending ?? null });
  } catch (error: any) {
    return c.json({ ok: false, worker: WORKER_NAME, error: String(error?.message || error) }, 500);
  }
});

// POST /session — create a new browser session
app.post("/session", ownerGate, async (c) => {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext();
    const page = await context.newPage();

    const sessionId = Math.random().toString(36).substring(7);
    sessions.set(sessionId, { browser, context, page });

    return c.json({ sessionId, status: "created" });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to create session", details: error.message }, 500);
  }
});

// POST /navigate — navigate to URL
app.post("/navigate", ownerGate, async (c) => {
  try {
    const { sessionId, url } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.goto(url);
    return c.json({ status: "navigated", url });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to navigate", details: error.message }, 500);
  }
});

// POST /screenshot — take screenshot
app.post("/screenshot", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const buffer = await session.page.screenshot({ type: "png" });
    const base64 = buffer.toString("base64");
    return c.json({ status: "screenshot", data: base64 });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to take screenshot", details: error.message }, 500);
  }
});

// POST /screenshot-4k — take 4K screenshot
app.post("/screenshot-4k", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.setViewportSize({ width: 3840, height: 2160 });
    const buffer = await session.page.screenshot({ type: "png" });
    const base64 = buffer.toString("base64");
    return c.json({ status: "screenshot-4k", data: base64 });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to take 4K screenshot", details: error.message }, 500);
  }
});

// POST /fill — fill form field
app.post("/fill", ownerGate, async (c) => {
  try {
    const { sessionId, selector, value } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.fill(selector, value);
    return c.json({ status: "filled", selector, value });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to fill", details: error.message }, 500);
  }
});

// POST /click — click element
app.post("/click", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.click(selector);
    return c.json({ status: "clicked", selector });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to click", details: error.message }, 500);
  }
});

// POST /submit — submit form
app.post("/submit", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.page.click(selector);
    await session.page.waitForNavigation({ timeout: 5000 }).catch(() => {});
    return c.json({ status: "submitted", selector });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to submit", details: error.message }, 500);
  }
});

// POST /scrape — scrape page content
app.post("/scrape", ownerGate, async (c) => {
  try {
    const { sessionId, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const content = await session.page.locator(selector).textContent();
    return c.json({ status: "scraped", selector, content });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to scrape", details: error.message }, 500);
  }
});

// POST /screencast — start screencast (video recording)
app.post("/screencast", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Screencast would require video codec setup; placeholder for now
    return c.json({ status: "screencast-started", sessionId });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to start screencast", details: error.message }, 500);
  }
});

// DELETE /session — close session
app.delete("/session", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    await session.browser.close();
    sessions.delete(sessionId);
    return c.json({ status: "closed", sessionId });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to close session", details: error.message }, 500);
  }
});

// Start server
Bun.serve({
  hostname: "::",
  port,
  fetch: app.fetch,
});

log(`Listening on port ${port}`);
void startSpawnWorker().catch((error) => {
  console.error("[PLAYWRIGHT-SERVICE] failed to start spawn worker", error);
});
