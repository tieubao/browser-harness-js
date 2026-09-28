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

const BODY_SELECTOR = 'div[aria-label="Message Body"], div.Am.Al.editable';

// ponytail: attachment names are a heuristic union of the download_url attribute (reliable,
// present on both read and compose attachment chips) and any childless leaf whose text ends in
// a file-extension-shaped suffix (catches names Gmail doesn't expose via download_url). Ceiling:
// the leaf scan is document-wide and can false-positive on domain-like text ("dwarves.foundation")
// -- upgrade path is scoping it to the attachment-chip container once that class is confirmed live.
const ATTACHMENT_NAMES_JS = `
  const names = new Set();
  document.querySelectorAll('[download_url]').forEach((el) => {
    const raw = el.getAttribute('download_url') || '';
    const seg = raw.split(':');
    if (seg[1]) { try { names.add(decodeURIComponent(seg[1])); } catch (e) { names.add(seg[1]); } }
  });
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim();
      if (/\\.[A-Za-z0-9]{2,5}$/.test(t) && t.length < 100) names.add(t);
    }
  });
`;

// Background-tab rows: innerText comes back empty for every row after the first when the tab
// is not foregrounded (Chrome skips layout for background tabs) -- textContent does not depend
// on layout, so it is the one that works here. Learned live 2026-09-28.
export async function searchRows(ctx, { authuser = 0, query, limit = 25 } = {}) {
  if (!query) throw new Error("searchRows: query is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    await ctx.session.use(targetId);
    await wait(9000);
    const rows = JSON.parse((await evaluate(ctx, `JSON.stringify(
      [...document.querySelectorAll('tr.zA')].slice(0, ${Number(limit) || 25}).map((r) =>
        (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)))`)) || "[]");
    return { rows };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

export async function readThread(ctx, { authuser = 0, query, maxChars = 1600 } = {}) {
  if (!query) throw new Error("readThread: query is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    await ctx.session.use(targetId);
    await wait(9000);

    const rowRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      const row = document.querySelector('tr.zA');
      return row ? row.getBoundingClientRect() : null;
    })())`)) || "null");
    if (!rowRect) return { stop: "no-results", hint: `no rows for query ${query}` };
    await clickRect(ctx, rowRect);
    await wait(3000);

    const expandRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      const btn = document.querySelector('[aria-label="Expand all"]');
      return btn ? btn.getBoundingClientRect() : null;
    })())`)) || "null");
    if (expandRect) {
      await clickRect(ctx, expandRect);
      await wait(1500);
    }

    const data = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      ${ATTACHMENT_NAMES_JS}
      const max = ${Number(maxChars) || 1600};
      const messages = [...document.querySelectorAll('div.a3s')].map((m) =>
        (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, max));
      const links = [...new Set([...document.querySelectorAll('div.a3s a')]
        .map((a) => a.href)
        .filter((h) => h && !h.includes('mail.google.com')))];
      return { attachments: [...names], links, messages };
    })())`)) || "{}");

    return data;
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// Never sends -- Gmail auto-saves an open compose as a draft, so an aborted or failed call
// still leaves recoverable state instead of a stray outbound message.
export async function composeDraft(ctx, { authuser = 0, to = "", cc = "", bcc = "", subject = "", body = "", attachments = [] } = {}) {
  const qs = new URLSearchParams({ view: "cm", fs: "1", to, cc, bcc, su: subject, body }).toString().replace(/\+/g, "%20");
  const url = `https://mail.google.com/mail/u/${authuser}/?${qs}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  await ctx.session.use(targetId);
  await wait(7000);

  if (attachments.length) {
    await ctx.session.DOM.enable();
    const { root } = await ctx.session.DOM.getDocument({ depth: -1, pierce: true });
    const { nodeId } = await ctx.session.DOM.querySelector({ nodeId: root.nodeId, selector: "input[type=file][name=Filedata]" });
    if (!nodeId) return { targetId, stop: "no-file-input" };
    await ctx.session.DOM.setFileInputFiles({ nodeId, files: attachments });
    await wait(8000);
  }

  const readback = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    ${ATTACHMENT_NAMES_JS}
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    return {
      from: (document.querySelector('input[name=from]') || {}).value || '',
      recipients: [...document.querySelectorAll('[data-hovercard-id]')].map((e) => e.getAttribute('data-hovercard-id')),
      subject: (document.querySelector('input[name=subjectbox]') || {}).value || '',
      attachments: [...names],
      body: body ? body.innerText : '',
    };
  })())`)) || "{}");

  return {
    targetId,
    from: readback.from || "",
    recipients: readback.recipients || [],
    subject: readback.subject || "",
    attachments: readback.attachments || [],
    body: (readback.body || "").slice(0, 200),
  };
}

// Gmail's compose body enforces Trusted Types: a page-script `el.innerHTML = ...` assignment
// throws. Plain-text replacement builds real DOM nodes instead (replaceChildren + <br>
// elements). An HTML fragment (a signature, say) needs a different bypass: CDP's
// DOM.setOuterHTML writes through the DOM domain, not a page-script property assignment, so
// Trusted Types does not see it -- swap a placeholder div in first, then setOuterHTML it.
// Learned live 2026-09-28.
export async function replaceDraftBody(ctx, { targetId, lines, html } = {}) {
  if (!targetId) throw new Error("replaceDraftBody: targetId is required");
  if (!lines && !html) throw new Error("replaceDraftBody: exactly one of lines or html is required");
  await ctx.session.use(targetId);

  if (lines) {
    const result = await evaluate(ctx, `(() => {
      const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      if (!body) return { stop: "no-body-editable" };
      const parts = ${JSON.stringify(lines)};
      const nodes = [];
      parts.forEach((line, i) => {
        if (i > 0) nodes.push(document.createElement("br"));
        nodes.push(document.createTextNode(line));
      });
      body.replaceChildren(...nodes);
      body.dispatchEvent(new Event("input", { bubbles: true }));
      return { length: body.innerText.length };
    })()`);
    return result;
  }

  const placeholderId = "bh-replace-" + Date.now();
  const placed = await evaluate(ctx, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return false;
    const ph = document.createElement("div");
    ph.id = ${JSON.stringify(placeholderId)};
    body.replaceChildren(ph);
    return true;
  })()`);
  if (!placed) return { stop: "no-body-editable" };

  await ctx.session.DOM.enable();
  const { root } = await ctx.session.DOM.getDocument({ depth: -1 });
  const { nodeId } = await ctx.session.DOM.querySelector({ nodeId: root.nodeId, selector: `#${placeholderId}` });
  if (!nodeId) return { stop: "placeholder-not-found" };
  await ctx.session.DOM.setOuterHTML({ nodeId, outerHTML: html });

  const length = await evaluate(ctx, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return 0;
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return body.innerText.length;
  })()`);
  return { length: Number(length) || 0 };
}
