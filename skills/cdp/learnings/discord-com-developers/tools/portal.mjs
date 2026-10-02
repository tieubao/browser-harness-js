// learnings/discord-com-developers/tools/portal.mjs
// Discord Developer Portal app + bot setup, driven through ONE dedicated foreground tab
// (hCaptcha, MFA and the consent-page scroll all need a visible tab). Steps a script cannot
// finish return {needsHuman:"captcha"|"mfa"} with the tab fronted; never loop on them.
// Tokens are returned to the caller only, never logged. See notes/overview.md.
import { execFile } from "node:child_process";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://discord.com/developers/applications";
const LABELS = ["Public Bot", "Requires OAuth2 Code Grant", "Private Channel Obfuscation",
  "Presence Intent", "Server Members Intent", "Message Content Intent"];
const TOKEN_RE = "[A-Za-z0-9_-]{24,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}";
let tabId;

async function ev(ctx, expression, timeout = 20000) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({
    expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || exceptionDetails.exception?.description || "evaluate failed");
  return result?.value;
}

async function front(ctx) {
  await ctx.session.Target.activateTarget({ targetId: tabId });
  await ctx.session.Emulation.setFocusEmulationEnabled({ enabled: true }).catch(() => {});
  // ponytail: macOS-only app raise, best effort; the Helium app name is an assumption.
  await new Promise((r) => execFile("osascript", ["-e", 'tell application "Helium" to activate'], () => r()));
}

async function open(ctx, url) {
  const alive = tabId && (await ctx.listPageTargets()).some((t) => t.targetId === tabId);
  if (!alive) {
    ({ targetId: tabId } = await ctx.session.Target.createTarget({ url }));
    await ctx.session.use(tabId);
  } else {
    await ctx.session.use(tabId);
    await ctx.session.Page.navigate({ url });
  }
  await front(ctx);
  await wait(3500);
}

// Poll an in-page expression until truthy.
async function until(ctx, expr, ms = 10000) {
  for (let t = 0; t < ms; t += 400) {
    const v = await ev(ctx, expr).catch(() => null);
    if (v) return v;
    await wait(400);
  }
  return null;
}

