/**
 * REPL-extended agent helpers for browser-harness-js. These exist for things
 * CDP structurally LACKS — never to wrap or hide a CDP method (the SDK's
 * ethos: if Chrome can do it, call it directly). They close over the live
 * `session` set in repl.ts via globalThis (read each call so a reconnect or a
 * different session replaces them transparently).
 *
 *   - drainSignals / attachSignals   : drainable async event queue (dialogs,
 *                                       downloads, navigations, crashes) +
 *                                       the modal-dialog tracker pageInfo() needs.
 *   - pageInfo                       : meta (url/title/viewport) via a timed
 *                                       Runtime.evaluate; surfaces {dialog} or
 *                                       {unresponsive} instead of silently hanging.
 *   - parseLocator / resolveLocator  : turn axView's `loc=role:R["N"]` into a
 *                                       backendDOMNodeId via queryAXTree — survives
 *                                       snapshot rebuilds ([n] refs do not).
 *   - help                           : per-helper usage so the model doesn't reload docs.
 *   - listLearnings / learnings       : registry over skills/cdp/learnings/<domain>/
 *                                       manifest.json, codified per-site tools so
 *                                       the agent stops re-deriving recipes each call.
 *   - attachTab / evalFile / waitForUrl / deepQuery : REPL scaffold-cutters. All
 *                                       four route by an explicit sessionId and
 *                                       never touch session.use, safe alongside
 *                                       other sessions on the same daemon.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Session } from './session.ts';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEARNINGS_DIR = join(SKILL_DIR, 'learnings');

function sessionOrThrow(): Session {
  const s = (globalThis as any).session as Session | undefined;
  if (!s) throw new Error('helpers: globalThis.session not initialized — start the REPL first (browser-harness-js).');
  return s;
}

// --- Locators -------------------------------------------------------------
// parseLocator is backslash-free: hand-written scanner with a Set-based char
// class so the file (and pi.write transport) doesn't have to dance around d
// / [ / s regex-literal escapes.
const STOP_CHARS = new Set<string>([
  ' ',
  String.fromCharCode(9),
  String.fromCharCode(10),
  String.fromCharCode(13),
  '[',
  ']',
  '"',
  String.fromCharCode(39),
  String.fromCharCode(96),
]);
const BACKSLASH = String.fromCharCode(92);

function parseLocator(loc: string): { role: string; name?: string } {
  let s = loc.trim();
  if (s.startsWith('loc=')) s = s.slice(4).trim();
  const ROLE_MARKER = 'role:';
  if (!s.startsWith(ROLE_MARKER)) {
    throw new Error('Invalid locator ' + JSON.stringify(loc) + '. Expected role:<role>["<accessibleName>"] (optionally with a loc= prefix).');
  }
  let roleEnd = ROLE_MARKER.length;
  while (roleEnd < s.length && !STOP_CHARS.has(s.charAt(roleEnd))) roleEnd++;
  if (roleEnd === ROLE_MARKER.length) throw new Error('Invalid locator (no role): ' + JSON.stringify(loc));
  const role = s.slice(ROLE_MARKER.length, roleEnd);
  let p = roleEnd;
  while (p < s.length && (s.charAt(p) === ' ' || s.charAt(p) === String.fromCharCode(9))) p++;
  if (p >= s.length) return { role };
  if (s.charAt(p) !== '[' || s.charAt(p + 1) !== '"') {
    throw new Error('Invalid locator (trailing chars after role): ' + JSON.stringify(loc) + ' at offset ' + p);
  }
  let q = p + 2;
  let buf = '';
  while (q < s.length) {
    const ch = s.charAt(q);
    if (ch === BACKSLASH) {
      buf += BACKSLASH + s.charAt(q + 1);
      q += 2;
      continue;
    }
    if (ch === '"') break;
    buf += ch;
    q++;
  }
  if (q >= s.length || s.charAt(q) !== '"') throw new Error('Invalid locator (unterminated name string): ' + JSON.stringify(loc));
  if (s.charAt(q + 1) !== ']') throw new Error('Invalid locator (missing ] after name): ' + JSON.stringify(loc));
  const name = JSON.parse('"' + buf + '"');
  return { role, name };
}

function isLocatorString(ref: number | string): boolean {
  return typeof ref === 'string' && (ref.startsWith('loc=') || ref.startsWith('role:'));
}

async function resolveLocator(loc: string): Promise<number> {
  const session = sessionOrThrow();
  const { role, name } = parseLocator(loc);
  // queryAXTree is the cheap, scoped path. It hangs on some Chromium versions
  // (see interaction-skills/accessibility-tree.md: same hang the doc warns about
  // for the shim path surfaces for the active-session call too in some builds).
  // Race it against a short timeout; on timeout fall through to a full-tree scan.
  try {
    const { root } = await session.domains.DOM.getDocument({});
    const params: any = name != null
      ? { nodeId: root.nodeId, role, accessibleName: name }
      : { nodeId: root.nodeId, role };
    const { nodes } = await Promise.race([
      session.domains.Accessibility.queryAXTree(params),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queryAXTree timeout')), 3_000)),
    ]);
    const node = (nodes || []).find((n: any) => !n.ignored && n.backendDOMNodeId);
    if (node) return (node as any).backendDOMNodeId as number;
  } catch {
    // queryAXTree failed/timed out — fall through to getFullAXTree scan.
  }
  // Fallback: scan the full AX tree for a node matching (role[, name]).
  // More expensive than queryAXTree (the whole tree, not a subtree scope) but
  // reliable when the served build doesn't answer queryAXTree.
  const { nodes: all } = await session.domains.Accessibility.getFullAXTree({});
  const wantName = name != null;
  const node = (all || []).find((n: any) => {
    if (n.ignored || !n.backendDOMNodeId) return false;
    const r = n.role && n.role.value;
    if (!r || r.toLowerCase() !== role.toLowerCase()) return false;
    if (wantName) {
      const nm = String((n.name && n.name.value) || String.fromCharCode(0)).trim();
      if (nm !== name) return false;
    }
    return true;
  });
  if (!node) {
    throw new Error('No element found for locator ' + JSON.stringify(loc) + ' (scanned ' + (all || []).length + ' AX node(s) via getFullAXTree; role="' + role + '"' + (wantName ? (', name="' + name + '"') : '') + ').');
  }
  return (node as any).backendDOMNodeId as number;
}

// --- Agent signals --------------------------------------------------------
let _signalsAttached = false;
let _sigOff = () => {};
const _signalQueue: string[] = [];
let _lastDialog: { type: string; message: string; defaultPrompt?: string } | undefined;
let _dlName = '';

const SIGNAL_HANDLERS: Record<string, (p: any) => string | null> = {
  'Page.javascriptDialogOpening': (p) => {
    _lastDialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt ?? '' };
    return 'dialog ' + p.type + ': ' + JSON.stringify(p.message);
  },
  'Page.javaScriptDialogClosed': () => { _lastDialog = undefined; return null; },
  'Page.fileChooserOpened': (p) => 'file chooser (' + p.mode + ')',
  'Page.downloadWillBegin': (p) => {
    _dlName = p.suggestedFilename ?? p.url ?? '';
    return 'download start: ' + _dlName;
  },
  'Page.downloadProgress': (p) => p.state === 'inProgress' ? null : 'download ' + p.state + ': ' + _dlName,
  'Page.windowOpen': (p) => 'window.open -> ' + (p.url ?? ''),
  'Page.frameNavigated': (p) => 'navigated -> ' + (p.frame && p.frame.url ? p.frame.url : ''),
  'Target.targetCreated': (p) => 'new ' + (p.targetInfo && p.targetInfo.type ? p.targetInfo.type : 'target') + ': ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Target.targetDestroyed': (p) => 'target closed: ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Target.targetCrashed': (p) => 'target CRASHED: ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Network.loadingFailed': (p) => 'request FAILED (' + p.type + '): ' + p.url + ' [' + (p.errorText ?? '') + ']',
};

function attachSignals(): void {
  if (_signalsAttached) return;
  const session = sessionOrThrow();
  _signalsAttached = true;
  const active = () => session.getActiveSession();
  _sigOff = session.onEvent((method: string, p: any, sid?: string) => {
    if (sid && sid !== active() && method.startsWith('Page.')) return;
    const fn = SIGNAL_HANDLERS[method];
    if (!fn) return;
    try {
      const m = fn(p);
      if (m) _signalQueue.push(m);
    } catch {
      // Never let a subscriber throw into the event loop.
    }
  });
}

function drainSignals(): string[] {
  attachSignals();
  return _signalQueue.splice(0, _signalQueue.length);
}

function detachSignals(): void {
  _sigOff();
  _signalsAttached = false;
  _lastDialog = undefined;
  _signalQueue.length = 0;
}

// --- pageInfo -------------------------------------------------------------
async function pageInfo(opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const session = sessionOrThrow();
  const timeoutMs = opts.timeoutMs ?? 2000;
  const EXPR = 'JSON.stringify({ url: location.href, title: document.title, w: window.innerWidth, h: window.innerHeight, sx: window.scrollX, sy: window.scrollY, pw: document.documentElement ? document.documentElement.clientWidth : 0, ph: document.documentElement ? document.documentElement.clientHeight : 0 })';
  const evalP = session.domains.Runtime.evaluate({ expression: EXPR, returnByValue: true });
  let timer!: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('pageInfo timeout after ' + timeoutMs + 'ms')), timeoutMs);
  });
  try {
    const result = (await Promise.race([evalP, timeoutP])) as any;
    if (result && result.exceptionDetails) {
      const e = result.exceptionDetails;
      throw new Error(e.text ?? (e.exception && e.exception.description) ?? 'Runtime.evaluate exception');
    }
    if (result && result.result && result.result.value) return JSON.parse(result.result.value);
    return {};
  } catch {
    if (_lastDialog) return { dialog: _lastDialog };
    return { unresponsive: true, hint: 'Page JS did not respond in time. Likely a blocking modal dialog, a long-running synchronous task, or the page navigated away mid-eval.' };
  } finally {
    // Same uncleared-timer bug class as boundedEvaluate below: without this,
    // a SUCCESSFUL call still leaves the timeoutMs timer armed and the
    // process alive until it fires.
    clearTimeout(timer);
  }
}

// --- REPL scaffold-cutters --------------------------------------------------
// Every one-off REPL snippet in a multi-tab session repeated the same three
// lines: find the tab, run some JS on it, wait for a bound. These four route
// by an explicit sessionId (never session.use, so they never race a parallel
// snippet touching a different tab) and never leave a page-side hang able to
// wedge the shared daemon (evalFile races a host-side timer around the CDP
// call; a hung Runtime.evaluate then rejects the caller instead of blocking
// the process indefinitely, the "10-minute fetch" failure this exists for).

/** Runtime.evaluate on an explicit session, raced against a host-side timer so
 *  a hung page cannot block past `ms`. Shared by evalFile, waitForUrl, and
 *  deepQuery. The timer is cleared as soon as either side settles, so a
 *  normal (non-timeout) call leaves nothing pending. The abandoned CDP
 *  request itself cannot be cancelled (no CDP method cancels an in-flight
 *  Runtime.evaluate); it is simply left to resolve or reject unread. */
