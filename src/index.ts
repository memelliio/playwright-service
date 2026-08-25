// @ts-nocheck
import { Hono } from "hono";
import pg from "pg";

const app = new Hono();
const { Client, Pool } = pg;

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
  process.env.MEMELLI_PGBOUNCER_PRIVATE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.POSTGRES_URL ||
  "";
const DB_APPLICATION_NAME = process.env.PGAPPNAME || "memelli-playwright-service";
const WORKER_NAME = process.env.SPAWN_WORKER_NAME || "playwright_bureau_monitor";
const HANDLER_CONFIG_KEY = process.env.SPAWN_HANDLER_CONFIG_KEY || "spawn.worker.handler_registry";
let draining = false;
let spawnListenerConnectedAt: string | null = null;
let lastDrainError: string | null = null;
let spawnWorkerStarting = false;
let spawnWorkerRetryTimer: ReturnType<typeof setTimeout> | null = null;
let spawnWorkerLastAttemptAt: string | null = null;
let spawnWorkerSafetyDrainTimer: ReturnType<typeof setInterval> | null = null;
const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: databaseUrlWithAppName(DATABASE_URL),
      application_name: DB_APPLICATION_NAME,
      max: Number(process.env.PG_POOL_MAX || 2),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 8000),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    } as any)
  : null;

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

function extractBalancedObject(text: string, fromIndex: number): any | null {
  let searchStart = fromIndex;
  for (let attempts = 0; attempts < 40; attempts++) {
    const braceIdx = text.lastIndexOf("{", searchStart);
    if (braceIdx < 0) return null;
    let depth = 0;
    let inStr = false;
    let strCh = "";
    let esc = false;
    for (let i = braceIdx; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === strCh) inStr = false;
        continue;
      }
      if (c === "\"" || c === "'") {
        inStr = true;
        strCh = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          if (i >= fromIndex) {
            try {
              return JSON.parse(text.slice(braceIdx, i + 1));
            } catch {}
          }
          break;
        }
      }
    }
    searchStart = braceIdx - 1;
  }
  return null;
}

const REPORT_MARKERS = /BundleComponents|TrueLinkCreditReportType|TradeLinePartition|rawReport/;

