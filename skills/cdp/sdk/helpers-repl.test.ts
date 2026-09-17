// Tests for the REPL scaffold-cutter helpers (attachTab, evalFile, waitForUrl,
// deepQuery) added in helpers.ts. All four read `globalThis.session` at call
// time, so tests fake it with a minimal object exposing just `_call` and
// `domains.Target.getTargets` -- no real browser, no real CDP wire.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extraHelpers } from './helpers.ts';

const { attachTab, evalFile, waitForUrl, deepQuery } = extraHelpers;

function withFakeSession<T>(fake: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const prev = g.session;
  g.session = fake;
  return fn().finally(() => { g.session = prev; });
}

// --- attachTab ---------------------------------------------------------

test('attachTab: matches by targetId hex prefix', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 'abc123def456', url: 'https://a.example' },
      { type: 'page', targetId: 'fedcba987654', url: 'https://b.example' },
    ] }) } },
    _call: async (method: string, params: any) => {
      assert.equal(method, 'Target.attachToTarget');
      assert.equal(params.targetId, 'abc123def456');
      return { sessionId: 'sid-1' };
    },
  };
  const r = await withFakeSession(fake, () => attachTab('abc123'));
  assert.deepEqual(r, { sessionId: 'sid-1', targetId: 'abc123def456', url: 'https://a.example' });
});

test('attachTab: matches by URL substring', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 't1', url: 'https://mail.example.com/inbox' },
      { type: 'page', targetId: 't2', url: 'https://docs.example.com' },
    ] }) } },
    _call: async () => ({ sessionId: 'sid-2' }),
  };
  const r = await withFakeSession(fake, () => attachTab('mail.example'));
  assert.equal(r.targetId, 't1');
});

test('attachTab: matches by RegExp against URL', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 't1', url: 'https://app.example.com/settings' },
    ] }) } },
    _call: async () => ({ sessionId: 'sid-3' }),
  };
  const r = await withFakeSession(fake, () => attachTab(/\/settings$/));
  assert.equal(r.targetId, 't1');
});

test('attachTab: zero matches throws', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 't1', url: 'https://a.example' },
    ] }) } },
    _call: async () => { throw new Error('must not attach on zero matches'); },
  };
  await withFakeSession(fake, async () => {
    await assert.rejects(() => attachTab('nowhere.example'), /no page target matched/);
  });
});

test('attachTab: multiple matches throws', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 't1', url: 'https://a.example/one' },
      { type: 'page', targetId: 't2', url: 'https://a.example/two' },
    ] }) } },
    _call: async () => { throw new Error('must not attach on multiple matches'); },
  };
  await withFakeSession(fake, async () => {
    await assert.rejects(() => attachTab('a.example'), /2 page targets matched/);
  });
});

// --- evalFile ------------------------------------------------------------

test('evalFile: returns the evaluated value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, 'return 1 + 1;');
  const fake = {
    _call: async (method: string, params: any) => {
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(params.expression, 'return 1 + 1;');
      assert.equal(params.returnByValue, true);
      assert.equal(params.awaitPromise, true);
      assert.equal(params.userGesture, false);
      return { result: { value: 2 } };
    },
  };
  try {
    const v = await withFakeSession(fake, () => evalFile('sid', file));
    assert.equal(v, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalFile: writes to opts.out and returns byte count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-out-'));
  const file = join(dir, 'snippet.js');
  const out = join(dir, 'result.txt');
  writeFileSync(file, 'return "hello";');
  const fake = { _call: async () => ({ result: { value: 'hello' } }) };
  try {
    const n = await withFakeSession(fake, () => evalFile('sid', file, { out }));
    assert.equal(n, Buffer.byteLength('hello', 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalFile: surfaces exceptionDetails as a thrown Error with the page-side message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-exc-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, 'throw new Error("boom");');
  const fake = {
    _call: async () => ({ exceptionDetails: { text: 'Uncaught Error: boom' } }),
  };
  try {
    await withFakeSession(fake, async () => {
      await assert.rejects(() => evalFile('sid', file), /boom/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalFile: a hung evaluate rejects within the timeout bound instead of hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-timeout-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, 'while(true){}');
  const fake = {
    // never resolves -- simulates a wedged page-side eval.
    _call: () => new Promise(() => {}),
  };
  const start = Date.now();
  try {
    await withFakeSession(fake, async () => {
      await assert.rejects(() => evalFile('sid', file, { timeoutMs: 50 }), /timed out after 50ms/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `evalFile took ${elapsed}ms, expected to reject near the 50ms bound`);
});

// --- waitForUrl ------------------------------------------------------------

test('waitForUrl: resolves once the polled URL matches', async () => {
  let calls = 0;
  const urls = ['https://example.com/login', 'https://example.com/login', 'https://example.com/dashboard'];
  const fake = {
    _call: async () => ({ result: { value: urls[calls++] } }),
  };
  const url = await withFakeSession(fake, () => waitForUrl('sid', /\/dashboard$/, { intervalMs: 1 }));
  assert.equal(url, 'https://example.com/dashboard');
});

test('waitForUrl: times out when the URL never matches', async () => {
  const fake = {
    _call: async () => ({ result: { value: 'https://example.com/login' } }),
  };
  await withFakeSession(fake, async () => {
    await assert.rejects(
      () => waitForUrl('sid', /\/dashboard$/, { timeoutMs: 30, intervalMs: 5 }),
      /timed out after 30ms/,
    );
  });
});

// --- deepQuery -------------------------------------------------------------

test('deepQuery: parses the page-side result and applies the opts.text filter', async () => {
  const items = [
    { text: 'Submit', x: 10, y: 20, w: 30, h: 40, disabled: false },
    { text: 'Cancel', x: 50, y: 60, w: 70, h: 80, disabled: true },
  ];
  const fake = {
    _call: async (method: string, params: any) => {
      assert.equal(method, 'Runtime.evaluate');
      assert.match(params.expression, /querySelectorAll/);
      return { result: { value: JSON.stringify(items) } };
    },
  };
  const all = await withFakeSession(fake, () => deepQuery('sid', 'button'));
  assert.equal(all.length, 2);
  const filtered = await withFakeSession(fake, () => deepQuery('sid', 'button', { text: 'Sub' }));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.text, 'Submit');
});
