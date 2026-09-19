// learnings/x-com/tools/post.mjs
// Compose + publish a post on X through the logged-in tab. Uses the real input path
// (mouse click into the textbox, Input.insertText for the body) and CDP file-input
// assignment for media -- never click an input[type=file], that opens the OS picker.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function mouseClick(ctx, x, y) {
  await ctx.session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function createPost(ctx, args) {
  const { text, media = [] } = args || {};
  if (!text) throw new Error("createPost: text is required");

  const { targetId } = await ctx.session.Target.createTarget({ url: "https://x.com/compose/post", background: false });
  try {
    await ctx.session.use(targetId);
    await wait(6000);

    // Refuse on logged-out (the composer redirects to the login flow).
    const state = JSON.parse((await evaluate(ctx, `JSON.stringify({
      url: location.href,
      textbox: !!document.querySelector('[data-testid=tweetTextarea_0]'),
    })`)) || "{}");
    if (!state.textbox) return { posted: false, reason: "no composer (logged out?)", url: state.url };

    // Click into the textbox, then type the whole body in one insertText call.
    const rect = JSON.parse((await evaluate(ctx,
      `JSON.stringify(document.querySelector('[data-testid=tweetTextarea_0]').getBoundingClientRect())`)) || "{}");
    await mouseClick(ctx, rect.x + rect.width / 2, rect.y + 10);
    await wait(400);
    await ctx.session.Input.insertText({ text });
    await wait(800);

    // Media: set files on the hidden input directly (works while display:none).
    if (media.length) {
      await ctx.session.DOM.enable();
      const { root } = await ctx.session.DOM.getDocument({ depth: -1 });
      const { nodeIds } = await ctx.session.DOM.querySelectorAll({ nodeId: root.nodeId, selector: "input[type=file]" });
      if (!nodeIds || !nodeIds.length) return { posted: false, reason: "no file input found" };
      await ctx.session.DOM.setFileInputFiles({ nodeId: nodeIds[0], files: media });
      await wait(9000); // preview + client-side processing (gif -> video)
    }

    // The page has two Post buttons; the dialog's tweetButton is the live one,
    // the timeline's tweetButtonInline stays aria-disabled while a dialog is open.
    const btn = JSON.parse((await evaluate(ctx, `JSON.stringify(
      [...document.querySelectorAll('[data-testid=tweetButton],[data-testid=tweetButtonInline]')]
        .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && b.getAttribute('aria-disabled') !== 'true' })
        .map((b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }))`)) || "[]");
    if (!btn.length) return { posted: false, reason: "no enabled Post button" };
    await mouseClick(ctx, btn[0].x, btn[0].y);
    await wait(8000);

    // After a successful post the composer unmounts and the tab lands on /home.
    // The status URL is in the toast ("View" link) if we catch it in time.
    const done = JSON.parse((await evaluate(ctx, `JSON.stringify({
      url: location.href,
      composerGone: !document.querySelector('[data-testid=tweetTextarea_0][role=textbox]'),
      toast: (document.querySelector('[data-testid=toast] a[href*="/status/"]') || {}).href || null,
    })`)) || "{}");
    if (done.toast) return { posted: true, url: done.toast };
    if (done.url.includes("/compose/")) return { posted: false, reason: "still on composer after click" };
    return { posted: true, url: null };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
