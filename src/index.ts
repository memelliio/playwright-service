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
  /* EVERY PULL IS A SNAPSHOT, AND THE UNIQUE KEYS NOW SAY SO.
     The www lane replaced the natural keys on credit_accounts, credit_scores_detail,
     credit_inquiries, credit_personal_info, credit_negative_items and credit_public_records with
     pull-scoped ones, so a second pull can store its own view of an account instead of colliding
     with the first. This worker still named the OLD columns in every ON CONFLICT, and Postgres
     answered "there is no unique or exclusion constraint matching the ON CONFLICT specification" -
     the prequal job errored 12 seconds after it was claimed and no report landed.
     Every insert here already stamps pullId; only the targets were stale.
     pull_id is also gone from every do-update list. Moving an older pull's row onto the newest pull
     is what destroys the deletion evidence the $25-per-account and $10-per-inquiry success fees are
     billed from - the previous snapshot has to still be there to compare against. */
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
) on conflict (customer_id, pull_id, coalesce(bureau, ''))
do update set vantage_score=excluded.vantage_score,
  raw=excluded.raw, created_at=now()
`);
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
    `Filled ${filled.tradelines} tradelines ${JSON.stringify(filled.per_bureau)}, ${filled.negatives} negative, ${filled.inquiries} inquiries, ${filled.identity_rows} identity, ${filled.public_records} public records, ${filled.scores} scores`,
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
      /* THE GRANTED TRADE IS WHERE THE NUMBERS LIVE.
       *
       * WorstPayStatus, amountPastDue, CreditLimit and the late counts are NOT on the tradeline -
       * the vendor nests them under GrantedTrade. Reading them off the top level returned undefined
       * every time, so past_due was always 0, credit_limit was never stored at all (which is why no
       * account could ever be graded for utilization), and the late counts never landed. */
      const gt = t.GrantedTrade || {};
      const pay = d(t.PayStatus), cond = d(t.AccountCondition), worst = d(gt.WorstPayStatus);
      const blob = [pay, cond, worst, remark].filter(Boolean).join(" | ");
      const hit = DEROG_RE.find((re) => re.test(blob));
      rows.push({
        bureau, creditor, acct: t2(t.accountNumber),
        type: d(gt.AccountType) || t2(part.accountTypeDescription), status: d(t.OpenClosed),
        resp: d(t.AccountDesignator), bal: Number(t.currentBalance) || 0,
        high: Number(t.highBalance) || 0,
        limit: Number(gt.CreditLimit) || 0,
        due: Number(gt.amountPastDue) || 0,
        monthly: Number(gt.monthlyPayment) || 0,
        late30: Number(gt.late30Count) || 0,
        late60: Number(gt.late60Count) || 0,
        late90: Number(gt.late90Count) || 0,
        opened: t2(t.dateOpened), closed: t2(t.dateClosed), reported: t2(t.dateReported),
        statusDate: t2(t.dateAccountStatus), verified: t2(t.dateVerified),
        designator: d(t.AccountDesignator), verification: d(t.VerificationIndicator),
        pay, cond, worst, dispute: d(t.DisputeFlag), industry: d(t.IndustryCode), remark,
        neg: Boolean(hit), why: hit ? (blob.match(hit) || [""])[0] : "", tl: t,
      });
    }
  }

  for (const a of rows) {
    await runtimeSql(`
insert into control_store.credit_accounts
 (id, customer_id, pull_id, bureau, creditor, account_number, account_type, status, responsibility,
  balance, high_balance, credit_limit, past_due, open_date, closed_date, reported_date,
  date_account_status, late30, late60, late90, is_negative,
  account_condition, dispute_flag, pay_status, worst_pay_status, verification, account_designator,
  industry, remarks, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(a.bureau)},
  ${sqlText(a.creditor)}, ${sqlText(a.acct)}, ${sqlText(a.type)}, ${sqlText(a.status)}, ${sqlText(a.resp)},
  ${a.bal}, ${a.high}, ${a.limit}, ${a.due},
  ${a.opened ? `${sqlText(a.opened)}::date` : "null"},
  ${a.closed ? `${sqlText(a.closed)}::date` : "null"},
  ${a.reported ? `${sqlText(a.reported)}::date` : "null"},
  ${a.statusDate ? `${sqlText(a.statusDate)}::date` : "null"},
  ${a.late30}, ${a.late60}, ${a.late90},
  ${a.neg}, ${sqlText(a.cond)}, ${sqlText(a.dispute)}, ${sqlText(a.pay)}, ${sqlText(a.worst)},
  ${sqlText(a.verification)}, ${sqlText(a.designator)},
  ${sqlText(a.industry)}, ${sqlText(a.remark)}, ${jsonSql(a.tl)}, now())
on conflict (customer_id, pull_id, coalesce(creditor,''), coalesce(bureau,''), coalesce(account_number,''),
             coalesce(balance::text,''))
do update set account_type=excluded.account_type, status=excluded.status,
  responsibility=excluded.responsibility, high_balance=excluded.high_balance,
  credit_limit=excluded.credit_limit, past_due=excluded.past_due,
  open_date=excluded.open_date, closed_date=excluded.closed_date, reported_date=excluded.reported_date,
  date_account_status=excluded.date_account_status,
  late30=excluded.late30, late60=excluded.late60, late90=excluded.late90,
  is_negative=excluded.is_negative, account_condition=excluded.account_condition,
  dispute_flag=excluded.dispute_flag, pay_status=excluded.pay_status,
  worst_pay_status=excluded.worst_pay_status, verification=excluded.verification,
  account_designator=excluded.account_designator,
  industry=excluded.industry, remarks=excluded.remarks, raw=excluded.raw
