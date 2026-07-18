// Regression test for the connect() port-hijack safety bug: a Session
// already connected to one browser silently rode the existing connection
// even when called again with an EXPLICIT, different target (port, host,
// wsUrl, or profileDir), instead of erroring, including via the auto-heal
// reconnect path and a concurrent in-flight connect(). In practice this
// touched the live logged-in daily-driver browser when a caller thought it
// was talking to a scoped, isolated instance.
//
// Also covers a same-day hardening pass (fable advisor review of the
// original fix, 2026-07-18): the pin that scopes _call()'s self-heal
// reconnect went stale across a close()+auto-detect-reconnect on the same
// Session, and the in-flight race guard didn't recognize `profileDir` as an
// explicit target at all.
//
// Uses a fake global WebSocket (no real Chrome needed), so no real browser
// is ever launched or attached to. NOT fully offline, though: `{ wsUrl }`
// is a pure passthrough in resolveWsUrl (zero I/O) and the wsUrl/port/host
// mismatch checks happen synchronously in connect()'s fast path before any
// resolve, but `autoAllow` defaults to true, so an explicit connect also
// calls `browserNameFor()` -> `detectBrowsers()`, real (best-effort,
// failure-tolerant) filesystem reads against whatever's actually on this
// machine. The profileDir tests do real, self-contained filesystem I/O on
// purpose (a temp dir with a fake DevToolsActivePort file) since profileDir
// resolution genuinely needs to read one to compare. The auto-detect-clears-
// the-pin test does the same trick against a temp $HOME so detectBrowsers()
// finds a fake candidate instead of scanning this machine's real browsers --
// it still never opens a real WebSocket (FakeWebSocket is swapped in for the
// whole test either way).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Session, explicitTargetMismatch } from './session.ts';

class FakeMessageEvent extends Event {
  data: string;
  constructor(data: string) {
    super('message');
    this.data = data;
  }
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  send(data: string): void {
    // Echo a fake-but-well-formed CDP response for any request with an `id`,
    // so a real _call() round trip resolves. Needed for the self-heal test
    // below, which must exercise the ACTUAL internal reconnect logic in
    // _call() (not a caller-driven reconnect) -- that requires a live
    // request/response cycle, not just connect()'s fast path.
    let msg: { id?: number };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const { id } = msg;
      queueMicrotask(() => {
        this.dispatchEvent(new FakeMessageEvent(JSON.stringify({ id, result: {} })));
      });
    }
  }
}

async function withFakeWebSocket<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.WebSocket;
  // @ts-expect-error -- swapping the global for the duration of the test
  globalThis.WebSocket = FakeWebSocket;
  try {
    return await fn();
  } finally {
    globalThis.WebSocket = real;
  }
}

test('explicitTargetMismatch: no explicit opts -> no mismatch', () => {
  assert.equal(explicitTargetMismatch({}, 'ws://127.0.0.1:9222/devtools/browser/x'), undefined);
});

test('explicitTargetMismatch: matching port -> no mismatch', () => {
  assert.equal(explicitTargetMismatch({ port: 9222 }, 'ws://127.0.0.1:9222/devtools/browser/x'), undefined);
});

test('explicitTargetMismatch: mismatching port -> mismatch description', () => {
  const result = explicitTargetMismatch({ port: 9333 }, 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.match(result ?? '', /port 9333/);
  assert.match(result ?? '', /9222/);
});

test('explicitTargetMismatch: matching wsUrl -> no mismatch', () => {
  const url = 'ws://127.0.0.1:9222/devtools/browser/x';
  assert.equal(explicitTargetMismatch({ wsUrl: url }, url), undefined);
});

test('explicitTargetMismatch: mismatching wsUrl -> mismatch description', () => {
  const result = explicitTargetMismatch(
    { wsUrl: 'ws://127.0.0.1:9333/devtools/browser/y' },
    'ws://127.0.0.1:9222/devtools/browser/x',
  );
  assert.match(result ?? '', /9333/);
});

test('connect(): an explicit port mismatch throws instead of silently riding the existing connection', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    assert.equal(session.isConnected(), true);

    await assert.rejects(
      () => session.connect({ port: 9333 }),
      (err: Error) => {
        assert.match(err.message, /already connected to ws:\/\/127\.0\.0\.1:9222/);
        assert.match(err.message, /port 9333/);
        assert.match(err.message, /construct a new Session/);
        return true;
      },
    );
    // the throw must NOT have torn down or replaced the existing connection.
    assert.equal(session.isConnected(), true);
  });
});

