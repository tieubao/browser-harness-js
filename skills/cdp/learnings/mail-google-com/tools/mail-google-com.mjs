// learnings/mail-google-com/tools/mail-google-com.mjs
// Send a Gmail message AS a send-as alias (e.g. a Google Group address) through a prefilled
// compose URL. The From selector is hidden on that view: element.click() and dispatched
// MouseEvents on the option do nothing, only a real Input.dispatchMouseEvent (mouseMoved,
// mousePressed, mouseReleased) at the target's own bounding-rect centre switches the sender.
// Verified live 2026-09-27. Sending is outward and irreversible, so prepareDraftAs stops short
// of Send and hands back a readback; sendPreparedDraft refuses without confirm:true.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// The only click technique that actually moves Gmail's From selector (see header comment).
async function realClick(ctx, x, y) {
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await ctx.session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickRect(ctx, rect) {
  await realClick(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

export async function findAccountSlot(ctx, { email, maxSlots = 4 } = {}) {
  if (!email) throw new Error("findAccountSlot: email is required");
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    await ctx.session.use(targetId);
    await ctx.session.Page.enable();
    for (let n = 0; n < maxSlots; n++) {
      await ctx.session.Page.navigate({ url: `https://mail.google.com/mail/u/${n}/` });
      await wait(4000);
      const title = String((await evaluate(ctx, "document.title")) || "");
      if (title.includes(email)) return { slot: n, title };
    }
    return { stop: "not-found", hint: `no signed-in slot under 0..${maxSlots - 1} matched ${email}` };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

export async function prepareDraftAs(ctx, { authuser = 0, to, subject, body, alias } = {}) {
  if (!to || !subject || !body || !alias) throw new Error("prepareDraftAs: to, subject, body, alias are all required");
  const url = `https://mail.google.com/mail/u/${authuser}/?view=cm&fs=1` +
    `&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  await ctx.session.use(targetId);
  await wait(6000); // Gmail's compose JS is heavy; a shorter wait sometimes catches an empty from selector.

  const hasFrom = await evaluate(ctx, "!!document.querySelector('input[name=from]')");
  if (!hasFrom) return { targetId, stop: "compose-not-loaded" };

  // Step A: click the leaf holding the recipient text (inside the To row) to expand the
  // collapsed header. This is where the From line becomes visible.
  const toRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const needle = ${JSON.stringify(to)};
    const leaf = [...document.querySelectorAll('span,div,td')].find((e) => e.children.length === 0 && (e.textContent || '').includes(needle));
    return leaf ? leaf.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!toRect) return { targetId, stop: "to-row-not-found" };
  await clickRect(ctx, toRect);
  await wait(800);

  // ponytail: the From leaf is identified by content (an email-like leaf near the top of the
  // page, not the To leaf itself), not by a hardcoded class name. Ceiling: assumes exactly one
  // such leaf appears above y=200 after the header expands; ratchet the y bound up if a future
  // Gmail layout pushes the From line lower.
  const fromLineRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const toNeedle = ${JSON.stringify(to)};
    const emailLike = /[\\w.+-]+@[\\w.-]+/;
    const leaves = [...document.querySelectorAll('span,div,td')].filter((e) => e.children.length === 0);
    const cand = leaves.find((e) => {
      const t = (e.textContent || '').trim();
      return t && emailLike.test(t) && !t.includes(toNeedle) && e.getBoundingClientRect().top < 200 && e.getBoundingClientRect().width > 0;
    });
    return cand ? cand.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!fromLineRect) return { targetId, stop: "from-line-not-found" };

  // Step B: real-click the From line to open its menu.
  await clickRect(ctx, fromLineRect);
  await wait(600);

  // Step C: pick the alias option. Filter to non-zero-width options only (closed/hidden
  // menu copies of the same items exist in the DOM with width 0).
  const optionRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const alias = ${JSON.stringify(alias)};
    const opts = [...document.querySelectorAll('[role=menuitem],[role=option]')]
      .filter((el) => (el.textContent || '').includes(alias) && el.getBoundingClientRect().width > 0);
    return opts[0] ? opts[0].getBoundingClientRect() : null;
  })())`)) || "null");
  if (!optionRect) return { targetId, stop: "alias-option-not-found" };
  await clickRect(ctx, optionRect);
  await wait(600);

  const fromValues = JSON.parse((await evaluate(ctx, "JSON.stringify([...document.querySelectorAll('input[name=from]')].map((x) => x.value))")) || "[]");
  const subjectValue = String((await evaluate(ctx, "(document.querySelector('input[name=subjectbox]') || {}).value || ''")) || "");
  if (!fromValues.some((v) => v.includes(alias))) return { targetId, stop: "alias-not-selected", from: fromValues };

  return { targetId, to, subject: subjectValue || subject, from: fromValues };
}

export async function sendPreparedDraft(ctx, { targetId, confirm } = {}) {
  if (!targetId) throw new Error("sendPreparedDraft: targetId is required");
  if (confirm !== true) return { stop: "confirm-required", hint: "read back prepareDraftAs's {to, subject, from} with the human before sending" };
  await ctx.session.use(targetId);
  const sendRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button]')].find((b) => (b.innerText || '').trim() === 'Send');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!sendRect) return { stop: "no-send-button" };
  await clickRect(ctx, sendRect);
  await wait(3000);
  const stillOpen = await evaluate(ctx, "!!document.querySelector('input[name=from]')");
  return stillOpen ? { stop: "compose-still-open-after-send" } : { sent: true };
}

