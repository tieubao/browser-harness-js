/**
 * ytdl — a self-contained YouTube downloader that runs as a Bun CLI.
 * No external `yt-dlp` binary: the innerTube player-API call, client
 * impersonation, n-signature / signature decipher (via ./solver), and the
 * throttled multi-connection download are all implemented here.
 *
 * The browser is OPTIONAL, not required. The engine is Bun (HTTP + AST solver
 * + parallel download + ffmpeg). When the `browser-harness-js` CLI is on PATH
 * and a YouTube tab is connected, ytdl reads the authed cookie jar + signature
 * timestamp from it to crack made-for-kids / age-gated / members-only content
 * via the `web_embedded` client. Without a browser, ytdl still works for public
 * videos via the unauthed `android_vr` client.
 *
 * Strategy (mirrors what yt-dlp does, in JS):
 *   1. Impersonate a SABR-free innerTube client and call /youtubei/v1/player.
 *      - `android_vr` (jsless, SABR-free at 1.65.10) is the primary: its format
 *        URLs come back direct, no signatureCipher, no `n` — nothing to solve.
 *      - `web_embedded` is the fallback for made-for-kids / age-gated / members-only
 *        content that returns UNPLAYABLE on android_vr. It needs an embedder
 *        identity (thirdParty.embedUrl) + encryptedHostFlags + signatureTimestamp,
 *        and its URLs carry an `n` param that must be transformed or YouTube 403s.
 *   2. Solve any `n` / `signatureCipher` on the returned URLs using the page's
 *      own player JS (base.js) via the vendored EJS solver (./solver).
 *   3. Download. Muxed itag 18 streams unthrottled on one connection; adaptive
 *      (HD) streams are server-capped to ~26 KB/s per connection, so we open
 *      many concurrent `Range:` requests — each gets its own full-speed burst.
 *      HD = video-only + audio-only, muxed with ffmpeg.
 */
import { solveNsig, solveSig } from './solver/solver.ts';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const WEB_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'; // public web innerTube key
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Common itags. Muxed = audio+video in one file; adaptive = one stream each.
const ITAGS: Record<number, { container: string; hasVideo: boolean; hasAudio: boolean }> = {
  18: { container: 'mp4', hasVideo: true, hasAudio: true },
  22: { container: 'mp4', hasVideo: true, hasAudio: true },
  137: { container: 'mp4', hasVideo: true, hasAudio: false },
  136: { container: 'mp4', hasVideo: true, hasAudio: false },
  135: { container: 'mp4', hasVideo: true, hasAudio: false },
  134: { container: 'mp4', hasVideo: true, hasAudio: false },
  248: { container: 'webm', hasVideo: true, hasAudio: false },
  247: { container: 'webm', hasVideo: true, hasAudio: false },
  140: { container: 'm4a', hasVideo: false, hasAudio: true },
  251: { container: 'webm', hasVideo: false, hasAudio: true },
  250: { container: 'webm', hasVideo: false, hasAudio: true },
  249: { container: 'webm', hasVideo: false, hasAudio: true },
};

export interface YtFormat {
  itag: number;
  mime: string;
  container: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  filesize?: number;
  url: string;
}

export interface YtInfo {
  videoId: string;
  title: string;
  author: string;
  duration_s: number;
  formats: YtFormat[];
  clientUsed: string;
}

export interface YtdlOpts {
  client?: 'android_vr' | 'web_embedded';
  quality?: string;        // '360p' | '720p' | '1080p' | 'best' | 'audio'
  outDir?: string;
  outName?: string;
  concurrency?: number;   // default 16
  cookies?: string;        // override; else read from a live tab if available
  visitorData?: string;
  embedUrl?: string;       // default https://www.reddit.com/
  verbose?: boolean;
}

function log(msg: string, verbose?: boolean) {
  if (verbose) process.stderr.write(`ytdl: ${msg}\n`);
}

