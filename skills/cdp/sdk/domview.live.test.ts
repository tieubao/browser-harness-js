import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { runDomClick, runDomType, runDomView, type DomViewDriver } from './domview.ts';
import { settleInitialNavigation } from './page.ts';
import { Session } from './session.ts';

// Real headless browser against a local fixture: the in-page reader, the
// ref -> live node -> trusted click path, and password redaction. Skips when
// no Chromium-family binary is installed. Own profile, own port, never the
// user's running browser.

const PAGE = `<!doctype html><html><head><title>Fixture</title>
<style>body{font:14px sans-serif;margin:16px} button{display:block;margin:6px 0}</style></head><body>
<a href="/next">Go next</a>
<label for="q">Search things</label><input id="q" type="search" value="old">
<label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret">
<button id="b" disabled>Disabled one</button>
<button id="hid" style="display:none">Hidden one</button>
<div aria-hidden="true"><button>Aria hidden one</button></div>
<input type="checkbox" id="c" aria-label="Nonstop only" checked>
<button onclick="document.title='clicked'">Press me</button>
<div style="height:3000px"></div>
<a href="/far">Far below</a>
</body></html>`;

const SHADOW_PAGE = `<!doctype html><html><head><title>Shadow fixture</title></head><body>
<p>light dom</p><button id="light">Light button</button>
<div id="host"></div>
<div id="nested"></div>
<select aria-label="Language"><option>English</option><option>French</option><option>German</option></select>
<select aria-label="Many">${Array.from({ length: 25 }, (_, i) => '<option>Opt ' + (i + 1) + '</option>').join('')}</select>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<style>button{display:block}</style>' +
  '<button id="sb" onclick="">Shadow press</button>' +
  '<label for="si">Shadow field</label><input id="si" type="text">' +
  '<span id="lbl">Labelled by id</span><button aria-labelledby="lbl">x</button>';
root.getElementById('sb').addEventListener('click', () => { document.title = 'shadow clicked'; });
const inner = document.getElementById('nested').attachShadow({ mode: 'open' });
inner.innerHTML = '<div id="deep"></div>';
inner.getElementById('deep').attachShadow({ mode: 'open' }).innerHTML = '<button>Deeply nested</button>';
const closed = document.createElement('div');
closed.attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed root button</button>';
document.body.appendChild(closed);
</script>
</body></html>`;

function browserPath(): string | undefined {
  return [
    process.env.CHROME_PATH,
    '/Applications/Helium.app/Contents/MacOS/Helium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => p && existsSync(p));
}

let proc: ChildProcess | undefined;
let server: Server | undefined;
let profile: string | undefined;
let wsUrl = '';
let origin = '';

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/next' ? '<title>Next page</title><p>arrived</p>'
      : req.url === '/far' ? '<title>Far page</title><p>far</p>'
      : req.url === '/shadow' ? SHADOW_PAGE : PAGE);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = browserPath();
  if (!path) return;
  profile = mkdtempSync(join(tmpdir(), 'domview-live-'));
  proc = spawn(path, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Headless Helium writes no DevToolsActivePort; read the ws URL it prints on stderr.
  let err = '';
  proc.stderr!.on('data', (c) => { err += c; });
  for (let i = 0; i < 100 && !/DevTools listening on (ws:\S+)/.test(err); i++) await new Promise((r) => setTimeout(r, 100));
  wsUrl = /DevTools listening on (ws:\S+)/.exec(err)?.[1] ?? '';
});

after(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc!.once('exit', r));
    proc.kill();
    await exited;
  }
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function open(path = '/') {
  const session = new Session();
  await session.connect({ wsUrl });
  const { targetId } = await session.domains.Target.createTarget({ url: `${origin}${path}` }) as { targetId: string };
  const { sessionId } = await session.domains.Target.attachToTarget({ targetId, flatten: true }) as { sessionId: string };
  const call = (method: string, params: unknown = {}) => session._call(method, params, { sessionId }) as Promise<any>;
  await call('Page.enable');
  // createTarget returns before the navigation commits; wait for the real document, not Helium's interim about:blank.
  await settleInitialNavigation(session, sessionId, { expectOrigin: origin });
  const driver: DomViewDriver = {
    evaluate: async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true })).result?.value,
    mouse: async (type, x, y) => { await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); },
    insertText: async (text) => { await call('Input.insertText', { text }); },
  };
  const title = async () => (await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value as string;
  const close = async () => {
    await session.domains.Target.closeTarget({ targetId }).catch(() => {});
    session.close();
  };
  return { driver, title, close, call };
}

