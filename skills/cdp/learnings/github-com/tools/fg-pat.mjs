// learnings/github-com/tools/fg-pat.mjs
// Fine-grained PAT repository access. GitHub has no API for this: the token page
// https://github.com/settings/personal-access-tokens/<id> is the editor (/<id>/edit is a 404).
// Two verbs share one tab by explicit targetId (never the active-tab pointer):
//   openFgPat    open the token page; sudo gate -> click "Use GitHub Mobile", return the digits
//   addFgPatRepo reveal the repo-access form and add one repository id, with guards
// Never types a password. The tab stays open between calls; the caller closes it.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

const readState = (page) => evaluate(page, `JSON.stringify({ title: document.title, href: location.href })`).then((s) => JSON.parse(s || "{}"));
const isSudoTitle = (title) => /Confirm access/i.test(title || "");

// Click the visible "Use GitHub Mobile" button by its text (selectors drift, label text does not).
const CLICK_MOBILE = `(() => {
  const b = [...document.querySelectorAll('button, a, summary')].find((e) => (e.innerText || "").trim() === "Use GitHub Mobile" && e.getClientRects().length > 0);
  if (!b) return false;
  b.click();
  return true;
})()`;

// The two digits GitHub shows for the phone prompt: a leaf element that is exactly two digits,
// else the first two-digit number after the words "GitHub Mobile" in the body text.
const READ_DIGITS = `(() => {
  const leaf = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && /^\\d{2}$/.test((e.innerText || "").trim()));
  if (leaf) return leaf.innerText.trim();
  const t = document.body.innerText;
  const i = t.search(/GitHub Mobile/i);
  const m = (i >= 0 ? t.slice(i) : "").match(/\\b(\\d{2})\\b/);
  return m ? m[1] : null;
})()`;

// Phase 1. No targetId: open the token page in a new background tab. With targetId: re-check that
// tab, polling up to waitMs for the sudo gate to clear (resend:true reloads and sends a fresh
// phone request, for when the old one expired).
// Returns {status:"ready", targetId} | {status:"sudo", targetId, digits, waiting?} | {status:"unexpected", targetId, href}.
export async function openFgPat(ctx, args) {
  const { tokenId, targetId: givenId, resend = false, waitMs = 30000 } = args || {};
  if (!/^\d+$/.test(String(tokenId ?? ""))) throw new Error("openFgPat: tokenId must be digits (the numeric suffix of the token link)");
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120000) throw new Error("openFgPat: waitMs must be an integer 0..120000");
  const url = `https://github.com/settings/personal-access-tokens/${tokenId}`;

  let targetId = givenId;
  const created = !givenId;
  if (created) ({ targetId } = await ctx.session.Target.createTarget({ url, background: true }));
  try {
    const page = await ctx.attachPage(targetId, { allowedOrigins: ["https://github.com"] });
    if (created) await wait(6000);
    if (!created && resend) { await page.cdp("Page.reload", {}); await wait(6000); }

    let state = await readState(page);
    if (!created && !resend && isSudoTitle(state.title) && waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (isSudoTitle(state.title) && Date.now() < deadline) { await wait(1500); state = await readState(page); }
      if (isSudoTitle(state.title)) return { status: "sudo", targetId, digits: await evaluate(page, READ_DIGITS), waiting: true };
    }

    if (!isSudoTitle(state.title)) {
      if (!state.href || !state.href.startsWith(url)) return { status: "unexpected", targetId, href: state.href };
      return { status: "ready", targetId };
    }

    if (created || resend) {
      if (!(await evaluate(page, CLICK_MOBILE))) return { status: "sudo", targetId, digits: null, reason: "no 'Use GitHub Mobile' button" };
      await wait(3000);
    }
    return { status: "sudo", targetId, digits: await evaluate(page, READ_DIGITS) };
  } catch (e) {
    if (created) { try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ } }
    throw e;
  }
}