export function getVideoId(urlOrId: string): string {
  const s = urlOrId.trim();
  if (/^[A-Za-z0-9_-]{6,}$/.test(s) && !s.includes('/') && !s.includes('.')) return s;
  const u = new URL(s);
  if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
  const v = u.searchParams.get('v');
  if (v) return v;
  const m = u.pathname.match(/\/(embed|shorts|v)\/([^/?#]+)/);
  if (m) return m[2];
  throw new Error(`ytdl: could not parse videoId from ${urlOrId}`);
}

// Optional bridge to a live browser tab via the `browser-harness-js` CLI.
// Returns null if the CLI is absent or no YouTube tab is connected — caller
// falls back to standalone scraping. Never throws.
function bhjs(snippet: string, timeoutMs = 20000): string | null {
  try {
    const r = spawnSync('browser-harness-js', [snippet], { encoding: 'utf8', timeout: timeoutMs });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

// One browser round-trip: open the (optionally logged-in) watch page and read the
// inlined ytInitialPlayerResponse — the player data the page rendered with full
// auth (cookies, poToken's effect, the real client context). Zero client
// impersonation, zero header spoofing: the page *is* the client. Also returns the
// player JS URL (for n-solve) and the cookie jar (for the HD web_embedded fallback).
//
// The inlined web response carries a discrete itag 18 (360p muxed) but adaptive
// formats are SABR-only (no discrete HD URLs) — so this is primary for 360p; for
// HD we still need the Bun-side web_embedded client, which uses these cookies.
// Returns null if the browser isn't available; caller falls back to android_vr.
function browserResolve(vid: string): { pr: any; playerJsUrl: string | null; cookies: string | null; loggedIn: boolean } | null {
  // Open the watch page in the background and poll for ytInitialPlayerResponse —
  // it's inlined in the initial HTML, available before the player boots, so we
  // don't wait for networkIdle. Pause any <video> ASAP to stop the page's own
  // googlevideo streaming (which would rate-limit collide with our download on
  // the same IP). Then grab the cookie jar. One round-trip, minimal autoplay.
  const snippet = `
if (!session.isConnected()) { try { await session.connect({ port: 9222, host: "127.0.0.1" }) } catch { try { await session.connect() } catch (e) { throw new Error("connect: " + e.message) } } }
const VID = ${JSON.stringify(vid)};
const t = await session.Target.createTarget({ url: "https://www.youtube.com/watch?v=" + VID, background: true })
const { sessionId } = await session.Target.attachToTarget({ targetId: t.targetId, flatten: true })
try {
  await cdp(sessionId, "Network.enable", {})
  await cdp(sessionId, "Page.enable", {})
  const probe = "window.ytInitialPlayerResponse ? JSON.stringify({ pr: window.ytInitialPlayerResponse, playerJsUrl: (window.ytcfg && window.ytcfg.data_ && window.ytcfg.data_.PLAYER_JS_URL) || null, loggedIn: !!document.cookie.match(/SAPISID/) }) : null"
  let pageData = null
  for (let i = 0; i < 40; i++) {
    try { const ev = await cdp(sessionId, "Runtime.evaluate", { expression: probe, returnByValue: true }); if (ev.result.value) { pageData = JSON.parse(ev.result.value); break } } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  try { await cdp(sessionId, "Runtime.evaluate", { expression: "document.querySelectorAll('video').forEach(v => v.pause())" }) } catch {}
  let cookies = ""
  try { const r = await cdp(sessionId, "Network.getCookies", { urls: ["https://www.youtube.com/"] }); cookies = r.cookies.map(c => c.name + "=" + c.value).join("; ") } catch {}
  return JSON.stringify({ page: pageData, cookies })
} finally {
  session.closeTab(t.targetId, sessionId).catch(() => {})
}`
  const out = bhjs(snippet, 30000);
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    const page = parsed.page;
    if (!page?.pr) return null;
    return { pr: page.pr, playerJsUrl: page.playerJsUrl, cookies: parsed.cookies || null, loggedIn: !!page.loggedIn };
  } catch { return null; }
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers } });
  if (!res.ok) throw new Error(`ytdl: fetch ${res.status} ${url}`);
  return res.text();
}

function scrape(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

async function scrapeVisitorData(videoId: string): Promise<string> {
  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
  const v = scrape(html, /"visitorData":"([^"]+)"/);
  if (!v) throw new Error('ytdl: no visitorData in watch HTML');
  return v;
}

let _baseJsCache: { url: string; src: string } | null = null;

// The EJS n/sig solver produces correct results for the `main` player JS variant
// (player_ias.vflset/en_US/base.js) but WRONG results for the `es6` variant the
// watch page actually loads (player_es6.vflset). yt-dlp forces `main` for the
// same reason. Extract the player_id from whatever URL we have, then construct
// the main-variant URL — never trust the tab's PLAYER_JS_URL variant directly.
const MAIN_VARIANT = 'player_ias.vflset/en_US/base.js';
function toMainVariantUrl(playerJsUrl: string): string {
  const full = playerJsUrl.startsWith('http') ? playerJsUrl : `https://www.youtube.com${playerJsUrl}`;
  const m = full.match(/\/s\/player\/([A-Za-z0-9_-]+)\//);
  if (m) return `https://www.youtube.com/s/player/${m[1]}/${MAIN_VARIANT}`;
  return full;
}

async function getBaseJs(videoId: string, tabSts: number | null, tabPlayerJsUrl: string | null): Promise<{ src: string; sts: number | null }> {
  let playerJsUrl = tabPlayerJsUrl || null;
  let sts: number | null = tabSts ?? null;
  if (!playerJsUrl || sts == null) {
    const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`);
    if (!playerJsUrl) playerJsUrl = scrape(html, /"PLAYER_JS_URL":"([^"]+)"/);
    if (sts == null) sts = Number(scrape(html, /"STS":(\d+)/) ?? '') || null;
  }
  if (!playerJsUrl) throw new Error('ytdl: no PLAYER_JS_URL');
  const full = toMainVariantUrl(playerJsUrl);
  if (_baseJsCache?.url === full) {
    if (sts == null) sts = Number(scrape(_baseJsCache.src, /(?:signatureTimestamp|sts)\s*:\s*(\d{5})/) ?? '') || null;
    return { src: _baseJsCache.src, sts };
  }
  const src = await fetchText(full);
  _baseJsCache = { url: full, src };
  if (sts == null) sts = Number(scrape(src, /(?:signatureTimestamp|sts)\s*:\s*(\d{5})/) ?? '') || null;
  return { src, sts };
}

async function callPlayer(videoId: string, clientNum: number, clientVersion: string, ua: string, visitorData: string, body: any, cookies?: string): Promise<any> {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${WEB_KEY}`, {
    method: 'POST',
    headers: {
      'X-YouTube-Client-Name': String(clientNum),
      'X-YouTube-Client-Version': clientVersion,
      'X-Goog-Visitor-Id': visitorData,
      'User-Agent': ua,
      'Origin': 'https://www.youtube.com',
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) throw new Error(`ytdl: player API error: ${j.error.message}`);
  return j;
}

async function callAndroidVr(videoId: string, visitorData: string, cookies?: string): Promise<any> {
  const AV_UA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
  return callPlayer(videoId, 28, '1.65.10', AV_UA, visitorData, {
    context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' } },
    videoId,
  }, cookies);
}

async function callWebEmbedded(videoId: string, opts: YtdlOpts, cookies?: string, tabSts?: number | null): Promise<any> {
  const embedUrl = opts.embedUrl || 'https://www.reddit.com/';
  // Fetch the embed page with the embedder as Referer so the server returns a
  // valid (non-Error-153) encryptedHostFlags + embeddedPlayerEncryptedContext.
  const html = await fetchText(`https://www.youtube.com/embed/${videoId}?html5=1`, { Referer: embedUrl });
  const clientVersion = scrape(html, /"clientVersion":"([^"]+)"/);
  const visitorData = opts.visitorData || scrape(html, /"visitorData":"([^"]+)"/);
  const encryptedHostFlags = scrape(html, /"encryptedHostFlags":"([^"]+)"/);
  const embeddedPlayerEncryptedContext = scrape(html, /"embeddedPlayerEncryptedContext":"([^"]+)"/);
  if (!clientVersion || !visitorData || !encryptedHostFlags) throw new Error('ytdl: web_embedded: incomplete embed context (try a different embedUrl)');

  const { sts } = await getBaseJs(videoId, tabSts ?? null, null);
  if (sts == null) throw new Error('ytdl: web_embedded: no signatureTimestamp (STS)');

  return callPlayer(videoId, 56, clientVersion, WEB_UA, visitorData, {
    context: {
      client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion, visitorData },
      thirdParty: {
        embedUrl,
        embeddedPlayerContext: { embeddedPlayerEncryptedContext, ancestorOriginsSupported: false },
      },
    },
    videoId,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: sts, encryptedHostFlags } },
    contentCheckOk: true,
    racyCheckOk: true,
  }, cookies);
}

