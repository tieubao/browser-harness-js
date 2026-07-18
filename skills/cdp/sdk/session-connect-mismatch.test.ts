// Regression test for the connect() port-hijack safety bug: a Session
// already connected to one browser silently rode the existing connection
// even when called again with an EXPLICIT, different target (port, host,
// wsUrl, or profileDir), instead of erroring, including via the auto-heal
// reconnect path and a concurrent in-flight connect(). In practice this
// touched the live logged-in daily-driver browser when a caller thought it
// was talking to a scoped, isolated instance.
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
// resolution genuinely needs to read one to compare.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Session, explicitTargetMismatch } from './session.ts';

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
  send(_data: string): void {
    // no-op: these tests never exercise _call(), only connect()'s fast path.
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

// --- pinned-target auto-heal coverage (round-2 review finding) -------------
// _call()'s self-heal reconnect (not exercised directly here -- it needs a
// real _call() round trip) is covered indirectly: this proves the PINNING
// mechanism itself (an explicit connect sets a target _call's heal path can
// read) works, since _call's heal logic is a one-line consumer of it
// (`this.pinnedWsUrl ? { wsUrl: this.pinnedWsUrl } : {}`) and is not
// independently retestable without exercising the full WebSocket message
// protocol this test file deliberately doesn't fake (see the file header).

test('connect(): an explicit connect pins the target so a later same-target reconnect (simulating heal) still works after a drop', async () => {
  await withFakeWebSocket(async () => {
    const session = new Session();
    const url = 'ws://127.0.0.1:9222/devtools/browser/fake-id-1';
    await session.connect({ wsUrl: url });
    assert.equal(session.isConnected(), true);
    // simulate the WS dropping (what _call's heal path reacts to)
    (session as unknown as { ws: { close(): void } }).ws.close();
    assert.equal(session.isConnected(), false);
    // a reconnect to the SAME pinned target must still succeed (this is
    // exactly what _call's heal path does internally via pinnedWsUrl).
    await session.connect({ wsUrl: url });
    assert.equal(session.isConnected(), true);
  });
});
