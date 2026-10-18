// learnings/dash-cloudflare-com/tools/forms.mjs
// Dashboard FORM drivers for flows the cookie-authenticated api() cannot do: in-page POST/PUT to
// /api/v4 returned 403 for Turnstile widget creation, AI Gateway provider keys and the AI Gateway
// token, so the dashboard's own React forms are the path. Distilled from a hand-driven CDP
// session on the Dwarves Cloudflare account.
//
// Three traps learned the hard way:
//  - Text fields need focus() then Input.insertText; setting .value does not reach React state.
//  - Combobox options and some buttons ignore el.click() and Enter. Only a real
//    Input.dispatchMouseEvent (moved, pressed, released) at the bounding-box centre works.
//  - Secrets (gateway provider key, the minted token) never go through argv, logs, or error text.
//    The provider key is read from an env var NAME the caller passes; the minted token comes back
//    as the return value only, same convention as mintToken in dash.mjs.
//
// Each call opens its own tab and closes it in finally, so calls do not trample each other.
// The tab is foreground: real mouse input on a throttled background tab is unreliable.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

async function realClick(ctx, x, y) {
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await ctx.session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// In-page helpers, prepended to every evaluated expression. find() returns the first VISIBLE
// element matching sel whose text (or aria-label, or value) matches re.
const PRELUDE = `
const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
const txt = (e) => (((e.innerText || e.getAttribute("aria-label") || e.value || "") + "")).trim();
const find = (sel, re, root) => [...(root || document).querySelectorAll(sel)].find((e) => vis(e) && re.test(txt(e)));
const rectOf = (e) => { if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
`;
// Module-scope ctx of the call in flight (set by openTab); every helper below reads it.
let currentCtx;
const inPage = (body) => evaluate(currentCtx, `(() => { ${PRELUDE} ${body} })()`);

const reOf = (src) => `new RegExp(${JSON.stringify(src)}, "i")`;

async function findRect(sel, reSrc, rootExpr) {
  const body = `const root = ${rootExpr || "document"}; if (!root) return null; return rectOf(find(${JSON.stringify(sel)}, ${reOf(reSrc)}, root));`;
  return inPage(body);
}

async function waitRect(sel, reSrc, { rootExpr, timeout = 15000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await findRect(sel, reSrc, rootExpr);
    if (r) return r;
    if (Date.now() > end) return null;
    await wait(400);
  }
}

// Wait for an element, then press it with a real mouse event at its bounding-box centre.
async function clickReal(label, sel, reSrc, opts) {
  const r = await waitRect(sel, reSrc, opts);
  if (!r) throw new Error(`not found: ${label}`);
  await realClick(currentCtx, r.x + r.width / 2, r.y + r.height / 2);
  return r;
}

// Focus an element (select its content) so Input.insertText replaces rather than appends.
async function focusEl(label, elExpr, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const ok = await inPage(`const el = ${elExpr}; if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); if (el.select) el.select(); return document.activeElement === el;`);
    if (ok) return;
    if (Date.now() > end) throw new Error(`not found: ${label}`);
    await wait(400);
  }
}

async function pollUntil(exprBody, timeout, interval = 400) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await inPage(exprBody);
    if (v) return v;
    if (Date.now() > end) return null;
    await wait(interval);
  }
}

// A login redirect or a re-auth prompt is not scriptable. The Turnstile PAGE itself may legitimately
// embed a challenges.cloudflare.com preview iframe, so unlike dash.mjs this does not stop on one.
async function blockedReason() {
  return inPage(`
    if (location.hostname !== "dash.cloudflare.com" || /^\\/(login|sign-up)/.test(location.pathname)) return "login";
    if (/enter your password to continue|confirm your identity|re-?enter your password/i.test(document.body.innerText || "")) return "sudo";
    return null;`);
}

async function openTab(ctx, url) {
  currentCtx = ctx;
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: false });
  await ctx.session.use(targetId);
  await ctx.session.Page.enable();
  await ctx.session.Page.navigate({ url });
  await wait(4000);
  await pollUntil(`return document.readyState === "complete";`, 15000);
  return targetId;
}

