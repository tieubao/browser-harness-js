/**
 * Probe: what a browser emits for a brand-new target (Target.createTarget) before it settles.
 *
 * Launches its OWN headless browser on a throwaway profile, never the user's browser.
 * Prints, with timestamps and the CDP session, Target.targetInfoChanged, Page.frameNavigated, Page.lifecycleEvent and
 * Runtime.executionContext{Created,Destroyed,sCleared} for createTarget with a URL and
 * with about:blank followed by Page.navigate.
 *
 *   node skills/cdp/sdk/bench/open-race-probe.ts <browser-binary> [runs]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.argv[2];
const RUNS = Number(process.argv[3] ?? 1);
if (!binary || !existsSync(binary)) { console.error('usage: open-race-probe.ts <browser-binary>'); process.exit(2); }

const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>probe</title><p>hello</p>'); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const profile = mkdtempSync(join(tmpdir(), 'open-race-probe-'));
const child = spawn(binary, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const portFile = join(profile, 'DevToolsActivePort');
for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
const [port, path] = readFileSync(portFile, 'utf8').split('\n');
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let nextId = 1, t0 = performance.now();
const pending = new Map<number, (v: any) => void>();
const log: string[] = [];
const stamp = () => `  +${String(Math.round(performance.now() - t0)).padStart(4)}ms`;
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>(resolve => {
  const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const watched = new Set(['Target.targetInfoChanged', 'Page.frameNavigated', 'Page.lifecycleEvent', 'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared']);
let autoAttach = false;
ws.addEventListener('message', async ev => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id) { pending.get(msg.id)?.(msg.result ?? msg.error); pending.delete(msg.id); return; }
  if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'page' && autoAttach) {
    const sid = msg.params.sessionId;
    await send('Page.enable', {}, sid); await send('Page.setLifecycleEventsEnabled', { enabled: true }, sid);
    await send('Runtime.enable', {}, sid); await send('Runtime.runIfWaitingForDebugger', {}, sid);
    return;
  }
  if (!watched.has(msg.method)) return;
  const p = msg.params;
  if (msg.method === 'Target.targetInfoChanged' && p.targetInfo.type !== 'page') return;
  if (msg.method === 'Page.lifecycleEvent' && !['init', 'commit', 'load'].includes(p.name)) return;
  if (msg.method === 'Runtime.executionContextCreated' && p.context.auxData?.isDefault === false) return;
  const detail = msg.method === 'Target.targetInfoChanged' ? p.targetInfo.url
    : msg.method === 'Page.frameNavigated' ? `${p.frame.parentId ? 'child' : 'main'} ${p.frame.url}`
    : msg.method === 'Page.lifecycleEvent' ? `${p.name} loader=${String(p.loaderId).slice(0, 6)}`
    : msg.method === 'Runtime.executionContextCreated' ? `ctx ${p.context.id} origin=${p.context.origin}`
    : msg.method === 'Runtime.executionContextDestroyed' ? `ctx ${p.executionContextId}` : '';
  log.push(`${stamp()} [${String(msg.sessionId ?? 'browser').slice(-4)}] ${msg.method} ${detail}`);
});

// Scenario A sees everything: the target is paused until the probe has enabled its domains.
// Scenarios B and C attach late, like Browser.open does, and show what a late attacher can observe.
const late = async (url: string, navigateTo?: string) => {
  const { targetId } = await send('Target.createTarget', { url, background: true });
  log.push(`${stamp()} (probe) createTarget returned`);
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
  await send('Runtime.enable', {}, sessionId);
  log.push(`${stamp()} (probe) attached [${sessionId.slice(-4)}], location=${JSON.stringify((await send('Runtime.evaluate', { expression: 'location.href+" "+document.readyState' }, sessionId)).result?.value)}`);
  if (navigateTo) {
    const nav = await send('Page.navigate', { url: navigateTo }, sessionId);
    log.push(`${stamp()} (probe) Page.navigate returned ${nav.errorText ? 'errorText=' + nav.errorText : 'ok'}`);
  }
  await new Promise(r => setTimeout(r, 1200));
  await send('Target.closeTarget', { targetId });
};
const scenarios: [string, () => Promise<void>][] = [
  ['A createTarget(url), auto-attached paused (full view)', async () => {
    autoAttach = true; await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await send('Target.createTarget', { url: `${origin}/`, background: true });
    await new Promise(r => setTimeout(r, 1200)); await send('Target.closeTarget', { targetId });
    await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }); autoAttach = false;
  }],
  ['B createTarget(url), late attach', () => late(`${origin}/`)],
  ['C createTarget(about:blank), late attach, Page.navigate (what Browser.open did)', () => late('about:blank', `${origin}/`)],
];
for (const [name, run] of scenarios) {
  for (let n = 1; n <= RUNS; n++) {
    log.length = 0; t0 = performance.now();
    await run();
    console.log(`${name} on ${binary.split('/').pop()} (run ${n})`); console.log(log.join('\n'));
  }
}
ws.close(); child.kill(); server.close();
