import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BINDING,
  ChunkAssembler,
  buildPageScript,
  loadRrwebSource,
  resetRrwebSourceCache,
} from './recording.ts';
import { Session } from './session.ts';

const PAGE = 'data:text/html,<html><body><h1 id="probe">hello-rrweb-2-1-1</h1></body></html>';

test('rrweb 2.1.1 records a FullSnapshot of a live tab', async t => {
  const home = mkdtempSync(join(tmpdir(), 'browser-harness-js-rrweb-live-'));
  const previousHome = process.env.BROWSER_HARNESS_JS_HOME;
  const previousJs = process.env.CDP_RRWEB_JS;
  process.env.BROWSER_HARNESS_JS_HOME = home;
  delete process.env.CDP_RRWEB_JS;
  resetRrwebSourceCache();

  const session = new Session();
  let targetId: string | undefined;
  let sessionId: string | undefined;
  // Own headless browser on a temp profile: a bare connect() auto-detects and can reach the user's real browser.
  let chrome: ChildProcess | undefined;
  let profile: string | undefined;
  try {
    const executable = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => p && existsSync(p));
    if (!executable) {
      t.skip('Chrome not installed (set CHROME_PATH)');
      return;
    }
    profile = mkdtempSync(join(tmpdir(), 'browser-harness-rrweb-profile-'));
    chrome = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
    try {
      await session.connect({ port: Number(readFileSync(portFile, 'utf8').split('\n')[0]) });
    } catch (error) {
      t.skip(error instanceof Error ? error.message : String(error));
      return;
    }

    const created = await session.domains.Target.createTarget({ url: PAGE, background: true }) as { targetId: string };
    targetId = created.targetId;
    const attached = await session.domains.Target.attachToTarget({ targetId, flatten: true }) as { sessionId: string };
    sessionId = attached.sessionId;

    await session._call('Runtime.enable', {}, { sessionId });
    await session._call('Page.enable', {}, { sessionId });
    await session._call('Runtime.addBinding', { name: BINDING }, { sessionId });

    const assembler = new ChunkAssembler();
    const events: Array<{ type: number; timestamp: number }> = [];
    const off = session.onEvent((method, params, sid) => {
      if (sid !== sessionId || method !== 'Runtime.bindingCalled') return;
      const body = params && typeof params === 'object' ? params as { name?: string; payload?: string } : {};
      if (body.name !== BINDING || typeof body.payload !== 'string') return;
      const event = assembler.push(body.payload);
      if (event && typeof event.type === 'number' && typeof event.timestamp === 'number') {
        events.push(event as { type: number; timestamp: number });
      }
    });

    const script = buildPageScript(await loadRrwebSource());
    const evalResult = await session._call('Runtime.evaluate', {
      expression: script + '\n;typeof window.rrweb !== "undefined" && typeof window.rrweb.record === "function" && window.__bh_rrweb_on === 1',
      returnByValue: true,
    }, { sessionId }) as { result?: { value?: unknown; exceptionDetails?: unknown } };
    if (evalResult.result?.exceptionDetails) {
      throw new Error('bootstrap threw in page');
    }
    assert.equal(evalResult.result?.value, true, 'rrweb.record should be installed on window');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !events.some(event => event.type === 2)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    off();

    const types = [...new Set(events.map(event => event.type))].sort((a, b) => a - b);
    assert.ok(events.some(event => event.type === 2), `expected FullSnapshot (type 2); got types ${types.join(',') || 'none'} (${events.length} events)`);
    assert.ok(events.some(event => event.type === 4), `expected Meta (type 4); got types ${types.join(',') || 'none'}`);
    const blob = JSON.stringify(events);
    assert.match(blob, /hello-rrweb-2-1-1/);
  } finally {
    if (targetId) await session.closeTab(targetId, sessionId).catch(() => {});
    if (session.isConnected()) session.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise(r => chrome!.once('exit', r));
      chrome.kill();
      await exited;
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (previousHome == null) delete process.env.BROWSER_HARNESS_JS_HOME;
    else process.env.BROWSER_HARNESS_JS_HOME = previousHome;
    if (previousJs == null) delete process.env.CDP_RRWEB_JS;
    else process.env.CDP_RRWEB_JS = previousJs;
    resetRrwebSourceCache();
    rmSync(home, { recursive: true, force: true });
  }
});