async function withTab(ctx, url, fn) {
  const targetId = await openTab(ctx, url);
  try {
    const stop = await blockedReason();
    if (stop) return { stop };
    return await fn();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// GET through the dashboard session on the current tab. Whitelist fields at the call site.
async function pageGet(path) {
  return inPage(`return fetch(${JSON.stringify("/api/v4" + path)}, { credentials: "include" }).then((r) => r.json());`);
}

function needArgs(tool, args, keys) {
  for (const k of keys) if (!args || !args[k]) throw new Error(`${tool}: ${k} is required`);
}

const CONFIGURED = `(document.body.innerText.match(/You have configured (\\d+) out of \\d+/) || [])[1]`;

const MODE_LABELS = { managed: "Managed", "non-interactive": "Non-interactive", invisible: "Invisible" };

// Create a Turnstile widget through the dashboard form. Returns the public site key read back
// from the widget list. The secret is never read here: read it with an API token that has
// Turnstile Read (GET /accounts/<id>/challenges/widgets/<sitekey>).
export async function addTurnstileWidget(ctx, args) {
  needArgs("addTurnstileWidget", args, ["accountId", "name"]);
  const { accountId, name } = args;
  const hostnames = [].concat(args.hostnames || []).filter(Boolean);
  if (!hostnames.length) throw new Error("addTurnstileWidget: hostnames is required");
  const mode = String(args.mode || "managed").toLowerCase();
  if (!MODE_LABELS[mode]) throw new Error(`addTurnstileWidget: mode must be one of ${Object.keys(MODE_LABELS).join(", ")}`);

  return withTab(ctx, `https://dash.cloudflare.com/${accountId}/turnstile`, async () => {
    // The list page's button lands on /turnstile/add. Fall back to the URL if the click misses.
    const r = await waitRect("a, button", "^add widget manually$", { timeout: 15000 });
    if (r) await realClick(ctx, r.x + r.width / 2, r.y + r.height / 2);
    if (!(await pollUntil(`return /\\/turnstile\\/add/.test(location.pathname);`, 8000))) {
      await ctx.session.Page.navigate({ url: `https://dash.cloudflare.com/${accountId}/turnstile/add` });
    }

    await focusEl("widget name input", `document.querySelector('input[name="name"]')`);
    await ctx.session.Input.insertText({ text: name });

    const added = [];
    for (const host of hostnames) {
      const before = Number(await inPage(`return ${CONFIGURED} || 0;`)) || 0;
      await focusEl("hostname input", `[...document.querySelectorAll("input")].find((i) => vis(i) && /hostname/i.test(i.placeholder || ""))`);
      await ctx.session.Input.insertText({ text: host });
      // The suggestion reads: Add “<host>” as a custom hostname. el.click() and Enter do NOT add it.
      const opt = await waitRect('[role="option"]', `custom hostname`, { timeout: 8000 });
      if (!opt) throw new Error(`hostname option did not appear for ${host}`);
      await realClick(ctx, opt.x + opt.width / 2, opt.y + opt.height / 2);
      const grew = await pollUntil(`return Number(${CONFIGURED} || 0) > ${before};`, 6000);
      if (!grew) return { stop: "hostname-not-added", hostname: host, added };
      added.push(host);
    }

    if (mode !== "managed") {
      await clickReal(`widget mode ${mode}`, '[role="radio"], label, input[type="radio"]', `^${MODE_LABELS[mode]}\\b`, { timeout: 8000 });
    }

    await clickReal("Create button", "button", "^create$");
    // After Create the dashboard leaves /turnstile/add.
    await pollUntil(`return !/\\/turnstile\\/add/.test(location.pathname);`, 20000);

    const r2 = await pageGet(`/accounts/${accountId}/challenges/widgets?per_page=50&order=created_on&direction=desc`);
    if (!r2 || !r2.success) return { error: (r2 && r2.errors) || "widget list read failed", hostnames: added };
    const w = (r2.result || []).filter((x) => x.name === name)[0];
    if (!w) return { error: "widget not found in list after Create", hostnames: added };
    return { name: w.name, sitekey: w.sitekey, mode: w.mode, domains: w.domains, hostnames: added };
  });
}

// Add a provider API key to an AI Gateway through the Provider Keys tab. The key is read from the
// env var NAMED by secretEnv inside the REPL process, typed into the password input with
// Input.insertText, and never returned, logged, or put in an error message. The REPL daemon is
// long-lived and does not see newly exported shell vars: set it in the daemon first with
// process.env[secretEnv] = <value> from a captured shell variable, never a literal.
// The first key for an account auto-creates and binds a Secrets Store.
export async function addGatewayProviderKey(ctx, args) {
  needArgs("addGatewayProviderKey", args, ["accountId", "gateway", "provider", "alias", "secretEnv"]);
  const { accountId, gateway, provider, alias, secretEnv } = args;
  const secret = process.env[secretEnv];
  if (!secret) return { stop: "secret-env-missing", secretEnv };

  const provRe = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return withTab(ctx, `https://dash.cloudflare.com/${accountId}/ai/ai-gateway/gateways/${gateway}/integrations`, async () => {
    const tab = await findRect('[role="tab"], button, a', "^provider keys$");
    if (tab) await realClick(ctx, tab.x + tab.width / 2, tab.y + tab.height / 2);
    await wait(1000);

    // Row for the provider: the nearest ancestor of an "Add" button that mentions the provider.
    const addRow = `
      const re = ${reOf(provRe)};
      const rowOf = (btn) => { let n = btn.parentElement; for (let i = 0; n && i < 8; i++, n = n.parentElement) if (re.test(n.innerText || "")) return n; return null; };
      const pick = (btns) => btns.map((b) => ({ b, row: rowOf(b) })).filter((x) => x.row).sort((a, b) => a.row.innerText.length - b.row.innerText.length)[0];
    `;
    const rowAdd = await inPage(`${addRow} const x = pick([...document.querySelectorAll("button")].filter((b) => vis(b) && /^add$/i.test(txt(b)))); return x ? rectOf(x.b) : null;`);
    if (rowAdd) {
      await realClick(ctx, rowAdd.x + rowAdd.width / 2, rowAdd.y + rowAdd.height / 2);
    } else {
      // Provider already has a key: open its Actions menu, then "Add another key".
      await clickReal(`Actions for ${provider}`, "button", `^actions for ${provRe}`);
      await clickReal("Add another key", '[role="menuitem"]', "^add another key$", { timeout: 8000 });
    }

    const dialog = `document.querySelector('[role="dialog"]')`;
    await focusEl("key password input", `${dialog} && ${dialog}.querySelector('input[type="password"]')`);
    await ctx.session.Input.insertText({ text: secret });
    await focusEl("alias input", `${dialog} && [...${dialog}.querySelectorAll("input")].find((i) => vis(i) && i.type !== "password" && (i.type === "text" || !i.type))`);
    await ctx.session.Input.insertText({ text: alias });

    await clickReal("Add Key button", "button", "^add key$", { rootExpr: dialog });

    // Outcome: dialog closes, or says it saved but could not verify. Close anyway in that case.
    const outcome = await pollUntil(`
      const d = ${dialog};
      if (!d) return "closed";
      if (/couldn.t verify/i.test(d.innerText || "")) return "unverified";
      if (/invalid|incorrect|error|failed/i.test(d.innerText || "")) return "error";
      return null;`, 25000);
    let verifiedByProvider = outcome === "closed";
    if (outcome === "unverified") {
      await clickReal("Close anyway", "button", "^close anyway$", { rootExpr: dialog, timeout: 8000 });
    } else if (outcome === "error") {
      const msg = await inPage(`const d = ${dialog}; return d ? d.innerText.slice(0, 200) : "";`);
      return { error: "dialog reported an error", dialogText: msg };
    } else if (!outcome) {
      return { error: "dialog did not settle within 25s" };
    }

    // Aliases only: the GET returns provider configs, never use the secret fields.
    const cfg = await pageGet(`/accounts/${accountId}/ai-gateway/gateways/${gateway}/provider_configs`);
    if (!cfg || !cfg.success) return { added: null, verifiedByProvider, error: (cfg && cfg.errors) || "provider_configs read failed" };
    const raw = Array.isArray(cfg.result) ? cfg.result : (cfg.result && (cfg.result.provider_configs || cfg.result.items)) || [];
    const aliases = raw.map((c) => ({ provider: c.provider_slug || c.provider || c.slug, alias: c.alias }));
    return { added: aliases.some((a) => a.alias === alias), verifiedByProvider, aliases };
  });
}

// Mint the AI Gateway "Run" token from the gateway Settings side panel (not a role=dialog). The
// panel presets Account / AI Gateway / Run on the account. Returns {name, value}; the one-time
// value goes to the caller only, same convention as mintToken in dash.mjs. Capture it with
// VAR=$(...), never echo it.
export async function createGatewayToken(ctx, args) {
  needArgs("createGatewayToken", args, ["accountId", "gateway", "name"]);
  const { accountId, gateway, name } = args;

  return withTab(ctx, `https://dash.cloudflare.com/${accountId}/ai/ai-gateway/gateways/${gateway}/settings`, async () => {
    await clickReal("Create authentication token", "button, a", "^create authentication token$");

    // The name field is labelled "Token name"; fall back to placeholder or aria-label.
    await focusEl("Token name input", `
      (() => {
        const lab = [...document.querySelectorAll("label")].find((l) => vis(l) && /^token name/i.test(txt(l)));
        const byLabel = lab && (lab.control || (lab.htmlFor && document.getElementById(lab.htmlFor)) || lab.querySelector("input"));
        return byLabel || [...document.querySelectorAll("input")].find((i) => vis(i) && /token name/i.test((i.placeholder || "") + (i.getAttribute("aria-label") || "")));
      })()`);
    await ctx.session.Input.insertText({ text: name });

    await clickReal("Create API Token button", "button", "^create api token$");

    const created = await pollUntil(`return /API Token Created/i.test(document.body.innerText || "");`, 30000);
    if (!created) return { error: "API Token Created section did not appear" };

    // The token sits in a readonly input or a code block under the "API Token Created" heading.
    const value = await inPage(`
      const heading = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && /API Token Created/i.test(e.textContent || "")).pop();
      let scope = heading; for (let i = 0; scope && i < 6; i++) {
        const cands = [...scope.querySelectorAll("input, code, pre")];
        const hit = cands.map((e) => (e.value || e.textContent || "").trim()).find((s) => /^[A-Za-z0-9_-]{30,}$/.test(s));
        if (hit) return hit;
        scope = scope.parentElement;
      }
      return null;`);
    if (!value) return { error: "token value not found in API Token Created section" };

    await clickReal("Finish button", "button", "^finish$", { timeout: 8000 });
    return { name, value };
  });
}
