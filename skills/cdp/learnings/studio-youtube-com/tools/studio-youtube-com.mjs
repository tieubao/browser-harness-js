// learnings/studio-youtube-com/tools/studio-youtube-com.mjs
// YouTube Studio for the Dwarves Foundation channel (UC_SyzGLf6wiqctQFsRI_frw), managed
// under han@d.foundation which is authuser=1 in the Helium browser. DOM-only automation:
// clicks are el.click() through Runtime.evaluate, never simulated mouse events, because
// Studio's own buttons respond to real DOM clicks fine (unlike X's popup-gated Post button).
//
// Gotchas this module encodes:
//  - The title/description boxes are contenteditable divs. document.execCommand returns
//    false unless the tab is the FOREGROUND tab, so setTextbox calls Page.bringToFront()
//    before every attempt and verifies the box text actually changed, retrying instead of
//    trusting the execCommand return value.
//  - The video id must come from the upload dialog's `a[href*="youtu.be/"]` href, never
//    from reading a screenshot: a screenshot can misread `l` as `I` (or vice versa) in the
//    11-char id and silently point every later call at the wrong video.
//  - The playlist checkbox list renders with empty innerText; match on textContent instead.
//  - The language listbox is a `tp-yt-paper-listbox` with 900+ children whose visibility
//    tracks something other than the DOM's own hidden state, so pick it by child count
//    instead of trying to filter for a "visible" one.
//  - Upload processing state lives in `.progress-label`'s last line; poll it for "Checks
//    complete" and treat "Video processing is taking longer than expected" as a stall the
//    caller must opt into saving through (allowSaveOnStall), not a silent default.

const CHANNEL_ID = "UC_SyzGLf6wiqctQFsRI_frw";
const AUTHUSER = 1;
const DOMAINS = ["studio.youtube.com"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function matches(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith("." + domain);
  } catch { return false; }
}

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function bringToFront(ctx) {
  try { await ctx.session.Page.bringToFront(); } catch { /* not fatal, retried by the caller */ }
}

// Focus + selectAll + insertText via execCommand, retried with bringToFront each time until
// the box text actually matches. execCommand silently returns false on a background tab, so
// the only reliable signal is reading the box back.
async function setTextbox(ctx, selector, text) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await bringToFront(ctx);
    const ok = await evaluate(ctx, `(() => {
      const box = document.querySelector(${JSON.stringify(selector)});
      if (!box) return false;
      box.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, ${JSON.stringify(text)});
      return (box.innerText || box.textContent || "").trim() === ${JSON.stringify(text.trim())};
    })()`);
    if (ok) return true;
    await wait(400);
  }
  return false;
}

async function setPlaylist(ctx, name) {
  const opened = await evaluate(ctx, `(() => {
    const trigger = document.querySelector("ytcp-video-metadata-playlists ytcp-dropdown-trigger");
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  if (!opened) return { done: false, reason: "no playlist dropdown trigger" };
  await wait(1200);

  const picked = await evaluate(ctx, `(() => {
    const boxes = [...document.querySelectorAll("ytcp-video-metadata-playlists ytcp-checkbox-lit")];
    const row = boxes.find((cb) => {
      let node = cb;
      for (let i = 0; i < 4 && node; i++) {
        if ((node.textContent || "").includes(${JSON.stringify(name)})) return true;
        node = node.parentElement;
      }
      return false;
    });
    if (!row) return { found: false };
    const box = row.querySelector("#checkbox");
    if (!box) return { found: true, checked: null, reason: "no #checkbox in matched row" };
    const isChecked = box.getAttribute("aria-checked") === "true" || box.checked === true;
    if (!isChecked) box.click();
    return { found: true, wasChecked: isChecked };
  })()`);
  if (!picked || !picked.found) return { done: false, reason: "no playlist row matched " + name, picked };
  await wait(400);

  const done = await evaluate(ctx, `(() => {
    const btns = [...document.querySelectorAll("ytcp-video-metadata-playlists ytcp-button")];
    const btn = btns.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (b.textContent || "").trim().includes("Done"); });
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  return { done, picked };
}

export async function status(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => DOMAINS.some((d) => matches(t.url, d)));
  if (!tab) return { state: "no-tab", hint: "no open tab matches " + DOMAINS.join(", ") };
  await ctx.session.use(tab.targetId);
  return { state: "tab", url: tab.url };
}

