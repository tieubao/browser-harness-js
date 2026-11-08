import assert from 'node:assert/strict';
import test from 'node:test';
import { Browser } from './browser.ts';
import type { Session } from './session.ts';

// Replays what Helium does for Target.createTarget({url}): the tab sits at about:blank with readyState
// "complete", navigates to the URL, then (sometimes) navigates again, which destroys the execution context.
const origin = 'https://allowed.test';
type Step = { at: number; url: string; ready?: string; contextGapMs?: number };

class HeliumTransport {
  generation = 1;
  url = 'about:blank';
  ready = 'complete';
  contextDownUntil = 0;
  calls: { method: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any, sid?: string) => void>();
  started = 0;
  /** When every navigation had committed; open must not resolve earlier. */
  lastNavigationAt = 0;
  readonly steps: Step[];
  constructor(steps: Step[]) { this.steps = steps; }
  getConnectionGeneration() { return this.generation; }
  isConnected() { return true; }
  onEvent(fn: (method: string, params: any, sid?: string) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(method: string, params: any = {}, sid = 'main') { for (const fn of this.listeners) fn(method, params, sid); }
  private play() {
    this.started = Date.now();
    for (const step of this.steps) setTimeout(() => {
      this.url = step.url; this.ready = step.ready ?? 'complete';
      this.contextDownUntil = Date.now() + (step.contextGapMs ?? 0);
      this.lastNavigationAt = Date.now();
      this.emit('Page.frameNavigated', { frame: { id: 'frame', loaderId: `loader${step.at}`, url: step.url } });
    }, step.at);
  }
  async _call(method: string, params: any, options: { sessionId?: string; expectedGeneration?: number } = {}): Promise<any> {
    this.calls.push({ method, params });
    switch (method) {
      case 'Target.createTarget': this.play(); return { targetId: 'tab' };
      case 'Target.attachToTarget': return { sessionId: 'main' };
      case 'Target.detachFromTarget': case 'Target.closeTarget': case 'Page.enable': return {};
      case 'Target.getTargets': return { targetInfos: [] };
      case 'Page.navigate': throw new Error('net::ERR_ABORTED');
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: this.url } } };
      case 'Runtime.evaluate':
        if (Date.now() < this.contextDownUntil) throw new Error('Execution context was destroyed.');
        if (String(params.expression).includes('readyState')) return { result: { value: { href: this.url, ready: this.ready } } };
        return { result: { value: { url: this.url, title: 'Fixture' } } };
      default: throw new Error(`Unexpected method ${method}`);
    }
  }
}
const open = (transport: HeliumTransport, timeoutMs = 3000, url = `${origin}/final`) =>
  new Browser(transport as unknown as Session).open(url, { allowedOrigins: [origin], timeoutMs });

test('open waits out about:blank, a first navigation and a second one that destroys the context', async () => {
  const transport = new HeliumTransport([
    { at: 60, url: `${origin}/step`, ready: 'loading' },
    { at: 120, url: `${origin}/final`, contextGapMs: 40 },
  ]);
  const page = await open(transport);
  const settledAt = Date.now();
  assert.ok(settledAt >= transport.lastNavigationAt, 'resolved after the last navigation committed');
  assert.equal(transport.url, `${origin}/final`);
  assert.equal((await page.info() as any).url, `${origin}/final`);
  assert.equal(transport.calls.find(c => c.method === 'Target.createTarget')!.params.url, `${origin}/final`, 'target is created with the real URL');
  assert.equal(transport.calls.filter(c => c.method === 'Page.navigate').length, 0, 'no goto races the initial navigation');
  assert.equal(transport.listeners.size > 0, true);
  page.dispose();
});

test('open does not resolve while the target sits on about:blank', async () => {
  const transport = new HeliumTransport([]);
  await assert.rejects(open(transport, 400), /did not settle.*about:blank/);
  assert.ok(transport.calls.some(c => c.method === 'Target.closeTarget'), 'the stuck tab is closed');
  assert.equal(transport.listeners.size, 0);
});

test('open keeps the origin guard when the delayed navigation lands off the allowed origins', async () => {
  const transport = new HeliumTransport([{ at: 80, url: 'https://denied.test/' }]);
  await assert.rejects(open(transport), /origin_denied/);
  assert.ok(transport.calls.some(c => c.method === 'Target.closeTarget'));
  assert.equal(transport.listeners.size, 0);
});

test('open still opens at once when the browser is on the URL already (Chrome)', async () => {
  const transport = new HeliumTransport([{ at: 0, url: `${origin}/final` }]);
  const started = Date.now();
  const page = await open(transport);
  assert.ok(Date.now() - started < 1000);
  page.dispose();
});