async function boundedEvaluate(sessionId: string, params: Record<string, unknown>, ms: number): Promise<any> {
  const session = sessionOrThrow();
  const evalP = session._call('Runtime.evaluate', params, { sessionId }) as Promise<any>;
  let timer!: ReturnType<typeof setTimeout>;
  const timeoutP = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('timed out after ' + ms + 'ms')), ms);
  });
  try {
    return await Promise.race([evalP, timeoutP]);
  } finally {
    clearTimeout(timer);
  }
}

/** Find one page target by targetId prefix (uppercase hex, 6-32 chars, only
 *  when at least one open target's id actually starts with it) or by URL
 *  match (RegExp or substring), attach to it, and return its sessionId
 *  without touching session.use or the active-session pointer. */
async function attachTab(match: string | RegExp): Promise<{ sessionId: string; targetId: string; url: string }> {
  const session = sessionOrThrow();
  const { targetInfos } = await session.domains.Target.getTargets({});
  const pages = (targetInfos as any[]).filter(t => t.type === 'page');
  const idPrefix = typeof match === 'string' && /^[0-9A-F]{6,32}$/.test(match)
    && pages.some(t => String(t.targetId).startsWith(match))
    ? match
    : undefined;
  const hits = pages.filter(t => idPrefix !== undefined ? String(t.targetId).startsWith(idPrefix)
    : match instanceof RegExp ? match.test(t.url) : t.url.includes(match as string));
  if (hits.length === 0) {
    throw new Error('attachTab: no page target matched ' + JSON.stringify(String(match)) + ' (' + pages.length + ' page target(s) open: ' + pages.map(t => t.url).join(', ') + ').');
  }
  if (hits.length > 1) {
    throw new Error('attachTab: ' + hits.length + ' page targets matched ' + JSON.stringify(String(match)) + ', narrow it. Candidates: ' + hits.map(t => t.targetId + ' ' + t.url).join('; '));
  }
  const target = hits[0];
  const { sessionId } = (await session._call('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as { sessionId: string };
  return { sessionId, targetId: target.targetId, url: target.url };
}

/** Run a local JS file on an explicit session via Runtime.evaluate, bounded by
 *  a REQUIRED timeout (default 30s) raced against the CDP call itself, so a
 *  hung page cannot block the caller (or the daemon) past the bound. The file
 *  text is evaluated as-is (never wrapped): it must be a valid expression or
 *  script, typically `(async()=>{ ... })()`, since a top-level `return` is a
 *  page-side SyntaxError. With opts.out, writes the result to that file and
 *  returns the byte count instead of the value; a result that JSON cannot
 *  serialize (undefined, BigInt) is written as its String() text rather than
 *  throwing. */
async function evalFile(sessionId: string, file: string, opts: { timeoutMs?: number; userGesture?: boolean; out?: string } = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const expression = await readFile(file, 'utf8');
  let result: any;
  try {
    result = await boundedEvaluate(sessionId, {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: opts.userGesture ?? false,
    }, timeoutMs);
  } catch (e) {
    throw new Error('evalFile: ' + (e instanceof Error ? e.message : String(e)) + ' running ' + file + ' on session ' + sessionId);
  }
  if (result && result.exceptionDetails) {
    const e = result.exceptionDetails;
    throw new Error('evalFile: ' + (e.text ?? (e.exception && e.exception.description) ?? 'Runtime.evaluate exception') + ' (' + file + ')');
  }
  const value = result && result.result ? result.result.value : undefined;
  if (opts.out) {
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else {
      let json: string | undefined;
      try { json = JSON.stringify(value); } catch { json = undefined; }
      text = json !== undefined ? json : String(value);
    }
    await writeFile(opts.out, text, 'utf8');
    return Buffer.byteLength(text, 'utf8');
  }
  return value;
}

/** Poll location.href on an explicit session until `test` passes (RegExp or
 *  predicate function). Each poll is itself bounded (min(intervalMs, time
 *  remaining), floored at 1000ms) so one hung poll cannot defeat the overall
 *  deadline; a timed-out or failing poll counts as a miss and the loop
 *  continues. The "wait until the human finishes signing in" loop, default
 *  5min overall bound, 5s interval. */
async function waitForUrl(sessionId: string, test: RegExp | ((url: string) => boolean), opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const matches = typeof test === 'function' ? test : (url: string) => test.test(url);
  const deadline = Date.now() + timeoutMs;
  let lastUrl: string | undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('waitForUrl: timed out after ' + timeoutMs + 'ms on session ' + sessionId + (lastUrl ? ' (last seen: ' + lastUrl + ')' : ''));
    }
    const pollMs = Math.max(1_000, Math.min(intervalMs, remaining));
    const pollStart = Date.now();
    let url: string | undefined;
    try {
      const r = await boundedEvaluate(sessionId, { expression: 'location.href', returnByValue: true }, pollMs);
      url = r && r.result ? r.result.value : undefined;
    } catch {
      // a hung or failing poll counts as a miss; the loop continues and the
      // overall timeoutMs above still governs when we give up.
    }
    if (typeof url === 'string') {
      lastUrl = url;
      if (matches(url)) return url;
    }
    const sleepMs = intervalMs - (Date.now() - pollStart);
    if (sleepMs > 0) await new Promise(res => setTimeout(res, sleepMs));
  }
}

