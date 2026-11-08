/**
 * One-call DOM snapshot view: the page-side alternative to `axView`.
 *
 * `domView` runs ONE `Runtime.evaluate` that reads the visible controls (role,
 * accessible name, value, state) and, on request, the visible text, then renders
 * them as a numbered `[n] role "name" ="value"` table. The live elements stay in
 * `window.__domView.refs` inside the page, so `domClick(n)` / `domType(n, text)`
 * resolve the ref to the real node, hit-test it, and click its center with
 * trusted `Input.dispatchMouseEvent`. No `getFullAXTree`, no ref-to-backendNodeId
 * map to ship back to the model.
 *
 * The in-page reader is ported from browser-use/jev-ultrafast `snapshot.js`
 * (upstream commit 8251e2723980), MIT License, Copyright (c) 2026 Browser Use.
 * Kept: the visibility test, accessible-name resolution, role/selector tables,
 * the viewport filter, and the visible-text walker. Dropped: the stale-page
 * guards (`pageKey`, `guard`, `marker`), the persistent id cache, and the
 * per-option `select` actions, which cost an `innerText` read per control and
 * are not needed when the model re-snapshots after each action. Added: password
 * redaction, state flags, an optional full-page mode.
 *
 * Pure apart from the `DomViewDriver` it is handed, so it unit-tests offline.
 * Injected as `domView` / `domClick` / `domType` in the REPL (see `repl.ts`).
 * For when to pick it over `axView`, see `interaction-skills/snapshot.md`.
 */

export type DomViewOptions = {
  /** Only controls whose center is inside the viewport. Default true (upstream behavior). */
  viewport?: boolean;
  /** Append the visible text (viewport only, capped at 6000 chars). Default false. */
  text?: boolean;
  /** Max controls listed. Default 250. */
  max?: number;
  /** Redact password-ish values (`="[redacted]"`). Default true. */
  redactSensitive?: boolean;
};

export type DomAction = {
  role: string;
  name: string;
  value: string;
  flags: string[];
  redacted: boolean;
};

export type DomSnapshot = {
  url: string;
  title: string;
  w: number;
  h: number;
  scrollY: number;
  height: number;
  actions: DomAction[];
  omitted: number;
  text: string;
};

/** The minimal CDP surface domView needs; repl.ts binds it to the live session. */
export type DomViewDriver = {
  evaluate: (expression: string) => Promise<any>;
  mouse: (type: 'mousePressed' | 'mouseReleased', x: number, y: number) => Promise<void>;
  insertText: (text: string) => Promise<void>;
};

/**
 * In-page reader. Takes one options object, returns a DomSnapshot or null when
 * there is no body yet. Stores the live elements, in ref order, on
 * `window.__domView.refs`. String.raw keeps the regex backslashes literal.
 */
export const DOM_SNAPSHOT_SRC = String.raw`(opts => {
  if (!document.body) return null;
  const SENS = /\b(password|passwd|passcode|pin|secret|token|ssn|cvv|cvc|card\s*number|account\s*number)\b/i;
  const redact = opts.redactSensitive !== false, vp = opts.viewport !== false;
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l => name(l, seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' ? '' : [...e.childNodes].map(n => n.nodeType === 3 ? n.textContent :
        n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map(r => '[role="' + r + '"]').join(',');
  const role = e => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text','email','url','tel','password'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const refs = [], actions = [];
  let omitted = 0;
  for (const e of document.querySelectorAll(selector)) {
    if (['file','hidden'].includes(e.type) || !visible(e) || e.matches(':disabled') ||
        e.closest('[aria-disabled="true"]')) continue;
    const rname = role(e), r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
    if (!rname || r.width <= 0 || r.height <= 0) continue;
    if (vp && (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    if (actions.length >= (opts.max || 250)) { omitted++; continue; }
    const label = name(e).replace(/\s+/g, ' ').trim();
    const flags = [];
    if (e === document.activeElement) flags.push('focused');
    for (const key of ['checked','selected','expanded','pressed']) {
      const v = e.getAttribute('aria-' + key);
      if (v === 'true' || (v === 'mixed' && key === 'checked')) flags.push(v === 'mixed' ? 'mixed' : key);
    }
    if (['checkbox','radio'].includes(e.type) && e.checked && !flags.includes('checked')) flags.push('checked');
    let value = '';
    if (e.tagName === 'SELECT') value = [...e.selectedOptions].map(o => o.label).join(', ');
    else if (e.tagName === 'INPUT' && !['button','submit','reset','image','checkbox','radio'].includes(e.type)) value = e.value;
    else if (e.tagName === 'TEXTAREA') value = e.value;
    else if (e.isContentEditable || (rname === 'combobox' && e.tagName !== 'INPUT')) value = e.innerText.trim();
    const sensitive = redact && (e.type === 'password' ||
      (['textbox','searchbox','spinbutton'].includes(rname) && SENS.test(label + ' ' + (e.getAttribute('autocomplete')||''))));
    refs.push(e);
    actions.push({role: rname, name: label, value: sensitive ? '' : value.slice(0, 40), flags,
      redacted: sensitive});
  }
  let text = '';
  if (opts.text) {
    const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange(); let node, length = 0;
    while ((node = walker.nextNode()) && length < 6000) {
      const v = node.textContent.trim(), parent = node.parentElement;
      if (!v || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node); const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(v); length += v.length;
      }
    }
    text = words.join('\n').slice(0, 6000);
  }
  window.__domView = {refs};
  return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY),
    height: document.documentElement.scrollHeight, actions, omitted, text};
})`;

