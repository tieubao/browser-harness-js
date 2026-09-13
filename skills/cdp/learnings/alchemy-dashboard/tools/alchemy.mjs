// learnings/alchemy-dashboard/tools/alchemy.mjs
// The Alchemy dashboard reads its own numbers from a tRPC API at https://app-api.alchemy.com/trpc/,
// authorized by a short-lived Bearer header. The session cookie alone is not enough: a
// credentials:"include" replay returns 401. This registry exists because the free plan's
// @alchemy/cli refuses --group-by and --filters, so per-app / per-method / per-network usage has
// no CLI route at all, and the dashboard's own tRPC is the only source.
//
// The captured header lives in module memory for the life of the daemon. It is never written to
// disk, never logged, and never interpolated into an error: every string that leaves this module
// through an Error passes mask() first.

const TRPC = "https://app-api.alchemy.com/trpc/";
const DASH = "https://dashboard.alchemy.com";
const GROUPS = ["appId", "method", "network"];
const CAPTURE_MS = 25000;
// The breakdown query is usually a second or two, but the first one after a reload has taken
// over 20s. The abort still has to exist: a page fetch under awaitPromise with no timeout wedges
// the REPL permanently, and only `browser-harness-js --restart` gets it back.
const FETCH_MS = 45000;

let cached = null;

const brief = (v) => (v.length > 12 ? v.slice(0, 4) + "…" + v.slice(-4) : "…");
const mask = (s) =>
  String(s == null ? "" : s)
    .replace(/Bearer\s+[\w.~+/=-]{8,}/gi, (m) => "Bearer " + brief(m.split(/\s+/)[1]))
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, brief);

async function useDashboardTab(ctx) {
  const targets = await ctx.listPageTargets();
  const tab = targets.find((t) => t.url.startsWith(DASH));
  if (!tab) throw new Error("no dashboard.alchemy.com tab open; open one and sign in first");
  await ctx.session.use(tab.targetId);
  return tab;
}

// One tRPC query, run page-side so it carries the browser's own origin and TLS session.
// The AbortController is not optional: a page fetch that hangs under awaitPromise wedges the
// whole REPL, and only `browser-harness-js --restart` gets it back.
async function trpc(ctx, proc, input, header) {
  const expression = `(async () => {
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), ${FETCH_MS});
    try {
      const url = ${JSON.stringify(TRPC + proc)} + "?input=" + encodeURIComponent(${JSON.stringify(JSON.stringify(input))});
      const r = await fetch(url, { headers: { Authorization: ${JSON.stringify(header)} }, signal: c.signal });
      return { status: r.status, body: await r.text() };
    } catch (e) {
      return { status: 0, body: "page fetch failed: " + String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  })()`;
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({
    expression, awaitPromise: true, returnByValue: true, timeout: FETCH_MS + 5000,
  });
  if (exceptionDetails) throw new Error(mask(exceptionDetails.text || "Runtime.evaluate failed"));
  return (result && result.value) || { status: 0, body: "no result" };
}

async function query(ctx, proc, input, args) {
  const supplied = args && args.auth;
  const header = supplied || (await captureAuth(ctx));
  const { status, body } = await trpc(ctx, proc, input, header);
  if (status === 200) return JSON.parse(body).result.data;
  // A 401 means the header went stale (the dashboard rotates it every few minutes) or the tab is
  // signed out. Raise instead of retrying: a retry would replay the same dead header, and a
  // silent re-capture would hide an expired login. Drop the cache so the NEXT call sniffs afresh.
  if (status === 401 && !supplied) cached = null;
  throw new Error(`${proc} ${status}: ${mask(body).slice(0, 300)}`);
}

// Sniff the Authorization header off a live request. Page.reload makes the SPA re-issue its tRPC
// calls; the first one carrying the header wins. Returns the value to the caller in memory only.
export async function captureAuth(ctx, args) {
  if (cached && !(args && args.force)) return cached;
  await useDashboardTab(ctx);
  await ctx.session.Network.enable({});
  let found = null;
  const off = ctx.session.onEvent((method, params) => {
    if (found || method !== "Network.requestWillBeSent") return;
    if (!/app-api\.alchemy\.com\/trpc/.test(params.request.url)) return;
    const headers = params.request.headers;
    const key = Object.keys(headers).find((h) => h.toLowerCase() === "authorization");
    if (key) found = headers[key];
  });
  try {
    await ctx.session.Page.reload({});
    const deadline = Date.now() + CAPTURE_MS;
    while (!found && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  } finally {
    off();
  }
  if (!found) throw new Error("no Authorization header on any trpc request within 25s; is the tab signed in?");
  cached = found;
  return cached;
}

// Daily usage buckets for one dimension. start and end are ISO UTC strings.
export async function usageBreakdown(ctx, args) {
  const { groupBy, start, end } = args || {};
  if (!GROUPS.includes(groupBy)) throw new Error(`usageBreakdown: groupBy must be one of ${GROUPS.join(", ")}`);
  if (!start || !end) throw new Error("usageBreakdown: start and end are required ISO UTC timestamps");
  return query(ctx, "usage.getBillingUsageBreakdownTimeseries", { product: "http", groupBy, start, end }, args);
}

// sid -> app name, the map that makes an appId breakdown readable. The raw getApps response also
// carries each app's authToken (a live API key); this returns names only, so no credential of any
// kind leaves the page.
export async function apps(ctx, args) {
  const data = await query(ctx, "apps.getApps", { includeProducts: false, includeWhitelistEntries: false }, args);
  const out = {};
  for (const app of data) out[app.sid] = app.name;
  return out;
}

// Fold a breakdown timeseries into per-key totals. Pure: no page, no network, no auth.
export async function summarize(ctx, args) {
  const series = Array.isArray(args) ? args : (args && args.series) || [];
  const totals = {};
  for (const row of series) {
    for (const [key, value] of Object.entries(row)) {
      if (key === "timestamp" || typeof value !== "number") continue;
      totals[key] = (totals[key] || 0) + value;
    }
  }
  return totals;
}
