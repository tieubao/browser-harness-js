// learnings/linkedin-com/tools/post.mjs
// Publish a LinkedIn post as the member ("self") or as a company page they administer.
// Opens one background tab, types the body with a single Input.insertText, attaches images
// on company pages via DOM.setFileInputFiles, asserts actor / media / paragraph count, DOM-clicks
// Post, then locates the new post and returns its permalink. Closes every tab it opens.
// Never bringToFront, never click an input[type=file] (that opens the OS picker).
import { existsSync } from "node:fs";
import { isAbsolute, extname } from "node:path";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

// Poll an in-page expression until it returns a truthy value or the timeout elapses.
async function waitFor(ctx, expression, ms) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await evaluate(ctx, expression); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) return v;
    await wait(500);
  }
}

const COMPANY_DIALOG = `[...document.querySelectorAll('[role=dialog]')].find((d) => d.querySelector('.ql-editor'))`;
const SELF_EDITOR = `document.querySelector('.tiptap.ProseMirror')`;

// Find an enabled, visible button inside `scope` whose trimmed text equals `label`; click it.
const clickButtonExpr = (scope, label) => `(() => {
  const root = ${scope};
  if (!root) return false;
  const btn = [...root.querySelectorAll('button,[role=button]')].find((b) =>
    (b.innerText || b.textContent || '').trim() === ${JSON.stringify(label)} && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.offsetParent !== null);
  if (!btn) return false;
  btn.click();
  return true;
})()`;

async function readMe(ctx) {
  return await evaluate(ctx, `(async () => {
    const m = document.cookie.match(/JSESSIONID="?([^";]+)/);
    const r = await fetch('/voyager/api/me', { credentials: 'include', headers: { 'csrf-token': m ? m[1] : '', accept: 'application/vnd.linkedin.normalized+json+2.1' } });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    const p = (j.included || []).find((x) => x && x.publicIdentifier) || (j.data && j.data.miniProfile) || j.miniProfile;
    if (!p || !p.publicIdentifier) return { error: 'no profile in /voyager/api/me' };
    return { publicIdentifier: p.publicIdentifier, first: p.firstName || '', last: p.lastName || '' };
  })()`);
}

