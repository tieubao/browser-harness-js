// learnings/drive-google-com/tools/drive-google-com.mjs
// Pull a Drive file the signed-in browser can see but no CLI can: curl, yt-dlp with every
// browser's cookies and rclone all returned 403 on 2026-09-23 for a 668 MB .mkv shared under the
// SECOND Google account (u/1). The browser session already holds that account, so the download
// URL with `authuser=<n>` plus the "too large to scan for viruses" form submit is the whole
// recipe. The file lands in the browser's own download directory (~/Downloads on Helium; a
// Browser.setDownloadBehavior path was ignored), so the caller watches for it there.
const DOMAINS = ["drive.google.com", "drive.usercontent.google.com"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function matches(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith('.' + domain);
  } catch { return false; }
}

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

export async function status(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => DOMAINS.some((d) => matches(t.url, d)));
  if (!tab) return { state: 'no-tab', hint: 'no open tab matches ' + DOMAINS.join(', ') };
  await ctx.session.use(tab.targetId);
  return { state: 'tab', url: tab.url };
}

// Start the download of one file id as the given Google account slot (authuser=0 is the first
// signed-in account, 1 the second). Returns {state:"started"} once the request was issued, or
// {stop:"403"} / {stop:"sign-in"} when that account cannot see the file. Watch the browser's
// download directory for "<name>.crdownload" turning into the final name.
export async function download(ctx, { fileId, authuser = 0, waitMs = 8000 } = {}) {
  if (!fileId) throw new Error("fileId is required");
  const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&authuser=${authuser}&confirm=t`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  await ctx.session.use(targetId);
  await wait(waitMs);
  const text = String(await evaluate(ctx, "document.body ? document.body.innerText : ''") || "");
  if (/403\. That.s an error/i.test(text)) { await ctx.session.Target.closeTarget({ targetId }); return { stop: "403", hint: "try another authuser slot" }; }
  if (/Sign in/i.test(text) && /Google/i.test(text)) { await ctx.session.Target.closeTarget({ targetId }); return { stop: "sign-in" }; }
  // Files over ~100 MB get the "can't scan this file for viruses" interstitial; its form is the download.
  const submitted = await evaluate(ctx, `(() => { const f = document.querySelector('form'); if (!f) return false; f.submit(); return true; })()`);
  return { state: "started", interstitial: submitted, note: "file lands in the browser's download dir; the tab closes itself when the download begins" };
}
