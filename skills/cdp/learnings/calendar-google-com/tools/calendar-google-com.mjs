// learnings/calendar-google-com/tools/calendar-google-com.mjs
// Read a Google Calendar "Secret address in iCal format". The value is a CREDENTIAL: anyone
// holding the URL reads the whole calendar. icalSecret() RETURNS it and prints nothing; the
// caller captures it straight into a shell variable and pipes it to a secret store:
//
//   ICAL=$(browser-harness-js 'await learnings("calendar-google-com", "ical-secret", {calendarId: "you@example.com"})')
//
// Never echo it, never paste it into a chat or a log. Recipe and traps: ../notes/overview.md.
//
// Gotchas this module encodes (proven live 2026-09-26, Helium / Chromium 154):
//  - The secret field is an <input> holding 10 bullet characters. The real URL is fetched only
//    after a reveal, so it is never in the DOM before that. The page's own "Copy to clipboard"
//    button leaves the clipboard EMPTY under automation, so read the input value instead.
//  - At a narrow window (innerWidth 853) both buttons sit past the viewport edge and a CDP click
//    at their centre lands outside the page and silently does nothing. scrollIntoView, then
//    click the centre of the part of the rect that is inside the viewport.
//  - The first real click on "Toggle visibility" opens a "Security warning" dialog. Click its OK,
//    then click "Toggle visibility" AGAIN; only then does the input carry the URL.
//  - Never click "Reset": it invalidates the address for every consumer. rectOf() refuses any
//    element whose label or text mentions reset.
const DOMAINS = ["calendar.google.com"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const ICAL_RE = /https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s"']*\/private-[^\s"'\/]+\/basic\.ics/;

// The settings page keys a calendar by the base64 of its id (for a primary calendar, the account
// email). Proven with an email id; the trailing "=" padding is stripped the way Google's own
// settings links omit it (unverified live for ids whose length needs padding).
export function settingsUrl(calendarId, authuser = 0) {
  if (!calendarId) throw new Error("calendarId is required");
  const b64 = Buffer.from(String(calendarId), "utf8").toString("base64").replace(/=+$/, "");
  return `https://calendar.google.com/calendar/u/${Number(authuser) || 0}/r/settings/calendar/${b64}`;
}

function matches(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith('.' + domain);
  } catch { return false; }
}

export async function status(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => DOMAINS.some((d) => matches(t.url, d)));
  if (!tab) return { state: 'no-tab', hint: 'no open tab matches ' + DOMAINS.join(', ') };
  await ctx.session.use(tab.targetId);
  return { state: 'tab', url: tab.url };
}

// In-page: find the target, scroll it into view, return the centre of its in-viewport part.
// kind "toggle" = the "Toggle visibility" button; kind "ok" = OK inside the Security warning dialog.
const rectOf = (kind) => `(() => {
  let el = null;
  if (${JSON.stringify(kind)} === "toggle") {
    el = [...document.querySelectorAll("[aria-label]")].find((e) => e.getAttribute("aria-label") === "Toggle visibility");
  } else {
    const dlg = [...document.querySelectorAll("[role=dialog],[role=alertdialog]")]
      .find((d) => /Security warning|should not give the secret address/i.test(d.textContent || ""));
    el = dlg && [...dlg.querySelectorAll("button,[role=button]")].find((b) => (b.textContent || "").trim() === "OK");
  }
  if (!el) return null;
  if (/reset/i.test((el.getAttribute("aria-label") || "") + " " + (el.textContent || ""))) return null;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth);
  const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
})()`;

// In-page: the first input value matching ICAL_RE, or null. Creates no page global.
const READ = `(() => {
  const re = new RegExp(${JSON.stringify(ICAL_RE.source)});
  for (const i of document.querySelectorAll("input")) { const m = (i.value || "").match(re); if (m) return m[0]; }
  return null;
})()`;

// In-page: blank every input that holds the URL, so the revealed value does not outlive the read
// even if the fire-and-forget tab close fails.
const REMASK = `(() => {
  const re = new RegExp(${JSON.stringify(ICAL_RE.source)});
  for (const i of document.querySelectorAll("input")) if (re.test(i.value || "")) i.value = "";
  return true;
})()`;

async function poll(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(stepMs);
  }
  return null;
}

// Returns the secret iCal URL as a plain string. Opens its own tab, closes it in finally.
// Errors never carry page text, so a failure cannot leak the value into a log.
export async function icalSecret(ctx, { calendarId, authuser = 0, timeoutMs = 20000 } = {}) {
  const url = settingsUrl(calendarId, authuser);
  const { session, cdp } = ctx;
  const t = await session.Target.createTarget({ url: "about:blank", background: true });
  const { sessionId } = await session.Target.attachToTarget({ targetId: t.targetId, flatten: true });
  const ev = async (expression) => {
    const r = await cdp(sessionId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error("ical-secret: in-page script failed");
    return r && r.result ? r.result.value : undefined;
  };
  const click = async (p) => {
    if (!p) throw new Error("ical-secret: click target not in view");
    await cdp(sessionId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    await cdp(sessionId, "Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await cdp(sessionId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  try {
    await cdp(sessionId, "Page.navigate", { url });
    const toggle = await poll(() => ev(rectOf("toggle")), timeoutMs);
    if (!toggle) throw new Error('ical-secret: no "Toggle visibility" button (not signed in under that authuser, wrong calendar id, or layout changed)');
    await click(toggle);
    const first = await poll(async () => ((await ev(READ)) ? "value" : (await ev(rectOf("ok"))) ? "dialog" : null), 8000);
    if (first === "dialog") {
      await click(await ev(rectOf("ok")));
      await poll(async () => !(await ev(rectOf("ok"))), 5000);
      await click(await poll(() => ev(rectOf("toggle")), 5000));
    }
    const secret = await poll(() => ev(READ), 10000);
    if (!secret) throw new Error("ical-secret: the secret address did not appear after reveal");
    return secret;
  } finally {
    await ev(REMASK).catch(() => {});
    session.closeTab(t.targetId, sessionId).catch(() => {});
  }
}