function extractReportJson(text: string): any | null {
  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(text))) {
    const body = match[1].trim();
    if (!body || (body[0] !== "{" && body[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(body);
      if (REPORT_MARKERS.test(JSON.stringify(parsed))) return parsed;
    } catch {}
  }
  const idx = text.search(REPORT_MARKERS);
  return idx >= 0 ? extractBalancedObject(text, idx) : null;
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
  if (!dbPool) throw new Error("database connection missing");
  const result = await dbPool.query(sql);
  return result.rows || [];
}

async function recordSpawnAnalytics(work: any, eventName: string, details: any = {}) {
  const payload = {
    work_id: work.id,
    worker: WORKER_NAME,
    lane: work.lane || null,
    work_class: work.work_class || null,
    analytic_key: work.analytic_key || null,
    event: eventName,
    ...details,
  };
  await runtimeSql(`
insert into control_store.spawn_analytics_event(
  id, event_category, event_name, properties, created_at
) values(
  ${sqlText(`spawn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)},
  'spawn_worker',
  ${sqlText(eventName)},
  ${sqlText(JSON.stringify(payload))},
  now()
)
`);
}

function sqlText(value: string | null | undefined) {
  if (value == null) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonSql(value: any) {
  return `${sqlText(JSON.stringify(value))}::jsonb`;
}

function databaseUrlWithAppName(value: string) {
  try {
    const url = new URL(value);
    url.searchParams.set("application_name", DB_APPLICATION_NAME);
    return url.toString();
  } catch {
    return value;
  }
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
  /* The row own id, not a derived one. A pull whose id nobody holds cannot be decomposed,
     cited, or re-run: measured 2026-08-25, the 08-24 pull for a real client was stored with a
     NULL id and every reader downstream silently fell back to an 11-day-old decomposition. */
  const inserted = await runtimeSql(`
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
returning id
`);
  const pullId = String(inserted?.[0]?.id || "");
  if (!pullId) throw new Error("credit_report_pulls insert returned no id - refusing to leave a pull unfilled");
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
  /* FILL THE PULL. A pull that is saved but never decomposed is worse than no pull.
     Measured 2026-08-25: an FTC identity theft report was filed for a real client naming ONE
     derogatory account because every reader was looking at an 11-day-old decomposition; the
     fresh pull carried FIVE across all three bureaus, and the report cannot be amended.
     The pull and the fill are ONE job, so a pull can never be left half done. */
  const filled = await fillPull(customerId, pullId, report);
  await creditEvent(
    customerId,
    "smartcredit",
    filled.refused_no_bureau ? "needs_action" : "success",
    filled.refused_no_bureau ? "fill_refused_rows" : "pull_filled",
    `Filled ${filled.tradelines} tradelines ${JSON.stringify(filled.per_bureau)}, ${filled.negatives} negative`,
    filled
  );

  return {
    component_count: comps.length,
    score_count: scores.length,
    bureaus: scores.map((s) => s.bureau),
    raw_size: text.length,
    pull_id: pullId,
    filled,
  };
}

/* Word anchored. An unanchored /late/ matches "collateral" - measured, it failed a real client. */
const DEROG_RE = [
  /\bcharge[- ]?off\b/i, /\bcollection\b/i, /\brepossess/i, /\bforeclos/i, /\bbankrupt/i,
  /\bwage earner\b/i, /\bchapter\s*(7|11|13)\b/i, /\b\d+\s*days? past due\b/i,
  /\bderogatory\b/i, /\bdefault\b/i, /\bsettle/i, /\bwritten off\b/i,
];

/* Decompose ONE pull into the per bureau data homes.
 *
 * The bureau lives on each TradeLinePartition.Tradeline as a plain bureau field. Source is null,
 * and the per bureau components (TUCReportV6 / EQFReportV6 / EXPReportV6) come back EMPTY - 22
 * bytes each - so MergeCreditReports is the only component carrying data.
 *
 * NO FALLBACKS: a tradeline with no bureau is REFUSED and counted, never written as "merged".
 * scripts/credit-lane/decompose-report.cjs hardcoded "merged" at both insert sites, which is why
 * every negative item read merged and no CFPB complaint could ever resolve a bureau. */
async function fillPull(customerId: string, pullId: string, report: any) {
  const d = (n: any) => String(n?.description || n?.abbreviation || n?.symbol || "").trim();
  const t2 = (v: any) => (v === undefined || v === null ? "" : String(v).trim());

  const rawComp = report?.BundleComponents?.BundleComponent;
  const comps = Array.isArray(rawComp) ? rawComp : rawComp ? [rawComp] : [];
  const merged = comps.find((c: any) => t2(c.Type) === "MergeCreditReports")?.TrueLinkCreditReportType;
  if (!merged) throw new Error("no MergeCreditReports component - refusing to guess a shape");
  const partsRaw = merged.TradeLinePartition;
  const parts = Array.isArray(partsRaw) ? partsRaw : partsRaw ? [partsRaw] : [];

  const rows: any[] = [];
  const refused: any[] = [];
  for (const part of parts) {
    const items = Array.isArray(part.Tradeline) ? part.Tradeline : part.Tradeline ? [part.Tradeline] : [];
    for (const t of items) {
      const bureau = t2(t.bureau).toLowerCase();
      const creditor = t2(t.creditorName || t.subscriberName);
      if (!bureau) { refused.push({ creditor, acct: t2(t.accountNumber) }); continue; }
      const remark = Array.isArray(t.Remark)
        ? t.Remark.map((r: any) => t2(r.customRemark || r.description)).join("; ")
        : t2(t.Remark?.customRemark || t.Remark?.description);
      const pay = d(t.PayStatus), cond = d(t.AccountCondition), worst = d(t.WorstPayStatus);
      const blob = [pay, cond, worst, remark].filter(Boolean).join(" | ");
      const hit = DEROG_RE.find((re) => re.test(blob));
      rows.push({
        bureau, creditor, acct: t2(t.accountNumber),
        type: t2(part.accountTypeDescription), status: d(t.OpenClosed),
        resp: d(t.AccountDesignator), bal: Number(t.currentBalance) || 0,
        high: Number(t.highBalance) || 0, due: Number(t.amountPastDue || t.pastDue) || 0,
        opened: t2(t.dateOpened), closed: t2(t.dateClosed), reported: t2(t.dateReported),
        pay, cond, worst, dispute: d(t.DisputeFlag), industry: d(t.IndustryCode), remark,
        neg: Boolean(hit), why: hit ? (blob.match(hit) || [""])[0] : "", tl: t,
      });
    }
  }

  for (const a of rows) {
    await runtimeSql(`
