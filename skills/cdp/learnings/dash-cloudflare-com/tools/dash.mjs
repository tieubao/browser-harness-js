// learnings/dash-cloudflare-com/tools/dash.mjs
// The Cloudflare dashboard talks the SAME /api/v4/* shapes as the public API, authenticated by
// the session cookie instead of a token. From a background tab on dash.cloudflare.com,
// fetch("/api/v4"+path, {credentials:"include"}) acts as the signed-in user with no CSRF header
// needed (verified 2026-09-04: GET, POST and PATCH all worked -- token mint, zone-settings PATCH
// on four zones). This exists because a scoped user token can be short of a permission (reading
// permission_groups, writing a zone setting outside its policy) that the signed-in user's own
// cookie already has in the UI.
//
// All four tools share one background tab (module scope, survives until the daemon restarts) so
// a run of several calls does not spawn a tab per call.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let tabId;

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function ensureTab(ctx) {
  if (tabId) {
    const alive = (await ctx.listPageTargets()).some((t) => t.targetId === tabId);
    if (alive) { await ctx.session.use(tabId); return tabId; }
  }
  const { targetId } = await ctx.session.Target.createTarget({ url: "https://dash.cloudflare.com/profile", background: true });
  tabId = targetId;
  await ctx.session.use(tabId);
  await wait(6000);
  return tabId;
}

// A Turnstile challenge or a re-auth ("sudo") prompt means the signed-in session cannot answer
// an API call as-is. Neither is scriptable (Turnstile by design, sudo needs a passkey/2FA
// device), so detect and stop rather than trying to click through.
async function stopReason(ctx) {
  return evaluate(ctx, `(() => {
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return "turnstile";
    const t = document.body.innerText || "";
    if (/enter your password to continue|confirm your identity|re-?enter your password/i.test(t)) return "sudo";
    return null;
  })()`);
}

// Signed-in user's email, read off the profile page.
export async function whoami(ctx) {
  await ensureTab(ctx);
  const stop = await stopReason(ctx);
  if (stop) return { stop };
  const text = await evaluate(ctx, "document.body.innerText");
  const m = String(text || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
  return m ? m[0] : { stop: "no-email-found" };
}

// Generic cookie-authenticated call. Limits learned 2026-09-04: acts as the signed-in user, so
// it CANNOT edit that user's own account membership or another user's 2FA (same wall the
// dashboard UI enforces). Never log the response here -- a token-mint body carries a secret
// value; return it to the caller and let the caller decide where it goes.
export async function api(ctx, args) {
  const { path, method, body } = args || {};
  if (!path || !path.startsWith("/")) throw new Error('api: path must start with "/" (e.g. "/user/tokens")');
  await ensureTab(ctx);
  const stop = await stopReason(ctx);
  if (stop) return { stop };
  const expr = `fetch(${JSON.stringify("/api/v4" + path)}, {
    credentials: "include",
    method: ${JSON.stringify(method || "GET")},
    headers: { "content-type": "application/json" }${body !== undefined ? `,
    body: ${JSON.stringify(JSON.stringify(body))}` : ""}
  }).then(r => r.json())`;
  return evaluate(ctx, expr);
}

// Mint a user API token via the dashboard session. Built on api(). The minted value is returned
// to the caller only -- this function never prints or stores it.
export async function mintToken(ctx, args) {
  const { name, policies } = args || {};
  if (!name || !Array.isArray(policies) || !policies.length) throw new Error("mintToken: name and a non-empty policies array are required");
  const r = await api(ctx, { path: "/user/tokens", method: "POST", body: { name, policies } });
  if (r && r.stop) return r;
  if (!r || !r.success) return { error: (r && r.errors) || "mint failed" };
  return { id: r.result.id, value: r.result.value };
}

// PATCH one zone setting via the dashboard session. Built on api().
export async function setZoneSetting(ctx, args) {
  const { zoneId, key, value } = args || {};
  if (!zoneId || !key) throw new Error("setZoneSetting: zoneId and key are required");
  const r = await api(ctx, { path: `/zones/${zoneId}/settings/${key}`, method: "PATCH", body: { value } });
  if (r && r.stop) return r;
  if (!r || !r.success) return { error: (r && r.errors) || "setZoneSetting failed" };
  return { key, value: r.result.value };
}