/** Page-side walker that crosses open shadow roots and returns visible
 *  matches for `selector` as { text, x, y, w, h, disabled, inViewport }
 *  (center coordinates; text trimmed to 120 chars, falling back to
 *  aria-label; inViewport is the center point falling inside innerWidth x
 *  innerHeight, not filtered on). opts.text (RegExp or substring) filters
 *  the result client-side. opts.timeoutMs bounds the evaluate (default
 *  15s). Read-only. */
async function deepQuery(sessionId: string, selector: string, opts: { text?: RegExp | string; timeoutMs?: number } = {}): Promise<Array<{ text: string; x: number; y: number; w: number; h: number; disabled: boolean; inViewport: boolean }>> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const expression = '(() => { const sel = ' + JSON.stringify(selector) + '; const out = []; '
    + 'const visit = (root) => { root.querySelectorAll(sel).forEach(el => { '
    + 'const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return; '
    + 'const st = getComputedStyle(el); if (st.visibility === "hidden" || st.display === "none") return; '
    + 'const raw = (el.innerText || el.getAttribute("aria-label") || el.textContent || "").trim(); '
    + 'const cx = r.left + r.width / 2; const cy = r.top + r.height / 2; '
    + 'const inViewport = cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight; '
    + 'out.push({ text: raw.slice(0, 120), x: cx, y: cy, w: r.width, h: r.height, disabled: el.disabled === true, inViewport }); }); '
    + 'root.querySelectorAll("*").forEach(el => { if (el.shadowRoot) visit(el.shadowRoot); }); }; '
    + 'visit(document); return JSON.stringify(out); })()';
  let r: any;
  try {
    r = await boundedEvaluate(sessionId, { expression, returnByValue: true }, timeoutMs);
  } catch (e) {
    throw new Error('deepQuery: ' + (e instanceof Error ? e.message : String(e)));
  }
  if (r && r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error('deepQuery: ' + (e.text ?? (e.exception && e.exception.description) ?? 'Runtime.evaluate exception'));
  }
  const raw = r && r.result ? r.result.value : undefined;
  const items: Array<{ text: string; x: number; y: number; w: number; h: number; disabled: boolean; inViewport: boolean }> = raw ? JSON.parse(raw) : [];
  if (opts.text == null) return items;
  const test = typeof opts.text === 'string'
    ? (t: string) => t.includes(opts.text as string)
    : (t: string) => (opts.text as RegExp).test(t);
  return items.filter(it => test(it.text));
}

