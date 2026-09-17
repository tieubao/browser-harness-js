// Tests for the REPL scaffold-cutter helpers (attachTab, evalFile, waitForUrl,
// deepQuery) and the pageInfo timer fix, all added/changed in helpers.ts. Most
// read `globalThis.session` at call time, so tests fake it with a minimal
// object exposing just `_call` / `domains.Target.getTargets` / `domains.Runtime.evaluate`,
// no real browser, no real CDP wire.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extraHelpers } from './helpers.ts';

const { attachTab, evalFile, waitForUrl, deepQuery, pageInfo } = extraHelpers;

function withFakeSession<T>(fake: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const prev = g.session;
  g.session = fake;
  return fn().finally(() => { g.session = prev; });
}

// --- attachTab ---------------------------------------------------------

test('attachTab: matches by an uppercase targetId hex prefix', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 'ABC123DEF456', url: 'https://a.example' },
      { type: 'page', targetId: 'FEDCBA987654', url: 'https://b.example' },
    ] }) } },
    _call: async (method: string, params: any) => {
      assert.equal(method, 'Target.attachToTarget');
      assert.equal(params.targetId, 'ABC123DEF456');
      return { sessionId: 'sid-1' };
    },
  };
  const r = await withFakeSession(fake, () => attachTab('ABC123'));
  assert.deepEqual(r, { sessionId: 'sid-1', targetId: 'ABC123DEF456', url: 'https://a.example' });
});

test('attachTab: a lowercase hex URL fragment falls back to URL matching (target ids are uppercase)', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 'ABC123DEF456', url: 'https://deadbeef.example.com' },
      { type: 'page', targetId: 'FEDCBA987654', url: 'https://other.example.com' },
    ] }) } },
    _call: async (method: string, params: any) => {
      assert.equal(params.targetId, 'ABC123DEF456');
      return { sessionId: 'sid-lc' };
    },
  };
  const r = await withFakeSession(fake, () => attachTab('deadbeef'));
  assert.equal(r.targetId, 'ABC123DEF456');
});