export async function verifySent(ctx, { authuser = 0, recipient, days = 1 } = {}) {
  if (!recipient) throw new Error("verifySent: recipient is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/in%3Asent+to%3A${encodeURIComponent(recipient)}+newer_than%3A${days}d`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    await ctx.session.use(targetId);
    await wait(4000);
    const count = Number((await evaluate(ctx, "document.querySelectorAll('tr.zA').length")) || 0);
    return { found: count > 0, count };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// addForwardingAddress / confirmForwarding / createForwardFilter, verified live 2026-09-28.
// Settings and search-results/filter dialogs are the same finicky Gmail SPA as compose: elements
// get real-clicked at their own bounding-rect centre (element.click() and dispatched MouseEvents
// on a menuitem/checkbox do nothing, see the header comment), and checkboxes here are rendered
// completely off-screen (x < 0) -- click their associated <label> text, which toggles the input
// via native label-for semantics.

async function pollUntil(ctx, expr, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(ctx, expr)) return true;
    await wait(intervalMs);
  }
  return false;
}

export async function addForwardingAddress(ctx, { authuser = 0, address } = {}) {
  if (!address) throw new Error("addForwardingAddress: address is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#settings/fwdandpop`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  await ctx.session.use(targetId);

  // A background settings tab can take 20-40s to render; poll for the forwarding radios
  // (input[name=sx_em]) instead of a fixed sleep.
  const rendered = await pollUntil(ctx, "!!document.querySelector('input[name=sx_em]')", 40000, 1000);
  if (!rendered) return { targetId, stop: "settings-not-rendered" };

  // Always go through the "Add a forwarding address" button. The inline "Forward a copy of
  // incoming mail to" textbox next to it looks like a plain field but typing into it directly
  // auto-selects that radio (forwarding ALL mail, not just this address) as a side effect of its
  // onchange handler, and saving an unverified address entered there fails with
  // "Invalid forwarding address". Leave "Disable forwarding" selected; never touch that textbox.
  const addRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /add a forwarding address/i.test((e.textContent || '').trim()));
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!addRect) return { targetId, stop: "add-button-not-found" };
  await clickRect(ctx, addRect);
  await wait(800);

  const inputRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const dlg = [...document.querySelectorAll('[role=dialog]')].pop();
    const input = dlg && dlg.querySelector('input[type=text],input[type=email]');
    return input ? input.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!inputRect) return { targetId, stop: "dialog-input-not-found" };
  await clickRect(ctx, inputRect);
  await ctx.session.Input.insertText({ text: address });
  await wait(300);

  const nextRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button],button')].find((b) => (b.innerText || b.textContent || '').trim() === 'Next');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!nextRect) return { targetId, stop: "next-button-not-found" };
  await clickRect(ctx, nextRect);

  // Google opens a separate "Verify it's you" challenge target (accounts.google.com) in some
  // sessions and goes straight to emailing a confirmation link (vf-... URL) in others. Poll
  // briefly for the popup target; this verb never answers the challenge itself.
  const before = new Set((await ctx.session.Target.getTargets()).targetInfos.filter((t) => t.type === "page").map((t) => t.targetId));
  const deadline = Date.now() + 8000;
  let popupTargetId = null;
  while (Date.now() < deadline && !popupTargetId) {
    const { targetInfos } = await ctx.session.Target.getTargets();
    const hit = targetInfos.find((t) => t.type === "page" && !before.has(t.targetId) && /accounts\.google\.com/.test(t.url));
    if (hit) popupTargetId = hit.targetId;
    else await wait(500);
  }
  return popupTargetId ? { status: "challenge", targetId, popupTargetId } : { status: "sent", targetId };
}

