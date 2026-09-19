// learnings/facebook-com/tools/post.mjs
// Compose + publish a post on a Facebook Page through the logged-in tab. Opens the
// page's own composer (the "What's on your mind?" button), types with Input.insertText,
// attaches media by CDP file-input assignment, clicks Post, then reloads the page and
// confirms the text is in the feed. Never click an input[type=file]: that opens the OS picker.
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

const DIALOG = `[...document.querySelectorAll('[role=dialog]')].find((d) => d.getAttribute('aria-label') === 'Create post' && d.querySelector('[role=textbox],[contenteditable=true]'))`;

export async function createPagePost(ctx, args) {
  const { pageUrl, text, media = [] } = args || {};
  if (!pageUrl) throw new Error("createPagePost: pageUrl is required");
  if (!text) throw new Error("createPagePost: text is required");

  const { targetId } = await ctx.session.Target.createTarget({ url: pageUrl, background: false });
  try {
    await ctx.session.use(targetId);
    await wait(7000);

    // Refuse on logged-out (the page renders the login form instead of the composer).
    const state = JSON.parse((await evaluate(ctx, `JSON.stringify({
      url: location.href,
      loggedOut: !!document.querySelector('input[name=email]'),
      composer: !![...document.querySelectorAll('[role=button]')].find((b) => (b.textContent || '').includes("What's on your mind")),
    })`)) || "{}");
    if (state.loggedOut) return { posted: false, reason: "logged out", url: state.url };
    if (!state.composer) return { posted: false, reason: "no composer button (not a managed page?)", url: state.url };

    // Open the composer with a DOM click. Synthesized mouse events on the same
    // rect did not open the dialog; element.click() does.
    await evaluate(ctx, `[...document.querySelectorAll('[role=button]')].find((b) => (b.textContent || '').includes("What's on your mind")).click()`);
    await wait(3000);
    const rect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      const dlg = ${DIALOG};
      const tb = dlg && dlg.querySelector('[role=textbox],[contenteditable=true]');
      if (!tb) return null;
      tb.focus();
      return tb.getBoundingClientRect();
    })())`)) || "null");
    if (!rect) return { posted: false, reason: "composer did not open" };

    // Click into the textbox, then type the whole body in one insertText call.
    await mouseClick(ctx, rect.x + 40, rect.y + 15);
    await wait(500);
    await ctx.session.Input.insertText({ text });
    await wait(800);
    const typed = await evaluate(ctx, `(() => { const d = ${DIALOG}; return d ? d.querySelector('[role=textbox],[contenteditable=true]').textContent.length : 0 })()`);
    if (!typed) return { posted: false, reason: "text did not land in the composer" };

    // Media: set files on the dialog's own file input (works while hidden).
    if (media.length) {
      await ctx.session.DOM.enable();
      const { root } = await ctx.session.DOM.getDocument({ depth: -1 });
      const { nodeIds } = await ctx.session.DOM.querySelectorAll({ nodeId: root.nodeId, selector: "[role=dialog] input[type=file]" });
      if (!nodeIds || !nodeIds.length) return { posted: false, reason: "no file input in the composer" };
      await ctx.session.DOM.setFileInputFiles({ nodeId: nodeIds[0], files: media });
      await wait(8000); // upload + preview (gif and video take the long end)
      const hasMedia = await evaluate(ctx, `!!document.querySelector('[role=dialog] img, [role=dialog] video')`);
      if (!hasMedia) return { posted: false, reason: "media preview did not appear" };
    }

    // The Post button is aria-label="Post" inside the dialog. DOM click again.
    const clicked = await evaluate(ctx, `(() => {
      const d = ${DIALOG};
      const btn = d && [...d.querySelectorAll('[role=button]')].find((b) => b.getAttribute('aria-label') === 'Post' || (b.textContent || '').trim() === 'Post');
      if (!btn || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.click();
      return true;
    })()`);
    if (!clicked) return { posted: false, reason: "no enabled Post button" };
    await wait(9000);
    const stillOpen = await evaluate(ctx, `!!(${DIALOG})`);
    if (stillOpen) return { posted: false, reason: "composer still open after Post" };

    // Confirm on a fresh load. After a navigation the harness session can re-bind
    // to another target, so re-select the tab before evaluating.
    await ctx.session.Page.enable();
    await ctx.session.Page.navigate({ url: pageUrl });
    await wait(9000);
    await ctx.session.use(targetId);
    const done = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      const needle = ${JSON.stringify(text.slice(0, 40))};
      const present = document.body.textContent.includes(needle);
      const leaf = [...document.querySelectorAll('span,div')].find((e) => e.children.length === 0 && (e.textContent || '').includes(needle));
      const art = leaf && leaf.closest('[role=article]');
      const url = art ? ([...art.querySelectorAll('a[href]')].map((a) => a.href).find((h) => /\\/posts\\/|pfbid|\\/videos\\//.test(h)) || null) : null;
      return { present, url };
    })())`)) || "{}");
    if (!done.present) return { posted: false, reason: "text not found on the page after reload" };
    return { posted: true, url: done.url || null };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
