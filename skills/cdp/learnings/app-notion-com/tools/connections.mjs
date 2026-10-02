// learnings/app-notion-com/tools/connections.mjs
// Notion developer portal, INTERNAL connections (https://app.notion.com/developers/connections).
// Tools reuse (or open) one app.notion.com/developers tab and leave it open, so
// open_connection -> set_capabilities -> share_pages chain on the same page.
// None of the tools prints the token; only revealToken returns it.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://app.notion.com/developers/connections";
const CAPS = {
  read: "Read content", update: "Update content", insert: "Insert content",
  readComments: "Read comments", insertComments: "Insert comments",
  sessions: "View sessions and interact with agents",
};
const USER_INFO = {
  none: "No user information",
  no_email: "Read user information without email addresses",
  email: "Read user information including email addresses",
};

async function ev(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception && exceptionDetails.exception.description) || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Click the first element matching sel whose trimmed textContent equals text (exact).
const clickText = (ctx, sel, text) => ev(ctx, `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`);

async function until(ctx, expr, what, ms = 10000) {
  for (let t = 0; t < ms; t += 250) { if (await ev(ctx, `!!(${expr})`)) return; await wait(250); }
  throw new Error("timed out waiting for " + what);
}

// Switch the session to an app.notion.com/developers tab (open one if none) and refuse a signed-out page.
async function page(ctx, path = "") {
  const { targetInfos } = await ctx.session.Target.getTargets();
  let tab = targetInfos.find((t) => t.type === "page" && t.url.startsWith("https://app.notion.com/developers"));
  if (!tab) {
    const { targetId } = await ctx.session.Target.createTarget({ url: BASE + path });
    tab = { targetId };
    await wait(4000);
  }
  await ctx.session.use(tab.targetId);
  await ctx.session.Target.activateTarget({ targetId: tab.targetId });
  if (path && !(await ev(ctx, "location.href")).includes(BASE + path)) { await ev(ctx, `location.href=${JSON.stringify(BASE + path)}`); await wait(4000); }
  await until(ctx, "document.body && document.body.innerText.length>50", "page render");
  // Signed out: the page renders cached with this banner; clicking would do nothing useful.
  if (await ev(ctx, "document.body.innerText.includes(\"You don't have permission to create connections\")"))
    throw new Error("not signed in to app.notion.com (a www.notion.so session does not carry; sign in on app.notion.com)");
}

const idFromUrl = (ctx) => ev(ctx, "(location.pathname.match(/connections\\/([0-9a-f-]{36})/)||[])[1]||null");

export async function listConnections(ctx) {
  await page(ctx);
  await ev(ctx, `location.pathname.endsWith('/connections')||(location.href=${JSON.stringify(BASE)})`);
  await until(ctx, "document.querySelector('tr')", "connection rows");
  // Ids are not in the rows (no links); openConnection returns the id after the click.
  return ev(ctx, "[...document.querySelectorAll('tr')].map(r=>r.innerText.split('\\n').map(s=>s.trim()).filter(Boolean)).filter(l=>l.length&&l[0]!=='Connection').map(l=>({name:l[0],details:l.slice(1)}))");
}

export async function openConnection(ctx, args) {
  const name = args && args.name;
  if (!name) throw new Error("name required");
  await page(ctx, "");
  if (!(await ev(ctx, "location.pathname.endsWith('/connections')"))) { await ev(ctx, `location.href=${JSON.stringify(BASE)}`); await wait(3000); }
  await until(ctx, "document.querySelector('tr')", "connection rows");
  const hit = await ev(ctx, `(()=>{const r=[...document.querySelectorAll('tr')].find(r=>r.innerText.split('\\n').map(s=>s.trim()).includes(${JSON.stringify(name)}));if(!r)return false;r.click();return true})()`);
  if (!hit) throw new Error("no connection named " + name);
  await until(ctx, "/connections\\/[0-9a-f-]{36}/.test(location.pathname)", "connection page");
  return { id: await idFromUrl(ctx), name };
}

export async function createConnection(ctx, args) {
  const name = args && args.name;
  if (!name) throw new Error("name required");
  await page(ctx);
  if (!(await clickText(ctx, "button", "New connection"))) throw new Error("New connection button not found");
  await until(ctx, "document.querySelector('[role=dialog] input[type=text]')", "create dialog");
  await ev(ctx, `(()=>{const i=document.querySelector('[role=dialog] input[type=text]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(name)});
    i.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[role=dialog] input[value=integrationToken]').click()})()`);
  if (!(await clickText(ctx, "[role=dialog] button", "Create connection"))) throw new Error("Create connection button not found");
  await until(ctx, "/connections\\/[0-9a-f-]{36}/.test(location.pathname)", "new connection page", 20000);
  return { id: await idFromUrl(ctx), name };
}

