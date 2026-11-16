// learnings/facebook-com/tools/feed.mjs
// Read a Facebook Page's feed and Reels-tab tiles through the logged-in session, in a BACKGROUND
// tab (never brought to front). The feed is virtualized: only the cards near the viewport stay
// hydrated, so every scroll round collects the visible cards and merges them by key.
// Counts come from aria-labels ("Like: 57 people", "Comment on X's post, 15 comments",
// "Share X's post, 1 share"). The visible timestamp is an SVG glyph (its text is scrambled or
// empty); the date only exists as a hover tooltip, so each round hovers the timestamps in view
// and stamps the tooltip text on the anchor as data-fbdate.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function openBackground(ctx, pageUrl) {
  const { targetId } = await ctx.session.Target.createTarget({ url: pageUrl, background: true });
  const page = await ctx.attachPage(targetId, { allowedOrigins: [new URL(pageUrl).origin] });
  // A background tab is "hidden": Facebook's lazy loader never runs. Make it look visible.
  await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.cdp("Page.enable", {});
  await page.cdp("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await wait(7000);
  return { targetId, page };
}

// A burst of small wheel events mimics a trackpad flick; one big wheel event does not load more.
async function wheelBurst(page, steps, dy) {
  for (let i = 0; i < steps; i++) {
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 500, deltaX: 0, deltaY: dy });
    await wait(120);
  }
}

const STAMPS = `JSON.stringify([...document.querySelectorAll('a[href^="?__cft__"][target=_blank]')]
  .filter((a) => a.querySelector('svg use') && !a.getAttribute('data-fbdate'))
  .map((a) => { const r = a.getBoundingClientRect();
    if (!(r.top > 70 && r.bottom < innerHeight - 10)) return null;
    const i = (window.__fbts = (window.__fbts || 0) + 1);
    a.setAttribute('data-fbts', i);
    return { i, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
  .filter(Boolean))`;

// Timestamp tooltips ("Sunday, November 8, 2026 at 11:04 AM") in the DOM now, with their centers.
const TIPS = `JSON.stringify([...document.querySelectorAll('[role=tooltip]')]
  .map((x) => { const r = x.getBoundingClientRect(); return { text: x.textContent.trim(), cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })
  .filter((t) => /\\b20\\d\\d at \\d+:\\d\\d/.test(t.text)))`;

// Hover each unstamped timestamp in view and copy its tooltip onto it. A tooltip can outlive the
// hover that opened it, so it counts as this anchor's own only when it sits next to the anchor
// (the tooltip opens centered just below it) and its text is new in this run.
async function stampTimestamps(page, used) {
  const tips = async () => JSON.parse((await evaluate(page, TIPS)) || "[]");
  for (const { i, x, y } of JSON.parse((await evaluate(page, STAMPS)) || "[]")) {
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    for (let t = 0; t < 6; t++) {
      await wait(200);
      if (!(await tips()).length) break;
    }
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 20, y });
    await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (let t = 0; t < 8; t++) {
      await wait(200);
      const own = (await tips()).find((tip) => !used.has(tip.text) && Math.abs(tip.cx - x) < 80 && Math.abs(tip.cy - y) < 80);
      if (!own) continue;
      used.add(own.text);
      await evaluate(page, `document.querySelector('[data-fbts="${i}"]')?.setAttribute('data-fbdate', ${JSON.stringify(own.text)})`);
      break;
    }
  }
}

const LOGGED_OUT = `!!document.querySelector('input[name=email]')`;

// Visible post cards. A card is the smallest ancestor of an "Actions for this post" button that
// holds exactly one such button and a "Comment on" control.
const COLLECT_CARDS = `(() => {
  const BTN = '[aria-label^="Actions for this post"]';
  const num = (s) => {
    const m = String(s || '').match(/([\\d][\\d.,]*)\\s*([KkMm])?/);
    if (!m) return 0;
    const mult = { k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(parseFloat(m[2] ? m[1].replace(/,/g, '.') : m[1].replace(/,/g, '')) * mult);
  };
  const cardOf = (b) => {
    let c = b;
    for (let i = 0; i < 40 && c; i++) {
      if (c.querySelectorAll(BTN).length === 1 && c.querySelector('[aria-label^="Comment on"]')) return c;
      c = c.parentElement;
    }
    return null;
  };
  const out = [];
  for (const b of document.querySelectorAll(BTN)) {
    const c = cardOf(b);
    if (!c) continue;
    const labels = [...c.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label') || '');
    let reactions = 0, comments = 0, shares = 0, m;
    for (const l of labels) {
      if ((m = l.match(/^[A-Za-z]+: ([\\d.,]+[KkMm]?) (?:people|person)$/))) reactions += num(m[1]);
      else if ((m = l.match(/^Comment on .*?, ([\\d.,]+[KkMm]?) comments?$/))) comments = num(m[1]);
      else if ((m = l.match(/^Share .*?, ([\\d.,]+[KkMm]?) shares?$/))) shares = num(m[1]);
    }
    const msg = c.querySelector('[data-ad-rendering-role="story_message"]');
    const text = ((msg && msg.innerText) || '').replace(/\\u034f/g, '').replace(/\\s*…\\s*See more\\s*$/, '').trim();
    let posted = '';
    const stamped = c.querySelector('[data-fbdate]');
    if (stamped) posted = stamped.getAttribute('data-fbdate');

    const hrefs = [...c.querySelectorAll('a[href]')].map((a) => a.href);
    const first = (re) => { for (const h of hrefs) { const x = h.match(re); if (x) return x[1]; } return ''; };
    const reel = first(/\\/reel\\/(\\d+)/);
    const pcb = first(/set=pcb\\.(\\d+)/);
    const post = first(/\\/(?:posts|videos)\\/([\\w-]+)/);
    const photos = [...new Set(hrefs.map((h) => (h.match(/\\/photo\\/?\\?fbid=(\\d+)/) || [])[1]).filter(Boolean))];
    const clock = c.innerText.match(/\\d+:\\d\\d\\s*\\/\\s*(\\d+:\\d\\d)/);
    const isVideo = !!reel || !!c.querySelector('video') || !!clock;
    const type = reel ? 'reel' : isVideo ? 'video' : photos.length > 1 ? 'album' : photos.length === 1 ? 'photo' : 'text';
    const id = reel ? 'reel:' + reel : pcb ? 'pcb:' + pcb : photos[0] ? 'photo:' + photos[0] : post ? 'post:' + post : '';
    const url = reel ? 'https://www.facebook.com/reel/' + reel + '/' : photos[0] ? 'https://www.facebook.com/photo/?fbid=' + photos[0] : '';
    const messenger = labels.includes('Send message') || /\\bSend message\\b/.test(c.innerText);
    out.push({ id, url, type, text: text.slice(0, 600), posted, reactions, comments, shares, messenger, duration: clock ? clock[1] : '' });
  }
  return JSON.stringify(out);
})()`;