// Upload one file, fill title/description, set audience/playlist/visibility, wait for
// processing, and save. Returns {id} on success or {stop:<reason>} on any step that could
// not be verified, never guesses forward past a failed step.
export async function upload(ctx, args = {}) {
  const {
    file,
    title,
    description = "",
    playlist,
    visibility = "UNLISTED",
    madeForKids = false,
    channelId = CHANNEL_ID,
    authuser = AUTHUSER,
    timeoutMs = 15 * 60 * 1000,
    allowSaveOnStall = false,
    confirmPublishAnyway = false,
  } = args;
  if (!file) throw new Error("upload: file is required");
  if (!title) throw new Error("upload: title is required");

  const url = `https://studio.youtube.com/channel/${channelId}/videos/upload?d=ud&authuser=${authuser}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  try {
    await ctx.session.use(targetId);
    await wait(6000);
    await bringToFront(ctx);

    await ctx.session.DOM.enable();
    const { root } = await ctx.session.DOM.getDocument({ depth: -1 });
    const { nodeId } = await ctx.session.DOM.querySelector({ nodeId: root.nodeId, selector: "input[type=file][name=Filedata]" });
    if (!nodeId) return { stop: "no-file-input", hint: "input[type=file][name=Filedata] not found; upload dialog may not have opened" };
    await ctx.session.DOM.setFileInputFiles({ nodeId, files: [file] });
    await wait(3000);

    const titleOk = await setTextbox(ctx, "#title-textarea #textbox", title);
    if (!titleOk) return { stop: "title-not-set" };

    if (description) {
      const descOk = await setTextbox(ctx, "#description-textarea #textbox", description);
      if (!descOk) return { stop: "description-not-set" };
    }

    const audienceName = madeForKids ? "VIDEO_MADE_FOR_KIDS_MFK" : "VIDEO_MADE_FOR_KIDS_NOT_MFK";
    const audienceSet = await evaluate(ctx, `(() => {
      const el = document.querySelector("tp-yt-paper-radio-button[name=${audienceName}]");
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!audienceSet) return { stop: "audience-not-set" };
    await wait(500);

    if (playlist) {
      const pl = await setPlaylist(ctx, playlist);
      if (!pl.done) return { stop: "playlist-not-set", detail: pl };
    }

    for (let i = 0; i < 3; i++) {
      await wait(600);
      const clicked = await evaluate(ctx, `(() => {
        const b = document.querySelector("ytcp-uploads-dialog #next-button");
        if (!b || b.disabled) return false;
        b.click();
        return true;
      })()`);
      if (!clicked) return { stop: `next-${i + 1}-failed` };
    }

    await wait(800);
    const visClicked = await evaluate(ctx, `(() => {
      const el = document.querySelector("tp-yt-paper-radio-button[name=${visibility}]");
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!visClicked) return { stop: "visibility-not-set" };
    await wait(500);

    const id = await evaluate(ctx, `(() => {
      const a = document.querySelector('ytcp-uploads-dialog a[href*="youtu.be/"]');
      if (!a) return null;
      const m = a.href.match(/youtu\\.be\\/([^?&]+)/);
      return m ? m[1] : null;
    })()`);
    if (!id) return { stop: "no-video-id" };

    const deadline = Date.now() + timeoutMs;
    let lastLabel = "";
    let stalled = false;
    while (Date.now() < deadline) {
      lastLabel = (await evaluate(ctx, `(() => {
        const els = document.querySelectorAll("ytcp-uploads-dialog .progress-label");
        const el = els[els.length - 1];
        return el ? el.textContent.trim() : "";
      })()`)) || "";
      if (/Checks complete/i.test(lastLabel)) break;
      if (/taking longer than expected/i.test(lastLabel)) {
        stalled = true;
        if (allowSaveOnStall) break;
      }
      await wait(5000);
    }
    if (!/Checks complete/i.test(lastLabel) && !(stalled && allowSaveOnStall)) {
      return { stop: "processing-timeout", id, lastLabel };
    }

    const saved = await evaluate(ctx, `(() => {
      const b = document.querySelector("ytcp-uploads-dialog #done-button");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!saved) return { stop: "no-done-button", id };
    await wait(1500);

    const stillChecking = await evaluate(ctx, `(() => (document.body ? document.body.textContent : "").includes("still checking your content"))()`);
    if (stillChecking) {
      if (!confirmPublishAnyway) return { stop: "still-checking-content", id, hint: "pass confirmPublishAnyway:true to click Publish anyway" };
      await evaluate(ctx, `(() => {
        const btns = [...document.querySelectorAll("button, ytcp-button")];
        const b = btns.find((x) => (x.textContent || "").includes("Publish anyway"));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      await wait(1500);
    }

    return { id };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}

// Set the video language and title/description language, then verify against /translations.
export async function setLanguage(ctx, args = {}) {
  const { id, language = "Vietnamese", authuser = AUTHUSER } = args;
  if (!id) throw new Error("setLanguage: id is required");

  const url = `https://studio.youtube.com/video/${id}/edit?authuser=${authuser}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  try {
    await ctx.session.use(targetId);
    await wait(6000);
    await bringToFront(ctx);

    await evaluate(ctx, `(() => {
      const els = [...document.querySelectorAll("*")];
      const el = els.find((e) => (e.textContent || "").trim() === "Show more" && e.offsetParent);
      if (el) el.click();
      return !!el;
    })()`);
    await wait(800);

    const inputCount = (await evaluate(ctx, `(() => document.querySelectorAll("ytcp-form-language-input").length)()`)) || 0;
    let applied = 0;
    for (let i = 0; i < inputCount; i++) {
      const visible = await evaluate(ctx, `(() => {
        const el = [...document.querySelectorAll("ytcp-form-language-input")][${i}];
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`);
      if (!visible) continue;

      const opened = await evaluate(ctx, `(() => {
        const el = [...document.querySelectorAll("ytcp-form-language-input")][${i}];
        const trigger = el.querySelector("ytcp-dropdown-trigger") || el;
        trigger.click();
        return true;
      })()`);
      if (!opened) continue;
      await wait(2500);

      const picked = await evaluate(ctx, `(() => {
        const boxes = [...document.querySelectorAll("tp-yt-paper-listbox")];
        const box = boxes.find((b) => b.children.length > 900);
        if (!box) return false;
        const item = [...box.querySelectorAll("tp-yt-paper-item")].find((it) => (it.textContent || "").trim() === ${JSON.stringify(language)});
        if (!item) return false;
        item.click();
        return true;
      })()`);
      if (picked) applied++;
      await wait(500);
    }
    if (!applied) return { stop: "no-language-input-set" };

    const saved = await evaluate(ctx, `(() => {
      const b = document.querySelector("ytcp-button#save");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!saved) return { stop: "no-save-button" };
    await wait(2000);

    const verifyUrl = `https://studio.youtube.com/video/${id}/translations?authuser=${authuser}`;
    const { targetId: verifyTargetId } = await ctx.session.Target.createTarget({ url: verifyUrl, background: true });
    await ctx.session.use(verifyTargetId);
    await wait(2500);
    const text = (await evaluate(ctx, `(() => document.body ? document.body.textContent : "")()`)) || "";
    try { await ctx.session.Target.closeTarget({ targetId: verifyTargetId }); } catch { /* already gone */ }
    await ctx.session.use(targetId);

    const verified = new RegExp(`Video language:\\s*${language}`, "i").test(text);
    return { applied, verified };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}

// List videos from the channel content page.
export async function list(ctx, args = {}) {
  const { limit = 20, channelId = CHANNEL_ID, authuser = AUTHUSER } = args;
  const url = `https://studio.youtube.com/channel/${channelId}/videos/upload?authuser=${authuser}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    await ctx.session.use(targetId);
    await wait(6000);
    const rows = await evaluate(ctx, `(() => {
      const rows = [...document.querySelectorAll("ytcp-video-row")].slice(0, ${limit});
      return rows.map((row) => {
        const a = row.querySelector('a[href*="/video/"]');
        const href = a ? a.getAttribute("href") : "";
        const m = href.match(/\\/video\\/([^/]+)\\//);
        const title = (row.querySelector("#video-title") || {}).textContent || "";
        const text = row.textContent || "";
        let visibility = "Unknown";
        if (/Unlisted/.test(text)) visibility = "Unlisted";
        else if (/Private/.test(text)) visibility = "Private";
        else if (/Public/.test(text)) visibility = "Public";
        return { id: m ? m[1] : null, title: title.trim(), visibility };
      });
    })()`);
    return { rows: rows || [] };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}

// Destructive. Refuses unless the delete-dialog text contains expectDuration and the
// caller passes {confirm:true}: the dialog is the only surface that names the video, so
// matching its stated duration is the guard against deleting the wrong id.
export async function remove(ctx, args = {}) {
  const { id, expectDuration, confirm = false, authuser = AUTHUSER } = args;
  if (!id) throw new Error("remove: id is required");
  if (!expectDuration) throw new Error("remove: expectDuration is required, this call is destructive");
  if (!confirm) return { stop: "confirm-required", hint: "pass {confirm:true} to actually delete" };

  const url = `https://studio.youtube.com/video/${id}/edit?authuser=${authuser}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  try {
    await ctx.session.use(targetId);
    await wait(6000);
    await bringToFront(ctx);

    const opened = await evaluate(ctx, `(() => {
      const b = document.querySelector('ytcp-icon-button[aria-label="Options"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!opened) return { stop: "no-options-button" };
    await wait(800);

    const clickedDelete = await evaluate(ctx, `(() => {
      const els = [...document.querySelectorAll("*")];
      const el = els.find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Delete");
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clickedDelete) return { stop: "no-delete-item" };
    await wait(1000);

    const dialogText = (await evaluate(ctx, `(() => document.body ? document.body.textContent : "")()`)) || "";
    if (!/Permanently delete this video/i.test(dialogText)) return { stop: "no-delete-dialog" };
    if (!dialogText.includes(expectDuration)) {
      return { stop: "duration-mismatch", hint: "dialog text does not contain expectDuration, refusing to delete", dialogText: dialogText.slice(0, 400) };
    }

    const ticked = await evaluate(ctx, `(() => {
      const c = document.querySelector("ytcp-checkbox-lit #checkbox");
      if (!c) return false;
      c.click();
      return true;
    })()`);
    if (!ticked) return { stop: "no-confirm-checkbox" };
    await wait(500);

    const deleted = await evaluate(ctx, `(() => {
      const els = [...document.querySelectorAll("*")];
      const el = els.find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Delete forever");
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!deleted) return { stop: "no-delete-forever-button" };
    await wait(2000);

    return { deleted: true, id };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}

// No browser needed. oembed answers 200 + title for public/unlisted videos (never for
// private); the watch page's playabilityStatus is the second, independent signal.
export async function probe(_ctx, args = {}) {
  const { id } = args;
  if (!id) throw new Error("probe: id is required");

  let oembed = { ok: false };
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent("https://youtu.be/" + id)}&format=json`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      const data = await res.json();
      oembed = { ok: true, status: res.status, title: data.title };
    } else {
      oembed = { ok: false, status: res.status };
    }
  } catch (e) {
    oembed = { ok: false, error: String((e && e.message) || e) };
  }

  let playable = { ok: false };
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await res.text();
    playable = { ok: /"playabilityStatus":\{"status":"OK"/.test(html), status: res.status };
  } catch (e) {
    playable = { ok: false, error: String((e && e.message) || e) };
  }

  return { id, oembed, playable };
}