// --- learnings registry ---------------------------------------------------
async function listLearnings(): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(LEARNINGS_DIR); } catch { return []; }
  const found: string[] = [];
  for (const c of entries) {
    const st = await stat(join(LEARNINGS_DIR, c)).catch(() => null);
    if (st && st.isDirectory()) {
      try { await readFile(join(LEARNINGS_DIR, c, 'manifest.json'), 'utf8'); found.push(c); }
      catch { /* no manifest */ }
    }
  }
  return found.sort();
}

async function loadManifest(domain: string): Promise<any> {
  let text: string;
  try { text = await readFile(join(LEARNINGS_DIR, domain, 'manifest.json'), 'utf8'); }
  catch { throw new Error('learnings: no manifest.json for "' + domain + '" (looked in ' + LEARNINGS_DIR + '/' + domain + '/manifest.json).'); }
  try { return JSON.parse(text); }
  catch (e) { throw new Error('learnings: ' + domain + '/manifest.json is not valid JSON: ' + (e as Error).message); }
}

function ctxForTool(): Record<string, unknown> {
  const g = globalThis as any;
  return {
    session: g.session, cdp: g.cdp, axView: g.axView, axClick: g.axClick, axType: g.axType,
    listPageTargets: g.listPageTargets, ext: g.ext, parseAxRefs: g.parseAxRefs, parseAxLocators: g.parseAxLocators,
    drainSignals, attachSignals, detachSignals, pageInfo, help, listLearnings, learnings,
  };
}

