// Offline tests for the findPage liveness probe: hung background tabs are skipped (or woken once),
// never attached. Fake `browser.session._call`; hung tabs never answer Runtime.evaluate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extraHelpers, tabAnswers } from './helpers.ts';

const { buildToolCtx } = extraHelpers;
const MS = 20;

type Mode = 'live' | 'hung' | 'wakeable';

function fakeEnv(tabs: Array<{ targetId: string; url: string; mode: Mode }>) {
  const calls: string[] = [];
  const attachedPages: string[] = [];
  const awake = new Set<string>();
  const detached: string[] = [];
  const session = {
    _call: (method: string, params: any, opts?: { sessionId?: string }) => {
      calls.push(method + (opts?.sessionId ? '@' + opts.sessionId : ''));
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'S-' + params.targetId });
      if (method === 'Target.detachFromTarget') { detached.push(params.sessionId); return Promise.resolve({}); }
      const id = String(opts?.sessionId).slice(2);
      const mode = tabs.find(t => t.targetId === id)!.mode;
      if (method === 'Emulation.setFocusEmulationEnabled') { if (mode === 'wakeable') awake.add(id); return Promise.resolve({}); }
      if (method === 'Runtime.evaluate') return mode === 'live' || awake.has(id) ? Promise.resolve({ result: { value: 1 } }) : new Promise(() => {});
      return Promise.resolve({});
    },
  };
  const browser = {
    session,
    tabs: async () => tabs.map(({ targetId, url }) => ({ targetId, url })),
    attach: async (targetId: string, options: { allowedOrigins: string[] }) => {
      attachedPages.push(targetId);
      const page = { targetId, allowedOrigins: options.allowedOrigins, disposed: false, dispose() { page.disposed = true; }, cdp: async () => ({}) };
      return page;
    },
  };
  return { browser, calls, attachedPages, detached };
}

async function withBrowser<T>(browser: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const prev = { browser: g.browser, session: g.session };
  g.browser = browser; g.session = undefined;
  try { return await fn(); } finally { g.browser = prev.browser; g.session = prev.session; }
}

test('findPage skips a hung first match and attaches the next live one, in tab order', async () => {
  const env = fakeEnv([
    { targetId: 'H1', url: 'https://fb.example/a', mode: 'hung' },
    { targetId: 'H2', url: 'https://fb.example/b', mode: 'hung' },
    { targetId: 'L1', url: 'https://fb.example/c', mode: 'live' },
    { targetId: 'L2', url: 'https://fb.example/d', mode: 'live' },
  ]);
  await withBrowser(env.browser, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const page: any = await (ctx as any).findPage('https://fb.example/', { livenessMs: MS });
    assert.equal(page.targetId, 'L1');
    assert.deepEqual(env.attachedPages, ['L1'], 'a hung tab never reaches browser.attach (Page.enable would hang)');
    assert.equal(env.detached.length, 3, 'every probe attachment is detached');
  });
});

test('findPage wakes a frozen tab once and uses it when it then answers', async () => {
  const env = fakeEnv([
    { targetId: 'W1', url: 'https://fb.example/a', mode: 'wakeable' },
    { targetId: 'L1', url: 'https://fb.example/b', mode: 'live' },
  ]);
  await withBrowser(env.browser, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const page: any = await (ctx as any).findPage('https://fb.example/', { livenessMs: MS });
    assert.equal(page.targetId, 'W1');
    assert.equal(env.calls.filter(c => c.startsWith('Emulation.setFocusEmulationEnabled')).length, 1);
  });
});

test('findPage with only hung matches throws naming the hung count and origins', async () => {
  const env = fakeEnv([
    { targetId: 'H1', url: 'https://fb.example/a?secret=1', mode: 'hung' },
    { targetId: 'H2', url: 'https://fb.example/b', mode: 'hung' },
    { targetId: 'O1', url: 'https://other.example/', mode: 'live' },
  ]);
  await withBrowser(env.browser, async () => {
    const { ctx } = await buildToolCtx({}, {});
    await assert.rejects(() => (ctx as any).findPage('https://fb.example/', { livenessMs: MS }), (e: Error) => {
      assert.match(e.message, /^findPage: 2 open tab\(s\) match /);
      assert.match(e.message, /none answered/);
      assert.ok(!e.message.includes('secret'), 'no query strings in the error');
      return true;
    });
    assert.deepEqual(env.attachedPages, []);
  });
});

test('findPage does not probe a tab it already adopted in this call', async () => {
  const env = fakeEnv([{ targetId: 'L1', url: 'https://fb.example/a', mode: 'live' }]);
  await withBrowser(env.browser, async () => {
    const { ctx } = await buildToolCtx({}, {});
    await (ctx as any).findPage('https://fb.example/', { livenessMs: MS });
    const before = env.calls.length;
    await (ctx as any).findPage('https://fb.example/', { livenessMs: MS });
    assert.equal(env.calls.length, before);
  });
});

test('browserTool domain match skips a hung tab for the next live one (default probe timing)', async () => {
  const env = fakeEnv([
    { targetId: 'H1', url: 'https://memo.d.foundation/a', mode: 'hung' },
    { targetId: 'L1', url: 'https://memo.d.foundation/b', mode: 'live' },
  ]);
  (env.browser as any).attach = async (targetId: string) => {
    env.attachedPages.push(targetId);
    return { targetId, disposed: false, dispose() {}, cdp: async () => ({ result: { value: 'ran-on-' + targetId } }) };
  };
  await withBrowser(env.browser, async () => {
    assert.equal(await extraHelpers.learnings('memo-d-foundation', 'layout_overflow', {}), 'ran-on-L1');
    assert.deepEqual(env.attachedPages, ['L1']);
  });
});

test('tabAnswers: false when attach itself never answers or throws', async () => {
  assert.equal(await tabAnswers({ _call: () => new Promise(() => {}) }, 'X', MS), false);
  assert.equal(await tabAnswers({ _call: () => Promise.reject(new Error('boom')) }, 'X', MS), false);
});