// Evaluated inside each test: `before` has not run yet when tests are declared.
const noBrowser = () => !browserPath() || !wsUrl;

test('snapshot lists visible enabled controls only, redacts the password', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open();
  try {
    const view = await runDomView(t.driver);
    assert.match(view, /\] link "Go next"/);
    assert.match(view, /\] searchbox "Search things" ="old"/);
    assert.match(view, /\] textbox "Password" ="\[redacted\]"/);
    assert.doesNotMatch(view, /hunter2/);
    assert.match(view, /\] checkbox "Nonstop only" <checked>/);
    assert.match(view, /\] button "Press me"/);
    assert.doesNotMatch(view, /Disabled one|Hidden one|Aria hidden one/);
    assert.doesNotMatch(view, /Far below/, 'viewport mode skips offscreen controls');
  } finally { await t.close(); }
});

test('viewport:false includes offscreen controls; text:true appends visible text', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open();
  try {
    assert.match(await runDomView(t.driver, { viewport: false }), /\] link "Far below"/);
    assert.match(await runDomView(t.driver, { text: true }), /# text\n[\s\S]*Go next/);
  } finally { await t.close(); }
});

test('domClick follows a link with a trusted click', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open();
  try {
    const view = await runDomView(t.driver);
    const ref = Number(/\[(\d+)\] link "Go next"/.exec(view)![1]);
    await runDomClick(t.driver, ref);
    for (let i = 0; i < 50 && (await t.title()) !== 'Next page'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await t.title(), 'Next page');
  } finally { await t.close(); }
});

test('domClick scrolls an offscreen ref into view; stale ref after navigation is an error', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open();
  try {
    const view = await runDomView(t.driver, { viewport: false });
    const far = Number(/\[(\d+)\] link "Far below"/.exec(view)![1]);
    await runDomClick(t.driver, far);
    for (let i = 0; i < 50 && (await t.title()) !== 'Far page'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await t.title(), 'Far page');
    await assert.rejects(() => runDomClick(t.driver, far), /unknown ref|stale ref/);
  } finally { await t.close(); }
});

test('domType replaces existing input content', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open();
  try {
    const view = await runDomView(t.driver);
    const ref = Number(/\[(\d+)\] searchbox/.exec(view)![1]);
    await runDomType(t.driver, ref, 'new text');
    assert.match(await runDomView(t.driver), /searchbox "Search things" <focused> ="new text"/);
  } finally { await t.close(); }
});

test('open shadow roots: domView lists controls, names resolve inside the root, closed roots stay hidden', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open('/shadow');
  try {
    const view = await runDomView(t.driver);
    assert.match(view, /\] button "Light button"/);
    assert.match(view, /\] button "Shadow press"/);
    assert.match(view, /\] textbox "Shadow field"/, 'label resolved through getRootNode');
    assert.match(view, /\] button "Labelled by id"/, 'aria-labelledby resolved in the same root');
    assert.match(view, /\] button "Deeply nested"/, 'nested shadow roots');
    assert.doesNotMatch(view, /Closed root button/, 'closed roots are unreachable');
  } finally { await t.close(); }
});

test('domClick clicks a button inside an open shadow root; domType fills its input', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open('/shadow');
  try {
    const view = await runDomView(t.driver);
    const btn = Number(/\[(\d+)\] button "Shadow press"/.exec(view)![1]);
    await runDomClick(t.driver, btn);
    for (let i = 0; i < 50 && (await t.title()) !== 'shadow clicked'; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await t.title(), 'shadow clicked');

    const field = Number(/\[(\d+)\] textbox "Shadow field"/.exec(view)![1]);
    await runDomType(t.driver, field, 'typed in shadow');
    assert.match(await runDomView(t.driver), /textbox "Shadow field" <focused> ="typed in shadow"/);
  } finally { await t.close(); }
});

test('options:true lists select option labels (cap 20, then +N more); default off', async (ctx) => {
  if (noBrowser()) return ctx.skip('no Chromium-family browser available');
  const t = await open('/shadow');
  try {
    const off = await runDomView(t.driver);
    assert.match(off, /combobox "Language" ="English"$/m);
    assert.doesNotMatch(off, /options:/);
    const on = await runDomView(t.driver, { options: true });
    assert.match(on, /combobox "Language" ="English" options: "English" \| "French" \| "German"$/m);
    assert.match(on, /combobox "Many" ="Opt 1" options: "Opt 1" \|.*"Opt 20" \| \+5 more$/m);
    assert.doesNotMatch(on, /Opt 21/);
  } finally { await t.close(); }
});
