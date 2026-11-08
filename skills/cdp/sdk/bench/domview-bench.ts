/**
 * Benchmark: domView (one Runtime.evaluate) vs getFullAXTree + axView({interactive:true}).
 *
 * Launches its OWN headless browser on a private port with a throwaway profile,
 * never the user's browser. Measures wall time, output size and element count
 * per page, runs a correctness spot check, and a click check on a local fixture.
 *
 *   node skills/cdp/sdk/bench/domview-bench.ts [--runs 7] [--out bench/results.json]
 *
 * Env: BENCH_BROWSER overrides the binary, BENCH_PORT the debugging port (9333).
 * Output: JSON on --out (default bench/results.json) and a summary on stdout.
 * RESULTS.md is written from that JSON by hand; see the file header there.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { axView } from '../axview.ts';
import { Session } from '../session.ts';
import { runDomClick, runDomView, type DomViewDriver, type DomViewOptions } from '../domview.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const RUNS = Number(arg('--runs', '7'));
const OUT = resolve(arg('--out', join(HERE, 'results.json')));
const PORT = Number(process.env.BENCH_PORT ?? 9333);
if (PORT === 9222) throw new Error('refusing port 9222: that is the shared browser');

const CANDIDATES = [
  process.env.BENCH_BROWSER,
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

type Target = { label: string; role: RegExp; name: RegExp };
type PageSpec = { id: string; url: string; targets: Target[] };

const TEXTISH = /^(textbox|searchbox|combobox)$/;
const PAGES: PageSpec[] = [
  { id: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Chromium_(web_browser)', targets: [
    { label: 'search box', role: TEXTISH, name: /^search wikipedia/i },
    { label: 'link Log in', role: /^link$/, name: /^log in$/i },
    { label: 'link Donate', role: /^link$/, name: /^donate$/i },
  ] },
  { id: 'hackernews', url: 'https://news.ycombinator.com/', targets: [
    { label: 'link new', role: /^link$/, name: /^new$/ },
    { label: 'link login', role: /^link$/, name: /^login$/ },
    { label: 'footer search box', role: TEXTISH, name: /.*/ },
  ] },
  { id: 'github', url: 'https://github.com/browser-use/jev-ultrafast', targets: [
    { label: 'link Issues', role: /^link$/, name: /^issues/i },
    { label: 'link Pull requests', role: /^link$/, name: /^pull requests/i },
    { label: 'search trigger', role: /^(button|textbox|searchbox|combobox)$/, name: /search/i },
  ] },
  // Substitute for the GitHub page, which returned HTTP 504 for every github.com URL on the bench day.
  { id: 'python-docs', url: 'https://docs.python.org/3/library/json.html', targets: [
    { label: 'search box', role: /^(textbox|searchbox|combobox)$/, name: /search/i },
    { label: 'link Previous topic or Index', role: /^link$/, name: /^(index|modules|next|previous)/i },
    { label: 'link Python', role: /^link$/, name: /^python$/i },
  ] },
  { id: 'google-flights', url: 'https://www.google.com/travel/flights?hl=en', targets: [
    { label: 'Where from', role: TEXTISH, name: /where from/i },
    { label: 'Where to', role: TEXTISH, name: /where to/i },
    { label: 'Search button', role: /^button$/, name: /^search/i },
  ] },
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect', targets: [
    { label: 'search', role: /^(button|textbox|searchbox|combobox)$/, name: /search/i },
    { label: 'link Reference', role: /^link$/, name: /^references?$/i },
    { label: 'link Guides', role: /^link$/, name: /^guides?$/i },
  ] },
];

const AX_INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'spinbutton', 'checkbox', 'radio',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'switch', 'tab',
  'treeitem', 'gridcell', 'columnheader', 'rowheader']);