insert into control_store.credit_accounts
 (id, customer_id, pull_id, bureau, creditor, account_number, account_type, status, responsibility,
  balance, high_balance, past_due, open_date, closed_date, reported_date, is_negative,
  account_condition, dispute_flag, pay_status, worst_pay_status, industry, remarks, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(a.bureau)},
  ${sqlText(a.creditor)}, ${sqlText(a.acct)}, ${sqlText(a.type)}, ${sqlText(a.status)}, ${sqlText(a.resp)},
  ${a.bal}, ${a.high}, ${a.due},
  ${a.opened ? `${sqlText(a.opened)}::date` : "null"},
  ${a.closed ? `${sqlText(a.closed)}::date` : "null"},
  ${a.reported ? `${sqlText(a.reported)}::date` : "null"},
  ${a.neg}, ${sqlText(a.cond)}, ${sqlText(a.dispute)}, ${sqlText(a.pay)}, ${sqlText(a.worst)},
  ${sqlText(a.industry)}, ${sqlText(a.remark)}, ${jsonSql(a.tl)}, now())
on conflict (customer_id, coalesce(creditor,''), coalesce(bureau,''), coalesce(account_number,''),
             coalesce(balance::text,''))
do update set pull_id=excluded.pull_id, account_type=excluded.account_type, status=excluded.status,
  responsibility=excluded.responsibility, high_balance=excluded.high_balance, past_due=excluded.past_due,
  open_date=excluded.open_date, closed_date=excluded.closed_date, reported_date=excluded.reported_date,
  is_negative=excluded.is_negative, account_condition=excluded.account_condition,
  dispute_flag=excluded.dispute_flag, pay_status=excluded.pay_status,
  worst_pay_status=excluded.worst_pay_status, industry=excluded.industry, remarks=excluded.remarks,
  raw=excluded.raw
`);
  }

  const negs = rows.filter((r) => r.neg);
  for (const n of negs) {
    await runtimeSql(`
insert into control_store.credit_negative_items
 (id, customer_id, pull_id, bureau, creditor, item_type, amount, status, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(n.bureau)},
  ${sqlText(n.creditor)}, ${sqlText(n.why || n.pay)}, ${n.bal}, ${sqlText(n.status)}, ${jsonSql(n.tl)}, now())
on conflict (customer_id, coalesce(creditor,''), coalesce(bureau,''), coalesce(status,''),
             coalesce(account_id,''))
do update set pull_id=excluded.pull_id, item_type=excluded.item_type, amount=excluded.amount,
  raw=excluded.raw