function parseSigCipher(sc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(sc)) out[k] = v;
  return out;
}

async function solveFormatUrl(fmt: any, baseJs: string): Promise<string> {
  let url = fmt.url;
  if (!url && fmt.signatureCipher) {
    const sc = parseSigCipher(fmt.signatureCipher);
    const solved = solveSig(baseJs, sc.s);
    url = `${sc.url}&${sc.sp || 'signature'}=${encodeURIComponent(solved)}`;
  }
  if (!url) throw new Error('ytdl: format has no url or signatureCipher');
  const u = new URL(url);
  const n = u.searchParams.get('n');
  if (n) {
    const solvedN = solveNsig(baseJs, n);
    u.searchParams.set('n', solvedN);
    url = u.href;
  }
  return url;
}

function toYtFormat(fmt: any, url: string): YtFormat {
  const m = ITAGS[fmt.itag];
  const mime = fmt.mimeType || '';
  const container = m?.container || (mime.includes('webm') ? 'webm' : 'mp4');
  return {
    itag: fmt.itag,
    mime,
    container,
    hasVideo: m?.hasVideo ?? mime.startsWith('video/'),
    hasAudio: m?.hasAudio ?? mime.startsWith('audio/'),
    width: fmt.width,
    height: fmt.height,
    fps: fmt.fps,
    bitrate: fmt.bitrate,
    filesize: fmt.contentLength ? Number(fmt.contentLength) : undefined,
    url,
  };
}