test('attachTab: a digit-only fragment matching no target id falls back to URL matching', async () => {
  const fake = {
    domains: { Target: { getTargets: async () => ({ targetInfos: [
      { type: 'page', targetId: 'ABC123DEF456', url: 'https://a.example/202509' },
    ] }) } },
    _call: async () => ({ sessionId: 'sid-digit' }),
  };
  const r = await withFakeSession(fake, () => attachTab('202509'));
  assert.equal(r.targetId, 'ABC123DEF456');
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
// Fixtures below are valid expressions, never a top-level `return` (that is a
// page-side SyntaxError since evalFile does not wrap the file). The fakes
// below also reject any expression starting with "return" so a future
// regression that re-wraps the file (making `return` legal again) cannot
// pass these tests for the wrong reason.

function rejectTopLevelReturn(expression: string): void {
  if (/^\s*return\b/.test(expression)) {
    throw new Error('Uncaught SyntaxError: Illegal return statement');
  }
}

test('evalFile: returns the evaluated value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, '(() => 1 + 1)();');
  const fake = {
    _call: async (method: string, params: any) => {
      assert.equal(method, 'Runtime.evaluate');
      rejectTopLevelReturn(params.expression);
      assert.equal(params.expression, '(() => 1 + 1)();');
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
  writeFileSync(file, '(() => "hello")();');
  const fake = {
    _call: async (method: string, params: any) => {
      rejectTopLevelReturn(params.expression);
      return { result: { value: 'hello' } };
    },
  };
  try {
    const n = await withFakeSession(fake, () => evalFile('sid', file, { out }));
    assert.equal(n, Buffer.byteLength('hello', 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalFile: opts.out with an undefined result writes the literal text "undefined" instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-undef-'));
  const file = join(dir, 'snippet.js');
  const out = join(dir, 'result.txt');
  writeFileSync(file, '(() => { /* side effect only, no return value */ })();');
  // No `.value` on `.result` -- mirrors what CDP sends back for `undefined`.
  const fake = { _call: async () => ({ result: {} }) };
  try {
    const n = await withFakeSession(fake, () => evalFile('sid', file, { out }));
    assert.equal(n, Buffer.byteLength('undefined', 'utf8'));
    assert.equal(readFileSync(out, 'utf8'), 'undefined');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evalFile: surfaces exceptionDetails as a thrown Error with the page-side message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-exc-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, '(() => { throw new Error("boom"); })();');
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
  writeFileSync(file, '(() => { while (true) {} })();');
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

test('waitForUrl: a hung poll does not defeat the overall deadline (each poll is itself bounded)', async () => {
  const fake = {
    // every poll hangs -- without a per-poll bound this would never throw.
    _call: () => new Promise(() => {}),
  };
  const start = Date.now();
  await withFakeSession(fake, async () => {
    await assert.rejects(
      () => waitForUrl('sid', /\/dashboard$/, { timeoutMs: 1500, intervalMs: 100 }),
      /timed out after 1500ms/,
    );
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, `waitForUrl took ${elapsed}ms, expected to give up near the 1500ms deadline (plus the 1000ms poll floor)`);
});

// --- deepQuery -------------------------------------------------------------

test('deepQuery: parses the page-side result and applies the opts.text filter', async () => {
  const items = [
    { text: 'Submit', x: 10, y: 20, w: 30, h: 40, disabled: false, inViewport: true },
    { text: 'Cancel', x: 50, y: 60, w: 70, h: 80, disabled: true, inViewport: true },
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

test('deepQuery: passes the inViewport field through', async () => {
  const items = [
    { text: 'Visible', x: 10, y: 20, w: 30, h: 40, disabled: false, inViewport: true },
    { text: 'Offscreen', x: 9999, y: 9999, w: 30, h: 40, disabled: false, inViewport: false },
  ];
  const fake = { _call: async () => ({ result: { value: JSON.stringify(items) } }) };
  const all = await withFakeSession(fake, () => deepQuery('sid', 'button'));
  assert.equal(all[0]?.inViewport, true);
  assert.equal(all[1]?.inViewport, false);
});

test('deepQuery: a hung evaluate rejects within its own timeout bound', async () => {
  const fake = { _call: () => new Promise(() => {}) };
  const start = Date.now();
  await withFakeSession(fake, async () => {
    await assert.rejects(() => deepQuery('sid', 'button', { timeoutMs: 60 }), /timed out after 60ms/);
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `deepQuery took ${elapsed}ms, expected to reject near the 60ms bound`);
});

// --- timer hygiene: a SUCCESSFUL call must leave no pending race timer -----
// Run as a real child process with no process.exit() call: Node only exits
// once its event loop is empty, so an uncleared setTimeout keeps the process
// alive until that timer fires. Asserting the child exits promptly is a
// black-box proof that the race timer was cleared, exactly how the
// independent verifier caught the original evalFile bug (a clean run stayed
// alive 30.07s because the timer at the old line 261 was never cleared).

const HELPERS_URL = new URL('./helpers.ts', import.meta.url).href;

function runChild(script: string, timeoutMs = 3000): { ms: number; timedOut: boolean } {
  const start = Date.now();
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: timeoutMs, stdio: 'pipe' });
    return { ms: Date.now() - start, timedOut: false };
  } catch (e: any) {
    return { ms: Date.now() - start, timedOut: e?.killed === true || e?.signal != null };
  }
}

test('evalFile: a successful call leaves no pending race timer (process exits promptly)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-evalfile-timercheck-'));
  const file = join(dir, 'snippet.js');
  writeFileSync(file, '(() => 1)();');
  try {
    const script = `
      globalThis.session = { _call: async () => ({ result: { value: 1 } }) };
      const { extraHelpers } = await import(${JSON.stringify(HELPERS_URL)});
      const v = await extraHelpers.evalFile('sid', ${JSON.stringify(file)});
      if (v !== 1) throw new Error('bad value ' + v);
    `;
    const { ms, timedOut } = runChild(script);
    assert.equal(timedOut, false);
    assert.ok(ms < 2000, `evalFile child took ${ms}ms, expected the process to exit promptly`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForUrl: a successful call leaves no pending race timer (process exits promptly)', () => {
  const script = `
    globalThis.session = { _call: async () => ({ result: { value: 'https://example.com/dashboard' } }) };
    const { extraHelpers } = await import(${JSON.stringify(HELPERS_URL)});
    const v = await extraHelpers.waitForUrl('sid', /dashboard$/, { intervalMs: 10 });
    if (v !== 'https://example.com/dashboard') throw new Error('bad url ' + v);
  `;
  const { ms, timedOut } = runChild(script);
  assert.equal(timedOut, false);
  assert.ok(ms < 2000, `waitForUrl child took ${ms}ms, expected the process to exit promptly`);
});

test('deepQuery: a successful call leaves no pending race timer (process exits promptly)', () => {
  const script = `
    globalThis.session = { _call: async () => ({ result: { value: '[]' } }) };
    const { extraHelpers } = await import(${JSON.stringify(HELPERS_URL)});
    await extraHelpers.deepQuery('sid', 'button');
  `;
  const { ms, timedOut } = runChild(script);
  assert.equal(timedOut, false);
  assert.ok(ms < 2000, `deepQuery child took ${ms}ms, expected the process to exit promptly`);
});

test('pageInfo: a successful call leaves no pending race timer (process exits promptly)', () => {
  const script = `
    globalThis.session = { domains: { Runtime: { evaluate: async () => ({ result: { value: JSON.stringify({url:'https://x',title:'t',w:1,h:1,sx:0,sy:0,pw:1,ph:1}) } }) } } };
    const { extraHelpers } = await import(${JSON.stringify(HELPERS_URL)});
    await extraHelpers.pageInfo();
  `;
  const { ms, timedOut } = runChild(script);
  assert.equal(timedOut, false);
  assert.ok(ms < 2000, `pageInfo child took ${ms}ms, expected the process to exit promptly`);
});