`);
  }

  const negs = rows.filter((r) => r.neg);
  for (const n of negs) {
    await runtimeSql(`
insert into control_store.credit_negative_items
 (id, customer_id, pull_id, bureau, creditor, item_type, amount, status, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(n.bureau)},
  ${sqlText(n.creditor)}, ${sqlText(n.why || n.pay)}, ${n.bal}, ${sqlText(n.status)}, ${jsonSql(n.tl)}, now())
on conflict (customer_id, pull_id, coalesce(creditor,''), coalesce(bureau,''), coalesce(status,''),
             coalesce(account_id,''))
do update set item_type=excluded.item_type, amount=excluded.amount,
  raw=excluded.raw
`);
  }

  /* THE REST OF THE REPORT.
   *
   * Accounts and negatives were the only things this fill wrote. Inquiries, the borrower block and
   * public records were decomposed by nothing, so every reader either found rows from an older pull
   * or found none - and the owner had to say so more than once. The report carries them; there is
   * no judgement call about which parts of a client's own credit file get stored. */
  /* Scores are decomposed HERE too, not only on the live pull path.
   *
   * They were written in storeSmartCreditReport, so re-decomposing a stored report never refreshed
   * them and the scores stayed pinned to whichever pull first wrote them. Same report, same
   * extractor, upserted onto the pull being decomposed. */
  let scoreCount = 0;
  for (const sc of extractScores(report).scores) {
    scoreCount++;
    await runtimeSql(`
insert into control_store.credit_scores_detail(
  id, customer_id, pull_id, bureau, vantage_score, raw, created_at
) values(
  gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)},
  ${sqlText(sc.bureau)}, ${sc.score}, ${jsonSql(sc)}, now()
) on conflict (customer_id, pull_id, coalesce(bureau, ''))
do update set vantage_score=excluded.vantage_score,
  raw=excluded.raw, created_at=now()
`);
  }

  const inqParts = Array.isArray(merged.InquiryPartition) ? merged.InquiryPartition
    : merged.InquiryPartition ? [merged.InquiryPartition] : [];
  let inquiryCount = 0;
  for (const part of inqParts) {
    const items = Array.isArray(part.Inquiry) ? part.Inquiry : part.Inquiry ? [part.Inquiry] : [];
    for (const q of items) {
      const bureau = t2(q.bureau).toLowerCase();
      const when = t2(q.inquiryDate);
      if (!bureau || !when) continue;
      inquiryCount++;
      await runtimeSql(`
insert into control_store.credit_inquiries
 (id, customer_id, pull_id, bureau, inquiry_date, subscriber_name, inquiry_type, is_hard, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(bureau)},
  ${sqlText(when)}::date, ${sqlText(t2(q.subscriberName))}, ${sqlText(d(q.inquiryType) || t2(q.inquiryType))},
  true, ${jsonSql(q)}, now())
on conflict (customer_id, pull_id, coalesce(subscriber_name, ''), coalesce(bureau, ''), coalesce(inquiry_date, '1900-01-01'::date))
do update set inquiry_type=excluded.inquiry_type, is_hard=excluded.is_hard,
  raw=excluded.raw, created_at=now()
`);
    }
  }

  /* The borrower block is one object carrying every identity fact the bureaus hold: names, birth,
     employers, current and previous addresses, the SSN partition and any credit statement. It is
     stored per bureau, whole, because a dispute turns on the parts nobody thought to select. */
  const borrower = merged.Borrower;
  const borrowers = Array.isArray(borrower) ? borrower : borrower ? [borrower] : [];
  let identityCount = 0;
  for (const b of borrowers) {
    /* The bureau on a borrower block is NOT a `bureau` field. It sits at
       Source.Bureau.abbreviation - "Equifax", "Experian", "TransUnion". Reading name.bureau
       returned undefined for all five names, so every identity row collapsed onto a single row with
       an empty bureau while the three real per-bureau rows stayed on an older pull. */
    const bureauOfBlock = (row: any) =>
      t2(row?.Source?.Bureau?.abbreviation || row?.Source?.Bureau?.description || row?.bureau).toLowerCase();
    const bureaus = new Set<string>();
    for (const name of [].concat(b.BorrowerName || [])) {
      const bu = bureauOfBlock(name);
      if (bu) bureaus.add(bu);
    }
    if (!bureaus.size) bureaus.add("");
    for (const bu of bureaus) {
      const forBureau = (value: any) => {
        const list = Array.isArray(value) ? value : value ? [value] : [];
        const scoped = list.filter((row: any) => !bu || bureauOfBlock(row) === bu);
        return scoped.length ? scoped : list;
      };
      const names = forBureau(b.BorrowerName);
      const first = names[0] as any;
      const full = t2(first?.Name?.first ? [first.Name.first, first.Name.middle, first.Name.last].filter(Boolean).join(" ") : first?.name);
      const born = ([] as any[]).concat(b.Birth || []).find((row: any) => !bu || bureauOfBlock(row) === bu)
        || ([] as any[]).concat(b.Birth || [])[0];
      /* The bureaus report what they actually hold, and here that is the YEAR ONLY - date "1970",
         BirthDate {day:null, month:null, year:"1970"}. Casting that to ::date is a Postgres syntax
         error, and it was being swallowed by a catch, so every identity row silently failed to
         write while the run counted three of them. A partial birth date stays in raw where it is
         still readable; dob only takes a real one. */
      const bornDay = t2(born?.BirthDate?.day), bornMonth = t2(born?.BirthDate?.month), bornYear = t2(born?.BirthDate?.year);
      const bornDate = /^\d{4}-\d{2}-\d{2}$/.test(t2(born?.date))
        ? t2(born.date)
        : (bornYear && bornMonth && bornDay ? `${bornYear}-${bornMonth.padStart(2, "0")}-${bornDay.padStart(2, "0")}` : "");
      identityCount++;
      await runtimeSql(`
