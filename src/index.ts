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

function jsonSql(value: any) {
  return `${sqlText(JSON.stringify(value))}::jsonb`;
}

async function creditEvent(customerId: string, provider: string, status: string, errorClass: string, message: string, raw?: any) {
  await runtimeSql(`
insert into control_store.credit_pull_events(id, customer_id, provider, attempted_at, status, error_class, message, raw)
values(
  gen_random_uuid()::text,
  ${sqlText(customerId)},
  ${sqlText(provider)},
  now(),
  ${sqlText(status)},
  ${sqlText(errorClass)},
  ${sqlText(message)},
  ${raw == null ? "null" : jsonSql(raw)}
)
`).catch(() => {});
}

async function getRuntimeValue(key: string) {
  const rows = await runtimeSql(
    `select value from control_store.rail_runtime_config where key=${sqlText(key)} order by updated_at desc nulls last limit 1`
  );
  return rows[0]?.value || "";
}

async function getSmartCreditCredentials(customerId: string) {
  const encKey = await getRuntimeValue("customer_data_enc_key");
  if (!encKey) {
    throw new Error("customer_data_enc_key missing");
  }
  const rows = await runtimeSql(`
select
  nullif(pgp_sym_decrypt(username_enc, ${sqlText(encKey)}), '') as username,
  nullif(pgp_sym_decrypt(password_enc, ${sqlText(encKey)}), '') as password
from control_store.customer_credentials
where customer_id::text=${sqlText(customerId)}
  and service ilike '%smartcredit%'
order by updated_at desc
limit 1
`);
  return {
    username: rows[0]?.username || "",
    password: rows[0]?.password || "",
  };
}

function bureauOf(text: string) {
  const t = String(text || "");
  if (t.includes("TUC")) return "transunion";
  if (t.includes("EXP")) return "experian";
  if (t.includes("EQF") || t.includes("EFX")) return "equifax";
  return "";
}

function extractScores(report: any) {
  let inner = report;
  if (report && typeof report.rawReport === "string") {
    try {
      inner = JSON.parse(report.rawReport);
    } catch {}
  }
  let comps = inner?.BundleComponents?.BundleComponent || [];
  if (!Array.isArray(comps)) comps = [comps];
  const scores: Array<{ bureau: string; score: number }> = [];
  comps.forEach((cp: any) => {
    const cst = cp?.CreditScoreType;
    if (!cst) return;
    (Array.isArray(cst) ? cst : [cst]).forEach((sc: any) => {
      const n = parseInt(sc?.riskScore, 10);
      const b = bureauOf(sc?.["@Type"] || sc?.Type || cp?.["@Type"] || cp?.Type);
      if (b && n >= 300 && n <= 900) scores.push({ bureau: b, score: n });
    });
  });
  return { inner, comps, scores };
}

async function storeSmartCreditReport(customerId: string, report: any, email = "", pulledBy = "spawn_playwright_pull") {
  const text = JSON.stringify(report);
  const { comps, scores } = extractScores(report);
  const pullId = `sc_${Buffer.from(customerId).toString("hex").slice(0, 10)}`;
  await runtimeSql(`
insert into control_store.credit_report_pulls(
  id, customer_id, email, provider, raw_report, raw_size, component_count, pulled_by, pulled_at
) values(
  gen_random_uuid()::text,
  ${sqlText(customerId)},
  ${sqlText(email)},
  'smartcredit',
  ${jsonSql(report)},
  ${text.length},
  ${comps.length},
  ${sqlText(pulledBy)},
  now()
)
`);
  for (const s of scores) {
    await runtimeSql(`
insert into control_store.credit_scores_detail(
  id, customer_id, pull_id, bureau, vantage_score, raw, created_at
) values(
  gen_random_uuid()::text,
  ${sqlText(customerId)},
  ${sqlText(pullId)},
  ${sqlText(s.bureau)},
  ${s.score},
  ${jsonSql(s)},
  now()
) on conflict do nothing
`).catch(() => {});
  }
  const ex = scores.find((s) => s.bureau === "experian")?.score || null;
  const tu = scores.find((s) => s.bureau === "transunion")?.score || null;
  const eq = scores.find((s) => s.bureau === "equifax")?.score || null;
  await runtimeSql(`
update control_store.customers
set port_status='report_pulled',
    last_report_pulled_at=now()
    ${ex ? `, experian_score=${Number(ex)}` : ""}
    ${tu ? `, transunion_score=${Number(tu)}` : ""}
    ${eq ? `, equifax_score=${Number(eq)}` : ""}
where id::text=${sqlText(customerId)}
`).catch(() => {});
  await creditEvent(
    customerId,
    "smartcredit",
    "success",
    "fresh_report",
    `Playwright SmartCredit report imported: ${comps.length} components, ${scores.length} scores`,
    { component_count: comps.length, score_count: scores.length, bureaus: scores.map((s) => s.bureau) }
  );
  return { component_count: comps.length, score_count: scores.length, bureaus: scores.map((s) => s.bureau), raw_size: text.length };
}