async function learnings(domain: string, tool?: string, args?: unknown): Promise<unknown> {
  const manifest = await loadManifest(domain);
  if (!tool) {
    return {
      nodeTools: Object.keys(manifest.nodeTools ?? {}),
      browserTools: Object.keys(manifest.browserTools ?? {}),
      notes: manifest.notes ?? [],
    };
  }
  const nodeDecl = manifest.nodeTools ? manifest.nodeTools[tool] : undefined;
  if (nodeDecl) {
    const fileUrl = pathToFileURL(join(LEARNINGS_DIR, domain, nodeDecl.path)).href;
    let mod: any;
    try { mod = await import(fileUrl); }
    catch (e) { throw new Error('learnings: cannot load ' + domain + '/' + nodeDecl.path + ': ' + (e as Error).message); }
    const fn = mod ? mod[nodeDecl.callable] : undefined;
    if (typeof fn !== 'function') {
      throw new Error('learnings: "' + tool + '" expected export "' + nodeDecl.callable + '" from ' + nodeDecl.path + '; found: ' + ((mod && Object.keys(mod).join(', ')) || '(none)'));
    }
    return await fn(ctxForTool(), args);
  }
  const brDecl = manifest.browserTools ? manifest.browserTools[tool] : undefined;
  if (brDecl) {
    const src = await readFile(join(LEARNINGS_DIR, domain, brDecl.path), 'utf8');
    const expr = '(async function(args){ ' + src + '; return typeof ' + brDecl.callable + ' === \'function\' ? await (' + brDecl.callable + ')(args) : ' + brDecl.callable + '; })(' + JSON.stringify(args ?? {}) + ')';
    const r = ((await sessionOrThrow().domains.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })) as any);
    if (r && r.exceptionDetails) {
      throw new Error('learnings browser tool "' + tool + '" failed: ' + (r.exceptionDetails.text ?? (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ?? ''));
    }
    return r && r.result ? r.result.value : undefined;
  }
  throw new Error('learnings: "' + tool + '" not declared in ' + domain + '/manifest.json (nodeTools: ' + (Object.keys(manifest.nodeTools ?? {}).join(', ') || 'none') + '; browserTools: ' + (Object.keys(manifest.browserTools ?? {}).join(', ') || 'none') + ').');
}

