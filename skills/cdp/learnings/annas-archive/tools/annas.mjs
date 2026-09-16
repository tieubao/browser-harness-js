// learnings/annas-archive/tools/annas.mjs
// Anna's Archive answers the CLI's HTML search with a 403 anti-bot challenge on every mirror,
// while the member JSON API (fetch by MD5) keeps working. So the browser does the one thing the
// CLI cannot: resolve a title to an MD5 by loading the search page in a real tab. Everything
// else (the download itself, quota) stays in ops-toolkit tools/annas-fetch.
//
// No credentials touch this module. The search page is public; the member key never leaves
// the annas-fetch CLI's op-run environment.

const BASE = "https://annas-archive.gl";
const LOAD_MS = 30000;
const POLL_MS = 500;

function searchUrl({ query, ext, lang }) {
  const u = new URL(BASE + "/search");
  u.searchParams.set("q", query);
  if (ext) u.searchParams.set("ext", ext);
  if (lang) u.searchParams.set("lang", lang);
  return u.toString();
}

// Reuse an annas-archive tab when one exists, else open one. The tab stays open between calls
// so a solved challenge cookie carries across searches.
async function useTab(ctx) {
  const targets = await ctx.listPageTargets();
  let tab = targets.find((t) => { try { return new URL(t.url).hostname.endsWith("annas-archive.gl"); } catch { return false; } });
  if (!tab) {
    const { targetId } = await ctx.session.Target.createTarget({ url: BASE + "/" });
    tab = { targetId };
  }
  await ctx.session.use(tab.targetId);
  return tab;
}