export function buildSnapshotExpr(opts: DomViewOptions = {}): string {
  return `${DOM_SNAPSHOT_SRC}(${JSON.stringify(opts)})`;
}

/**
 * Resolve ref -> live node, bring it into view, hit-test its center. Returns
 * `{x,y}` or `{error}`. `fill` also focuses and selects existing content.
 */
export function buildResolveExpr(ref: number, fill = false): string {
  return String.raw`((ref, fill) => {
    const e = window.__domView && window.__domView.refs[ref - 1];
    if (!e) return {error: 'unknown ref ' + ref + ': run domView first'};
    if (!e.isConnected) return {error: 'stale ref ' + ref + ': node left the page, run domView again'};
    e.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
    if (!r.width || !r.height) return {error: 'ref ' + ref + ' has no box'};
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(e.contains(hit) || hit.contains(e))) {
      return {error: 'ref ' + ref + ' is covered by <' + (hit ? hit.tagName.toLowerCase() : 'nothing') + '>'};
    }
    return {x, y};
  })(${ref}, ${fill})`;
}

const SELECT_ACTIVE_EXPR = String.raw`(() => {
  const a = document.activeElement;
  if (a && typeof a.select === 'function') a.select();
  else if (a && a.isContentEditable) getSelection().selectAllChildren(a);
})()`;

function fmt(a: DomAction, n: number): string {
  let line = `[${n}] ${a.role}`;
  const nm = a.name.length > 120 ? a.name.slice(0, 117) + '...' : a.name;
  if (nm) line += ` "${nm}"`;
  if (a.flags.length) line += ` <${a.flags.join(' ')}>`;
  if (a.redacted) line += ' ="[redacted]"';
  else if (a.value) line += ` ="${a.value}"`;
  return line;
}

/** Render a snapshot as the numbered table (pure). */
export function formatDomView(snap: DomSnapshot): string {
  const out = [
    `# ${snap.url} "${snap.title}" viewport ${snap.w}x${snap.h} scroll ${snap.scrollY}/${snap.height}`,
    ...snap.actions.map((a, i) => fmt(a, i + 1)),
  ];
  if (snap.omitted > 0) out.push(`# ${snap.omitted} more controls omitted (raise max, or scope the page)`);
  if (snap.text) out.push('', '# text', snap.text);
  return out.join('\n');
}

/** Take the snapshot and render it. Throws if the document has no body yet. */
export async function runDomView(driver: DomViewDriver, opts: DomViewOptions = {}): Promise<string> {
  const snap = (await driver.evaluate(buildSnapshotExpr(opts))) as DomSnapshot | null;
  if (!snap) throw new Error('domView: document has no body yet (navigating?), retry after load');
  return formatDomView(snap);
}

function parseRef(ref: number | string): number {
  const n = typeof ref === 'string' ? Number(ref.replace(/\[|\]/g, '')) : ref;
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid dom ref: ${ref}`);
  return n;
}

async function resolve(driver: DomViewDriver, ref: number | string, fill: boolean) {
  const r = (await driver.evaluate(buildResolveExpr(parseRef(ref), fill))) as { x?: number; y?: number; error?: string };
  if (!r || r.error || r.x == null || r.y == null) throw new Error(`domClick: ${r?.error ?? 'could not resolve ref'}`);
  return { x: r.x, y: r.y };
}

/** Click the center of a domView ref with trusted mouse events. */
export async function runDomClick(driver: DomViewDriver, ref: number | string): Promise<void> {
  const { x, y } = await resolve(driver, ref, false);
  await driver.mouse('mousePressed', x, y);
  await driver.mouse('mouseReleased', x, y);
}

/** Click-focus a domView ref, select its current content, then insert text. */
export async function runDomType(driver: DomViewDriver, ref: number | string, text: string): Promise<void> {
  await runDomClick(driver, ref);
  await driver.evaluate(SELECT_ACTIVE_EXPR);
  await driver.insertText(text);
}
