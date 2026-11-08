// Offline tests for the learnings runner ctx: ctx.page, ctx.findPage, ctx.attachPage, cleanup,
// and the legacy ctx fields staying intact. Fake `browser` / `session` globals, no real browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extraHelpers } from './helpers.ts';

const { buildToolCtx, learnings } = extraHelpers;

type FakePage = { targetId: string; allowedOrigins: string[]; timeoutMs?: number; disposed: boolean; dispose: () => void; cdp: (method: string, params?: unknown) => Promise<unknown> };

function fakeBrowser(tabs: Array<{ targetId: string; url: string }>) {
  const attached: FakePage[] = [];
  const browser = {
    tabs: async () => tabs,
    attach: async (targetId: string, options: { allowedOrigins: string[]; timeoutMs?: number }) => {
      const page: FakePage = { targetId, allowedOrigins: options.allowedOrigins, timeoutMs: options.timeoutMs, disposed: false, dispose() { page.disposed = true; },
        cdp: async (method: string) => (method === 'Runtime.evaluate' ? { result: { value: '["A","B"]' } } : {}) };
      attached.push(page);
      return page;
    },
  };
  return { browser, attached };
}

async function withGlobals<T>(fakes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const prev: Record<string, unknown> = {};
  for (const k of Object.keys(fakes)) { prev[k] = g[k]; g[k] = fakes[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(fakes)) g[k] = prev[k]; }
}

const TABS = [
  { targetId: 'T1', url: 'https://other.example/home' },
  { targetId: 'T2', url: 'https://mail.example.com/u/0/#inbox' },
  { targetId: 'T3', url: 'https://mail.example.com/u/1/#inbox' },
];

test('findPage: string is a URL prefix; first match is attached with its origin and the manifest domains allowed', async () => {
  const { browser, attached } = fakeBrowser(TABS);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx, cleanup } = await buildToolCtx({ domains: ['mail.example.com'] }, {});
    const page: any = await (ctx as any).findPage('https://mail.example.com/u/');
    assert.equal(page.targetId, 'T2');
    assert.deepEqual(page.allowedOrigins, ['https://mail.example.com']);
    assert.equal(page.timeoutMs, 60_000);
    assert.equal(attached.length, 1);
    cleanup();
  });
});

test('findPage: a bare hostname is not a prefix and does not match', async () => {
  const { browser } = fakeBrowser(TABS);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    await assert.rejects(() => (ctx as any).findPage('mail.example.com', { waitMs: 0 }), /no open page matches mail\.example\.com/);
  });
});

test('findPage: RegExp matches anywhere in the URL, flags g/y are ignored, extra origins are added', async () => {
  const { browser } = fakeBrowser(TABS);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const page: any = await (ctx as any).findPage(/\/u\/1\//g, { allowedOrigins: ['https://accounts.example.com'], timeoutMs: 5000 });
    assert.equal(page.targetId, 'T3');
    assert.deepEqual(page.allowedOrigins, ['https://mail.example.com', 'https://accounts.example.com']);
    assert.equal(page.timeoutMs, 5000);
    const again: any = await (ctx as any).findPage(/\/u\/1\//g);
    assert.equal(again, page, 'same target returns the cached Page');
  });
});

test('findPage: no match throws a clear error listing open tabs', async () => {
  const { browser, attached } = fakeBrowser(TABS);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    await assert.rejects(() => (ctx as any).findPage(/nowhere\.invalid/, { waitMs: 0 }), /findPage: no open page matches \/nowhere\\\.invalid\/ \(open: https:\/\/other\.example\/home/);
    await assert.rejects(() => (ctx as any).findPage(42 as any), /URL prefix string or a RegExp/);
    assert.equal(attached.length, 0);
  });
});

test('ctx.page: args.targetId wins; legacy fields stay present', async () => {
  const { browser, attached } = fakeBrowser(TABS);
  const session = { marker: 'S' };
  await withGlobals({ browser, session, cdp: () => 'cdp', axView: () => 'ax', listPageTargets: () => [] }, async () => {
    const { ctx, cleanup } = await buildToolCtx({ domains: ['mail.example.com'] }, { targetId: 'T2' });
    const c: any = ctx;
    assert.equal(c.page.targetId, 'T2');
    assert.equal(c.browser, browser);
    assert.equal(c.pageError, undefined);
    assert.equal(c.session, session);
    for (const k of ['cdp', 'axView', 'listPageTargets', 'axClick', 'axType', 'ext', 'parseAxRefs', 'parseAxLocators',
      'drainSignals', 'attachSignals', 'detachSignals', 'pageInfo', 'help', 'listLearnings', 'learnings']) assert.ok(k in c, k);
    assert.equal(typeof c.findPage, 'function');
    assert.equal(typeof c.attachPage, 'function');
    cleanup();
    assert.ok(attached.every(p => p.disposed));
  });
});