test('connect(): an explicit wsUrl mismatch throws instead of silently riding the existing connection', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    assert.equal(session.isConnected(), true);

    await assert.rejects(
      () => session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-DIFFERENT' }),
      /already connected to/,
    );
    assert.equal(session.isConnected(), true);
  });
});

test('connect(): a matching explicit target does NOT throw (idempotent re-connect)', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const url = 'ws://127.0.0.1:9222/devtools/browser/fake-id-1';
    await session.connect({ wsUrl: url });
    await session.connect({ wsUrl: url });
    await session.connect({ port: 9222 });
    assert.equal(session.isConnected(), true);
  });
});

test('connect(): no explicit target rides the existing connection (no throw) -- the common reconnect-heal idiom', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    await session.connect(); // no args at all -- must NOT throw
    assert.equal(session.isConnected(), true);
  });
});

// --- host coverage (round-2 review finding) ---------------------------------

test('explicitTargetMismatch: same port, different host -> mismatch description', () => {
  const result = explicitTargetMismatch(
    { port: 9222, host: '100.64.0.1' },
    'ws://127.0.0.1:9222/devtools/browser/x',
  );
  assert.match(result ?? '', /100\.64\.0\.1/);
  assert.match(result ?? '', /127\.0\.0\.1/);
});

test('explicitTargetMismatch: matching port AND host -> no mismatch', () => {
  assert.equal(
    explicitTargetMismatch({ port: 9222, host: '100.64.0.1' }, 'ws://100.64.0.1:9222/devtools/browser/x'),
    undefined,
  );
});

test('connect(): an explicit host mismatch (same port, different host) throws', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    await assert.rejects(
      () => session.connect({ port: 9222, host: '100.64.0.1' }),
      /already connected to/,
    );
    assert.equal(session.isConnected(), true);
  });
});

// --- profileDir coverage (round-2 review finding, this project's own docs
// recommend { profileDir } as THE way to target a specific browser) ---------

function fakeProfileDir(port: number, wsId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bhjs-session-test-profile-'));
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/${wsId}`);
  return dir;
}

test('connect(): an explicit profileDir mismatch (resolves to a different browser) throws', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/connected-id' });
    const otherProfile = fakeProfileDir(9333, 'other-browser-id');
    try {
      await assert.rejects(
        () => session.connect({ profileDir: otherProfile }),
        (err: Error) => {
          assert.match(err.message, /already connected to/);
          assert.match(err.message, /profileDir/);
          return true;
        },
      );
      assert.equal(session.isConnected(), true);
    } finally {
      rmSync(otherProfile, { recursive: true, force: true });
    }
  });
});

test('connect(): a profileDir that resolves to the SAME browser does not throw', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/same-id' });
    const sameProfile = fakeProfileDir(9222, 'same-id');
    try {
      await session.connect({ profileDir: sameProfile });
      assert.equal(session.isConnected(), true);
    } finally {
      rmSync(sameProfile, { recursive: true, force: true });
    }
  });
});

// --- in-flight-connect race coverage (round-2 review finding) --------------

test('connect(): a concurrent connect() with a DIFFERENT explicit target rejects instead of riding the in-flight one', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const first = session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    const second = session.connect({ port: 9333 });
    await assert.rejects(second, /already in flight/);
    await first; // the original call must still succeed normally
    assert.equal(session.isConnected(), true);
  });
});

test('connect(): a concurrent connect() with NO explicit target rides the in-flight one (no throw)', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const first = session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake-id-1' });
    const second = session.connect(); // no explicit target -- must ride, not reject
    await Promise.all([first, second]);
    assert.equal(session.isConnected(), true);
  });
});

test('connect(): a concurrent connect() with the SAME explicit target rides the in-flight one (no throw)', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const url = 'ws://127.0.0.1:9222/devtools/browser/fake-id-1';
    const first = session.connect({ wsUrl: url });
    const second = session.connect({ wsUrl: url });
    await Promise.all([first, second]);
    assert.equal(session.isConnected(), true);
  });
});

// --- profileDir in-flight race coverage (2026-07-18 hardening: targetKey()
// didn't recognize profileDir at all, so a concurrent connect({ profileDir })
// call silently rode whatever else was in flight instead of throwing) -------

test('connect(): a concurrent connect() with a DIFFERENT explicit profileDir rejects instead of riding the in-flight one', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const dirA = fakeProfileDir(9222, 'race-profile-a');
    const dirB = fakeProfileDir(9333, 'race-profile-b');
    try {
      const first = session.connect({ profileDir: dirA });
      const second = session.connect({ profileDir: dirB });
      await assert.rejects(second, /already in flight/);
      await first; // the original call must still succeed normally
      assert.equal(session.isConnected(), true);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

test('connect(): a concurrent connect() with the SAME explicit profileDir rides the in-flight one (no throw)', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const dir = fakeProfileDir(9222, 'race-profile-same');
    try {
      const first = session.connect({ profileDir: dir });
      const second = session.connect({ profileDir: dir });
      await Promise.all([first, second]);
      assert.equal(session.isConnected(), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- pinned-target auto-heal coverage ---------------------------------------
// This test exercises the REAL self-heal path inside _call() (not a caller-
// driven reconnect) via the echoing FakeWebSocket above: a genuine protocol
// round trip proves the fake responds like a real CDP endpoint, then the WS
// is dropped and a second _call() must succeed by internally reconnecting to
// the PINNED target. This is mutation-provable: comment out the
// `this.pinnedWsUrl = this.ws?.url` assignment (or the `pinnedWsUrl ? {
// wsUrl } : {}` read in _call()'s heal branch) and this test fails, because
// heal falls through to blind auto-detect, which finds no candidates in this
// sandboxed test environment (no DevToolsActivePort anywhere under a real
// $HOME during a normal test run) and rejects.

test('connect(): an explicit connect pins the target so the SELF-HEAL reconnect inside _call() (not a caller-driven reconnect) retries the pinned target after a drop, never blind auto-detect', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const url = 'ws://127.0.0.1:9222/devtools/browser/fake-id-1';
    await session.connect({ wsUrl: url });
    assert.equal(session.isConnected(), true);
    // A real protocol round trip via the echoing FakeWebSocket -- proves the
    // fake behaves like a live CDP endpoint before we rely on it for heal.
    await session._call('Target.getTargets', {});
    // simulate the WS dropping (what _call's heal path reacts to)
    (session as unknown as { ws: { close(): void } }).ws.close();
    assert.equal(session.isConnected(), false);
    // No caller-driven reconnect here -- _call()'s OWN internal self-heal
    // must fire and pick the pinned target.
    await session._call('Target.getTargets', {});
    assert.equal(session.isConnected(), true);
    assert.equal((session as unknown as { ws: { url: string } }).ws.url, url);
  });
});

