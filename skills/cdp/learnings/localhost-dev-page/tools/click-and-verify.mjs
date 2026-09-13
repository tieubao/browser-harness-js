// learnings/localhost-dev-page/tools/click-and-verify.mjs
// Fallback for a Chromium instance the harness's own Session cannot discover:
// a throwaway --remote-debugging-port instance driven directly, not through
// ctx.session (see notes/overview.md, trap 2). Called as click-and-verify(ctx, args);
// ctx is accepted for the standard callable shape but unused, since the whole
// point is that ctx.session belongs to a different browser.
export async function clickAndVerify(ctx, args) {
  const port = args.port || 9333;
  const before4 = await fetchJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
  const before6 = await fetchJson(`http://[::1]:${port}/json/list`).catch(() => []);
  const targets = before4.length ? before4 : before6;
  const page = targets.find((t) => t.type === "page" && (t.url || "").includes(args.urlIncludes));
  if (!page) throw new Error(`no page target matching "${args.urlIncludes}" on port ${port} (checked 127.0.0.1 and [::1])`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const evaluate = (expression) => {
    const id = ++msgId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
    });
  };

  try {
    const before = await evaluate(args.before);
    await evaluate(`document.querySelector(${JSON.stringify(args.selector)}).click()`);
    await new Promise((r) => setTimeout(r, args.delayMs || 2000));
    const after = await evaluate(args.after);
    return { before: before.result?.result?.value, after: after.result?.result?.value };
  } finally {
    ws.close();
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