// --- help -----------------------------------------------------------------
const HELP: Record<string, string> = {
  axView: 'axView(nodes, opts?) -> string. Compress Accessibility.getFullAXTree nodes into a tree with [n] refs -> backendDOMNodeId. opts: { interactive?, refs?, maxDepth?, redactSensitive?, locators? }',
  axDiff: 'axDiff(prev, next) -> string. Structural diff of two axView strings; refs stripped before compare.',
  parseAxRefs: 'parseAxRefs(view) -> Map<refNumber, backendDOMNodeId>. From the trailing # refs -> backendDOMNodeId map.',
  parseAxLocators: 'parseAxLocators(view) -> Map<refNumber, locatorString>. Reads the loc=role:R["N"] field. Locators survive re-snapshots; resolve via axClick(locator).',
  axClick: 'axClick(ref, refs?) -> void. ref = number | "[n]" | role:button["Submit"]. Omit refs when ref is a locator.',
  axType: 'axType(ref, refs, text) -> void. Click-focus ref then Input.insertText. Pass null for refs if ref is a locator.',
  attachSignals: 'attachSignals(). Subscribe once and start buffering CDP signals (dialogs, downloads, navigation, crashes). Idempotent.',
  drainSignals: 'drainSignals() -> string[]. Drain+clear the buffer (auto-attaches on first call). React in priority order: dialog > crash > download > navigation > other.',
  detachSignals: 'detachSignals(). Stop buffering; clear dialog state.',
  pageInfo: 'pageInfo(opts?) -> {url,title,w,h,sx,sy,pw,ph} | {dialog:{type,message,...}} | {unresponsive:true, hint:string}. opts.timeoutMs default 2000. {dialog} when a modal blocks page JS; {unresponsive} if eval hung with no dialog.',
  help: 'help(name?) -> string. This. Call with no arg to list all helpers.',
  listPageTargets: 'listPageTargets() -> PageTarget[]. Filters chrome:// / devtools:// from Target.getTargets. Extension transport also fills index/windowId/groupId/pinned/muted/active.',
  ext: 'ext.* Chrome-extension commands (extension transport only): ext.group({tabIds}), ext.ungroup, ext.getTabGroups, ext.updateTabGroup, ext.moveTabGroup, ext.updateTab, ext.moveTabs, ext.discardTab, ext.reloadTab, ext.duplicateTab, ext.highlight, ext.getWindows, ext.createWindow, ext.updateWindow, ext.removeWindow. Also session.Browser.getWindowForTarget / getWindowBounds / setWindowBounds.',
  listLearnings: 'listLearnings() -> string[]. Domains under skills/cdp/learnings/.',
  learnings: 'learnings(domain, tool?, args?) -> any. learnings("site") -> {nodeTools, browserTools, notes}. learnings("site", "toolName", args) calls the registered node/browser tool; the tool function receives (ctx, args) where ctx carries session/cdp/axView/axClick/axType/listPageTargets/parseAxRefs/parseAxLocators/drainSignals/pageInfo/help.',
  attachTab: 'attachTab(match) -> {sessionId, targetId, url}. match = an uppercase hex targetId prefix (6-32 chars, only when a target actually starts with it) or a RegExp/substring against the tab URL, otherwise falls back to URL matching. Throws on zero or multiple matches. Never calls session.use.',
  evalFile: 'evalFile(sessionId, file, opts?) -> value | byteCount. Runs a local JS file via Runtime.evaluate on the explicit session, returnByValue+awaitPromise. The file is evaluated as-is (never wrapped): it must be an expression or script, typically (async()=>{ ... })(), since a top-level return is a page-side SyntaxError. opts: {timeoutMs=30000, userGesture=false, out}. Bounded by a REQUIRED timeout raced against the call, so a hung page cannot wedge the daemon. opts.out writes the result to a file (String(value) when JSON cannot serialize it, e.g. undefined) and returns its byte count instead of throwing.',
  waitForUrl: 'waitForUrl(sessionId, test, opts?) -> string. Polls location.href on the explicit session until test (RegExp or (url)=>boolean) passes. Each poll is itself bounded (min(intervalMs, time remaining), floored at 1000ms) so one hung poll cannot defeat the overall deadline. opts: {timeoutMs=300000, intervalMs=5000}. Throws on overall timeout. The "wait for the human to finish signing in" loop.',
  deepQuery: 'deepQuery(sessionId, selector, opts?) -> Array<{text,x,y,w,h,disabled,inViewport}>. Page-side walker crossing open shadow roots; visible matches only, center coords, text trimmed to 120 chars (falls back to aria-label), inViewport = center point inside innerWidth x innerHeight (not filtered on). opts: {text, timeoutMs=15000}. opts.text (RegExp or substring) filters by that text. Read-only.',
};

function help(name?: string): string {
  const names = Object.keys(HELP).sort();
  if (!name) return 'helpers: ' + names.join(', ');
  return HELP[name] ?? '(no help for "' + name + '". helpers: ' + names.join(', ') + ')';
}

export const extraHelpers = {
  parseLocator,
  isLocatorString,
  resolveLocator,
  attachSignals,
  drainSignals,
  detachSignals,
  pageInfo,
  help,
  listLearnings,
  learnings,
  attachTab,
  evalFile,
  waitForUrl,
  deepQuery,
  ctxForTool,
};