export async function getPlayerResponse(videoId: string, opts: YtdlOpts = {}): Promise<{ pr: any; client: string; baseJs: string | null; cookies: string | null }> {
  const vid = getVideoId(videoId);
  const verbose = opts.verbose;
  const quality = opts.quality || 'best';

  // The inlined browser response yields a discrete itag 18 (360p muxed) only —
  // adaptive is SABR-only on the web client, so no discrete HD/audio. It's primary
  // for 360p (native: full auth, poToken's effect, zero impersonation). For HD/audio
  // we lead with the discrete-URL clients (android_vr for public, web_embedded for
  // gated) and use the inlined response only as a last-resort 360p fallback.
  const isSd = quality === '360p';
  let order: string[];
  if (opts.client) {
    order = [opts.client];
  } else if (isSd) {
    // android_vr is fast + headless for public 360p; inlined (native, full auth) is
    // the gated-content fallback when android_vr returns UNPLAYABLE; web_embedded last.
    order = ['android_vr', 'inlined', 'web_embedded'];
  } else {
    order = ['android_vr', 'web_embedded', 'inlined'];
  }

  // Lazy browser resolve: only run when a client in the order needs it. For HD on a
  // public video, android_vr succeeds first and the browser is never touched.
  let browser: ReturnType<typeof browserResolve> | undefined;  // undefined = not yet attempted
  const getBrowser = (): ReturnType<typeof browserResolve> | null => {
    if (browser === undefined) browser = browserResolve(vid);
    return browser;
  };

  const tryClient = async (client: string): Promise<any | null> => {
    if (client === 'inlined') {
      const b = getBrowser();
      if (!b?.pr) return null;
      const pr = b.pr;
      const ok = pr.playabilityStatus?.status === 'OK' && (pr.streamingData?.formats || []).some((f: any) => f.itag === 18 && f.url);
      log(`inlined: ${ok ? 'OK (itag 18 discrete)' : (pr.playabilityStatus?.status + ' / no itag-18 discrete')}`, verbose);
      return ok ? pr : null;
    }
    if (client === 'android_vr') {
      const b = getBrowser();
      const cookies = opts.cookies || b?.cookies || undefined;
      const visitorData = opts.visitorData || await scrapeVisitorData(vid);
      log(`android_vr player call`, verbose);
      const pr = await callAndroidVr(vid, visitorData, cookies);
      if (pr.playabilityStatus?.status === 'OK') return pr;
      log(`android_vr: ${pr.playabilityStatus?.status} ${pr.playabilityStatus?.reason || ''}`, verbose);
      return null;
    }
    if (client === 'web_embedded') {
      const b = getBrowser();
      const cookies = opts.cookies || b?.cookies || undefined;
      log(`web_embedded player call`, verbose);
      const pr = await callWebEmbedded(vid, opts, cookies, null);
      if (pr.playabilityStatus?.status === 'OK') return pr;
      log(`web_embedded: ${pr.playabilityStatus?.status} ${pr.playabilityStatus?.reason || ''}`, verbose);
      return null;
    }
    return null;
  };

  let pr: any = null, client = '';
  for (const c of order) {
    try { pr = await tryClient(c); if (pr) { client = c; break; } }
    catch (e: any) { log(`${c} threw: ${e.message}`, verbose); }
  }
  if (!pr) throw new Error('ytdl: no client returned OK (video may be private/DRM, or pass client:"web_embedded")');

  const all = [...(pr.streamingData?.formats || []), ...(pr.streamingData?.adaptiveFormats || [])];
  const needsSolver = all.some((f) => f.url && new URL(f.url).searchParams.has('n')) || all.some((f) => f.signatureCipher);
  const baseJs = needsSolver ? (await getBaseJs(vid, null, getBrowser()?.playerJsUrl)).src : null;
  const cookies = opts.cookies || getBrowser()?.cookies || null;
  return { pr, client, baseJs, cookies };
}