type Item = { role: string; name: string };
function parseItems(view: string): Item[] {
  const items: Item[] = [];
  for (const raw of view.split('\n')) {
    const m = /^\s*\[\d+\] (\S+)(.*)$/.exec(raw);
    if (!m) continue;
    let rest = m[2]!.replace(/ ="[^"]*"$/, '').replace(/ <[^>]*>$/, '').replace(/ \(h\d\)$/, '');
    const q = /^ "(.*)"$/.exec(rest);
    items.push({ role: m[1]!, name: (q ? q[1]! : '').replace(/\s+/g, ' ').trim() });
  }
  return items;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]!; };
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const bin = CANDIDATES.find((p) => p && existsSync(p));
  if (!bin) throw new Error('no browser binary found; set BENCH_BROWSER');
  const profile = mkdtempSync(join(tmpdir(), 'domview-bench.'));
  const proc = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr!.on('data', (c) => { err += c; });
  for (let i = 0; i < 150 && !/DevTools listening on (ws:\S+)/.test(err); i++) await sleep(100);
  const wsUrl = /DevTools listening on (ws:\S+)/.exec(err)?.[1];
  if (!wsUrl) { proc.kill(); throw new Error('browser did not report a DevTools URL'); }
  return { bin, proc, profile, wsUrl };
}

type Methods = 'A' | 'B' | 'Btext' | 'Ball';
const METHOD_LABEL: Record<Methods, string> = {
  A: 'A: getFullAXTree + axView({interactive:true})',
  B: 'B: domView() viewport',
  Btext: 'B+text: domView({text:true})',
  Ball: 'B-all: domView({viewport:false,max:100000})',
};