test('ctx.page: falls back to the REPL active target, then to null', async () => {
  const { browser } = fakeBrowser(TABS);
  await withGlobals({ browser, session: { getActiveTargetId: () => 'T3' } }, async () => {
    const { ctx } = await buildToolCtx({}, undefined);
    assert.equal((ctx as any).page.targetId, 'T3');
    assert.deepEqual((ctx as any).page.allowedOrigins, ['https://mail.example.com']);
  });
  await withGlobals({ browser, session: { getActiveTargetId: () => undefined } }, async () => {
    const { ctx } = await buildToolCtx({}, undefined);
    assert.equal((ctx as any).page, null);
    assert.equal((ctx as any).pageError, undefined);
  });
});

test('ctx.page: an attach failure is not fatal; pageError explains and page is null', async () => {
  const browser = { tabs: async () => [], attach: async () => { throw new Error('boom'); } };
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({ domains: ['a.example'] }, { targetId: 'T9' });
    assert.equal((ctx as any).page, null);
    assert.equal((ctx as any).pageError, 'boom');
  });
});

test('ctx.page: a target with no http(s) origin and no manifest domains reports pageError', async () => {
  const { browser, attached } = fakeBrowser([{ targetId: 'B1', url: 'about:blank' }]);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, { targetId: 'B1' });
    assert.equal((ctx as any).page, null);
    assert.match((ctx as any).pageError, /no http\(s\) origin to allow/);
    assert.equal(attached.length, 0);
  });
});

test('attachPage: derives the origin from the tab URL, honours explicit origins', async () => {
  const { browser } = fakeBrowser([...TABS, { targetId: 'N1', url: 'https://new.example/login' }]);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const page: any = await (ctx as any).attachPage('N1', { allowedOrigins: ['https://sso.example'] });
    assert.deepEqual(page.allowedOrigins, ['https://new.example', 'https://sso.example']);
  });
});

test('learnings(): runs a node-tool with the Page ctx and disposes every Page when it returns or throws', async () => {
  const { browser, attached } = fakeBrowser(TABS);
  const session = {
    domains: { Runtime: { evaluate: async () => ({ result: { value: '["A","B"]' } }) } },
    getActiveSession: () => undefined,
  };
  await withGlobals({ browser, session }, async () => {
    const out = await learnings('example', 'getOutline', { max: 2, targetId: 'T2' });
    assert.ok(Array.isArray(out));
    assert.equal(attached.length, 1);
    assert.equal(attached[0]!.targetId, 'T2');
    assert.equal(attached[0]!.disposed, true);
  });
});

test('no browser global: ctx.page is null, requirePage throws a clear error, legacy fields remain', async () => {
  const session = { marker: 'S' };
  await withGlobals({ browser: undefined, session }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const c: any = ctx;
    assert.equal(c.page, null);
    assert.equal(c.session, session);
    assert.throws(() => c.requirePage(), /no default page: no args\.targetId and no active tab; pass \{targetId\} or use ctx\.findPage/);
  });
});

test('requirePage returns the default page when one resolved', async () => {
  const { browser } = fakeBrowser(TABS);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, { targetId: 'T1' });
    assert.equal((ctx as any).requirePage(), (ctx as any).page);
  });
});

test('findPage: waits for a tab that is still about:blank to reach its URL', async () => {
  const tabs = [{ targetId: 'N1', url: 'about:blank' }];
  const { browser } = fakeBrowser(tabs);
  setTimeout(() => { tabs[0]!.url = 'https://late.example/app'; }, 250);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const started = Date.now();
    const page: any = await (ctx as any).findPage('https://late.example/', { waitMs: 3000 });
    assert.equal(page.targetId, 'N1');
    assert.deepEqual(page.allowedOrigins, ['https://late.example']);
    assert.ok(Date.now() - started >= 200);
  });
});

test('findPage: gives up after waitMs when the tab never reaches the URL', async () => {
  const { browser } = fakeBrowser([{ targetId: 'N1', url: 'about:blank' }]);
  await withGlobals({ browser, session: undefined }, async () => {
    const { ctx } = await buildToolCtx({}, {});
    const started = Date.now();
    await assert.rejects(() => (ctx as any).findPage('https://late.example/', { waitMs: 300 }), /no open page matches/);
    assert.ok(Date.now() - started >= 250);
  });
});

test('Session.getActiveTargetId tracks use() and follows setActiveSession restores', async () => {
  const { Session } = await import('./session.ts');
  const s: any = new Session();
  let n = 0;
  s._call = async () => ({ sessionId: 'sid-' + (++n) });
  assert.equal(s.getActiveTargetId(), undefined);
  await s.use('TARGET-A');
  assert.equal(s.getActiveTargetId(), 'TARGET-A');
  const previous = s.getActiveSession();
  await s.use('TARGET-B');
  assert.equal(s.getActiveTargetId(), 'TARGET-B');
  s.setActiveSession(previous);
  assert.equal(s.getActiveTargetId(), 'TARGET-A');
  s.setActiveSession(undefined);
  assert.equal(s.getActiveTargetId(), undefined);
  s.setActiveSession('foreign');
  assert.equal(s.getActiveTargetId(), undefined);
});