export async function info(urlOrId: string, opts: YtdlOpts = {}): Promise<YtInfo> {
  const vid = getVideoId(urlOrId);
  const { pr, client, baseJs } = await getPlayerResponse(vid, opts);
  const raw = [...(pr.streamingData?.formats || []), ...(pr.streamingData?.adaptiveFormats || [])];
  const formats: YtFormat[] = [];
  for (const f of raw) {
    if (!f.url && !f.signatureCipher) continue;  // SABR-only (no discrete URL) — expected on the inlined web response, skip silently
    try {
      const url = baseJs ? await solveFormatUrl(f, baseJs) : f.url;
      if (!url) continue;
      formats.push(toYtFormat(f, url));
    } catch (e: any) { log(`skip itag ${f.itag}: ${e.message}`, opts.verbose); }
  }
  // muxed first, then height desc, then bitrate desc
  formats.sort((a, b) => (Number(!!b.hasAudio && !!b.hasVideo) - Number(!!a.hasAudio && !!a.hasVideo)) || (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return {
    videoId: vid,
    title: pr.videoDetails?.title || vid,
    author: pr.videoDetails?.author || '',
    duration_s: Number(pr.videoDetails?.lengthSeconds || 0),
    formats,
    clientUsed: client,
  };
}

export async function formats(urlOrId: string, opts: YtdlOpts = {}): Promise<YtFormat[]> {
  return (await info(urlOrId, opts)).formats;
}

function sanitizeTitle(s: string): string {
  return s.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'yt_video';
}

async function discoverTotal(url: string, referer?: string): Promise<number | null> {
  // googlevideo 405s HEAD; use a 1-byte range GET and read Content-Range.
  try {
    const res = await fetchRetry(url, { 'User-Agent': WEB_UA, ...(referer ? { Referer: referer } : {}), Range: 'bytes=0-0' });
    if (!res.ok && res.status !== 206) return null;
    const cr = res.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)$/);
      if (m) return Number(m[1]);
    }
    const cl = Number(res.headers.get('content-length') || '');
    return cl || null;
  } catch {
    return null;
  }
}

