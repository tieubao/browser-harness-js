// Regression test for the connect() port-hijack safety bug: a Session
// already connected to one browser silently rode the existing connection
// even when called again with an EXPLICIT, different target (port or
// wsUrl), instead of erroring. In practice this touched the live logged-in
// daily-driver browser when a caller thought it was talking to a scoped,
// isolated instance.
//
// Uses a fake global WebSocket (no real Chrome needed) so this runs
// offline. `{ wsUrl }` is a pure passthrough in resolveWsUrl (no I/O), so
// the "already connected" setup step needs no network/filesystem access
// either -- and the mismatch check itself happens in the connect() fast
// path, before resolveWsUrl is ever called, so the mismatch scenarios need
// no I/O at all.
import assert from 'node:assert/strict';
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