`);
  }

  const perBureau: Record<string, number> = {};
  for (const r of rows) perBureau[r.bureau] = (perBureau[r.bureau] || 0) + 1;
  const negPerBureau: Record<string, number> = {};
  for (const r of negs) negPerBureau[r.bureau] = (negPerBureau[r.bureau] || 0) + 1;
  return {
    pull_id: pullId, partitions: parts.length, tradelines: rows.length,
    per_bureau: perBureau, negatives: negs.length, negatives_per_bureau: negPerBureau,
    refused_no_bureau: refused.length, refused,
  };
}

async function cookieHeaderFromContext(context: any) {
  const cookies = await context.cookies().catch(() => []);
  return cookies.map((cookie: any) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function runSmartCreditOAuthPull(state: any, payload: any, step: any) {
  const customerId = String(state.customer_id || payload.customer_id || "");
  if (!customerId) throw new Error("missing customer_id in queued instruction payload");
  if (!state.credentials?.username || !state.credentials?.password) {
    state.customer_id = customerId;
    state.credentials = await getSmartCreditCredentials(customerId);
  }
  if (!state.credentials?.username || !state.credentials?.password) {
    await creditEvent(customerId, "smartcredit", "failed", "need_connect", "No SmartCredit credentials on file");
    throw new Error("no smartcredit credentials on file");
  }

  const clientId = step.client_id || "117dfa4a-e9e3-4268-98de-a89cf34cd67e";
  const redirect = step.redirect_uri || "https://member.smartcredit.com/auth";
  const authz = step.authorize_url || "https://auth.smartcredit.com/oauth2/authorize";
  const pageUrl = `${authz}/?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(step.scope || "openid offline_access")}`;

  await state.page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: Number(step.timeout_ms || 90000) });
  await state.page.locator('input[name="loginId"], input#loginId, input[type="email"]').first().fill(String(state.credentials.username), { timeout: Number(step.timeout_ms || 30000) });
  await state.page.locator('input[name="password"], input#password, input[type="password"]').first().fill(String(state.credentials.password), { timeout: Number(step.timeout_ms || 30000) });

  const submit = state.page.locator('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")').first();
  await Promise.all([
    state.page.waitForLoadState("domcontentloaded", { timeout: Number(step.timeout_ms || 90000) }).catch(() => {}),
    submit.click({ timeout: Number(step.timeout_ms || 30000) }),
  ]);

  let code = "";
  for (let hop = 0; hop < 12; hop++) {
    const current = state.page.url();
    try {
      const url = new URL(current);
      if (current.startsWith(redirect) && url.searchParams.get("code")) {
        code = String(url.searchParams.get("code"));
        break;
      }
      if (/reactivat/i.test(current)) {
        await creditEvent(customerId, "smartcredit", "needs_action", "needs_reactivation", "SmartCredit membership needs reactivation");
        throw new Error(`smartcredit needs reactivation: ${current}`);
      }
    } catch {}
    await state.page.waitForTimeout(1000);
  }
  if (!code) {
    await creditEvent(customerId, "smartcredit", "needs_action", "oauth_authorization_failed", "No authorization code returned");
    throw new Error(`SmartCredit did not complete the authorization step: ${state.page.url()}`);
  }

  const cookieHeader = await cookieHeaderFromContext(state.context);
  const tokenRes = await fetch(`https://api.smartcredit.com/v1/login?code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`, {
    headers: { Cookie: cookieHeader, Accept: "application/json" },
  });
  const tokenText = await tokenRes.text();
  let tokenJson: any = {};
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {}
  const accessToken = tokenJson?.access_token;
  if (!accessToken) {
    const accountStatus = String(tokenJson?.accountStatus || "").toUpperCase();
    const otcRequired = Boolean(tokenJson?.otc);
    const detail = `token exchange ${tokenRes.status}${accountStatus ? ` accountStatus=${accountStatus}` : ""}${otcRequired ? " otc" : ""}: ${tokenText.slice(0, 300).replace(/\s+/g, " ")}`;
    if (accountStatus && accountStatus !== "ACTIVE") {
      await creditEvent(customerId, "smartcredit", "needs_action", `account_${accountStatus.toLowerCase()}`, detail);
      throw new Error(`SmartCredit account is ${accountStatus}`);
    }
    if (otcRequired) {
      await creditEvent(customerId, "smartcredit", "needs_action", "otc_required", detail);
      throw new Error("SmartCredit is asking for a one-time code");
    }
    await creditEvent(customerId, "smartcredit", "failed", "oauth_token_exchange_failed", detail);
    throw new Error("SmartCredit did not issue a session");
  }

  const reportRes = await fetch(step.report_url || "https://api.smartcredit.com/v1/credit/3bs/current", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const reportText = await reportRes.text();
  if (reportRes.status === 403) {
    await creditEvent(customerId, "smartcredit", "needs_action", "report_not_in_plan", `report fetch refused after a successful login (${reportRes.status})`);
    throw new Error("SmartCredit plan does not include the 3-bureau report");
  }
  if (reportRes.status === 401) {
    await creditEvent(customerId, "smartcredit", "needs_action", "report_unauthorized", `report fetch rejected after authorization (${reportRes.status})`);
    throw new Error("SmartCredit authorized the login but rejected the report request");
  }
  if (reportRes.status === 404) {
    await creditEvent(customerId, "smartcredit", "needs_action", "no_3b_ordered", "No 3-bureau report has been ordered on this account");
    throw new Error("No 3-bureau report on this account yet");
  }
  if (reportRes.status !== 200) throw new Error(`SmartCredit report status ${reportRes.status}`);
  const report = extractReportJson(reportText);
  if (!report) {
    await creditEvent(customerId, "smartcredit", "failed", "report_unrecognized", "3bs/current response had no recognizable report payload");
    throw new Error("report not recognized");
  }

  return await storeSmartCreditReport(customerId, report, String(payload.email || ""), step.pulled_by || "spawn_playwright_oauth_pull");
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
          const response = await fetch(step.url, {
            headers,
            signal: AbortSignal.timeout(Number(step.timeout_ms || 60000)),
            redirect: "manual",
          });
          state[step.status_target || "last_status"] = response.status;
          state[step.headers_target || "last_headers"] = Object.fromEntries(response.headers.entries());
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
          const response = await fetch(step.url, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(form).toString(),
            signal: AbortSignal.timeout(Number(step.timeout_ms || 60000)),
            redirect: "manual",
          });
          state[step.status_target || "last_status"] = response.status;
          state[step.headers_target || "last_headers"] = Object.fromEntries(response.headers.entries());
          const setCookie = response.headers.get("set-cookie") || "";
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
        case "smartcredit_oauth_pull": {
          state[step.target || "stored"] = await runSmartCreditOAuthPull(state, payload, step);
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
      const startedAt = Date.now();
      try {
        await recordSpawnAnalytics(work, "claimed", { status: "running" });
        const result = await executeWork(work);
        await recordSpawnAnalytics(work, "completed", { status: "done", elapsed_ms: Date.now() - startedAt });
        await finishWork(work.id, "done", { ok: true, worker: WORKER_NAME, ...result }, `done:${work.id}`);
        log("done", work.id);
      } catch (error: any) {
        const errorText = String(error?.message || error);
        try {
          await recordSpawnAnalytics(work, "failed", { status: "error", elapsed_ms: Date.now() - startedAt, error: errorText.slice(0, 500) });
        } catch (analyticsError: any) {
          log("analytics error", work.id, String(analyticsError?.message || analyticsError));
        }
        await finishWork(
          work.id,
          "error",
          { ok: false, worker: WORKER_NAME, error: errorText },
          `error:${errorText.slice(0, 400)}`
        );
        log("error", work.id, errorText);
      }
    }
  } finally {
    draining = false;
  }
}

