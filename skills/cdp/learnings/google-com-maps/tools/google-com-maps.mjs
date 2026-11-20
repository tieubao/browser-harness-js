// learnings/google-com-maps/tools/google-com-maps.mjs
// Saved lists on Google Maps (web), in one throwaway background tab per call, signed in through
// the default browser context. Three tools: listItems (read), createList, saveToList (writes).
// Pure helpers (exported for the offline test): cleanText, foldName, parseCount, parseListEntry,
// matchList, matchesRegion, rankResults, pickResult, chooserAction, searchUrl.
// Test hook: the offline test shrinks every wait.
export const _timing = { scale: 1 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms * _timing.scale));

const ORIGIN = "https://www.google.com";
// Saved panel (Lists tab) straight from a URL: no Menu click, no "Saved" menu item hunt.
const SAVED_URL = `${ORIGIN}/maps/@0,0,3z/data=!4m2!10m1!1e1?hl=en`;
const MAX_CANDIDATES = 4;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

// Maps prefixes names with an icon glyph from the Private Use Area (e.g. "Saved places") and uses
// NBSP / zero-width characters. Strip them before comparing anything.
export function cleanText(s) {
  return String(s ?? "")
    .replace(/[\ue000-\uf8ff]/g, "")
    .replace(/[\u00a0\u200b-\u200f\u2060\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function foldName(s) {
  return cleanText(String(s ?? "").normalize("NFKC")).toLowerCase();
}

// "1,331 places" -> 1331, "1 place" -> 1
export function parseCount(s) {
  const m = /([\d,]+)\s+places?\b/i.exec(String(s ?? ""));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const VIS_RE = /^(Private|Shared|Public)\s*[\u00b7\u2022]\s*[\d,]+\s+places?$/i;

// One list button / chooser row: lines are [optional icon], name, "Private \u00b7 17 places".
// Returns null when no visibility line is present (not a list row).
export function parseListEntry(text) {
  const lines = String(text ?? "").split("\n").map(cleanText).filter(Boolean);
  const at = lines.findIndex((l) => VIS_RE.test(l));
  if (at < 1) return null;
  return { name: lines[at - 1], visibility: /^(\w+)/.exec(lines[at])[1].toLowerCase(), count: parseCount(lines[at]) };
}

// Exact match on the folded name. No fuzzy matching: "China" must never resolve to "China trip".
// Returns { index, entry } or null. entries: [{ name, ... }]
export function matchList(entries, wanted) {
  const want = foldName(wanted);
  if (!want) return null;
  const index = entries.findIndex((e) => foldName(e.name) === want);
  return index < 0 ? null : { index, entry: entries[index] };
}

// Names that contain the wanted text, for an error message when the exact name is absent.
export function listSuggestions(entries, wanted, limit = 5) {
  const want = foldName(wanted);
  return entries.filter((e) => foldName(e.name).includes(want) || want.includes(foldName(e.name))).slice(0, limit).map((e) => e.name);
}

// mustContain: a string ("Jiulongpo, Chongqing") or array. Comma-separated parts must ALL be present
// (case-insensitive substring); inside one part, "|" means any of ("Chongqing|\u91cd\u5e86").
export function matchesRegion(text, mustContain) {
  if (mustContain == null || mustContain === "") return true;
  const parts = (Array.isArray(mustContain) ? mustContain : String(mustContain).split(","))
    .map((p) => String(p).trim())
    .filter(Boolean);
  const hay = foldName(text);
  return parts.every((part) => part.split("|").some((alt) => alt.trim() && hay.includes(foldName(alt))));
}

// Names that are almost never what a "save this place" request means. Excluded unless the query
// itself contains the same word ("Mutianyu" must not resolve to its ticket office).
const NOISE_RE = new RegExp(
  "\\b(ticket|tickets|hotel|hostel|inn|homestay|guest ?house|lodging|lodge|retreat|villa|apartments?|resort|restaurant|travel agency|bed & breakfast|cafe|souvenirs?|store|shop|parking|kindergarten|school|farm ?stay|farmhouse|visitor (center|centre)|information (center|centre)|entrance|gate|swimming pool)\\b|\u552e\u7968|\u9152\u5e97|\u5bbe\u9986|\u9910\u5385|\u996d\u5e97|\u505c\u8f66|\u519c\u5bb6\u4e50|\u6c11\u5bbf",
  "i"
);
const GENERIC = new Set(["the", "of", "and", "a", "scenic", "area", "spot", "park", "national", "forest", "district", "city", "old", "town", "village"]);

export function isNoise(name, query, category = "") {
  for (const field of [name, category]) {
    const m = NOISE_RE.exec(String(field ?? ""));
    if (m && !foldName(query).includes(m[0].toLowerCase())) return true;
  }
  return false;
}

// Feed card text reads "Name | Name | 4.3(49) | Museum \u00b7 address ...": the category is the part before the dot.
export function cardCategory(text) {
  const m = /\|\s*([^|\u00b7]+?)\s*\u00b7/.exec(String(text ?? ""));
  return m ? m[1] : "";
}

const stem = (t) => t.replace(/s$/, "");

const tokenize = (s) => foldName(s).split(/[^\p{L}\p{N}']+/u).filter((t) => t.length > 1).map(stem);

// Significant tokens of the first comma-separated part of the query (the place name proper).
// Generic words ("scenic area", "national park") are ignored unless nothing else is left, so
// "Yuanjiajie Scenic Area" cannot be satisfied by "Yangjiajie Scenic Area".
function nameTokens(query) {
  const all = tokenize(String(query ?? "").split(",")[0]);
  const real = all.filter((t) => !GENERIC.has(t));
  return real.length ? real : all;
}

// cards: [{ name, text? }] (text = the feed card's visible text). Returns ranked candidates
// [{ index, score }], best first, noise and weak name matches removed. A name fully covered by the
// query ("Yu Garden" for "Yu Garden Shanghai") beats one with extra words ("Yu Garden Tea"). A card
// whose text matches mustContain gets a bonus; the real region check happens on the place page
// (cards often carry only a plus code).
export function rankResults(cards, { query = "", mustContain = null } = {}) {
  const head = foldName(String(query).split(",")[0]);
  const tokens = nameTokens(query);
  const queryAll = new Set(tokenize(query));
  const latin = tokens.some((t) => /[a-z]/.test(t));
  const out = [];
  cards.forEach((card, index) => {
    const name = foldName(card.name);
    if (!name || isNoise(card.name, query, cardCategory(card.text))) return;
    const nameAll = tokenize(card.name);
    const seen = tokenize(`${card.name} ${card.text ?? ""}`);
    const hits = tokens.filter((t) => seen.some((n) => n === t || (t.length > 3 && n.startsWith(t)))).length;
    // Name words must show up in the name or the card text. A query with no Latin word (a Chinese
    // fallback) cannot be compared with the English names Maps shows, so it skips this guard.
    if (latin && hits / tokens.length < 0.6) return;
    const extra = nameAll.filter((n) => !queryAll.has(n) && !GENERIC.has(n)).length;
    let score = hits * 10 - extra * 3;
    if (name === head) score += 1000;
    else if (!extra) score += 100;
    if (mustContain && matchesRegion(`${card.name} ${card.text ?? ""}`, mustContain)) score += 50;
    out.push({ index, score });
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}

export function pickResult(cards, opts) {
  const ranked = rankResults(cards, opts);
  return ranked.length ? ranked[0].index : -1;
}

// What to do with the Save chooser. rows: [{ name, checked }]. The rows are TOGGLES: clicking a
// checked row removes the place from that list, so "already saved" must never be clicked.
export function chooserAction(rows, wanted, createIfMissing = true) {
  const hit = matchList(rows, wanted);
  if (!hit) return { action: createIfMissing ? "create" : "stop-missing" };
  return hit.entry.checked ? { action: "already", index: hit.index } : { action: "click", index: hit.index };
}

export function searchUrl(query) {
  return `${ORIGIN}/maps/search/${encodeURIComponent(String(query).trim())}?hl=en`;
}

// "Save" -> 0, "Saved (3)" -> 3 (the place page Save button counts the lists the place is in)
export function savedCount(label) {
  const s = String(label ?? "").trim();
  if (/^Save$/i.test(s)) return 0;
  const m = /^Saved(?:\s*\((\d+)\))?$/i.exec(s);
  return m ? Number(m[1] ?? 1) : null;
}

// ---------------------------------------------------------------------------------------------
// In-page snippets (strings evaluated through page.cdp Runtime.evaluate)
// ---------------------------------------------------------------------------------------------

const JS_CLEAN = `const clean=(s)=>(s||'').replace(/[\\ue000-\\uf8ff]/g,'').replace(/\\u00a0/g,' ').trim();`;
const JS_VISIBLE = `const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};`;

// Page shape: place page, results feed, nothing found, or still loading. signedIn is a boolean only.
const READ_STATE = `(()=>{
  const place=location.pathname.startsWith('/maps/place/')&&[...document.querySelectorAll('h1')].some(h=>h.innerText.trim()&&h.innerText.trim()!=='Results');
  const feed=document.querySelectorAll('[role=feed] a[href*="/maps/place/"]').length;
  const none=/can.t find|No results found/i.test(document.body.innerText||'');
  return JSON.stringify({mode:place?'place':feed?'feed':none?'none':'loading',feed,signedIn:!!document.querySelector('a[role=button][aria-label^="Google Account"]')});
})()`;

const READ_FEED = `(()=>{
  ${JS_CLEAN}
  return JSON.stringify([...document.querySelectorAll('[role=feed] a[href*="/maps/place/"]')].map(a=>{
    const card=a.closest('[role=article]')||a.parentElement;
    return {name:clean(a.getAttribute('aria-label')),text:clean((card.innerText||'').replace(/\\n/g,' | ')),href:a.href};
  }));
})()`;

// Place page facts. Address alone often lacks the city; the plus-code row carries it.
const READ_PLACE = `(()=>{
  ${JS_CLEAN}
  const h1=[...document.querySelectorAll('h1')].map(h=>clean(h.innerText)).find(t=>t&&t!=='Results')||'';
  const label=(sel,prefix)=>{const e=document.querySelector(sel);return e?clean((e.getAttribute('aria-label')||e.innerText||'').replace(prefix,'')):''};
  const save=[...document.querySelectorAll('button')].find(b=>/^Saved?( \\(\\d+\\))?$/.test(b.getAttribute('aria-label')||'')&&b.getBoundingClientRect().width>0);
  const chip=[...document.querySelectorAll('button')].map(b=>clean((b.innerText||'').replace(/\\n/g,' | '))).find(t=>/^Saved in /.test(t))||'';
  return JSON.stringify({name:h1,address:label('[data-item-id="address"]',/^Address:\\s*/),plusCode:label('[data-item-id="oloc"]',/^Plus code:\\s*/),saveLabel:save?save.getAttribute('aria-label'):'',chip});
})()`;

const READ_LIST_BUTTONS = `(()=>{
  return JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText||'').filter(t=>/\\n(Private|Shared|Public)\\s*\\u00b7/.test(t)));
})()`;

// Opened list: title, header count, and every item (name, detail lines, note). Each item holds
// exactly one textarea[aria-label=Note]; the highest ancestor with exactly one is the item root.
const READ_LIST = `(()=>{
  ${JS_CLEAN}
  const SEL='textarea[aria-label="Note"]';
  const lines=(document.body.innerText||'').split('\\n').map(clean).filter(Boolean);
  const h=lines.findIndex(l=>/^(Private|Shared|Public)\\s*\\u00b7\\s*[\\d,]+\\s*places?$/.test(l));
  const items=[];
  for(const t of document.querySelectorAll(SEL)){
    let p=t,root=null;
    while(p.parentElement){const par=p.parentElement;if(par.querySelectorAll(SEL).length>1)break;p=par;root=p;}
    if(!root)continue;
    const ls=(root.innerText||'').split('\\n').map(clean).filter(Boolean).filter(l=>l!=='Note'&&l!=='Add a note');
    items.push({name:ls[0]||'',detail:ls.slice(1),note:t.value});
  }
  return JSON.stringify({title:h>0?lines[h-1]:'',header:h>=0?lines[h]:'',items});
})()`;

const SCROLL_LIST_END = `(()=>{const t=[...document.querySelectorAll('textarea[aria-label="Note"]')].pop();if(t)t.scrollIntoView({block:'end'});return 1})()`;

const READ_CHOOSER = `(()=>{
  return JSON.stringify([...document.querySelectorAll('[role=menuitemradio]')].map(e=>({text:e.innerText||'',checked:e.getAttribute('aria-checked')==='true'})));
})()`;

// Expression helpers that resolve one element (null when absent).
const EL_SAVE_BUTTON = `[...document.querySelectorAll('button')].find(b=>/^Saved?( \\(\\d+\\))?$/.test(b.getAttribute('aria-label')||'')&&b.getBoundingClientRect().width>0)`;
const EL_NEW_LIST_IN_CHOOSER = `[...document.querySelectorAll('button')].find(b=>/New list/.test(b.innerText||'')&&b.getBoundingClientRect().width>0)`;
const EL_NEW_LIST_IN_PANEL = `document.querySelector('button[aria-label="New list"]')`;
const EL_DIALOG_INPUT = `[...document.querySelectorAll('[role=dialog]')].filter(d=>/New list/.test(d.innerText||'')).map(d=>d.querySelector('input')).find(Boolean)`;
const EL_CREATE_BUTTON = `[...document.querySelectorAll('[role=dialog] button')].find(b=>(b.getAttribute('aria-label')||'')==='Create'&&b.getBoundingClientRect().width>0)`;
const elListButton = (name) =>
  `[...document.querySelectorAll('button')].find(b=>/\\n(Private|Shared|Public)\\s*\\u00b7/.test(b.innerText||'')&&(b.innerText||'').split('\\n').map(s=>s.replace(/[\\ue000-\\uf8ff]/g,'').trim()).filter(Boolean)[0]===${JSON.stringify(cleanText(name))})`;
const elChooserRow = (index) => `document.querySelectorAll('[role=menuitemradio]')[${Number(index)}]`;
// Item root in an opened list: the ancestor holding exactly one Note textarea (see READ_LIST).
const elItemRoot = (name) => `(()=>{
  const clean=(s)=>(s||'').replace(/[\\ue000-\\uf8ff]/g,'').replace(/\\u00a0/g,' ').trim();
  const want=${JSON.stringify(foldName(name))};
  const SEL='textarea[aria-label="Note"]';
  const roots=[];
  for(const t of document.querySelectorAll(SEL)){let p=t,root=null;while(p.parentElement){const par=p.parentElement;if(par.querySelectorAll(SEL).length>1)break;p=par;root=p;}if(root)roots.push(root);}
  const nm=(r)=>clean((r.innerText||'').split('\\n').map(clean).filter(Boolean)[0]||'').toLowerCase();
  return roots.find(r=>nm(r)===want)||null;
})()`;

// ---------------------------------------------------------------------------------------------
// Node-side plumbing
// ---------------------------------------------------------------------------------------------

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}
const evalJson = async (page, expression) => JSON.parse(await evaluate(page, expression));

// Real CDP mouse events at the element centre (Maps ignores a bare element.click() in most menus).
async function clickAt(page, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
}

// Scroll the element into view, let the layout settle, then click its centre. Returns false when absent.
async function clickEl(page, elExpr) {
  const has = await evaluate(page, `(()=>{const e=${elExpr};if(!e)return 0;e.scrollIntoView({block:'center'});return 1})()`);
  if (!has) return false;
  await wait(500);
  const xy = await evaluate(page, `(()=>{const e=${elExpr};if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify([r.x+r.width/2,r.y+r.height/2])})()`);
  if (!xy) return false;
  const [x, y] = JSON.parse(xy);
  await clickAt(page, x, y);
  return true;
}

async function pressKey(page, key, code, vk) {
  for (const type of ["keyDown", "keyUp"]) await page.cdp("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk });
}

// Replace the value of the focused text field (select all, delete, insert).
async function typeInto(page, text) {
  await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
  await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  await pressKey(page, "Backspace", "Backspace", 8);
  await page.cdp("Input.insertText", { text });
}

async function poll(fn, { timeoutMs = 15000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await wait(intervalMs);
  }
  return last || null;
}

async function navigate(page, url) {
  await page.cdp("Page.navigate", { url });
}

// One background tab in the default context (the Google login lives there), closed in finally.
async function withTab(ctx, fn) {
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    const page = await ctx.attachPage(targetId, { allowedOrigins: [ORIGIN] });
    await page.cdp("Page.enable");
    // A hidden tab otherwise renders late or not at all and drops input.
    await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await page.cdp("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    return await fn(page);
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// Saved panel -> the user's lists as [{ name, visibility, count }]. Throws when signed out.
async function readLists(page) {
  await navigate(page, SAVED_URL);
  let stable = 0;
  let prev = -1;
  const lists = await poll(
    async () => {
      const raw = await evalJson(page, READ_LIST_BUTTONS);
      if (raw.length && raw.length === prev) stable += 1;
      else stable = 0;
      prev = raw.length;
      return stable >= 1 ? raw : null;
    },
    { timeoutMs: 25000, intervalMs: 900 }
  );
  if (!lists || !lists.length) {
    const st = await evalJson(page, READ_STATE);
    if (!st.signedIn) throw new Error("google-com-maps: not signed in to Google in this browser (no account control, no saved lists)");
    throw new Error("google-com-maps: the Saved panel showed no lists");
  }
  return lists.map(parseListEntry).filter(Boolean);
}

// Open one list's detail view and read it fully (scrolls until the item count equals the header
// count or stops changing). Returns { title, header, count, items, complete }.
async function readOpenedList(page, entry) {
  const read = () => evalJson(page, READ_LIST);
  const head = await poll(
    async () => {
      const r = await read();
      return foldName(r.title) === foldName(entry.name) && parseCount(r.header) === entry.count && (r.items.length > 0 || entry.count === 0) ? r : null;
    },
    { timeoutMs: 20000, intervalMs: 800 }
  );
  if (!head) throw new Error(`google-com-maps: opened "${entry.name}" but the panel title/count never matched (expected ${entry.count} places)`);
  let cur = head;
  let flat = 0;
  for (let i = 0; i < 60 && cur.items.length < entry.count && flat < 3; i++) {
    await evaluate(page, SCROLL_LIST_END);
    await wait(900);
    const next = await read();
    flat = next.items.length === cur.items.length ? flat + 1 : 0;
    cur = next;
  }
  const count = parseCount(cur.header);
  return { title: cur.title, header: cur.header, count, items: cur.items, complete: cur.items.length === count };
}

async function openList(page, list) {
  const lists = await readLists(page);
  const hit = matchList(lists, list);
  if (!hit) {
    const near = listSuggestions(lists, list);
    throw new Error(`google-com-maps: no list named "${list}"` + (near.length ? ` (similar: ${near.join(", ")})` : ""));
  }
  if (!(await clickEl(page, elListButton(hit.entry.name)))) throw new Error(`google-com-maps: list button for "${hit.entry.name}" not found`);
  return { entry: hit.entry, lists };
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

// Read-only. Items come back in the list's own order.
export async function listItems(ctx, { list } = {}) {
  if (!list || typeof list !== "string") throw new Error("listItems: list (the list name) is required");
  return withTab(ctx, async (page) => {
    const { entry } = await openList(page, list);
    const r = await readOpenedList(page, entry);
    return { list: entry.name, visibility: entry.visibility, count: r.count, itemCount: r.items.length, complete: r.complete, items: r.items };
  });
}

// Creates a list through the Saved panel's "New list" dialog. No-op when the exact name exists.
// WRITE PATH: not exercised live (see notes/overview.md); the dialog selectors were read, not driven.
export async function createList(ctx, { name } = {}) {
  const wanted = cleanText(name);
  if (!wanted) throw new Error("createList: name is required");
  if (wanted.length > 40) throw new Error("createList: Maps caps a list name at 40 characters");
  return withTab(ctx, async (page) => {
    const before = await readLists(page);
    const existing = matchList(before, wanted);
    if (existing) return { created: false, name: existing.entry.name, count: existing.entry.count };
    if (!(await clickEl(page, EL_NEW_LIST_IN_PANEL))) return { stop: "no-new-list-button", hint: "the Saved panel has no New list button" };
    await createFromDialog(page, wanted);
    const after = await poll(async () => (matchList(await readLists(page), wanted) ? true : null), { timeoutMs: 12000, intervalMs: 1500 });
    if (!after) return { stop: "outcome-unknown", hint: `clicked Create for "${wanted}" but the list did not show up in the Saved panel; inspect before retrying` };
    return { created: true, name: wanted };
  });
}

// Dialog already open? no: this clicks nothing before the dialog; it waits for it, names the list, clicks Create.
async function createFromDialog(page, wanted) {
  const input = await poll(async () => (await evaluate(page, `!!(${EL_DIALOG_INPUT})`)) || null, { timeoutMs: 8000, intervalMs: 400 });
  if (!input) throw new Error("google-com-maps: the New list dialog did not open");
  await evaluate(page, `(()=>{const i=${EL_DIALOG_INPUT};i.focus();i.select();return 1})()`);
  await typeInto(page, wanted);
  await wait(500);
  const typed = await evaluate(page, `(${EL_DIALOG_INPUT}).value`);
  if (cleanText(typed) !== wanted) throw new Error(`google-com-maps: the dialog name field holds "${cleanText(typed)}", expected "${wanted}"`);
  if (!(await clickEl(page, EL_CREATE_BUTTON))) throw new Error("google-com-maps: Create button not found in the New list dialog");
  await wait(2500);
}

// Search + region check. Returns { place } or { tried }. place = { name, address, plusCode, saveLabel, chip }.
async function findPlace(page, queries, mustContain) {
  const tried = [];
  for (const query of queries) {
    await navigate(page, searchUrl(query));
    let lastKey = "";
    let stable = 0;
    const state = await poll(
      async () => {
        const st = await evalJson(page, READ_STATE);
        const key = `${st.mode}:${st.feed}`;
        stable = key === lastKey ? stable + 1 : 0;
        lastKey = key;
        return st.mode !== "loading" && stable >= 2 ? st : null;
      },
      { timeoutMs: 25000, intervalMs: 700 }
    );
    if (!state || state.mode === "none") {
      tried.push({ query, reason: "no results" });
      continue;
    }
    const check = async () => {
      const place = await evalJson(page, READ_PLACE);
      if (isNoise(place.name, query)) return { reason: "noise", place };
      const plain = rankResults([{ name: place.name, text: `${place.address} ${place.plusCode}` }], { query });
      if (!plain.length) return { reason: "name", place };
      if (!matchesRegion(`${place.name} ${place.address} ${place.plusCode}`, mustContain)) return { reason: "region", place };
      return { place };
    };
    if (state.mode === "place") {
      const r = await check();
      if (r.place && !r.reason) return { place: r.place, query };
      tried.push({ query, name: r.place.name, address: r.place.address, reason: r.reason });
      continue;
    }
    const cards = await evalJson(page, READ_FEED);
    const ranked = rankResults(cards, { query, mustContain }).slice(0, MAX_CANDIDATES);
    if (!ranked.length) {
      tried.push({ query, reason: "no plausible result", seen: cards.slice(0, 5).map((c) => c.name) });
      continue;
    }
    for (const { index } of ranked) {
      await navigate(page, cards[index].href);
      const ok = await poll(async () => ((await evalJson(page, READ_STATE)).mode === "place" ? true : null), { timeoutMs: 20000, intervalMs: 700 });
      if (!ok) {
        tried.push({ query, name: cards[index].name, reason: "place page did not load" });
        continue;
      }
      await wait(1200);
      const r = await check();
      if (r.place && !r.reason) return { place: r.place, query };
      tried.push({ query, name: r.place.name, address: r.place.address, reason: r.reason });
    }
  }
  return { tried };
}

async function chooserRows(page) {
  const raw = await evalJson(page, READ_CHOOSER);
  return raw.map((r) => ({ ...parseListEntry(r.text), checked: r.checked })).filter((r) => r.name);
}

async function openChooser(page) {
  if ((await chooserRows(page)).length) return; // already open: the Save button would close it
  if (!(await clickEl(page, EL_SAVE_BUTTON))) throw new Error("google-com-maps: Save button not found on the place page");
  const rows = await poll(async () => ((await chooserRows(page)).length ? true : null), { timeoutMs: 10000, intervalMs: 500 });
  if (!rows) throw new Error("google-com-maps: the Save list chooser did not open");
}

// Put the open place into the list. Returns { alreadySaved, listCreated } or { stop }.
async function saveViaChooser(page, list, createIfMissing, listCreated = false) {
  await openChooser(page);
  const rows = await chooserRows(page);
  const decision = chooserAction(rows, list, createIfMissing);
  if (decision.action === "already") return { alreadySaved: !listCreated, listCreated };
  if (decision.action === "stop-missing") return { stop: "list-missing", hint: `no list named "${list}" and createIfMissing is false`, lists: rows.map((r) => r.name) };
  if (decision.action === "create") {
    if (!(await clickEl(page, EL_NEW_LIST_IN_CHOOSER))) return { stop: "no-new-list-button", hint: "the Save chooser has no New list row" };
    await createFromDialog(page, cleanText(list));
    // Creating from the chooser may or may not also save the place: re-open and let the read decide.
    await wait(1500);
    return saveViaChooser(page, list, false, true);
  }
  const before = savedCount((await evalJson(page, READ_PLACE)).saveLabel);
  if (!(await clickEl(page, elChooserRow(decision.index)))) throw new Error("google-com-maps: chooser row vanished before the click");
  // Verify by read-back, never by the click: the chip names the list, or the Save button count rose.
  const ok = await poll(
    async () => {
      const p = await evalJson(page, READ_PLACE);
      const n = savedCount(p.saveLabel);
      return foldName(p.chip).includes(foldName(list)) || (n != null && before != null && n > before) ? true : null;
    },
    { timeoutMs: 10000, intervalMs: 700 }
  );
  if (!ok) return { stop: "outcome-unknown", hint: "clicked the list row but could not confirm the save; inspect the place before retrying" };
  return { alreadySaved: false, listCreated };
}

// Set the note of one item in an opened list: JS click on "Add note" (a coordinate click lands on the
// wrong row after the list scrolls), focus the Note textarea, type, Tab out, read the value back.
async function setNote(page, itemName, note) {
  const found = await evaluate(page, `(()=>{const r=${elItemRoot(itemName)};if(!r)return null;r.scrollIntoView({block:'center'});const t=r.querySelector('textarea[aria-label="Note"]');return JSON.stringify({note:t?t.value:''})})()`);
  if (!found) return { note: "item-not-found" };
  if (JSON.parse(found).note === note) return { note: "unchanged" };
  await wait(600);
  const focused = await evaluate(
    page,
    `(()=>{const r=${elItemRoot(itemName)};if(!r)return '';const b=r.querySelector('button[aria-label="Add note"]');if(b)b.click();const t=r.querySelector('textarea[aria-label="Note"]');if(t)t.focus();return document.activeElement&&document.activeElement.tagName+':'+(document.activeElement.getAttribute('aria-label')||'')})()`
  );
  if (!/^TEXTAREA:Note$/.test(focused || "")) return { note: "not-focused" };
  await wait(500);
  await typeInto(page, note);
  await wait(600);
  await pressKey(page, "Tab", "Tab", 9);
  await wait(1500);
  const value = await evaluate(page, `(()=>{const r=${elItemRoot(itemName)};const t=r&&r.querySelector('textarea[aria-label="Note"]');return t?t.value:null})()`);
  return { note: value === note ? "set" : "unconfirmed" };
}

// Search a place, check it is in the right region, and save it into the named list (created when
// absent unless createIfMissing is false). A place already in the list is left alone (the chooser
// rows are toggles). fallbacks: extra queries tried in order when the first finds nothing usable,
// e.g. the same place in Chinese. WRITE PATH: see notes/overview.md for what was driven live.
export async function saveToList(ctx, { query, list, note, mustContain, fallbacks = [], createIfMissing = true } = {}) {
  if (!query || typeof query !== "string") throw new Error("saveToList: query is required");
  if (!list || typeof list !== "string") throw new Error("saveToList: list (the list name) is required");
  const queries = [query, ...(Array.isArray(fallbacks) ? fallbacks : [fallbacks])].filter((q) => typeof q === "string" && q.trim());
  return withTab(ctx, async (page) => {
    const found = await findPlace(page, queries, mustContain);
    if (!found.place) return { stop: "no-match", hint: "no result passed the name and region checks; nothing was saved", tried: found.tried };
    const { place } = found;
    const saved = await saveViaChooser(page, list, createIfMissing);
    if (saved.stop) return { ...saved, name: place.name, address: place.address };
    const out = { saved: true, alreadySaved: saved.alreadySaved, listCreated: saved.listCreated, list: cleanText(list), name: place.name, address: place.address || place.plusCode, usedQuery: found.query };
    if (note) {
      const { entry } = await openList(page, list);
      await readOpenedList(page, entry);
      Object.assign(out, await setNote(page, place.name, note));
    }
    return out;
  });
}