// caps: {read,update,insert,readComments,insertComments,sessions: boolean, userInfo: "none"|"no_email"|"email"}.
// Omitted keys stay as they are. Autosaves; no Save button. Returns the resulting state.
export async function setCapabilities(ctx, caps = {}) {
  await page(ctx);
  await clickText(ctx, "[role=tab]", "Configuration");
  for (const [key, label] of Object.entries(CAPS)) {
    if (typeof caps[key] !== "boolean") continue;
    const state = await ev(ctx, `(()=>{const b=[...document.querySelectorAll('button[aria-pressed]')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return null;
      if((b.getAttribute('aria-pressed')==='true')!==${caps[key]})b.click();return true})()`);
    if (state === null) throw new Error("capability button not found: " + label);
    await wait(500);
  }
  if (caps.userInfo) {
    if (!USER_INFO[caps.userInfo]) throw new Error("userInfo must be none|no_email|email");
    if (!(await clickText(ctx, "button", USER_INFO[caps.userInfo]))) throw new Error("user info button not found");
    await wait(500);
  }
  return ev(ctx, `(()=>{const o={};const C=${JSON.stringify(CAPS)};
    for(const [k,l] of Object.entries(C)){const b=[...document.querySelectorAll('button[aria-pressed]')].find(x=>x.textContent.trim()===l);o[k]=b?b.getAttribute('aria-pressed')==='true':null}
    const u=${JSON.stringify(USER_INFO)};
    for(const [k,l] of Object.entries(u)){const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===l);if(b&&b.querySelector('span span'))o.userInfo=k}
    return o})()`);
}

// queries: page-name strings; exact (default false): require the menuitem text to END with the query
// (menuitem text is icon+title+path like "🏢ClientsDatabases/US Operating"). Returns {added, missing}.
export async function sharePages(ctx, args) {
  const queries = (args && args.queries) || [];
  const exact = !!(args && args.exact);
  await page(ctx);
  await clickText(ctx, "[role=tab]", "Content access");
  await wait(500);
  if (!(await clickText(ctx, "button", "Edit access"))) throw new Error("Edit access button not found");
  await until(ctx, "document.querySelector(\"[role=dialog] input[placeholder='Search pages']\")", "access dialog");
  const s = ctx.session;
  await s.Emulation.setFocusEmulationEnabled({ enabled: true });
  const added = [], missing = [];
  for (const q of queries) {
    // The native value setter does not trigger Notion's search: type through CDP.
    await ev(ctx, "(()=>{const i=document.querySelector(\"[role=dialog] input[placeholder='Search pages']\");i.focus();i.select()})()");
    for (const type of ["keyDown", "keyUp"]) await s.Input.dispatchKeyEvent({ type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await s.Input.insertText({ text: q });
    await wait(1500);
    const r = await ev(ctx, `(()=>{const q=${JSON.stringify(q)},ex=${exact};
      const it=[...document.querySelectorAll('[role=menu] [role=menuitem]')].find(m=>{const t=m.textContent;return ex?t.trim().endsWith(q):t.includes(q)});
      if(!it)return 'missing'; if(it.textContent.includes('Already added'))return 'already'; it.click();return 'added'})()`);
    (r === "missing" ? missing : added).push(q);
    await wait(500);
  }
  await s.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await s.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await wait(500);
  if (!(await clickText(ctx, "[role=dialog] button", "Save"))) throw new Error("dialog Save button not found");
  await wait(1500);
  return { added, missing, summary: await ev(ctx, "(document.body.innerText.match(/Teamspaces \\(\\d+ pages?\\)/)||[])[0]||null") };
}

// Internal connections have only name + icon (no description). The rename is explicit-Save, unlike capabilities.
export async function renameConnection(ctx, args) {
  const newName = args && args.newName;
  if (!newName) throw new Error("newName required");
  await page(ctx);
  await clickText(ctx, "[role=tab]", "Configuration");
  if (!(await clickText(ctx, "button", "Edit"))) throw new Error("Display information Edit button not found");
  await until(ctx, "document.querySelectorAll('input[type=text]').length===1", "name input");
  await ev(ctx, `(()=>{const i=document.querySelector('input[type=text]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(newName)});
    i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  if (!(await clickText(ctx, "button", "Save"))) throw new Error("Save button not found");
  await wait(1500);
  return { newName };
}

// Returns the raw token string. Callers capture it into a variable and must never print it.
export async function revealToken(ctx) {
  await page(ctx);
  await clickText(ctx, "[role=tab]", "Configuration");
  const toggle = "document.querySelector('button[aria-label=\"Show or hide API token\"]')";
  if (!(await ev(ctx, `!!${toggle}`))) throw new Error("token toggle not found (OAuth connection, or not on the Configuration tab)");
  await ev(ctx, `${toggle}.click()`);
  await wait(500);
  const token = await ev(ctx, "(document.body.innerText.match(/ntn_[A-Za-z0-9]{30,}/)||[])[0]||null");
  await ev(ctx, `${toggle}.click()`);
  if (!token) throw new Error("token not visible after reveal");
  return token;
}