async function startSpawnWorker() {
  spawnWorkerStarting = true;
  spawnWorkerLastAttemptAt = new Date().toISOString();
  if (!DATABASE_URL || !KEY) {
    throw new Error("spawn worker requires DATABASE_URL and runtime authority");
  }
  const client = new Client({
    connectionString: databaseUrlWithAppName(DATABASE_URL),
    application_name: DB_APPLICATION_NAME,
  } as any);
  await client.connect();
  await client.query(`set application_name to ${sqlText(DB_APPLICATION_NAME)}`);
  await client.query(`listen ${SPAWN_CHANNEL}`);
  spawnListenerConnectedAt = new Date().toISOString();
  void drainOnce().then(() => {
    lastDrainError = null;
  }).catch((error) => {
    lastDrainError = String(error?.message || error);
    console.error("[PLAYWRIGHT-SERVICE] boot drain failed", error);
  });
  if (!spawnWorkerSafetyDrainTimer) {
    spawnWorkerSafetyDrainTimer = setInterval(() => {
      void drainOnce().then(() => {
        lastDrainError = null;
      }).catch((error) => {
        lastDrainError = String(error?.message || error);
        console.error("[PLAYWRIGHT-SERVICE] safety drain failed", error);
      });
    }, Number(process.env.SPAWN_WORKER_SAFETY_DRAIN_MS || 60000));
  }
  client.on("notification", () => {
    void drainOnce().then(() => {
      lastDrainError = null;
    }).catch((error) => {
      lastDrainError = String(error?.message || error);
      console.error("[PLAYWRIGHT-SERVICE] event drain failed", error);
    });
  });
  client.on("error", (error) => {
    spawnListenerConnectedAt = null;
    lastDrainError = String(error?.message || error);
    console.error("[PLAYWRIGHT-SERVICE] spawn listener error", error);
    scheduleSpawnWorkerReconnect();
  });
  client.on("end", () => {
    spawnListenerConnectedAt = null;
    lastDrainError = "spawn listener ended";
    console.error("[PLAYWRIGHT-SERVICE] spawn listener ended");
    scheduleSpawnWorkerReconnect();
  });
  log(`spawn worker listening on ${SPAWN_CHANNEL} via ${WORKER_NAME}`);
  void drainOnce().then(() => {
    lastDrainError = null;
  }).catch((error) => {
    lastDrainError = String(error?.message || error);
    console.error("[PLAYWRIGHT-SERVICE] initial drain failed", error);
  });
}

