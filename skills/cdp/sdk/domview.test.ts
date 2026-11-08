import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import {
  DOM_SNAPSHOT_SRC,
  buildResolveExpr,
  buildSnapshotExpr,
  formatDomView,
  runDomClick,
  runDomType,
  runDomView,
  type DomSnapshot,
  type DomViewDriver,
} from './domview.ts';

const SNAP: DomSnapshot = {
  url: 'https://example.test/',
  title: 'Example',
  w: 1280,
  h: 800,
  scrollY: 0,
  height: 3000,
  omitted: 0,
  text: '',
  actions: [
    { role: 'link', name: 'Donate', value: '', flags: [], redacted: false },
    { role: 'searchbox', name: 'Search', value: 'cats', flags: ['focused'], redacted: false },
    { role: 'checkbox', name: 'Nonstop only', value: '', flags: ['checked'], redacted: false },
    { role: 'textbox', name: 'Password', value: '', flags: [], redacted: true },
    { role: 'button', name: '', value: '', flags: [], redacted: false },
  ],
};

test('formatDomView renders a numbered [n] role "name" ="value" table', () => {
  const view = formatDomView(SNAP);
  const lines = view.split('\n');
  assert.equal(lines[0], '# https://example.test/ "Example" viewport 1280x800 scroll 0/3000');
  assert.equal(lines[1], '[1] link "Donate"');
  assert.equal(lines[2], '[2] searchbox "Search" <focused> ="cats"');
  assert.equal(lines[3], '[3] checkbox "Nonstop only" <checked>');
  assert.equal(lines[5], '[5] button');
});

test('password-ish values render as [redacted], never the raw value', () => {
  const view = formatDomView(SNAP);
  assert.match(view, /\[4\] textbox "Password" ="\[redacted\]"/);
  // Even if a value slipped through, a redacted action must not print it.
  const leaked = { ...SNAP, actions: [{ ...SNAP.actions[3]!, value: 'hunter2' }] };
  assert.doesNotMatch(formatDomView(leaked), /hunter2/);
});

test('omitted controls and visible text are reported', () => {
  const view = formatDomView({ ...SNAP, omitted: 12, text: 'Hello\nWorld' });
  assert.match(view, /# 12 more controls omitted/);
  assert.match(view, /# text\nHello\nWorld$/);
});

test('long names are capped', () => {
  const name = 'x'.repeat(300);
  const view = formatDomView({ ...SNAP, actions: [{ role: 'link', name, value: '', flags: [], redacted: false }] });
  assert.ok(view.split('\n')[1]!.length < 140);
  assert.match(view, /\.\.\."$/);
});

test('in-page source and expressions compile (parse only, never run here)', () => {
  assert.doesNotThrow(() => new Script(DOM_SNAPSHOT_SRC));
  assert.doesNotThrow(() => new Script(buildSnapshotExpr({ text: true, viewport: false })));
  assert.doesNotThrow(() => new Script(buildResolveExpr(3, true)));
  assert.match(buildSnapshotExpr({ max: 5 }), /\{"max":5\}\)$/);
});

test('upstream attribution is kept in the module header', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./domview.ts', import.meta.url), 'utf8');
  assert.match(src, /browser-use\/jev-ultrafast/);
  assert.match(src, /8251e2723980/);
  assert.match(src, /MIT License/);
});

function fakeDriver(evalResults: unknown[]) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const queue = [...evalResults];
  const driver: DomViewDriver = {
    evaluate: async (expression) => {
      calls.push({ kind: 'evaluate', args: [expression] });
      return queue.shift();
    },
    mouse: async (type, x, y) => { calls.push({ kind: 'mouse', args: [type, x, y] }); },
    insertText: async (text) => { calls.push({ kind: 'insertText', args: [text] }); },
  };
  return { driver, calls };
}

test('runDomView evaluates one expression and formats the result', async () => {
  const { driver, calls } = fakeDriver([SNAP]);
  const view = await runDomView(driver, { text: false });
  assert.equal(calls.length, 1);
  assert.match(view, /\[1\] link "Donate"/);
});

test('runDomView throws a clear error when the page has no body', async () => {
  const { driver } = fakeDriver([null]);
  await assert.rejects(() => runDomView(driver), /no body yet/);
});

test('runDomClick resolves the ref in-page, then presses and releases at the returned point', async () => {
  const { driver, calls } = fakeDriver([{ x: 10, y: 20 }]);
  await runDomClick(driver, '[7]');
  assert.match(calls[0]!.args[0] as string, /\)\(7, false\)$/);
  assert.deepEqual(calls.slice(1).map((c) => c.args), [['mousePressed', 10, 20], ['mouseReleased', 10, 20]]);
});

test('runDomClick surfaces stale and covered refs and sends no mouse events', async () => {
  const { driver, calls } = fakeDriver([{ error: 'stale ref 2: node left the page, run domView again' }]);
  await assert.rejects(() => runDomClick(driver, 2), /stale ref 2/);
  assert.equal(calls.filter((c) => c.kind === 'mouse').length, 0);
});

test('invalid refs are rejected before any CDP call', async () => {
  const { driver, calls } = fakeDriver([]);
  await assert.rejects(() => runDomClick(driver, 'abc'), /Invalid dom ref/);
  await assert.rejects(() => runDomClick(driver, 0), /Invalid dom ref/);
  assert.equal(calls.length, 0);
});

test('runDomType clicks, selects existing content, then inserts text', async () => {
  const { driver, calls } = fakeDriver([{ x: 5, y: 6 }, undefined]);
  await runDomType(driver, 3, 'hello');
  assert.deepEqual(calls.map((c) => c.kind), ['evaluate', 'mouse', 'mouse', 'evaluate', 'insertText']);
  assert.deepEqual(calls[4]!.args, ['hello']);
  assert.match(calls[3]!.args[0] as string, /select/);
});