insert into control_store.credit_personal_info
 (id, customer_id, pull_id, bureau, full_name, first_name, last_name, dob, addresses, employers, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(bu)},
  ${sqlText(full)}, ${sqlText(t2(first?.Name?.first))}, ${sqlText(t2(first?.Name?.last))},
  ${bornDate ? `${sqlText(bornDate)}::date` : "null"},
  ${jsonSql({ current: forBureau(b.BorrowerAddress), previous: forBureau(b.PreviousAddress) })},
  ${jsonSql(forBureau(b.Employer))},
  ${jsonSql({ names, birth: b.Birth, social: b.SocialPartition, ssn: b.SocialSecurityNumber, statement: b.CreditStatement })},
  now())
on conflict (customer_id, pull_id, coalesce(bureau, ''))
do update set full_name=excluded.full_name, first_name=excluded.first_name,
  last_name=excluded.last_name, dob=excluded.dob, addresses=excluded.addresses,
  employers=excluded.employers, raw=excluded.raw
`);
    }
  }

  /* RAW PROVIDER FIELD MAPPING, not a spelling story.
   *
   *   raw_payload_field_name = PulblicRecordPartition
   *   reader_expected        = PublicRecordPartition
   *
   * The raw key is what SmartCredit actually sends; whether it reads odd is beside the point. A
   * reader that only accepts the expected name finds nothing and reports a clean file, which is how
   * a bankruptcy stays invisible. Both names are read, so the raw field maps into the normalized
   * public-records node either way. Pause only if the raw value is PRESENT and no normalized row
   * gets written. */
  const prRaw = merged.PulblicRecordPartition ?? merged.PublicRecordPartition;
  const prParts = Array.isArray(prRaw) ? prRaw : prRaw ? [prRaw] : [];
  let publicRecordCount = 0;
  for (const part of prParts) {
    const items = Array.isArray(part.PublicRecord) ? part.PublicRecord : part.PublicRecord ? [part.PublicRecord] : [];
    for (const r of items) {
      const bureau = t2(r.bureau).toLowerCase();
      publicRecordCount++;
      await runtimeSql(`
insert into control_store.credit_public_records
 (id, customer_id, pull_id, bureau, record_type, status, filed_date, amount, reference, raw, created_at)
values (gen_random_uuid()::text, ${sqlText(customerId)}, ${sqlText(pullId)}, ${sqlText(bureau)},
  ${sqlText(d(r.Type) || t2(r.type))}, ${sqlText(d(r.Status) || t2(r.status))},
  ${r.filingDate ? `${sqlText(t2(r.filingDate))}::date` : "null"},
  ${Number(r.amount) || 0}, ${sqlText(t2(r.referenceNumber))}, ${jsonSql(r)}, now())
on conflict do nothing
`);
    }
  }

  /* credit_report_parsed is what the letter composer matches a selection against.
   *
   * Filling credit_accounts and credit_negative_items is not enough. On 2026-08-25
   * generate_credit_repair_letters refused with selected_accounts_not_matched_to_current_report
   * for CORNERSTONE|2021-12-21|transunion - the account named on the client's own filed FTC
   * report - because the newest credit_report_parsed row belonged to an 11-day-old pull. The
   * composer reads THIS table, so a pull that does not write it leaves every letter composed
   * against stale data.
   *
   * The flat parsed_accounts shape is one of the two the composer accepts
   * (fromSmartcreditTradeline handles {creditor, bureau, account_number, ...} directly). */
  const parsedAccounts = rows.map((a) => ({
    creditor: a.creditor,
    bureau: a.bureau,
    account_number: a.acct,
    account_partition_id: a.partition,
    account_item_id: a.item_id,
    account_type: a.type,
    status: a.status,
    responsibility: a.resp,
    balance: a.bal,
    high_balance: a.high,
    past_due: a.due,
    opened_on: a.opened,
    open_date: a.opened,
    closed_date: a.closed,
    reported_date: a.reported,
    pay_status: a.pay,
    account_condition: a.cond,
    worst_status: a.worst,
    dispute_flag: a.dispute,
    industry: a.industry,
    remarks: a.remark,
    is_negative: a.neg,
  }));
  await runtimeSql(`
insert into control_store.credit_report_parsed (customer_id, pull_id, parsed, created_at)
values (${sqlText(customerId)}, ${sqlText(pullId)},
        ${jsonSql({
          /* The composer reads parsed->'accounts'. It also sorts any row whose source ends in
             complete_v1 ahead of every other row REGARDLESS of date, so a fill that does not use
             that suffix is invisible behind an older one. Both are required or the newest pull is
             silently ignored - measured 2026-08-25, CORNERSTONE on TransUnion could not be matched
             while it sat in the newest parsed row under the wrong key. */
          source: "playwright_fill_pull_complete_v1",
          accounts: parsedAccounts,
          parsed_accounts: parsedAccounts,
          tradelines: rows.length,
        })},
        now())