// In-page body of phase 2. ONE evaluation: reveal the form, guard, append, schedule Update. Opening
// the form in a separate evaluation found it closed again and the update silently never saved.
export function addRepoExpression({ org, repoId, expectCount }) {
  return `(async () => {
  const org = ${JSON.stringify(org)}, repoId = ${JSON.stringify(String(repoId))}, expect = ${JSON.stringify(expectCount)};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = 'form[action*="/grant-requests/organizations/' + org + '"]';
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const out = (o) => JSON.stringify(o);
  let form = document.querySelector(sel);
  if (!visible(form)) {
    const edits = [...document.querySelectorAll('button')].filter((b) => (b.innerText || "").trim() === "Edit");
    if (edits.length < 2) return out({ aborted: "edit-button-missing", edits: edits.length });
    edits[1].click();
    for (let i = 0; i < 20 && !visible(form = document.querySelector(sel)); i++) await wait(150);
  }
  if (!visible(form)) return out({ aborted: "form-not-open" });
  const target = form.querySelector('input[name="install_target"][value="selected"]');
  if (!target || !target.checked) return out({ aborted: "install-target-not-selected" });
  const inputs = [...form.querySelectorAll('input[name="repository_ids[]"]')];
  if (inputs.length !== expect) return out({ aborted: "count-mismatch", count: inputs.length, expect });
  if (inputs.some((i) => i.value === repoId)) return out({ aborted: "already-present", count: inputs.length });
  if (!inputs.length) return out({ aborted: "no-input-to-clone" });
  const update = [...form.querySelectorAll('button, input[type=submit]')].find((e) => ((e.innerText || e.value || "")).trim() === "Update");
  if (!update) return out({ aborted: "update-button-missing" });
  const clone = inputs[inputs.length - 1].cloneNode(true);
  clone.value = repoId;
  inputs[inputs.length - 1].insertAdjacentElement("afterend", clone);
  const after = form.querySelectorAll('input[name="repository_ids[]"]').length;
  setTimeout(() => update.click(), 300);
  return out({ done: true, before: inputs.length, after });
})()`;
}

// Phase 2. Needs the targetId from openFgPat once its status is "ready". Aborts, changing nothing, unless
// install_target=selected is checked, repoId is absent, and the current repo count equals expectCount.
// Returns {done:true, before, after} or {done:false, reason, ...}. Cannot verify access: the caller does,
// with the token itself (GET repos/<o>/<r>/actions/runs flips 404 -> 200, an old repo stays 200).
export async function addFgPatRepo(ctx, args) {
  const { targetId, org, repoId, expectCount } = args || {};
  if (!targetId) throw new Error("addFgPatRepo: targetId is required (from openFgPat)");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(String(org ?? ""))) throw new Error("addFgPatRepo: org must be a GitHub org login");
  if (!/^\d+$/.test(String(repoId ?? ""))) throw new Error("addFgPatRepo: repoId must be digits (the numeric repository id)");
  if (!Number.isInteger(expectCount) || expectCount < 1) throw new Error("addFgPatRepo: expectCount must be an integer >= 1");

  const page = await ctx.attachPage(targetId, { allowedOrigins: ["https://github.com"] });
  const state = await readState(page);
  if (isSudoTitle(state.title)) return { done: false, reason: "sudo", targetId };
  if (!/^https:\/\/github\.com\/settings\/personal-access-tokens\/\d+/.test(state.href || "")) return { done: false, reason: "not-on-token-page", href: state.href, targetId };

  const res = JSON.parse((await evaluate(page, addRepoExpression({ org, repoId, expectCount }))) || "{}");
  if (!res.done) { const { aborted, ...rest } = res; return { done: false, reason: aborted || "no-result", ...rest, targetId }; }
  await wait(4000); // let the Update POST and navigation finish before the caller closes the tab
  return { done: true, before: res.before, after: res.after, targetId };
}