// googlevideo transiently 403s a request and 206s it on retry — yt-dlp retries
// on 403/429 for the same reason. Bounded retries with short backoff.
async function fetchRetry(url: string, headers: Record<string, string>, attempts = 4): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, { headers });
    if (res.status !== 403 && res.status !== 429) return res;
    // drain to allow connection reuse, then back off
    try { await res.arrayBuffer(); } catch {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return fetch(url, { headers });
}

/** Concurrent multi-connection range download — dodges the per-connection throttle. */
async function downloadParallel(url: string, outPath: string, concurrency = 16, referer?: string): Promise<number> {
  const hdrs = { 'User-Agent': WEB_UA, ...(referer ? { Referer: referer } : {}) };
  const total = await discoverTotal(url, referer);
  if (!total) {
    const res = await fetchRetry(url, hdrs);
    if (!res.ok && res.status !== 206) throw new Error(`ytdl: download ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('ytdl: download returned 0 bytes (URL expired or missing referer)');
    writeFileSync(outPath, Buffer.from(buf));
    return buf.byteLength;
  }
  const part = Math.ceil(total / concurrency);
  const parts: { idx: number; start: number; end: number }[] = [];
  for (let i = 0; i < concurrency; i++) {
    const start = i * part;
    const end = Math.min(start + part - 1, total - 1);
    if (start > end) break;
    parts.push({ idx: i, start, end });
  }
  const partPaths = parts.map((p) => `${outPath}.part${p.idx}`);
  await Promise.all(parts.map(async (p) => {
    const res = await fetchRetry(url, { ...hdrs, Range: `bytes=${p.start}-${p.end}` });
    if (!res.ok && res.status !== 206) throw new Error(`ytdl: range ${p.start}-${p.end} → ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error(`ytdl: range ${p.start}-${p.end} returned 0 bytes`);
    writeFileSync(partPaths[p.idx], Buffer.from(buf));
  }));
  writeFileSync(outPath, Buffer.concat(parts.map((_, i) => readFileSync(`${outPath}.part${i}`))));
  for (const pp of partPaths) { try { unlinkSync(pp); } catch {} }
  return total;
}

function runFfmpeg(cmd: string[], quiet = false): number {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: quiet ? 'ignore' : 'inherit' });
  return r.status ?? 1;
}

function pickFormats(formats: YtFormat[], quality: string): { video?: YtFormat; audio?: YtFormat; muxed?: YtFormat } {
  const muxed = formats.filter((f) => f.hasVideo && f.hasAudio);
  const video = formats.filter((f) => f.hasVideo && !f.hasAudio);
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo);

  if (quality === 'audio') {
    if (!audio[0]) throw new Error('ytdl: no audio-only format');
    return { audio: audio[0] };
  }
  const byQ = (arr: YtFormat[], q: string) => {
    if (q === 'best') return arr[0];
    const targetH = parseInt(q, 10);
    if (targetH) {
      const exact = arr.find((f) => f.height === targetH);
      if (exact) return exact;
      const below = arr.filter((f) => (f.height ?? 0) <= targetH);
      if (below.length) return below[0];
    }
    return arr[0];
  };
  if (quality === '360p' || quality === '720p') {
    const m = byQ(muxed, quality);
    if (m) return { muxed: m };
  }
  const v = byQ(video, quality);
  if (!v) {
    const m = byQ(muxed, quality);
    if (m) return { muxed: m };
    throw new Error('ytdl: no suitable video format');
  }
  return { video: v, audio: audio[0] };
}