on conflict (customer_id, pull_id)
do update set parsed=excluded.parsed, created_at=now()
`);

  const perBureau: Record<string, number> = {};
  for (const r of rows) perBureau[r.bureau] = (perBureau[r.bureau] || 0) + 1;
  const negPerBureau: Record<string, number> = {};
  for (const r of negs) negPerBureau[r.bureau] = (negPerBureau[r.bureau] || 0) + 1;
  return {
    pull_id: pullId, partitions: parts.length, tradelines: rows.length,
    per_bureau: perBureau, negatives: negs.length, negatives_per_bureau: negPerBureau,
    parsed_accounts: parsedAccounts.length,
    /* Reported so the receipt says what LANDED, per section. A fill that writes accounts and
       nothing else used to report success, and the missing sections were only visible to whoever
       went looking in the tables. */
    inquiries: inquiryCount, identity_rows: identityCount, public_records: publicRecordCount,
    scores: scoreCount,
    refused_no_bureau: refused.length, refused,
  };
}

async function cookieHeaderFromContext(context: any) {
  const cookies = await context.cookies().catch(() => []);
  return cookies.map((cookie: any) => `${cookie.name}=${cookie.value}`).join("; ");
}

// What the authorization page is actually saying. A URL alone cannot tell a wrong password from
// an OTP prompt from a Cloudflare hold, and for weeks all three reported the same sentence.
async function describeAuthPage(page: any) {
  try {
    const title = await page.title();
    const text = String(await page.evaluate(() => document.body?.innerText || "")).replace(/\s+/g, " ").trim();
    const ray = (text.match(/Ray ID:?\s*([a-f0-9]{12,})/i) || [])[1] || null;
    const alert = String(
      await page.evaluate(() => {
        const node = document.querySelector('.alert, .error, [role="alert"], .form-error, .callout-alert');
        return node ? (node as any).innerText || "" : "";
      })
    ).replace(/\s+/g, " ").trim();
    const message = alert || text.slice(0, 300);
    let reason = "no_authorization_code_and_page_carries_no_error";
    if (ray || /just a moment|verify you are human|checking your browser/i.test(title + " " + text)) reason = "cloudflare_interstitial_held";
    else if (/one[- ]time|verification code|two[- ]factor|authenticator|passcode/i.test(text)) reason = "one_time_code_required";
    else if (/invalid|incorrect|not match|no account|locked|disabled|suspended/i.test(alert || text)) reason = "credentials_refused";
    else if (/reactivat|expired|renew/i.test(text)) reason = "membership_needs_reactivation";
    return { title, message, ray_id: ray, reason };
  } catch (error: any) {
    return { title: null, message: null, ray_id: null, reason: "auth_page_unreadable: " + String(error?.message || error) };
  }
}

// THE BROWSER KEEPS ITS SESSION NOW.
//
// Measured 2026-09-01: this service opened a brand new empty browser for every run and closed it
// at the end, so nothing survived - no cookies, no history, no profile. That is why Cloudflare
// challenged the login submit every single time. cf_clearance is the cookie Cloudflare hands you
// AFTER you pass once; a real person sees "Just a moment" one time and never again. We threw it
// away on every run and arrived as a stranger, forever. The one hand that ever landed a report on
// this account is named browser_live_session_pull - a real session with a real profile.
//
// launchPersistentContext keeps a real Chrome profile on disk. Chrome locks a profile directory,
// so the worker and the manual session get their own, and a second concurrent open on the same
// directory is REFUSED by name rather than quietly opening a throwaway one.
// The Railway service carries its own start command, so the Dockerfile CMD that wrapped this
// process in xvfb-run never runs - measured 2026-09-01: PID 1 is "bun src/index.ts" and DISPLAY
// is empty, and Chrome refused with "you launched a headed browser without having a XServer
// running". Start the display here instead, where nothing can override it.
let displayStarted = false;
async function ensureDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (displayStarted) return ":99";
  const { spawn } = await import("child_process");
  const { existsSync } = await import("fs");
  spawn("Xvfb", [":99", "-screen", "0", "1440x900x24", "-nolisten", "tcp"], { detached: true, stdio: "ignore" }).unref();
  displayStarted = true;
  for (let i = 0; i < 50; i++) {
    if (existsSync("/tmp/.X11-unix/X99")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync("/tmp/.X11-unix/X99")) {
    throw new Error("xserver_did_not_start: Xvfb :99 never created its socket, so a headed Chrome cannot run");
  }
  process.env.DISPLAY = ":99";
  console.log("[PLAYWRIGHT] display :99 up");
  return ":99";
}

const CHROME_PROFILE_ROOT = process.env.CHROME_PROFILE_DIR || "/var/lib/memelli-chrome";
const WORKER_PROFILE = CHROME_PROFILE_ROOT + "/worker";
const SESSION_PROFILE = CHROME_PROFILE_ROOT + "/session";
const profileInUse = new Set<string>();

async function openPersistentChrome(chromium: any, profileDir: string) {
  if (profileInUse.has(profileDir)) {
    throw new Error("chrome_profile_locked: " + profileDir + " is already open; a second browser on one profile would discard the session");
  }
  await ensureDisplay();
  profileInUse.add(profileDir);
  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      acceptDownloads: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(process.env.PLAYWRIGHT_PROXY_SERVER
        ? { proxy: { server: process.env.PLAYWRIGHT_PROXY_SERVER, username: process.env.PLAYWRIGHT_PROXY_USERNAME, password: process.env.PLAYWRIGHT_PROXY_PASSWORD } }
        : {}),
    });
  } catch (error) {
    profileInUse.delete(profileDir);
    throw error;
  }
}

async function closePersistentChrome(context: any, profileDir: string) {
  try { await context.close(); } finally { profileInUse.delete(profileDir); }
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

  // Each hop names itself. "did not complete the authorization step" was true of the page load,
  // the credential fill and the submit alike, and they are three different failures.
  await state.page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: Number(step.timeout_ms || 90000) });
  const afterLoad = await describeAuthPage(state.page);
  await walkEvent("step", { ok: afterLoad.reason !== "cloudflare_interstitial_held", at: "authorize_loaded", customer_id: customerId, title: afterLoad.title, reason: afterLoad.reason, ray_id: afterLoad.ray_id });

  await state.page.locator('input[name="loginId"], input#loginId, input[type="email"]').first().fill(String(state.credentials.username), { timeout: Number(step.timeout_ms || 30000) });
  await state.page.locator('input[name="password"], input#password, input[type="password"]').first().fill(String(state.credentials.password), { timeout: Number(step.timeout_ms || 30000) });
  const afterFill = await describeAuthPage(state.page);
  await walkEvent("step", { ok: true, at: "credentials_filled", customer_id: customerId, title: afterFill.title, reason: afterFill.reason });

  const submit = state.page.locator('button[type="submit"], input[type="submit"], button:has-text("Log In"), button:has-text("Login"), button:has-text("Sign In")').first();
  await Promise.all([
    state.page.waitForLoadState("domcontentloaded", { timeout: Number(step.timeout_ms || 90000) }).catch(() => {}),
    submit.click({ timeout: Number(step.timeout_ms || 30000) }),
  ]);
  const afterSubmit = await describeAuthPage(state.page);
  await walkEvent("step", { ok: afterSubmit.reason !== "cloudflare_interstitial_held", at: "submit_clicked", customer_id: customerId, title: afterSubmit.title, reason: afterSubmit.reason, ray_id: afterSubmit.ray_id, url: state.page.url() });

  let code = "";
  let reactivation = "";
  for (let hop = 0; hop < 12; hop++) {
    const current = state.page.url();
    // Only URL PARSING belongs in this try. The reactivation throw used to sit inside it and the
    // empty catch ate it, so a membership that needed reactivating was reported as a generic
    // authorization failure and nobody could tell the two apart.
    let parsedCode = "";
    try {
      parsedCode = String(new URL(current).searchParams.get("code") || "");
    } catch {
      parsedCode = "";
    }
    if (current.startsWith(redirect) && parsedCode) {
      code = parsedCode;
      break;
    }
    if (/reactivat/i.test(current)) {
      reactivation = current;
      break;
    }
    await state.page.waitForTimeout(1000);
  }
  if (reactivation) {
    await creditEvent(customerId, "smartcredit", "needs_action", "needs_reactivation", "SmartCredit membership needs reactivation");
    await walkEvent("blocked", { ok: false, state: "blocked_named", at: "oauth_authorize", customer_id: customerId, reason: "smartcredit_needs_reactivation", url: reactivation });
    throw new Error(`smartcredit needs reactivation: ${reactivation}`);
  }
  if (!code) {
    // Read what the page actually SAYS. Reporting only the URL is why this failure was
    // indistinguishable from a Cloudflare hold, a wrong password and an OTP prompt for weeks.
    const seen = await describeAuthPage(state.page);
    await creditEvent(customerId, "smartcredit", "needs_action", "oauth_authorization_failed", seen.message || "No authorization code returned");
    await walkEvent("blocked", {
      ok: false,
      state: "blocked_named",
      at: "oauth_authorize",
      customer_id: customerId,
      reason: seen.reason,
      url: state.page.url(),
      title: seen.title,
      page_says: seen.message,
      ray_id: seen.ray_id,
    });
    throw new Error(`SmartCredit did not complete the authorization step [${seen.reason}]: ${seen.message || state.page.url()}`);
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

// The limb reports itself. Measured 2026-09-01: this service had emitted ZERO analytics events
// in its entire life, so every failed walk left no trace and the only way to learn anything was
// to fire it again at a real account. Every step now lands on the declared carrier line
// `browser.walk:` under runtime.unit.agent_definition.memelli.agentic.agent.
const WALK_TRACKER =
  process.env.ANALYTICS_TRACKER_PUBLIC_URL ||
  "https://analytics-tracker-production.up.railway.app";

async function walkEvent(verb: string, metadata: any) {
  const event = "browser.walk:" + verb;
  try {
    const res = await fetch(WALK_TRACKER + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-event": event, "x-service": "memelli-io" },
      body: JSON.stringify({
        event,
        metadata: {
          ...metadata,
          carrier_line: "infinity.spawn.runtime.ceo.admin.locked.browser_walk",
          root: "runtime.unit.agent_definition.memelli.agentic.agent",
          driver: "patchright",
        },
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    // A refused carrier is named out loud. It is NOT retried and NOT swallowed into a success -
    // a walk must not die because its instrument is down, and a dead instrument must not look fine.
    if (!body?.ok) console.error("[WALK] carrier refused " + event + ": " + (body?.error || res.status));
  } catch (error: any) {
    console.error("[WALK] carrier unreachable " + event + ": " + String(error?.message || error));
  }
}

// Cloudflare does not answer with an error - it answers 200 with an interstitial. Read the page
// for the interstitial itself, and carry the Ray ID, which is the only handle support will take.
async function readChallenge(page: any) {
  try {
    const title = await page.title();
    const text = String(await page.evaluate(() => document.body?.innerText || "")).slice(0, 4000);
    const held = /just a moment|checking your browser|verify you are human|attention required/i.test(title + " " + text);
    const ray = (text.match(/Ray ID:?\s*([a-f0-9]{12,})/i) || [])[1] || null;
    return { held, ray_id: ray, title };
  } catch (error: any) {
    return { held: null, ray_id: null, read_error: String(error?.message || error) };
  }
}

async function runPlaywrightScript(handler: any, payload: any) {
  const { chromium } = await import("patchright");
  // The profile is the fix. A browser with no saved session can never hold cf_clearance, so
  // every run met the challenge as a first-time stranger. See openPersistentChrome.
  const context = await openPersistentChrome(chromium, WORKER_PROFILE);
  const page = context.pages()[0] || await context.newPage();
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
        case "capture_response_json": {
          // The report page is a Vue app: it fetches its data and never puts it in the DOM or in
          // storage, and the bearer it uses lives in memory only - measured 2026-09-01, localStorage
          // held 32 keys and not one token, and a plain navigation to the endpoint answers
          // Unauthorized. So do not re-ask for it. Catch the response the page is ALREADY given,
          // which is exactly what a person sees on the screen.
          const pattern = new RegExp(step.url_pattern);
          const [captured] = await Promise.all([
            page.waitForResponse(
              (r: any) => pattern.test(r.url()) && r.status() === 200,
              { timeout: Number(step.timeout_ms || 90000) }
            ),
            page.goto(step.url, { waitUntil: step.wait_until || "domcontentloaded", timeout: Number(step.timeout_ms || 90000) }),
          ]);
          const captureText = await captured.text();
          state[step.text_target || "captured_text"] = captureText;
          state[step.url_target || "captured_url"] = captured.url();
          try {
            state[step.target || "report"] = JSON.parse(captureText);
          } catch {
            throw new Error(
              (step.error || "captured_response_not_json") + ": " + captured.url() +
              " " + captureText.length + " bytes first " + JSON.stringify(captureText.slice(0, 160))
            );
          }
          break;
        }
        case "read_page_json": {
          // The three-bureau report is a JSON file the member site serves to a logged-in browser:
          // /member/credit-report/3b/simple.htm?format=JSON. The walk is already signed in, so the
          // cookie the page needs is the one it is holding. No OAuth code, no token exchange, no
          // Bearer call to the API - measured 2026-09-01, the token dance is what the walk kept
          // dying on while the file itself was sitting one navigation away.
          const raw = String(await page.evaluate(() => document.body?.innerText || ""));
          state[step.text_target || "last_text"] = raw;
          if (step.landed_target) state[step.landed_target] = page.url();
          let value: any = null;
          try {
            value = JSON.parse(raw);
          } catch {
            // Say what came back instead. A login bounce and a plan refusal are different answers
            // and they both arrive as "not JSON" if nobody looks.
            const title = await page.title().catch(() => "");
            throw new Error(
              (step.error || "three_bureau_json_not_returned") +
                ": landed " + page.url() + " title " + JSON.stringify(title) +
                " first " + JSON.stringify(raw.slice(0, 160).replace(/\s+/g, " "))
            );
          }
          state[step.target || "report"] = value;
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
    // Closing the persistent context is what WRITES the profile back to disk. The cookies this
    // run earned - cf_clearance included - are kept for the next one.
    await closePersistentChrome(context, WORKER_PROFILE).catch(() => {});
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


/* ---------------------------------------------------------------------------
 * PHASE MARKS - the loader for a browser walk.
 *
 * Mel, 2026-08-26: "break it down like you would have a loader on a page ...
 * so then that way, if the agent actually stalls out on any of these, it's in a
 * loader step so it knows where it was at."
 *
 * The walks are long and their step numbers do not divide where a run actually
 * stops - CFPB steps 2 through 5 only run for a brand-new account. So the rail
 * row for each walk carries loader_phases: the MAJOR phases, each with a proof
 * it finished and a sentence for what a stall there means.
 *
 * The phase list is READ FROM THAT SAME ROW. This service does not carry its own
 * copy, because two copies drift and then the loader describes a walk nobody is
 * running.
 *
 * A phase is not a log line. It is written to control_store.credit_filing_events
 * as phase:<key>:<state>, which is exactly what GET /api/credit/walk_progress
 * reads. One table, one shape, one reader.
 * ------------------------------------------------------------------------- */

const WALK_PHASE_ROWS: Record<string, string> = {
  cfpb_complaint: "AGENT_BROWSER_WALK_CFPB_COMPLAINT",
  ftc_identity_theft_report: "AGENT_BROWSER_WALK_FTC_IDENTITY_THEFT",
};

// browser sessionId -> the phase that browser session is currently inside
const phaseState = new Map<string, any>();
const phaseModelCache = new Map<string, any[]>();

async function loadWalkPhases(walkType: string) {
  const key = WALK_PHASE_ROWS[walkType];
  if (!key) {
    throw new Error(
      "walk_type_has_no_phase_row: " + walkType + " - known: " + Object.keys(WALK_PHASE_ROWS).join(", "),
    );
  }
  const cached = phaseModelCache.get(walkType);
  if (cached) return cached;
  if (!dbPool) throw new Error("phase_marks_require_database_url");
  const row = await dbPool.query(
    "select value from control_store.rail_runtime_config where key = $1 limit 1",
    [key],
  );
  if (!row.rowCount) throw new Error("walk_row_absent: " + key);
  const value = typeof row.rows[0].value === "string" ? JSON.parse(row.rows[0].value) : row.rows[0].value;
  const phases = value && value.loader_phases && value.loader_phases.phases;
  /* Named, never filled in with a default sequence. A loader showing invented phases is worse than
     one showing none - it reports progress through steps the walk is not taking. */
  if (!Array.isArray(phases) || !phases.length) throw new Error("walk_row_carries_no_loader_phases: " + key);
  phaseModelCache.set(walkType, phases);
  return phases;
}

async function filingSessionCustomer(filingSessionId: string) {
  if (!dbPool) throw new Error("phase_marks_require_database_url");
  const row = await dbPool.query(
    "select customer_id from control_store.credit_filing_sessions where id = $1 limit 1",
    [filingSessionId],
  );
  /* Refused rather than inserted anyway. A phase row pointing at a filing session that does not
     exist is invisible to the loader and reads as a walk that never started. */
  if (!row.rowCount) throw new Error("filing_session_not_found: " + filingSessionId);
  return String(row.rows[0].customer_id || "");
}

async function writePhaseMark(mark: any, state: string, detail?: string) {
  if (!dbPool) throw new Error("phase_marks_require_database_url");
  await dbPool.query(
    `insert into control_store.credit_filing_events
       (session_id, customer_id, event_type, actor_role, bureau, payload, created_at)
     values ($1, $2, $3, 'playwright_service', $4, $5::jsonb, now())`,
    [
      mark.filingSessionId,
      mark.customerId,
      "phase:" + mark.phase + ":" + state,
      mark.bureau || "",
      JSON.stringify({
        phase: mark.phase,
        state,
        kind: mark.kind || null,
        label: mark.label || null,
        detail: detail || null,
        walk_type: mark.walkType,
        browser_session: mark.sessionId,
      }),
    ],
  );
}

/* A verb that fails while a phase is open marks that phase failed.
 *
 * Without this the walk driver has to remember to report every failure, and the one it forgets is
 * the one that matters - the loader would sit showing "active" forever on a phase that died. The
 * mark is written from the response status, so it cannot disagree with what the caller saw. */
app.use("*", async (c, next) => {
  await next();
  /* Read AFTER the handler, and only when it failed. Parsing the body first would consume the
     stream every verb in this service depends on - one bookkeeping feature would take the whole
     browser limb down with it. Nothing here runs on the success path at all. */
  if (c.req.method !== "POST" || c.res.status < 400) return;
  let sessionId = "";
  try {
    const body = await c.req.json();
    sessionId = String((body && body.sessionId) || "");
  } catch {
    return;
  }
  if (!sessionId) return;
  const mark = phaseState.get(sessionId);
  if (!mark) return;
  try {
    await writePhaseMark(mark, "failed", c.req.path + " answered " + c.res.status);
    phaseState.delete(sessionId);
  } catch (error: any) {
    // Never let a bookkeeping write change what the caller is told about their own request.
    console.error("[PLAYWRIGHT] phase fail-mark write failed", error?.message || error);
  }
});

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
    const { chromium } = await import("patchright");
    // Measured 2026-08-31: a real SmartCredit sign-in filled and clicked correctly and
    // auth.smartcredit.com answered with a Cloudflare security check, Ray ID a3403d4e08f6d69c.
    // Dressing the user agent did not clear it, and it was never going to: the tell is the CDP
    // command Runtime.enable, which stock Playwright issues and Cloudflare reads directly.
    // The driver is Patchright now - it runs page scripts in isolated execution contexts and
    // never issues Runtime.enable. Measured against 31 Cloudflare targets in 2026, stock
    // Playwright was the WORST performer of every stealth tool tested. The IP was not the gate.
    // The manual session keeps its own Chrome profile too, on its own directory, because
    // Chrome locks a profile and two browsers on one would throw the session away.
    const context = await openPersistentChrome(chromium, SESSION_PROFILE);
    const page = context.pages()[0] || await context.newPage();

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
    sessions.set(sessionId, { context, page, downloads, profileDir: SESSION_PROFILE });
    await walkEvent("open", { ok: true, session_id: sessionId, proxied: Boolean(process.env.PLAYWRIGHT_PROXY_SERVER) });

    return c.json({ sessionId, status: "created" });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    await walkEvent("blocked", { ok: false, at: "session_create", reason: String(error?.message || error) });
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
    const gate = await readChallenge(session.page);
    await walkEvent(gate.held ? "gate_hold" : "step", {
      ok: !gate.held,
      state: gate.held ? "blocked_named" : "verified",
      session_id: sessionId,
      url,
      title: gate.title,
      ray_id: gate.ray_id,
      reason: gate.held ? "cloudflare_interstitial_held" : undefined,
    });
    return c.json({ status: "navigated", url, gate });
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

/* POST /type - real keystrokes, one at a time.
 *
 * page.fill sets the value and fires input, which is enough for a plain field and NOT enough for a
 * typeahead: measured 2026-08-25 on the CFPB company search, fill put "TRANSUNION INTERMEDIATE" in
 * the box and no option list ever rendered, because the Lightning combobox listens for key events.
 * A form that needs a suggestion picked cannot be driven by fill alone. */
app.post("/type", ownerGate, async (c) => {
  try {
    const { sessionId, selector, value, delay, clear } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    await session.page.click(selector);
    if (clear !== false) {
      await session.page.fill(selector, "");
    }
    await session.page.type(selector, String(value ?? ""), { delay: Number(delay) || 90 });
    const landed = await session.page.inputValue(selector).catch(() => null);
    return c.json({ status: "typed", selector, landed });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to type", details: error.message }, 500);
  }
});

/* POST /press - a single key on the focused element (Enter, ArrowDown, Tab). */
app.post("/press", ownerGate, async (c) => {
  try {
    const { sessionId, key, selector } = await c.req.json();
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (selector) await session.page.focus(selector);
    await session.page.keyboard.press(String(key || "Enter"));
    return c.json({ status: "pressed", key });
  } catch (error) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to press", details: error.message }, 500);
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


/* POST /phase - advance the loader.
 *
 *   { sessionId, filingSessionId, walkType, phase }  enter a phase; the phase it was in is closed done
 *   { sessionId, state: "done" }                     close the current phase (the last one has no successor)
 *   { sessionId, state: "failed", detail }           close it as failed
 *
 * A phase the walk row does not carry is REFUSED with the list that exists. Recording a near match
 * would point the next lane at the wrong channel - and on these walks the channels are an inbox, an
 * SMS line and a phone call.
 */

/* POST /decompose - re-decompose a pull that is ALREADY stored.
 *
 * NOT /fill: that name is already the browser form-fill verb, and a second route with the same
 * path never runs - the first registration wins and answers "Session not found" for a request that
 * has nothing to do with a browser session.
 *
 * The raw report is saved before it is decomposed, so a fill defect does not mean the report is
 * gone - it means the report was never fully read. Re-pulling to fix a decomposition bug asks the
 * vendor for something we already have, and when the vendor is refusing (measured 2026-08-26:
 * token exchange 403 "Invalid Request") it cannot be fixed at all.
 *
 * So this re-runs fillPull against a stored pull_id. Same code path as a live pull; no second
 * decomposer that can drift from it.
 */
app.post("/decompose", ownerGate, async (c) => {
  try {
    const { customerId, pullId } = await c.req.json();
    if (!customerId) return c.json({ error: "customerId required" }, 400);
    if (!dbPool) return c.json({ error: "fill requires DATABASE_URL" }, 503);

    const found = pullId
      ? await dbPool.query(
          "select id::text as id, raw_report, pulled_at from control_store.credit_report_pulls where id::text = $1 and customer_id = $2",
          [String(pullId), String(customerId)],
        )
      : await dbPool.query(
          "select id::text as id, raw_report, pulled_at from control_store.credit_report_pulls where customer_id = $1 order by pulled_at desc limit 1",
          [String(customerId)],
        );
    if (!found.rowCount) return c.json({ error: "pull_not_found", customerId, pullId: pullId || "(newest)" }, 404);

    const row = found.rows[0];
    const report = typeof row.raw_report === "string" ? JSON.parse(row.raw_report) : row.raw_report;
    if (!report) return c.json({ error: "pull_has_no_raw_report", pull_id: row.id }, 409);

    const filled = await fillPull(String(customerId), String(row.id), report);
    return c.json({ status: "filled", pull_id: row.id, pulled_at: row.pulled_at, ...filled });
  } catch (error: any) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to fill", details: error?.message || String(error) }, 500);
  }
});

app.post("/phase", ownerGate, async (c) => {
  try {
    const { sessionId, filingSessionId, walkType, phase, state, detail, bureau } = await c.req.json();
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);

    if (!phase) {
      const closing = String(state || "");
      if (closing !== "done" && closing !== "failed") {
        return c.json({ error: "phase required, or state done|failed to close the current one" }, 400);
      }
      const open = phaseState.get(sessionId);
      if (!open) return c.json({ error: "no_phase_open_for_this_session", sessionId }, 409);
      await writePhaseMark(open, closing, detail);
      phaseState.delete(sessionId);
      return c.json({ status: "phase_closed", phase: open.phase, label: open.label, state: closing });
    }

    if (!filingSessionId) return c.json({ error: "filingSessionId required to enter a phase" }, 400);
    if (!walkType) return c.json({ error: "walkType required to enter a phase" }, 400);

    const phases = await loadWalkPhases(String(walkType));
    const known = phases.find((p: any) => String(p && p.key) === String(phase));
    if (!known) {
      return c.json({
        error: "phase_not_in_the_walk",
        phase,
        walk_type: walkType,
        accepted: phases.map((p: any) => p.key),
      }, 400);
    }

    const customerId = await filingSessionCustomer(String(filingSessionId));

    // The phase it was in finished when the next one began. Nothing else closes it.
    const open = phaseState.get(sessionId);
    if (open && open.phase !== String(phase)) await writePhaseMark(open, "done");

    const mark = {
      sessionId: String(sessionId),
      filingSessionId: String(filingSessionId),
      customerId,
      walkType: String(walkType),
      phase: String(phase),
      label: known.label || null,
      kind: known.kind || "acting",
      bureau: bureau ? String(bureau) : "",
    };
    await writePhaseMark(mark, "entered", detail);
    phaseState.set(String(sessionId), mark);

    return c.json({
      status: "phase_entered",
      phase: mark.phase,
      label: mark.label,
      kind: mark.kind,
      // A code wait means the form has stopped and the next value comes from outside the browser.
      waiting_on: known.channel || null,
      closed_previous: open && open.phase !== mark.phase ? open.phase : null,
    });
  } catch (error: any) {
    console.error("[PLAYWRIGHT] Error:", error);
    return c.json({ error: "Failed to record phase", details: error?.message || String(error) }, 500);
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

    await closePersistentChrome(session.context, session.profileDir || SESSION_PROFILE);
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