// Merge one collected card into the list. A video card often hydrates its reel link a round
// later than its caption, so a video with the same 40-char caption counts as the same post.
function mergeCard(list, p) {
  const t40 = p.text.slice(0, 40);
  const same = (e) =>
    (p.id && e.id === p.id) ||
    (t40 && e.text.slice(0, 40) === t40 && /^(reel|video)$/.test(e.type) && /^(reel|video)$/.test(p.type) && (!p.id || !e.id || e.id === p.id)) ||
    (!p.id && !e.id && e.text.slice(0, 40) === t40 && e.type === p.type && e.posted === p.posted);
  const old = list.find(same);
  if (!old) { list.push(p); return true; }
  for (const f of ["reactions", "comments", "shares"]) old[f] = Math.max(old[f], p[f]);
  for (const f of ["id", "url", "posted", "duration"]) old[f] = old[f] || p[f];
  if (old.type === "video" && p.type === "reel") old.type = "reel";
  old.messenger = old.messenger || p.messenger;
  return false;
}

export async function listPageFeed(ctx, args) {
  const { pageUrl, maxPosts = 40, maxRounds = 60, stallRounds = 6, settleMs = 1000 } = args || {};
  if (!pageUrl) throw new Error("listPageFeed: pageUrl is required");
  const { targetId, page } = await openBackground(ctx, pageUrl);
  try {
    if (await evaluate(page, LOGGED_OUT)) return { posts: [], reason: "logged out" };
    const posts = [];
    const used = new Set();
    let unchanged = 0, rounds = 0;
    while (rounds < maxRounds && unchanged < stallRounds && posts.length < maxPosts) {
      rounds += 1;
      let grew = false;
      // Short steps (3 x 400 px, below one viewport) so no card slips past between two collects;
      // a card that hydrates late is picked up by the next collect.
      for (let step = 0; step < 3; step++) {
        await stampTimestamps(page, used);
        for (const p of JSON.parse((await evaluate(page, COLLECT_CARDS)) || "[]")) grew = mergeCard(posts, p) || grew;
        await wheelBurst(page, 2, 200);
        await wait(500);
      }
      unchanged = grew ? 0 : unchanged + 1;
      await wait(settleMs);
    }
    posts.splice(maxPosts);
    if (!posts.length) return { posts: [], reason: "no posts found (empty page or no access)" };
    return { posts, count: posts.length, rounds, stalled: unchanged >= stallRounds };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// Reels-tab tiles: id plus the view count printed on each tile ("615", "11K", "1.3K").
export async function listPageReelViews(ctx, args) {
  const { pageUrl, maxReels = 60, maxRounds = 40, stallRounds = 6, settleMs = 2000 } = args || {};
  if (!pageUrl) throw new Error("listPageReelViews: pageUrl is required");
  const { targetId, page } = await openBackground(ctx, pageUrl);
  const TILES = `JSON.stringify([...document.querySelectorAll('a[href*="/reel/"]')].map((a) => {
    const id = (a.href.match(/\\/reel\\/(\\d+)/) || [])[1];
    return id ? [id, (a.innerText || '').split('\\n')[0].trim()] : null;
  }).filter(Boolean))`;
  const toNum = (s) => {
    const m = String(s).match(/^([\d.,]+)\s*([KkMm])?$/);
    if (!m) return null;
    const mult = { k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1;
    return Math.round(parseFloat(m[2] ? m[1].replace(/,/g, ".") : m[1].replace(/,/g, "")) * mult);
  };
  try {
    if (await evaluate(page, LOGGED_OUT)) return { reels: [], reason: "logged out" };
    const seen = new Map();
    let unchanged = 0, rounds = 0;
    while (rounds < maxRounds && unchanged < stallRounds && seen.size < maxReels) {
      rounds += 1;
      const before = seen.size;
      for (const [id, t] of JSON.parse((await evaluate(page, TILES)) || "[]")) if (!seen.has(id)) seen.set(id, toNum(t));
      unchanged = seen.size === before ? unchanged + 1 : 0;
      await evaluate(page, `(() => { const l = document.querySelectorAll('a[href*="/reel/"]'); if (l.length) l[l.length - 1].scrollIntoView({ block: "end" }); })()`);
      await wheelBurst(page, 1, 3000);
      await wait(settleMs);
    }
    if (!seen.size) return { reels: [], reason: "no reels found (empty page or no access)" };
    const reels = [...seen].slice(0, maxReels).map(([id, views]) => ({ id, url: `https://www.facebook.com/reel/${id}/`, views }));
    return { reels, count: reels.length, rounds };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