export async function createPost(ctx, args) {
  const { actor, text, media = [], actorName } = args || {};
  if (!actor) throw new Error('createPost: actor is required ("self" or a company admin page URL)');
  if (!text || !text.trim()) throw new Error("createPost: text is required");

  const isSelf = actor === "self";
  let listUrl = null;
  if (!isSelf) {
    const m = /linkedin\.com\/company\/(\d+)/.exec(actor);
    if (!m) throw new Error('createPost: actor must be "self" or a URL like https://www.linkedin.com/company/<numeric id>/admin/page-posts/published/');
    listUrl = `https://www.linkedin.com/company/${m[1]}/admin/page-posts/published/`;
  }
  if (isSelf && media.length) return { posted: false, reason: "media on a personal post is not proven; refusing" };
  for (const p of media) {
    if (!isAbsolute(p) || !existsSync(p) || !/^\.(png|jpe?g)$/i.test(extname(p))) {
      return { posted: false, reason: `media must be an existing absolute png/jpg path: ${p}` };
    }
  }

  const startUrl = isSelf ? "https://www.linkedin.com/feed/" : listUrl;
  const lines = text.split("\n");
  const needle = lines[0].replace(/\s+/g, " ").trim().slice(0, 40);

  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    await ctx.session.use(targetId);
    await ctx.session.Page.enable();
    await ctx.session.Emulation.setFocusEmulationEnabled({ enabled: true });
    await ctx.session.Page.navigate({ url: startUrl });
    await ctx.session.use(targetId);

    // Wait for "Start a post"; a logged-out session redirects to a login / authwall page.
    const ready = await waitFor(ctx, `(() => {
      if (/\\/(login|authwall|checkpoint|uas)\\b/.test(location.pathname) || document.querySelector('input[name=session_key]')) return 'logged-out';
      const b = [...document.querySelectorAll('button,[role=button]')].find((x) => (x.innerText || '').trim() === 'Start a post' && x.offsetParent !== null);
      return b ? 'ready' : '';
    })()`, 30000);
    if (ready === "logged-out") return { posted: false, reason: "logged out" };
    if (ready !== "ready") return { posted: false, reason: "no 'Start a post' button (not logged in, or not an admin of this page?)" };

    const me = await readMe(ctx);
    if (isSelf && (!me || me.error)) return { posted: false, reason: `cannot resolve publicIdentifier: ${me && me.error}` };
    const fullName = me && !me.error ? `${me.first} ${me.last}`.trim() : "";

    const baseline = isSelf ? [] : (await evaluate(ctx, `[...document.querySelectorAll('[data-urn]')].map((e) => e.getAttribute('data-urn'))`)) || [];

    if (!(await evaluate(ctx, clickButtonExpr("document.body", "Start a post")))) return { posted: false, reason: "could not click 'Start a post'" };
    await wait(1500);
    await ctx.session.use(targetId);

    const scope = isSelf ? "document.body" : `(${COMPANY_DIALOG})`;
    const editorExpr = isSelf ? SELF_EDITOR : `(${COMPANY_DIALOG}) && (${COMPANY_DIALOG}).querySelector('.ql-editor')`;
    const opened = await waitFor(ctx, `!!(${editorExpr})`, 20000);
    if (!opened) return { posted: false, reason: "composer did not open" };

    // Media first (company only): Add media -> set files -> Next back to the composer.
    if (media.length) {
      const added = await evaluate(ctx, `(() => {
        const d = ${COMPANY_DIALOG};
        const b = d && d.querySelector('button[aria-label="Add media"]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!added) return { posted: false, reason: "no 'Add media' button in the composer" };
      await wait(2000);
      await ctx.session.DOM.enable();
      const { root } = await ctx.session.DOM.getDocument({ depth: -1, pierce: true });
      const { nodeIds } = await ctx.session.DOM.querySelectorAll({ nodeId: root.nodeId, selector: "input[type=file]" });
      if (!nodeIds || !nodeIds.length) return { posted: false, reason: "no file input after 'Add media'" };
      await ctx.session.DOM.setFileInputFiles({ nodeId: nodeIds[nodeIds.length - 1], files: media });
      const nextClicked = await waitFor(ctx, clickButtonExpr("document.body", "Next"), 45000);
      if (!nextClicked) return { posted: false, reason: "'Next' never became available after upload" };
      await wait(1500);
      const back = await waitFor(ctx, `!!(${COMPANY_DIALOG})`, 15000);
      if (!back) return { posted: false, reason: "composer did not return after 'Next'" };
    }

    // Text: focus the editor, then ONE insertText with the whole body.
    const focused = await evaluate(ctx, `(() => { const e = ${editorExpr}; if (!e) return false; e.focus(); return true; })()`);
    if (!focused) return { posted: false, reason: "editor missing before typing" };
    await wait(300);
    await ctx.session.Input.insertText({ text });
    await wait(1000);

    // Pre-post assertions. Abort with a reason instead of posting when any fails.
    const st = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
      const root = ${scope};
      const ed = ${editorExpr};
      return {
        actorText: root ? (root.innerText || '') : '',
        paragraphs: ed ? ed.querySelectorAll('p').length : 0,
        typed: ed ? (ed.innerText || '').trim().length : 0,
        preview: !!(root && root.querySelector('img[alt="Image preview"]')),
      };
    })())`)) || "{}");
    if (!st.typed) return { posted: false, reason: "text did not land in the editor" };
    if (st.paragraphs !== lines.length) return { posted: false, reason: `paragraph count ${st.paragraphs} != ${lines.length} lines` };
    if (actorName) {
      if (!st.actorText.includes(actorName)) return { posted: false, reason: `actor name '${actorName}' not shown in the composer` };
    } else if (isSelf) {
      if (!fullName || !st.actorText.includes(fullName)) return { posted: false, reason: `member name '${fullName}' not shown in the composer` };
    } else if (fullName && st.actorText.includes(fullName)) {
      return { posted: false, reason: `composer shows the member's own name '${fullName}', not the company page` };
    }
    if (media.length && !st.preview) return { posted: false, reason: "media not attached (no img[alt='Image preview'])" };

    const clicked = await evaluate(ctx, clickButtonExpr(scope, "Post"));
    if (!clicked) return { posted: false, reason: "no enabled 'Post' button" };
    await wait(5000);
    const stillOpen = await evaluate(ctx, `!!(${editorExpr})`);
    if (stillOpen) return { posted: false, reason: "composer still open after Post" };

    // Locate the new post and build the permalink.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (isSelf) {
        await ctx.session.Page.navigate({ url: `https://www.linkedin.com/in/${me.publicIdentifier}/recent-activity/all/` });
      } else {
        await ctx.session.Page.navigate({ url: listUrl });
      }
      await ctx.session.use(targetId);
      await wait(8000);
      const urn = await evaluate(ctx, isSelf
        ? `(() => {
            const html = document.documentElement.outerHTML;
            const safe = ${JSON.stringify(needle)}.split(/[&<>"'\`]/)[0];
            const at = safe.length >= 8 ? html.indexOf(safe) : -1;
            if (at < 0) return null;
            const re = /urn:li:activity:(\\d+)/g;
            re.lastIndex = at;
            const m = re.exec(html);
            return m ? m[0] : null;
          })()`
        : `(() => {
            const seen = ${JSON.stringify(baseline)};
            const norm = (s) => (s || '').replace(/\\s+/g, ' ');
            const el = [...document.querySelectorAll('[data-urn]')].find((e) => !seen.includes(e.getAttribute('data-urn')) && norm(e.innerText).includes(${JSON.stringify(needle)}));
            return el ? el.getAttribute('data-urn') : null;
          })()`);
      if (urn) return { posted: true, url: `https://www.linkedin.com/feed/update/${urn}/` };
    }
    return { posted: true, url: null };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
