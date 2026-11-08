// learnings/discord-com/tools/discord-com.mjs
// READ-ONLY reader for Han's own Discord web client (discord.com, already logged in): the DM
// list and one DM's history. DOM reading only. It never sends a message, never touches the
// user token, never clicks anything. Each call opens its own NEW background target and closes
// it afterwards. A navigation in a hidden tab can take ~15s to render, so every wait is a poll.
// See notes/overview.md. Page API port: learnings/PORTING.md.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Poll an in-page expression until truthy; returns the last value (falsy on timeout).
async function until(page, expression, timeoutMs, stepMs = 500) {
  let value;
  for (let t = 0; t < timeoutMs; t += stepMs) {
    value = await evaluate(page, expression).catch(() => null);
    if (value) return value;
    await wait(stepMs);
  }
  return value;
}

async function openBackground(ctx, url) {
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  const page = await ctx.attachPage(targetId, { allowedOrigins: [new URL(url).origin] });
  await page.cdp("Page.enable");
  await page.cdp("Page.navigate", { url });
  return { targetId, page };
}

const closeTarget = (ctx, targetId) => ctx.session.Target.closeTarget({ targetId }).catch(() => {});

const DM_LINKS = `document.querySelectorAll('a[href*="/channels/@me/"]')`;
const MSG_COUNT = `document.querySelectorAll('li[id^=chat-messages-]').length`;

// "vincent (direct message), Do Not Disturb" -> {name:"vincent", kind:"dm"}
// "PAMsheep, Thinh (group message), 3 Members" -> {name:"PAMsheep, Thinh", kind:"group"}
const LIST_EXPR = `JSON.stringify((() => {
  const seen = new Set();
  const out = [];
  for (const a of ${DM_LINKS}) {
    const channelId = (a.getAttribute('href').match(/\\/channels\\/@me\\/(\\d+)/) || [])[1];
    if (!channelId || seen.has(channelId)) continue;
    const label = a.getAttribute('aria-label') || '';
    const m = label.match(/^(.*?)\\s*\\((direct|group) message\\)/);
    if (!m) continue;
    seen.add(channelId);
    out.push({ name: m[1], channelId, kind: m[2] === 'group' ? 'group' : 'dm' });
  }
  return out;
})())`;

// Read-only. Returns [{name, channelId, kind}] or {stop, ...}.
export async function listDms(ctx, _args) {
  const { targetId, page } = await openBackground(ctx, "https://discord.com/channels/@me");
  try {
    const ready = await until(page, `${DM_LINKS}.length > 0`, 40000);
    if (!ready) {
      const href = String(await evaluate(page, "location.href").catch(() => ""));
      return { stop: href.includes("/login") ? "not-signed-in" : "dm-list-not-rendered", targetId, href };
    }
    await wait(1000); // let the list settle so aria-labels are final
    return JSON.parse(String(await evaluate(page, LIST_EXPR)));
  } finally {
    closeTarget(ctx, targetId);
  }
}

const SCROLLER = `(document.querySelector('ol[data-list-id=chat-messages]') || {closest: () => null}).closest('[class*=scroller]')`;
const AT_START = `document.body.innerText.includes('beginning of your direct message history')`;

// author is blank on continuation messages: carry the last non-empty author forward.
const ROWS_EXPR = `JSON.stringify((() => {
  let last = '';
  return [...document.querySelectorAll('li[id^=chat-messages-]')].map((li) => {
    const author = ((li.querySelector('[id^=message-username-]') || {}).innerText || '').trim();
    if (author) last = author;
    return {
      time: (li.querySelector('time[datetime]') || {getAttribute: () => ''}).getAttribute('datetime') || '',
      author: last,
      text: ((li.querySelector('[id^=message-content-]') || {}).innerText || ''),
      images: li.querySelectorAll('img').length,
    };
  });
})())`;

// Read-only. Returns {channelId, scrolls, reachedStart, rows:[{time, author, text, images}]} or {stop, ...}.
export async function readDm(ctx, { channelId, maxScrolls = 25 } = {}) {
  if (!channelId || !/^\d+$/.test(String(channelId))) throw new Error("readDm: channelId (digits) is required");
  const { targetId, page } = await openBackground(ctx, `https://discord.com/channels/@me/${channelId}`);
  try {
    // A hidden-tab navigation took ~15s to render; a fixed 7s wait returned 0 rows.
    const rendered = await until(page, `${MSG_COUNT} > 0`, 60000);
    if (!rendered) {
      const href = String(await evaluate(page, "location.href").catch(() => ""));
      return { stop: href.includes("/login") ? "not-signed-in" : "messages-not-rendered", targetId, href };
    }

    let count = Number(await evaluate(page, MSG_COUNT));
    let scrolls = 0;
    let reachedStart = Boolean(await evaluate(page, AT_START));
    while (!reachedStart && scrolls < maxScrolls) {
      const scrolled = await evaluate(page, `(() => { const s = ${SCROLLER}; if (!s) return false; s.scrollTop = 0; return true; })()`);
      if (!scrolled) return { stop: "scroller-not-found", targetId };
      scrolls++;
      await wait(2500);
      reachedStart = Boolean(await evaluate(page, AT_START));
      const next = Number(await evaluate(page, MSG_COUNT));
      if (next <= count) break; // not growing; a hidden tab may refuse to load older history, see notes
      count = next;
    }

    const rows = JSON.parse(String(await evaluate(page, ROWS_EXPR)));
    return { channelId: String(channelId), scrolls, reachedStart, rows };
  } finally {
    closeTarget(ctx, targetId);
  }
}