function getPath(source: any, dotted: string) {
  return String(dotted || "")
    .split(".")
    .filter(Boolean)
    .reduce((acc: any, key: string) => (acc == null ? undefined : acc[key]), source);
}

async function runPlaywrightScript(handler: any, payload: any) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const state: any = { payload, handler, page, context };
  try {
    for (const step of handler.script || []) {
      switch (step.op) {
        case "load_customer_smartcredit_credentials": {
          const customerId = String(payload[step.customer_id_from || "customer_id"] || "");
          if (!customerId) throw new Error("missing customer_id in queued instruction payload");
          state.customer_id = customerId;
          state.credentials = await getSmartCreditCredentials(customerId);
          if (!state.credentials.username || !state.credentials.password) {
            await creditEvent(customerId, "smartcredit", "failed", "need_connect", "No SmartCredit credentials on file");
            throw new Error("no smartcredit credentials on file");
          }
          break;
        }
        case "goto":
          await page.goto(step.url, {
            waitUntil: step.wait_until || "domcontentloaded",
            timeout: Number(step.timeout_ms || 60000),
          });
          break;
        case "fill":
          await page.fill(step.selector, String(getPath(state, step.from) ?? ""));
          break;
        case "click":
          await page.locator(step.selector).click();
          break;
        case "wait_for_url_not_contains":
          await page.waitForURL((url) => !String(url).includes(String(step.value || "")), {
            timeout: Number(step.timeout_ms || 60000),
          });
          break;
        case "wait_for_load_state":
          await page.waitForLoadState(step.state || "networkidle", {
            timeout: Number(step.timeout_ms || 60000),
          }).catch(() => {});
          break;
        case "assert_url_not_contains": {
          const currentUrl = page.url();
          if (currentUrl.includes(String(step.value || ""))) {
            if (state.customer_id && step.credit_event) {
              await creditEvent(
                state.customer_id,
                step.credit_event.provider || "smartcredit",
                step.credit_event.status || "failed",
                step.credit_event.error_class || "invalid_login",
                step.credit_event.message || `URL contained forbidden value: ${step.value}`,
                { current_url: currentUrl }
              );
            }
            throw new Error(step.error || `url contained ${step.value}: ${currentUrl}`);
          }
          break;
        }
        case "capture_url":
          state[step.target || "current_url"] = page.url();
          break;
        case "request_get_text": {
          const headers: Record<string, string> = {};
          Object.entries(step.headers || {}).forEach(([key, value]) => {
            headers[key] = String(value);
          });
          if (step.cookie_from) {
            const cookie = String(getPath(state, step.cookie_from) || "");
            if (cookie) headers.Cookie = cookie;
          }
          const response = await context.request.get(step.url, {
            headers,
            timeout: Number(step.timeout_ms || 60000),
          });
          state[step.status_target || "last_status"] = response.status();
          state[step.headers_target || "last_headers"] = response.headers();
          state[step.target || "last_text"] = await response.text();
          break;
        }
        case "request_post_form": {
          const form: Record<string, string> = {};
          Object.entries(step.form || {}).forEach(([key, value]) => {
            form[key] = String(typeof value === "string" && value.startsWith("$")
              ? getPath(state, value.slice(1)) ?? ""
              : value);
          });
          const response = await context.request.post(step.url, {
            form,
            timeout: Number(step.timeout_ms || 60000),
            maxRedirects: 0,
          });
          state[step.status_target || "last_status"] = response.status();
          state[step.headers_target || "last_headers"] = response.headers();
          const setCookie = response.headers()["set-cookie"] || "";
          state[step.cookie_target || "login_cookie"] = (setCookie.match(/JSESSIONID=[^;]+/) || [""])[0];
          state[step.target || "last_text"] = await response.text();
          break;
        }
        case "assert_status_200": {
          const status = Number(getPath(state, step.from || "last_status") || 0);
          if (status >= 300 && status < 400) {
            const location = String(getPath(state, `${step.headers_from || "last_headers"}.location`) || "");
            if (location.includes(String(step.reactivation_contains || "reactivation"))) {
              if (state.customer_id) {
                await creditEvent(state.customer_id, "smartcredit", "needs_action", "needs_reactivation", "SmartCredit membership needs reactivation");
              }
              throw new Error(`smartcredit needs reactivation: ${location}`);
            }
            throw new Error(`report redirected: ${status} ${location}`);
          }
          if (status !== 200) throw new Error(step.error_prefix ? `${step.error_prefix} ${status}` : `status ${status}`);
          break;
        }
        case "parse_json": {
          const sourceText = String(getPath(state, step.from || "") || "");
          try {
            state[step.target || "json"] = JSON.parse(sourceText);
          } catch {
            throw new Error(step.error || "report not JSON");
          }
          break;
        }
        case "store_smartcredit_report": {
          const customerId = String(state.customer_id || payload.customer_id || "");
          const report = getPath(state, step.report_from || "report");
          const email = String(getPath(state, step.email_from || "") || "");
          state[step.target || "stored"] = await storeSmartCreditReport(customerId, report, email, step.pulled_by || "spawn_playwright_pull");
          break;
        }
        default:
          throw new Error(`unknown hotload script op: ${step.op}`);
      }
    }
    return state;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function loadHandlerRegistry() {
  const rows = await runtimeSql(
    `select value from control_store.memelli_hotload_config where config_key=${sqlText(HANDLER_CONFIG_KEY)} and status='active' order by version desc limit 1`
  );
  return rows[0]?.value || {};
}

async function loadHotloadValue(configKey: string) {
  const rows = await runtimeSql(
    `select value from control_store.memelli_hotload_config where config_key=${sqlText(configKey)} and status='active' order by version desc limit 1`
  );
  return rows[0]?.value || null;
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
  const handlerRef = workerConfig?.handlers?.[payload.contract] || {};
  const resolvedHandler =
    handlerRef?.contract_key ? await loadHotloadValue(String(handlerRef.contract_key)) : handlerRef;
  const handler = resolvedHandler || {};
  const kind = handler.kind || handlerRef.kind || "route";
  if (kind === "playwright_script") {
    const state = await runPlaywrightScript(handler, payload);
    return {
      kind,
      customer_id: state.customer_id,
      login_url: state.current_url,
      stored: state.stored,
    };
  }
  if (!handler.kind) {
    throw new Error(`invalid hotloaded handler for ${payload.contract}: route fallback disabled`);
  }
  if (handler.kind === "route") {
    throw new Error(`legacy route handler rejected for ${payload.contract}: use a hotloaded script contract`);
  }
  const route = handler.route;
  const body: Record<string, any> = {};
  const bodyMap = handler.body_from_instruction || { customer_id: "customer_id" };
  for (const [target, source] of Object.entries(bodyMap)) {
    body[target] = payload[source as string];
  }
  if (!body.customer_id && payload.customer_id) body.customer_id = payload.customer_id;
  if (!body.customer_id) throw new Error("missing customer_id in queued instruction payload");
  const result = await railPost(route, body);
  return { kind, route, body, result };
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