// --- pin lifecycle: a later auto-detect connect() must CLEAR a stale
// explicit pin (2026-07-18 hardening: a Session reused across a close() +
// auto-detect reconnect kept the OLD explicit pin, so a later WS drop's
// self-heal would silently reattach to the stale target instead of the
// browser this Session actually auto-detected onto). ------------------------

test(
  'connect(): a later auto-detect connect() clears a stale explicit pin, so self-heal reconnects to the auto-detected target -- not the old pinned one',
  { skip: process.platform !== 'darwin' },
  async () => {
    await withFakeWebSocket(async () => {
      const session = new Session();
      const pinnedUrl = 'ws://127.0.0.1:9222/devtools/browser/explicit-a';
      await session.connect({ wsUrl: pinnedUrl });
      assert.equal((session as unknown as { pinnedWsUrl?: string }).pinnedWsUrl, pinnedUrl);
      session.close();

      // Auto-detect connect (no explicit target) lands on a DIFFERENT
      // browser -- faked via a temp $HOME with one candidate profile dir's
      // DevToolsActivePort file (same technique as fakeProfileDir, just
      // planted where detectBrowsers()'s hardcoded candidate list expects
      // it). No real filesystem outside the temp dir, and no real WebSocket
      // (FakeWebSocket stays swapped in), is ever touched.
      const fakeHome = mkdtempSync(join(tmpdir(), 'bhjs-session-test-autodetect-home-'));
      const chromeDir = join(fakeHome, 'Library', 'Application Support', 'Google', 'Chrome');
      mkdirSync(chromeDir, { recursive: true });
      writeFileSync(join(chromeDir, 'DevToolsActivePort'), '9333\n/devtools/browser/auto-detected-b');
      const realHome = process.env.HOME;
      process.env.HOME = fakeHome;
      try {
        await session.connect();
      } finally {
        process.env.HOME = realHome;
        rmSync(fakeHome, { recursive: true, force: true });
      }
      assert.equal(session.isConnected(), true);
      assert.equal(
        (session as unknown as { ws: { url: string } }).ws.url,
        'ws://127.0.0.1:9333/devtools/browser/auto-detected-b',
      );
      // The fix under test: the pin from the earlier explicit connect must
      // be CLEARED, not left stale at the old explicit target.
      assert.equal((session as unknown as { pinnedWsUrl?: string }).pinnedWsUrl, undefined);
    });
  },
);