export async function confirmForwarding(ctx, { verifyUrl } = {}) {
  if (!verifyUrl) throw new Error("confirmForwarding: verifyUrl is required");
  const { targetId } = await ctx.session.Target.createTarget({ url: verifyUrl, background: false });
  await ctx.session.use(targetId);
  await wait(3000);

  const confirmRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button],button')].find((b) => (b.innerText || b.textContent || '').trim() === 'Confirm');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!confirmRect) return { targetId, stop: "confirm-button-not-found" };
  await clickRect(ctx, confirmRect);
  await wait(2000);

  const successText = String((await evaluate(ctx, "document.body.innerText.trim().slice(0, 500)")) || "");
  return { targetId, successText };
}

export async function createForwardFilter(ctx, { authuser = 0, query, forwardTo, dryRun = false } = {}) {
  if (!query || !forwardTo) throw new Error("createForwardFilter: query and forwardTo are required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  await ctx.session.use(targetId);
  await wait(5000);

  const advRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = document.querySelector('[aria-label="Advanced search options"]');
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!advRect) return { targetId, stop: "advanced-search-not-found" };
  await clickRect(ctx, advRect);
  await wait(1000);

  const createLinkRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Create filter');
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!createLinkRect) return { targetId, stop: "create-filter-link-not-found" };
  await clickRect(ctx, createLinkRect);
  await wait(1000);

  // The "Forward it to:" checkbox is rendered off-screen (x < 0, see header comment); real-click
  // its <label> text instead, which toggles the checkbox via native label-for semantics.
  const fwdLabelRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!fwdLabelRect) return { targetId, stop: "forward-checkbox-not-found" };
  await clickRect(ctx, fwdLabelRect);
  await wait(500);

  const listboxRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const label = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    const forId = label && label.getAttribute('for');
    const listbox = forId && document.getElementById(forId).parentElement.querySelector('[role=listbox]');
    return listbox ? listbox.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!listboxRect) return { targetId, stop: "forward-listbox-not-found" };
  await clickRect(ctx, listboxRect);
  await wait(500);

  // The listbox's own selected-value node stays put; the real options that open on click are
  // separate, wider (300px) elements elsewhere in the DOM -- filter to those, same trick as the
  // alias picker in prepareDraftAs.
  const optionRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const target = ${JSON.stringify(forwardTo)};
    const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.getBoundingClientRect().width > 200 && (o.textContent || '').includes(target));
    return opts[0] ? opts[0].getBoundingClientRect() : null;
  })())`)) || "null");
  if (!optionRect) return { targetId, stop: "forward-address-option-not-found", hint: `${forwardTo} is not a verified forwarding address on this account` };
  await clickRect(ctx, optionRect);
  await wait(500);

  // Assert exactly the "Forward it to:" checkbox is ticked and the listbox now shows forwardTo
  // before ever touching the Create filter button.
  const state = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const checks = [...document.querySelectorAll('input[type=checkbox]')]
      .map((c) => {
        const lbl = document.querySelector('label[for="' + c.id + '"]');
        return lbl ? { label: lbl.textContent.trim(), checked: c.checked } : null;
      })
      .filter(Boolean);
    const fwdLabel = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    const forId = fwdLabel && fwdLabel.getAttribute('for');
    const listbox = forId && document.getElementById(forId).parentElement.querySelector('[role=listbox]');
    return { checks, listboxText: listbox ? listbox.textContent.trim() : null };
  })())`)) || "null");
  if (!state) return { targetId, stop: "assert-failed" };

  const checkedOnes = state.checks.filter((c) => c.checked);
  const onlyForwardChecked = checkedOnes.length === 1 && /forward it to/i.test(checkedOnes[0].label);
  const listboxHasForwardTo = String(state.listboxText || "").includes(forwardTo);
  if (!onlyForwardChecked || !listboxHasForwardTo) {
    return { targetId, stop: "assert-mismatch", checkedOnes, listboxText: state.listboxText };
  }

  if (dryRun) return { targetId, dryRun: true, checkedOnes, listboxText: state.listboxText };

  // Real mouse events only past this point: a DOM .click() has no user gesture, and Gmail's
  // "verify it's you" confirmation for a forwarding filter is then silently blocked.
  const createBtnRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Create filter');
    const btn = el && el.closest('button,[role=button]');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!createBtnRect) return { targetId, stop: "create-filter-button-not-found" };
  await clickRect(ctx, createBtnRect);
  await wait(1500);

  const continueRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Continue');
    const btn = el && (el.closest('button,[role=button]') || el);
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (continueRect) {
    await clickRect(ctx, continueRect);
    await wait(1000);
  }

  return { targetId, created: true, checkedOnes, listboxText: state.listboxText };
}
