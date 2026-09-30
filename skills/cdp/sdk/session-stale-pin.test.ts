import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from './session.ts';

class FakeWS extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; url: string;
  constructor(url: string) {
    super(); this.url = url;
    queueMicrotask(() => {
      if (url.includes('dead')) { this.readyState = 3; this.dispatchEvent(new Event('error')); return; }
      this.readyState = 1; this.dispatchEvent(new Event('open'));
    });
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(data: string) {
    const m = JSON.parse(data);
    queueMicrotask(() => {
      const e = new Event('message') as Event & { data: string };
      e.data = JSON.stringify({ id: m.id, result: {} });
      this.dispatchEvent(e);
    });
  }
}

// A failed explicit connect must not leave the previous pin in charge: the
// next self-heal would otherwise act on the earlier browser instead of failing loud.
test('self-heal after a failed explicit reconnect never lands on the previously pinned browser', async () => {
  const real = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS;
  try {
    const s = new Session();
    const a = 'ws://127.0.0.1:9222/devtools/browser/scoped-a';
    await s.connect({ wsUrl: a, autoAllow: false });
    s.close();
    await assert.rejects(s.connect({ wsUrl: 'ws://127.0.0.1:9444/devtools/browser/dead-b', autoAllow: false, timeoutMs: 200 }));
    await assert.rejects(s._call('Target.getTargets', {}));
    assert.notEqual((s as unknown as { ws?: { url: string; readyState: number } }).ws?.readyState, 1);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = real;
  }
});