async function main() {
  const { bin, proc, profile, wsUrl } = await launch();
  const pid = proc.pid!;
  console.error(`browser pid ${pid} (${bin}) ${wsUrl.replace(/\/[0-9a-f-]{20,}$/, '/<id>')}`);
  const session = new Session();
  let fixtureServer: ReturnType<typeof createServer> | undefined;
  try {
    await session.connect({ wsUrl });
    const version = (await session.domains.Browser.getVersion()) as { product: string; userAgent: string };
    const { targetId } = (await session.domains.Target.createTarget({ url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await session.domains.Target.attachToTarget({ targetId, flatten: true })) as { sessionId: string };
    const call = (method: string, params: unknown = {}) => session._call(method, params, { sessionId }) as Promise<any>;
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setUserAgentOverride', { userAgent: UA });
    const driver: DomViewDriver = {
      evaluate: async (expression) => {
        const r = await call('Runtime.evaluate', { expression, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result?.value;
      },
      mouse: async (type, x, y) => { await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); },
      insertText: async (text) => { await call('Input.insertText', { text }); },
    };

    const run = async (m: Methods): Promise<string> => {
      if (m === 'A') {
        const { nodes } = await call('Accessibility.getFullAXTree', {});
        return axView(nodes, { interactive: true });
      }
      const opts: DomViewOptions = m === 'Btext' ? { text: true } : m === 'Ball' ? { viewport: false, max: 100000 } : {};
      return runDomView(driver, opts);
    };

    const results: any[] = [];
    const dropped: { id: string; why: string }[] = [];
    for (const page of PAGES) {
      let loaded = false;
      let finalUrl = '';
      let lastStatus = 0;
      for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
        try {
          await call('Page.navigate', { url: page.url });
          for (let i = 0; i < 150; i++) {
            const r = await call('Runtime.evaluate', {
              expression: 'JSON.stringify([location.href, document.readyState, document.body ? document.body.innerText.length : 0, (performance.getEntriesByType("navigation")[0] || {}).responseStatus || 0])',
              returnByValue: true,
            });
            const [href, state, kids, status] = JSON.parse(r.result?.value ?? '["","",0,0]');
            lastStatus = status;
            if (state === 'complete' && href !== 'about:blank' && kids > 50 && status < 400) { finalUrl = href; loaded = true; break; }
            if (state === 'complete' && status >= 400) break; // HTTP error page: retry the navigation
            await sleep(100);
          }
          if (loaded) await sleep(3000); // let client-rendered controls settle
        } catch (e) { console.error(`${page.id} attempt ${attempt}: ${(e as Error).message}`); }
      }
      if (!loaded) { dropped.push({ id: page.id, why: `did not load in 3 attempts (last HTTP status ${lastStatus})` }); continue; }

      const methods: Methods[] = ['A', 'B', 'Btext', 'Ball'];
      const times: Record<Methods, number[]> = { A: [], B: [], Btext: [], Ball: [] };
      const cold: Partial<Record<Methods, number>> = {};
      const outputs: Partial<Record<Methods, string>> = {};
      // Warmup round (first call pays one-time AX enable / script compile); recorded as `cold`, not in stats.
      for (const m of methods) {
        const t0 = performance.now();
        outputs[m] = await run(m);
        cold[m] = performance.now() - t0;
      }
      for (let i = 0; i < RUNS; i++) {
        for (const m of methods) {
          const t0 = performance.now();
          outputs[m] = await run(m);
          times[m].push(performance.now() - t0);
        }
      }

      const axNoRefs = axView((await call('Accessibility.getFullAXTree', {})).nodes, { interactive: true, refs: false });
      const itemsA = parseItems(outputs.A!).filter((i) => AX_INTERACTIVE.has(i.role));
      const items: Record<Methods, Item[]> = {
        A: itemsA, B: parseItems(outputs.B!), Btext: parseItems(outputs.Btext!), Ball: parseItems(outputs.Ball!),
      };
      const stats: any = {};
      for (const m of methods) {
        stats[m] = {
          medianMs: +median(times[m]).toFixed(1), p95Ms: +p95(times[m]).toFixed(1), coldMs: +cold[m]!.toFixed(1),
          chars: outputs[m]!.length, tokens: Math.round(outputs[m]!.length / 4), elements: items[m].length,
          rawMs: times[m].map((t) => +t.toFixed(1)),
        };
      }
      stats.A.charsNoRefs = axNoRefs.length;

      const found = (m: Methods, t: Target) => items[m].some((i) => t.role.test(i.role) && t.name.test(i.name));
      const targets = page.targets.map((t) => ({ label: t.label, A: found('A', t), B: found('B', t), Ball: found('Ball', t) }));
      const names = (xs: Item[]) => new Set(xs.map((i) => i.name.toLowerCase()).filter(Boolean));
      const nA = names(items.A), nB = names(items.B), nAll = names(items.Ball);
      const diff = (x: Set<string>, y: Set<string>) => [...x].filter((n) => !y.has(n));
      const overlap = (x: Set<string>) => ({
        both: [...nA].filter((n) => x.has(n)).length,
        axOnly: diff(nA, x).length, domOnly: diff(x, nA).length,
        axOnlyExamples: diff(nA, x).slice(0, 8), domOnlyExamples: diff(x, nA).slice(0, 8),
      });
      results.push({
        id: page.id, url: page.url, finalUrl, title: (await driver.evaluate('document.title')) as string,
        stats, targets, overlapViewport: overlap(nB), overlapAll: overlap(nAll),
        sampleB: outputs.B!.split('\n').slice(0, 12), sampleA: outputs.A!.split('\n').slice(0, 12),
      });
      console.error(`${page.id}: A ${stats.A.medianMs}ms/${stats.A.chars}ch/${stats.A.elements}el  B ${stats.B.medianMs}ms/${stats.B.chars}ch/${stats.B.elements}el`);
    }

    // Click check against a local fixture: domClick a known link and confirm navigation.
    fixtureServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/target'
        ? '<title>Target reached</title><p>ok</p>'
        : '<title>Fixture</title><nav><a href="/other">Other</a> <a href="/target">Known link</a></nav><button>Noise</button>');
    });
    await new Promise<void>((r) => fixtureServer!.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(fixtureServer.address() as { port: number }).port}`;
    await call('Page.navigate', { url: `${origin}/` });
    for (let i = 0; i < 100; i++) {
      if ((await driver.evaluate('location.pathname + document.readyState')) === '/complete') break;
      await sleep(50);
    }
    const view = await runDomView(driver);
    const ref = Number(/\[(\d+)\] link "Known link"/.exec(view)?.[1]);
    await runDomClick(driver, ref);
    let title = '';
    for (let i = 0; i < 50 && title !== 'Target reached'; i++) { await sleep(100); title = (await driver.evaluate('document.title')) as string; }
    const click = { ref, navigated: title === 'Target reached', title };

    await call('Page.navigate', { url: 'about:blank' }).catch(() => {});
    const out = {
      date: '2026-11-08', browser: version.product, binary: bin, runs: RUNS, warmupRounds: 1,
      viewport: '1280x800', userAgentOverride: UA, methods: METHOD_LABEL, results, dropped, click,
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${OUT}`);
  } finally {
    fixtureServer?.close();
    try { session.close(); } catch { /* best-effort */ }
    // Kill only the browser this script launched, by PID. The throwaway profile
    // under the OS temp dir is left for the OS to reap.
    const exited = new Promise((r) => proc.once('exit', r));
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, sleep(5000)]);
    console.error(`browser ${pid} stopped; profile ${profile}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
