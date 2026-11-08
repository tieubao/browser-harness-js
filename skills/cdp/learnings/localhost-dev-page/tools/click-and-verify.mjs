// learnings/localhost-dev-page/tools/click-and-verify.mjs
// For a Chromium instance the daemon's own Session is not bound to: a throwaway
// --remote-debugging-port instance (see notes/overview.md, trap 2). The tool opens
// its OWN Browser (its own Session and WebSocket) on that port and drives the page
// through the Page API, so ctx.page / ctx.session (the daemon's browser) are unused.
// Called as clickAndVerify(ctx, args). Porting contract: learnings/PORTING.md.
import { Browser } from "../../../sdk/browser.ts";

export async function clickAndVerify(ctx, args) {
  const port = args.port || 9333;
  const before4 = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const before6 = await fetchJson(`http://[::1]:${port}/json/list`).catch(() => []);
  const host = before4.length ? "127.0.0.1" : "[::1]";
  const targets = before4.length ? before4 : before6;
  const found = targets.find((t) => t.type === "page" && (t.url || "").includes(args.urlIncludes));
  if (!found) throw new Error(`no page target matching "${args.urlIncludes}" on port ${port} (checked 127.0.0.1 and [::1])`);

  const own = new Browser();
  try {
    await own.connect({ port, host });
    const page = await own.attach(found.id, { allowedOrigins: [new URL(found.url).origin] });
    const evaluate = async (expression) => {
      const r = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      return r.result?.value;
    };
    const before = await evaluate(args.before);
    await evaluate(`document.querySelector(${JSON.stringify(args.selector)}).click()`);
    await new Promise((r) => setTimeout(r, args.delayMs || 2000));
    const after = await evaluate(args.after);
    return { before, after };
  } finally {
    own.disconnect();
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
