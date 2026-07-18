#!/usr/bin/env node
// pipe-browse: drive a Chromium profile over the CDP *pipe* (--remote-debugging-pipe).
// No TCP debug port ever opens, so only THIS process can speak CDP to the browser:
// the "whitelist of one" for money-adjacent surfaces (banks, anything where an open
// localhost debug port would expose the whole session's cookies to any local process
// via Network.getAllCookies).
//
// This is the portless sibling of the WebSocket-attach harness (cdp skill /
// browser-harness-js): that one attaches to an ALREADY-RUNNING, already-debuggable
// browser over a TCP port; this one LAUNCHES its own Chromium with the pipe
// transport, so there's no port to attach to (or attack) in the first place. Reach
// for this skill instead of gsearch/cdp for a sensitive login session; reach for
// gsearch/cdp for everything else (it's faster to set up: no launch, attaches to
// whatever's already open).
//
// Playwright launches Chromium with the pipe transport by default; this wrapper
// adds named persistent profiles (login survives across invocations) and four
// verbs that cover the explore-distill loop.
//
// Usage:
//   pipe-browse open <profile> <url>          headed; user logs in, closes window
//   pipe-browse snap <profile> <url>          print title/url + aria snapshot
//   pipe-browse shot <profile> <url> <out>    screenshot to file
//   pipe-browse run  <profile> <steps.mjs>    steps file exports: async (page, ctx) => {}
// Options: --headed (default for open, off elsewhere), --exe <chromium-path>
//
// Profiles live under ~/.local/share/pipe-browse/profiles/<name>; each is
// single-purpose by policy (one site per profile, e.g. "acb").

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--headed') flags.headed = true;
  else if (args[i] === '--exe') flags.exe = args[++i];
  else pos.push(args[i]);
}
const [verb, profileName, ...rest] = pos;

if (!verb || !profileName || (verb !== 'open' && rest.length === 0)) {
  console.error('usage: pipe-browse <open|snap|shot|run> <profile> <url|steps.mjs> [out.png] [--headed] [--exe path]');
  process.exit(2);
}

// Reject anything that isn't a bare directory-name-shaped string BEFORE it
// ever reaches resolve(). Without this, an absolute path or a "../" segment
// in profileName escapes ~/.local/share/pipe-browse/profiles/ entirely --
// worst case, it points launchPersistentContext at a REAL, everyday browser
// profile (cookies/logins for every site you use daily), which is strictly
// worse than the TCP-debug-port exposure this whole tool exists to avoid.
// profileName can come from an agent-supplied CLI arg, so treat it as
// untrusted input, not just a typo guard.
if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
  console.error(`pipe-browse: profile name must be alphanumeric/underscore/hyphen only, got: ${JSON.stringify(profileName)}`);
  process.exit(2);
}

const profileDir = resolve(homedir(), '.local/share/pipe-browse/profiles', profileName);
mkdirSync(profileDir, { recursive: true, mode: 0o700 });

const headless = verb === 'open' ? false : !flags.headed;
const ctx = await chromium.launchPersistentContext(profileDir, {
  headless,
  // Chromium's OS-level renderer sandbox stays ON (Playwright's default
  // otherwise pushes --no-sandbox, meant for root/Docker/CI environments,
  // not a normal user session) -- this tool exists to protect sensitive
  // (bank/brokerage) pages, so the sandbox should stay up against a
  // malicious ad or third-party script on exactly those pages.
  chromiumSandbox: true,
  ...(flags.exe ? { executablePath: flags.exe } : {}),
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

try {
  if (verb === 'open') {
    const url = rest[0] ?? 'about:blank';
    if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log(`pipe-browse: headed session on profile "${profileName}". Log in, then close the window.`);
    await ctx.waitForEvent('close', { timeout: 0 });
  } else if (verb === 'snap') {
    await page.goto(rest[0], { waitUntil: 'networkidle' });
    console.log(`# ${await page.title()}\n# ${page.url()}\n`);
    console.log(await page.locator('body').ariaSnapshot());
  } else if (verb === 'shot') {
    await page.goto(rest[0], { waitUntil: 'networkidle' });
    await page.screenshot({ path: rest[1] ?? 'shot.png', fullPage: false });
    console.log(`saved ${rest[1] ?? 'shot.png'}`);
  } else if (verb === 'run') {
    const mod = await import(resolve(rest[0]));
    await mod.default(page, ctx);
  } else {
    console.error(`unknown verb: ${verb}`);
    process.exitCode = 2;
  }
} finally {
  if (verb !== 'open') await ctx.close();
}