function scheduleSpawnWorkerReconnect(delayMs = Number(process.env.SPAWN_WORKER_RETRY_MS || 15000)) {
  if (spawnWorkerRetryTimer || spawnWorkerStarting) return;
  spawnWorkerRetryTimer = setTimeout(() => {
    spawnWorkerRetryTimer = null;
    void startSpawnWorker().catch((error) => {
      spawnListenerConnectedAt = null;
      lastDrainError = String(error?.message || error);
      console.error("[PLAYWRIGHT-SERVICE] spawn worker start failed", error);
      scheduleSpawnWorkerReconnect();
    }).finally(() => {
      spawnWorkerStarting = false;
    });
  }, Math.max(delayMs, 1000));
}

function bootSpawnWorker() {
  void startSpawnWorker().catch((error) => {
    spawnWorkerStarting = false;
    spawnListenerConnectedAt = null;
    lastDrainError = String(error?.message || error);
    console.error("[PLAYWRIGHT-SERVICE] spawn worker start failed", error);
    scheduleSpawnWorkerReconnect();
  }).finally(() => {
    spawnWorkerStarting = false;
  });
}

// Health check
app.get("/health", (c) => c.json({
  status: "ok",
  type: "playwright-service",
  residentSpine: {
    applicationName: DB_APPLICATION_NAME,
    channel: SPAWN_CHANNEL,
    connectedAt: spawnListenerConnectedAt,
  },
  worker: {
    name: WORKER_NAME,
    connected: Boolean(spawnListenerConnectedAt),
    starting: spawnWorkerStarting,
    lastAttemptAt: spawnWorkerLastAttemptAt,
    lastDrainError,
  },
}));
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
app.post("/worker/drain", ownerGate, async (c) => {
  try {
    await drainOnce();
    lastDrainError = null;
    const rows = await runtimeSql(
      `select count(*)::int as pending from control_store.spawn_work where status='pending' and (work_class='executor_credit_monitoring' or lane='credit_monitoring')`
    );
    return c.json({ ok: true, worker: WORKER_NAME, pending: rows[0]?.pending ?? null });
  } catch (error: any) {
    lastDrainError = String(error?.message || error);
    return c.json({ ok: false, worker: WORKER_NAME, error: lastDrainError }, 500);
  }
});

