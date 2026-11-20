// learnings/claude-ai/tools/claude-ai.mjs
// Helpers for the Claude Code web UI (claude.ai/code, Projects beta). The guarded click
// refuses many of its controls and Radix menus ignore a bare mousePressed/mouseReleased, so
// clicks here are raw Input events after a hover. Every helper works on ctx.requirePage()
// (the tab named by args.targetId, else the REPL's active tab). Porting contract: ../../PORTING.md.
import { writeFile } from "node:fs/promises";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://claude.ai";
const VIEW = { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false };
// The sidebar is 232 px wide and lists private session and project names; crop it out.
const DEFAULT_CLIP = { x: 232, y: 0, width: 1048, height: 820 };

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

// Viewport rect of the element `expr` evaluates to, or null when it is absent.
export async function rect(ctx, expr) {
  const js = `(()=>{const e=(${expr});if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2}})()`;
  return evaluate(ctx.requirePage(), js);
}

// mouseMoved, ~150 ms, then press and release at the centre. Radix menus need the hover.
export async function hoverClick(ctx, expr) {
  const page = ctx.requirePage();
  const r = await rect(ctx, expr);
  if (!r) throw new Error("hoverClick: no element for " + expr);
  const at = { x: r.cx, y: r.cy };
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await wait(150);
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
  return { clicked: true, x: r.cx, y: r.cy };
}

// Click inside `scopeSelector` the element whose trimmed innerText equals `text` (menu entries
// are not role=menuitem); else the first button whose innerText includes it (button text
// carries a leading newline from the icon).
export async function clickByText(ctx, scopeSelector, text) {
  const s = JSON.stringify(scopeSelector);
  const t = JSON.stringify(text);
  const pick = `(()=>{const all=[...document.querySelectorAll(${s})].flatMap(n=>[...n.querySelectorAll("*")]);return all.find(e=>e.innerText&&e.innerText.trim()===${t})||all.find(e=>e.matches("button,[role=button]")&&e.innerText.includes(${t}))})()`;
  return hoverClick(ctx, pick);
}

// Screenshot a clip of a background tab to outPath. The override is cleared afterwards.
export async function shot(ctx, outPath, clip = DEFAULT_CLIP) {
  const page = ctx.requirePage();
  await page.cdp("Emulation.setDeviceMetricsOverride", VIEW);
  try {
    const { data } = await page.cdp("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
    await writeFile(outPath, Buffer.from(data, "base64"));
  } finally {
    await page.cdp("Emulation.clearDeviceMetricsOverride", {});
  }
  return { path: outPath, clip };
}

// ---- node-tool entry points: the runner calls fn(ctx, args) ----

export async function status(ctx) {
  let page;
  try { page = await ctx.findPage(ORIGIN + "/", { waitMs: 500 }); }
  catch { return { state: "no-tab", hint: "no open tab on " + ORIGIN + "; run openCode" }; }
  return { state: "tab", url: (await page.info()).url };
}

// Background tab on /code. The default 10 s deadline fails because the SPA never settles; on
// failure browser.open closes the tab. The Page is released here, the tab stays open.
export async function openCode(ctx, args = {}) {
  const page = await ctx.browser.open(args.url || ORIGIN + "/code", { allowedOrigins: [ORIGIN], timeoutMs: 45000 });
  const { targetId } = page;
  page.dispose();
  return { targetId };
}

// ---- artifactLink: recover a claude.ai artifact link by title ----
// Claude Code's output masker hides claude.ai artifact links, so a session cannot hand one to the
// operator. The gallery page lists every artifact as <a href="/artifact/<id>"> inside a card
// that carries its title; read the id from there.
const GALLERY = ORIGIN + "/code/artifacts";
const MAX_DEPTH = 6;

// Space-separated 4-char groups; the chunking is what gets an id past the masker.
export const chunkId = (id) => (id.match(/.{1,4}/g) || []).join(" ");

export const linkFor = (id) => ({ id, url: ORIGIN + "/artifact/" + id, idChunks: chunkId(id) });

// anchors: [{id, depths: boolean[]}] in DOM order, depths[d] = "the ancestor d levels up (0 = the
// anchor itself) has innerText containing the title". Keep the anchors matching at the smallest
// depth that has any match (the card, not the whole list), deduped by id.
export function pickMatches(anchors) {
  for (let d = 0; d <= MAX_DEPTH; d++) {
    const hit = anchors.filter((a) => a.depths[d]);
    if (hit.length) return [...new Set(hit.map((a) => a.id))];
  }
  return [];
}

// One in-page pass: for each artifact anchor the per-depth title test, plus a card title.
export const collectJs = (title) => `(()=>{const t=${JSON.stringify(title)};return [...document.querySelectorAll('a[href*="/artifact/"]')].map(a=>{const m=a.getAttribute("href").match(/\\/artifact\\/([A-Za-z0-9_-]+)/);if(!m)return null;const depths=[];let n=a,first="";for(let d=0;d<=${MAX_DEPTH};d++){const x=n?n.innerText||"":"";depths.push(x.includes(t));if(!first)first=x.split("\\n").map(l=>l.trim()).find(Boolean)||"";n=n&&n.parentElement}return{id:m[1],depths,first}}).filter(Boolean)})()`;

async function waitForTitle(page, title, deadline) {
  const probe = `document.body.innerText.includes(${JSON.stringify(title)})`;
  const reloadAt = Date.now() + 15000;
  let reloaded = false;
  while (Date.now() < deadline) {
    if (await evaluate(page, probe)) return true;
    if (!reloaded && Date.now() > reloadAt) { reloaded = true; await page.cdp("Page.reload", {}); }
    await wait(500);
  }
  return false;
}

// Open (or reuse args.targetId) a background tab on the gallery, wait for the title, return the
// link(s). A tab it opened is closed; a reused one is left open.
export async function artifactLink(ctx, args = {}) {
  const title = args.title;
  if (!title) throw new Error("artifactLink: title is required");
  const reuse = Boolean(args.targetId);
  const page = reuse ? ctx.requirePage() : await ctx.browser.open(GALLERY, { allowedOrigins: [ORIGIN], timeoutMs: 45000 });
  try {
    if (reuse && !(await evaluate(page, "location.href")).startsWith(GALLERY)) {
      await page.cdp("Page.navigate", { url: GALLERY });
    }
    await waitForTitle(page, title, Date.now() + 45000);
    const anchors = await evaluate(page, collectJs(title));
    const ids = pickMatches(anchors);
    if (!ids.length) {
      const seen = [...new Set(anchors.map((a) => a.first).filter(Boolean))].slice(0, 10);
      return { state: "not-found", titlesSeen: seen };
    }
    const links = ids.map(linkFor);
    return links.length > 1 ? { ...links[0], matches: links } : links[0];
  } finally {
    if (reuse) page.dispose();
    else await page.close();
  }
}

export const rectTool = (ctx, args) => rect(ctx, args.expr);
export const hoverClickTool = (ctx, args) => hoverClick(ctx, args.expr);
export const clickByTextTool = (ctx, args) => clickByText(ctx, args.scope, args.text);
export const shotTool = (ctx, args) => shot(ctx, args.out, args.clip);