async function evalIn(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({
    expression, awaitPromise: true, returnByValue: true, timeout: LOAD_MS,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || "Runtime.evaluate failed");
  return result && result.value;
}

// Wait until the page shows result cards (or an explicit "no results"), polling from Node so a
// challenge interstitial that takes a few seconds to clear is just a longer wait, not a failure.
// Three traps, all seen live: Page.navigate returns before the old document is gone; the
// recent-downloads ticker carries /md5/ anchors on every page; and the anti-bot check redirects
// through an interstitial (…&check=1) that lists random books in real result cards. So "cards
// exist" is not "results exist". Ready means a card mentions a query word, or the page says no
// results. A mid-navigation evaluate returns undefined and counts as loading.
async function waitForResults(ctx, words) {
  const started = Date.now();
  while (Date.now() - started < LOAD_MS) {
    // "Execution context was destroyed" mid-navigation is a loading state, not an error.
    const state = await evalIn(ctx, `(() => {
      if (document.readyState !== "complete") return "loading";
      const words = ${JSON.stringify(words)};
      const cards = [...document.querySelectorAll('a[href^="/md5/"]')]
        .filter((a) => !a.closest(".js-recent-downloads-scroll") && a.closest("div.border-b"))
        .map((a) => (a.closest("div.border-b").innerText || "").toLowerCase());
      const text = document.body ? document.body.innerText : "";
      if (cards.some((c) => words.some((w) => c.includes(w)))) return "ready";
      if (/No files found|no results/i.test(text)) return "empty";
      return "loading";
    })()`).catch(() => "loading");
    if (state === "ready" || state === "empty") return state;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return "timeout";
}

const significant = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);

// One search page -> rows. Each result card is an <a href="/md5/..."> whose innerText carries the
// title line and a meta line ("English [en], .epub, 🚀/lgli/zlib, 1.2MB, 2011, ..."). Parsing the
// text beats selectors here: the card markup has changed more than once, the text shape has not.
export async function search(ctx, { query, ext = "epub", lang = "en", limit = 5 } = {}) {
  if (!query) throw new Error("query is required");
  await useTab(ctx);
  await ctx.session.Page.navigate({ url: searchUrl({ query, ext, lang }) });
  const state = await waitForResults(ctx, significant(query));
  if (state !== "ready") return { query, state, rows: [] };
  // A result card is a bordered flex row holding the cover anchor and a text column. The page
  // also carries a "recent downloads" ticker of /md5/ anchors (.js-recent-downloads-scroll),
  // which is why the anchor list alone returned garbage the first time.
  const rows = await evalIn(ctx, `(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href^="/md5/"]')) {
      if (a.closest(".js-recent-downloads-scroll")) continue;
      const m = a.getAttribute("href").match(/\\/md5\\/([0-9a-f]{32})/);
      if (!m || seen.has(m[1])) continue;
      const card = a.closest("div.border-b") || a.parentElement;
      const text = ((card && card.innerText) || "").replace(/\\s+/g, " ").trim();
      if (!text) continue;
      seen.add(m[1]);
      out.push({ md5: m[1], text });
    }
    return out;
  })()`);
  return { query, state, rows: rows.slice(0, limit).map(parseRow) };
}

// Meta line shape: "English [en] · EPUB · 0.9MB · 2011 · 📕 Book (fiction) · 🚀/lgli/zlib · Save · 38,650 · 42 · 1"
// The first comma-grouped number after "Save" is the lifetime download count.
function parseRow({ md5, text }) {
  // Meta line first; fall back to the source path's extension (some cards truncate the meta).
  const ext = ((text.match(/·\s*(EPUB|PDF|MOBI|AZW3|DJVU|CBZ)\s*·/i) || text.match(/\.(epub|pdf|mobi|azw3|djvu|cbz)\b/i) || [, ""])[1]).toLowerCase();
  const size = (text.match(/·\s*(\d+(?:\.\d+)?\s?[KMG]B)\s*·/i) || [, ""])[1];
  const year = (text.match(/·\s*((?:19|20)\d{2})\s*·/) || [, ""])[1];
  const downloads = Number(((text.match(/Save\s*·\s*([\d,]+)/) || [, "0"])[1]).replace(/,/g, ""));
  // Drop the leading source path (lgli/R:\...) so pick text starts at the title.
  const title = text.replace(/^\S*\/[^ ]*\.(epub|pdf|mobi|azw3)\s*/i, "").slice(0, 140);
  return { md5, ext, size, year, downloads, text: title };
}

// Diagnostic: navigate to a search and sample the page once a second. Use it when search()
// returns rows that do not match the query; the samples show what the page did over time.
export async function probe(ctx, { query, ext = "epub", lang = "en", seconds = 12 } = {}) {
  await useTab(ctx);
  await ctx.session.Page.navigate({ url: searchUrl({ query, ext, lang }) });
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    const s = await evalIn(ctx, `(() => {
      const cards = [...document.querySelectorAll("div.border-b")].filter((d) => d.querySelector('a[href^="/md5/"]'));
      return { t: ${i}, href: location.href.slice(0, 120), ready: document.readyState, cards: cards.length,
        first: cards.slice(0, 2).map((d) => d.innerText.replace(/\\s+/g, " ").slice(0, 70)),
        h1: (document.querySelector("h1,h2") || {}).innerText || "",
        head: document.body.innerText.replace(/\\s+/g, " ").slice(0, 120) };
    })()`).catch((e) => ({ t: i, error: String(e.message || e).slice(0, 80) }));
    samples.push(s);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return samples;
}

// Resolve a list of titles to one MD5 each. Picks the first row whose extension matches and whose
// text contains every significant word of the title; falls back to the first row. Returns one
// record per title so the caller can eyeball misses before spending fast-download quota.
export async function resolve(ctx, { titles, ext = "epub", lang = "en" } = {}) {
  if (!Array.isArray(titles) || !titles.length) throw new Error("titles[] is required");
  const out = [];
  for (const t of titles) {
    const query = typeof t === "string" ? t : t.query;
    const want = significant(typeof t === "string" ? t : t.match || t.query);
    const wantExt = (typeof t === "object" && t.ext) || ext;
    const res = await search(ctx, { query, ext: wantExt, lang, limit: 8 });
    const byDownloads = (a, b) => (b.downloads || 0) - (a.downloads || 0);
    const matching = res.rows.filter((r) => r.ext === wantExt && want.every((w) => r.text.toLowerCase().includes(w))).sort(byDownloads);
    const hit = matching[0]
      || res.rows.filter((r) => r.ext === wantExt).sort(byDownloads)[0]
      || res.rows[0] || null;
    out.push({ query, state: res.state, md5: hit ? hit.md5 : null, pick: hit ? hit.text : null,
      alternatives: res.rows.filter((r) => r !== hit).slice(0, 3).map((r) => r.md5 + " " + r.text.slice(0, 80)) });
  }
  return out;
}