// POST /session — create a new browser session
app.post("/session", ownerGate, async (c) => {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    // acceptDownloads is what makes a native browser download recoverable. Without it Chromium
    // cancels the download and NOTHING reaches disk - measured 2026-08-25 on a one-time FTC
    // identity theft report: the button was clicked for real, the page emitted its analytics
    // event, and no file existed anywhere in the container. The document was unrecoverable.
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    const sessionId = Math.random().toString(36).substring(7);
    const downloads: any[] = [];
    // Capture EVERY download the moment it starts. Do not wait to be asked - a one-time
    // document is gone by the time anyone thinks to ask for it.
    page.on("download", async (d) => {
      const rec: any = { filename: d.suggestedFilename(), url: d.url(), at: new Date().toISOString() };
      try {
        rec.path = await d.path();
        rec.failure = await d.failure();
      } catch (e) { rec.error = String(e && e.message || e); }
      downloads.push(rec);
      console.log("[PLAYWRIGHT] download captured:", JSON.stringify(rec));
    });
    sessions.set(sessionId, { browser, context, page, downloads });

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
// POST /select - set a <select> by VISIBLE LABEL, then read back what actually landed.
// Built 2026-08-25. `fill` refuses a <select> ("Element is not an <input>..."), which blocked the
// FTC identity-theft walk at four selects: DoTMM, DoTYY, primePhoneType, twoFactorType.
//
// Label, never value: the FTC option values are meaningless indices like "2: 0".
//
// The readback is the point. On 2026-08-25 native typeahead on this same form silently set
// UZBEKISTAN for country, 1998 for a 1970 date of birth and 2025 for a 2021 theft year - and the
// form still reported ZERO invalid fields. A form can be fully valid and fully wrong, and an FTC
// identity theft report is permanent and cannot be amended. So this verb refuses on mismatch
// instead of reporting success.
// GET-style list of everything this session has downloaded.
app.post("/downloads", ownerGate, async (c) => {
  try {
    const { sessionId } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const list = (session.downloads || []).map((d: any, i: number) => ({
      index: i, filename: d.filename, url: d.url, at: d.at, path: d.path || null,
      error: d.error || d.failure || null,
    }));
    return c.json({ status: "ok", count: list.length, downloads: list });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to list downloads", details: error.message }, 500);
  }
});

// POST /download - click something that triggers a native download and RETURN THE FILE.
// Built 2026-08-25 after a one-time FTC identity theft report PDF was lost: the click fired,
// the analytics beacon fired, and the file never existed because downloads were not accepted.
// Never report success without bytes - an empty capture is the failure this verb exists to stop.
app.post("/download", ownerGate, async (c) => {
  try {
    const { sessionId, selector, index, timeout } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    let rec: any = null;
    if (typeof index === "number") {
      rec = (session.downloads || [])[index];
      if (!rec) return c.json({ error: "no_download_at_index", have: (session.downloads || []).length }, 404);
    } else {
      if (!selector) return c.json({ error: "download: selector or index required" }, 400);
      const waiter = session.page.waitForEvent("download", { timeout: Number(timeout) || 60000 });
      await session.page.click(selector);
      const d = await waiter;
      rec = { filename: d.suggestedFilename(), url: d.url(), path: await d.path(), at: new Date().toISOString() };
    }

    if (!rec.path) {
      return c.json({ error: "download_had_no_path", detail: rec.error || rec.failure || null, rec }, 502);
    }
    const bytes = await Bun.file(rec.path).arrayBuffer();
    if (!bytes || bytes.byteLength === 0) {
      return c.json({ error: "download_was_empty", rec }, 502);
    }
    return c.json({
      status: "downloaded",
      filename: rec.filename,
      url: rec.url,
      bytes: bytes.byteLength,
      base64: Buffer.from(bytes).toString("base64"),
    });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to download", details: error.message }, 500);
  }
});

app.post("/select", ownerGate, async (c) => {
  try {
    const { sessionId, selector, label } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (typeof label !== "string" || !label.length) {
      return c.json({ error: "select: label is required (visible option text, not value)" }, 400);
    }

    await session.page.selectOption(selector, { label });

    const landed = await session.page.locator(selector).evaluate((el) => {
      const s = el as HTMLSelectElement;
      return (s.options[s.selectedIndex] || { text: "" }).text.trim();
    });

    if (landed.toLowerCase() !== label.trim().toLowerCase()) {
      return c.json({
        error: "select_readback_mismatch",
        details: "wanted " + JSON.stringify(label) + " but the control holds " + JSON.stringify(landed),
        selector, wanted: label, got: landed,
      }, 409);
    }
    return c.json({ status: "selected", selector, label, verified: landed });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to select", details: error.message }, 500);
  }
});

// POST /eval - read page state. Without this a walk can only infer state from a click status,
// which is how a cleared required field went unnoticed.
app.post("/eval", ownerGate, async (c) => {
  try {
    const { sessionId, expression } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const result = await session.page.evaluate((src) => {
      return Function('"use strict";return (' + src + ")")();
    }, expression);
    return c.json({ status: "evaluated", result });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to evaluate", details: error.message }, 500);
  }
});

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

Bun.serve({
  hostname: "::",
  port,
  fetch: app.fetch,
});

log(`Listening on port ${port}`);
bootSpawnWorker();