export async function download(urlOrId: string, opts: YtdlOpts = {}): Promise<string> {
  const vid = getVideoId(urlOrId);
  const quality = opts.quality || 'best';
  const outDir = opts.outDir || `${homedir()}/Downloads`;
  const concurrency = opts.concurrency || 16;

  const inf = await info(vid, opts);
  const pick = pickFormats(inf.formats, quality);
  const safe = sanitizeTitle(opts.outName || inf.title);
  // Referer per client: inlined/web URLs are signed to youtube.com; web_embedded
  // URLs to the embedder; android_vr URLs need none.
  const referer = inf.clientUsed === 'web_embedded' ? (opts.embedUrl || 'https://www.reddit.com/')
    : inf.clientUsed === 'inlined' ? 'https://www.youtube.com/'
    : undefined;

  if (pick.muxed) {
    const out = `${outDir}/${safe}.${pick.muxed.container}`;
    log(`downloading itag ${pick.muxed.itag} (muxed ${pick.muxed.height || ''}p) → ${out}`, opts.verbose);
    // Muxed itag 18 is unthrottled — single-stream is faster and avoids parallel-range 403s.
    const n = await downloadParallel(pick.muxed.url, out, 1, referer);
    log(`done: ${(n / 1024 / 1024).toFixed(1)} MB`, opts.verbose);
    return out;
  }
  // Audio-only pick (adaptive audio is throttled → keep parallel).
  if (pick.audio && !pick.video) {
    const a = pick.audio;
    const out = `${outDir}/${safe}.${a.container}`;
    log(`downloading itag ${a.itag} (audio ${a.container}) → ${out}`, opts.verbose);
    const n = await downloadParallel(a.url, out, concurrency, referer);
    log(`done: ${(n / 1024 / 1024).toFixed(1)} MB`, opts.verbose);
    return out;
  }
  if (!pick.video) throw new Error('ytdl: picked neither muxed nor video');
  const audio = pick.audio;
  const vOut = `${outDir}/.ytdl_${vid}_v.${pick.video.container}`;
  const aOut = audio ? `${outDir}/.ytdl_${vid}_a.${audio.container}` : null;
  log(`downloading itag ${pick.video.itag} (video ${pick.video.height || ''}p)`, opts.verbose);
  await downloadParallel(pick.video.url, vOut, concurrency, referer);
  if (audio && aOut) {
    log(`downloading itag ${audio.itag} (audio)`, opts.verbose);
    await downloadParallel(audio.url, aOut, concurrency, referer);
  }
  const ext = pick.video.container === 'webm' && audio?.container === 'webm' ? 'webm' : 'mp4';
  // Suffix the height so HD (adaptive) doesn't overwrite a prior muxed (360p) download.
  const out = `${outDir}/${safe}_${pick.video.height || 'video'}p.${ext}`;
  const cmd = audio && aOut
    ? ['ffmpeg', '-y', '-i', vOut, '-i', aOut, '-c', 'copy', '-movflags', '+faststart', out]
    : ['ffmpeg', '-y', '-i', vOut, '-c', 'copy', '-movflags', '+faststart', out];
  log(`muxing → ${out}`, opts.verbose);
  const code = runFfmpeg(cmd, !opts.verbose);
  try { unlinkSync(vOut); } catch {}
  if (aOut) { try { unlinkSync(aOut); } catch {} }
  if (code !== 0) throw new Error(`ytdl: ffmpeg exited ${code}`);
  return out;
}