async function realClick(ctx, x, y) {
  const I = ctx.session.Input;
  await I.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await I.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await I.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// Page-side: smallest element whose trimmed text matches, as a centre point.
const FIND = (tag, text) => `(()=>{const t=${JSON.stringify(text)};const els=[...document.querySelectorAll(${JSON.stringify(tag)})]
  .filter(e=>e.innerText&&e.innerText.trim()===t&&e.getBoundingClientRect().width>0);
  const e=els.pop();if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();
  return {x:r.x+r.width/2,y:r.y+r.height/2}})()`;

async function realClickText(ctx, tag, text) {
  const p = await ev(ctx, FIND(tag, text));
  if (!p) return false;
  await realClick(ctx, p.x, p.y);
  return true;
}

const clickText = (ctx, text) => ev(ctx, `(()=>{const b=[...document.querySelectorAll('button,[role=button]')]
  .find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`);

// hCaptcha iframe, "Are you human", or an MFA dialog -> which human step is on screen.
const humanStep = (ctx) => ev(ctx, `(()=>{
  if(document.querySelector('iframe[src*="hcaptcha"],iframe[title*="hCaptcha"]')||/Are you human/i.test(document.body.innerText))return 'captcha';
  if(/Multi-Factor Authentication/i.test(document.body.innerText))return 'mfa';
  return null})()`);

async function needsHuman(ctx, kind) {
  await front(ctx);
  return { needsHuman: kind, tabId };
}

const appIdOf = (ctx) => ev(ctx, `(location.pathname.match(/applications\\/(\\d+)/)||[])[1]||null`);

// Read-only: current tab URL and app id.
export async function status(ctx, _args) {
  await open(ctx, BASE);
  const url = await ev(ctx, "location.href");
  return { signedIn: url.includes("/developers/applications"), url, tabId };
}

// WRITE. Create an application. Returns {appId} or {needsHuman:"captcha"}.
export async function createApp(ctx, args) {
  const { name } = args || {};
  if (!name) throw new Error("createApp: name is required");
  await open(ctx, BASE);
  if (!(await until(ctx, `[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='New Application')`))) return { stop: "not-signed-in" };
  await clickText(ctx, "New Application");
  if (!(await until(ctx, `document.querySelector('[role=dialog] input[name=name]')`))) throw new Error("create dialog did not open");
  await ev(ctx, `(()=>{const i=document.querySelector('[role=dialog] input[name=name]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(name)});
    i.dispatchEvent(new Event('input',{bubbles:true}));
    const c=document.querySelector('[role=dialog] input[type=checkbox]');if(c&&!c.checked)c.click();return true})()`);
  await wait(300);
  await ev(ctx, `(()=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.innerText.trim()==='Create');b.click()})()`);
  for (let t = 0; t < 12000; t += 500) {
    await wait(500);
    const id = await appIdOf(ctx);
    if (id) return { appId: id };
    if ((await humanStep(ctx)) === "captcha") return needsHuman(ctx, "captcha");
  }
  throw new Error("createApp: neither an app id nor a captcha appeared");
}

// Page-side reader of the six bot switches, label-checked by walking up parents.
const BOT_ROWS = `(()=>{const L=${JSON.stringify(LABELS)};
  return [...document.querySelectorAll('input[type=checkbox]')].slice(0,6).map((c,i)=>{
    let p=c.parentElement,ok=false;
    for(let n=0;p&&n<8;n++,p=p.parentElement){if((p.innerText||'').trim().startsWith(L[i])){ok=true;break}}
    return {label:L[i],checked:c.checked,labelConfirmed:ok}})})()`;

async function openBot(ctx, appId) {
  await open(ctx, `${BASE}/${appId}/bot`);
  if (!(await until(ctx, `document.querySelectorAll('input[type=checkbox]').length>=6`))) throw new Error("bot page switches not found");
}

// Read-only. Returns [{label, checked, labelConfirmed}].
export async function getBotSettings(ctx, args) {
  const { appId } = args || {};
  if (!appId) throw new Error("getBotSettings: appId is required");
  await openBot(ctx, appId);
  return ev(ctx, BOT_ROWS);
}

async function saveChanges(ctx) {
  if (!(await until(ctx, `[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Save Changes')`, 4000))) return { saved: false, reason: "no Save Changes bar" };
  await clickText(ctx, "Save Changes");
  await wait(1500);
  const err = await ev(ctx, `(document.body.innerText.match(/Private application cannot[^\\n]*|Careful, you have unsaved changes/)||[])[0]||null`);
  return err ? { saved: false, reason: err } : { saved: true };
}

// Click switch i only after its label is confirmed.
const toggle = (ctx, i) => ev(ctx, `(()=>{const L=${JSON.stringify(LABELS)};const c=document.querySelectorAll('input[type=checkbox]')[${i}];
  let p=c.parentElement,ok=false;for(let n=0;p&&n<8;n++,p=p.parentElement){if((p.innerText||'').trim().startsWith(L[${i}])){ok=true;break}}
  if(!ok)return false;c.click();return true})()`);

async function setSwitches(ctx, appId, want) {
  await openBot(ctx, appId);
  const rows = await ev(ctx, BOT_ROWS);
  let changed = false;
  for (const [i, v] of want) {
    if (rows[i].checked === v) continue;
    if (!(await toggle(ctx, i))) throw new Error(`label mismatch for switch ${i} (${LABELS[i]}); not clicked`);
    changed = true;
  }
  const save = changed ? await saveChanges(ctx) : { saved: true, unchanged: true };
  if (!save.saved) return { ...save, settings: await ev(ctx, BOT_ROWS) };
  await openBot(ctx, appId);
  return { ...save, settings: await ev(ctx, BOT_ROWS) };
}

// WRITE. Privileged intents; omit a key to leave it alone. Returns the re-read settings.
export async function setIntents(ctx, args) {
  const { appId, presence, members, messageContent } = args || {};
  if (!appId) throw new Error("setIntents: appId is required");
  const want = [[3, presence], [4, members], [5, messageContent]].filter(([, v]) => typeof v === "boolean");
  return setSwitches(ctx, appId, want);
}

// Install Link must be "None" before Public Bot can go off.
async function installLinkNone(ctx, appId) {
  await open(ctx, `${BASE}/${appId}/installation`);
  if (!(await until(ctx, `/Install Link/.test(document.body.innerText)`))) throw new Error("installation page not loaded");
  const current = await ev(ctx, `/Discord Provided Link/.test(document.body.innerText)`);
  if (!current) return { already: true };
  // Synthetic events do not open this dropdown; it needs a real mouse click.
  if (!(await realClickText(ctx, "*", "Discord Provided Link"))) throw new Error("install link dropdown not found");
  await wait(600);
  await ctx.session.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await ctx.session.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await wait(600);
  return saveChanges(ctx);
}

// WRITE. Public Bot on/off. Turning it off first sets Install Link to None.
export async function setPublicBot(ctx, args) {
  const { appId, value } = args || {};
  if (!appId || typeof value !== "boolean") throw new Error("setPublicBot: appId and boolean value are required");
  const install = value ? null : await installLinkNone(ctx, appId);
  if (install && install.saved === false) return { step: "install-link", ...install };
  return setSwitches(ctx, appId, [[0, value]]);
}

// Poll body text for a bot token. The caller captures it; this never logs it.
export async function readToken(ctx, args) {
  const { timeoutMs = 60000 } = args || {};
  const token = await until(ctx, `(document.body.innerText.match(new RegExp(${JSON.stringify(TOKEN_RE)}))||[])[0]||null`, timeoutMs);
  return token ? { token } : { token: null };
}

// WRITE, destructive (old token dies). Returns {token} or {needsHuman:"mfa"}; after the human
// acts, call readToken.
export async function resetToken(ctx, args) {
  const { appId } = args || {};
  if (!appId) throw new Error("resetToken: appId is required");
  await openBot(ctx, appId);
  if (!(await clickText(ctx, "Reset Token"))) throw new Error("Reset Token button not found");
  if (!(await until(ctx, `/Reset Bot's Token\\?/.test(document.body.innerText)`))) throw new Error("confirm dialog missing");
  await clickText(ctx, "Yes, do it!");
  for (let t = 0; t < 10000; t += 500) {
    await wait(500);
    if ((await humanStep(ctx)) === "mfa") return needsHuman(ctx, "mfa");
    const r = await readToken(ctx, { timeoutMs: 400 });
    if (r.token) return r;
  }
  throw new Error("resetToken: no token and no MFA dialog appeared");
}

// Pure. Build the OAuth2 invite URL.
export function inviteUrl(_ctx, args) {
  const { appId, permissions = 0, guildId } = args || {};
  if (!appId) throw new Error("inviteUrl: appId is required");
  const q = new URLSearchParams({ client_id: appId, scope: "bot", permissions: String(permissions) });
  if (guildId) { q.set("guild_id", guildId); q.set("disable_guild_select", "true"); }
  return `https://discord.com/oauth2/authorize?${q}`;
}

// WRITE. Walk the consent flow. Returns {authorized:true,...} or {needsHuman:"mfa"}.
export async function authorizeInvite(ctx, args) {
  await open(ctx, inviteUrl(ctx, args));
  await until(ctx, `/Continue to Discord|Authorize|Keep Scrolling/.test(document.body.innerText)`);
  if (await clickText(ctx, "Continue to Discord")) await wait(2500);
  await front(ctx);
  // Background tabs never register scroll; set scrollTop on every scrollable div.
  await ev(ctx, `[...document.querySelectorAll('div')].filter(d=>d.scrollHeight>d.clientHeight+20).forEach(d=>d.scrollTop=d.scrollHeight)`);
  await wait(800);
  if (await clickText(ctx, "Continue")) await wait(1500);
  if (!(await until(ctx, `[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Authorize'&&!b.disabled)`, 6000))) {
    return { authorized: false, reason: "Authorize button not enabled", text: (await ev(ctx, `document.body.innerText.slice(0,200)`)) };
  }
  await realClickText(ctx, "button", "Authorize");
  for (let t = 0; t < 10000; t += 500) {
    await wait(500);
    if ((await humanStep(ctx)) === "mfa") return needsHuman(ctx, "mfa");
    const done = await ev(ctx, `/Authorized|added to/i.test(document.body.innerText)`);
    if (done) return { authorized: true };
  }
  return { authorized: false, reason: "no confirmation seen", text: await ev(ctx, `document.body.innerText.slice(0,200)`) };
}
