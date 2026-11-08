// learnings/figma-com/tools/admin.mjs
// Figma team admin console, read on the logged-in tab. Two node-tools, each opens its own tab,
// works, and closes it, so a call is safe next to whatever the operator has open.
//
// Traps this encodes (frozen 2026-09-03 after the Dwarves subscription audit):
//   - /files/team/<id>/admin and /admin/billing typed as URLs render "Something went wrong".
//     The console opens from the sidebar "Admin" row, an <li> whose React handler ignores
//     el.click(); a real Input.dispatchMouseEvent at its centre works. After that first open,
//     /files/team/<id>/team-admin-console/members and /settings are direct routes.
//   - The people grid is virtualized: only one screen of rows is in the DOM. adminPeople scrolls
//     to the end in steps and de-duplicates by email.
//   - "Upgrade your plan" under Settings > Plan = free Starter. A paid Figma charge with no paid
//     team here belongs to ANOTHER Figma account (receipt emails name it).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assertTeam(args) {
  const id = String((args && args.teamId) || "");
  // Interpolated into URLs and page JS: digits only, or nothing runs.
  if (!/^[0-9]{1,32}$/.test(id)) throw new Error("teamId must be digits, got: " + id);
  return id;
}

// The tab openTab attached for this ctx (one ctx per tool call).
const current = new WeakMap();

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await current.get(ctx).cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception && exceptionDetails.exception.description) || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Open a tab, route page-level calls to it, wait for the SPA to settle.
async function openTab(ctx, url, settleMs) {
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  const page = await ctx.attachPage(targetId, { allowedOrigins: ["https://www.figma.com"] });
  current.set(ctx, page);
  // Background tab, never activated (Han's window must not move). Focus emulation plus an active
  // lifecycle state keep it rendering. The short-read bug of the old foreground version was the grid's
  // own scroll container (see adminPeople), not tab visibility; the 53-row read is unverified here.
  await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await page.cdp("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  await wait(settleMs);
  return targetId;
}

async function closeTab(ctx, targetId) {
  try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
}

// If the direct console route errored, go through the sidebar Admin row with a real click.
async function ensureConsole(ctx, teamId) {
  const broken = await evaluate(ctx, "document.body.innerText.includes('Something went wrong')");
  if (!broken) return;
  await evaluate(ctx, "location.href='https://www.figma.com/files/team/" + teamId + "/recents-and-sharing/recently-viewed'");
  await wait(8000);
  const centre = await evaluate(ctx, "(()=>{const e=document.querySelector('li[class*=goToAdminRow]');if(!e)return null;const r=e.getBoundingClientRect();return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]})()");
  if (!centre) throw new Error("Admin row not in the sidebar: this account is not an admin of team " + teamId);
  const [x, y] = centre;
  const page = current.get(ctx);
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await wait(8000);
}

const SEATS = new Set(["Admin", "Limited access", "Full seat", "Dev seat", "Collab seat", "Viewer", "Editor", "Owner"]);
const EMAIL = /^[\w.+-]+@[\w.-]+\.\w+$/;

export async function adminPeople(ctx, args) {
  const teamId = assertTeam(args);
  const tab = await openTab(ctx, "https://www.figma.com/files/team/" + teamId + "/team-admin-console/members", 9000);
  try {
    await ensureConsole(ctx, teamId);
    // The grid virtualizes rows inside its OWN scroll container (div.scroll_container--scrollContainer,
    // overflow: scroll), not the document and not [role=rowgroup]: find the nearest scrollable
    // ancestor of a row and step through it by ~0.8 viewports, collecting until nothing new appears.
    const raw = await evaluate(ctx, `(async()=>{
      const seen=new Map();
      const collect=()=>{for(const r of document.querySelectorAll('[role=row]')){
        const c=[...r.querySelectorAll('[role=cell],[role=gridcell]')].map(x=>x.innerText.replace(/\\n+/g,'|').trim());
        const em=(c.join('|').match(/[\\w.+-]+@[\\w.-]+\\.\\w+/)||[])[0];
        if(em&&!seen.has(em))seen.set(em,c);}};
      let sc=document.querySelector('[role=row]');
      while(sc&&sc!==document.body){const ov=getComputedStyle(sc).overflowY;
        if((ov==='scroll'||ov==='auto')&&sc.scrollHeight>sc.clientHeight+5)break; sc=sc.parentElement;}
      if(!sc||sc===document.body)sc=document.scrollingElement;
      collect(); let stale=0,last=0;
      for(let i=0;i<80&&stale<3;i++){
        sc.scrollTop=Math.min(sc.scrollTop+sc.clientHeight*0.8,sc.scrollHeight);
        await new Promise(r=>setTimeout(r,500)); collect();
        if(seen.size===last)stale++; else {stale=0; last=seen.size;}
        if(sc.scrollTop+sc.clientHeight>=sc.scrollHeight-2)stale++;
      }
      return [...seen.values()];
    })()`);
    return (raw || []).map((cells) => {
      const parts = cells.join("|").split("|").filter((p) => p && !p.startsWith("Select "));
      const email = parts.find((p) => EMAIL.test(p)) || "";
      const seat = parts.find((p) => SEATS.has(p)) || "";
      const name = parts.find((p) => p !== email && p !== seat && p.length > 1) || "";
      const last = parts[parts.length - 1];
      return { name, seat, email, lastActive: [email, seat, name].includes(last) ? "" : last };
    });
  } finally {
    await closeTab(ctx, tab);
  }
}

export async function adminPlan(ctx, args) {
  const teamId = assertTeam(args);
  const tab = await openTab(ctx, "https://www.figma.com/files/team/" + teamId + "/team-admin-console/settings", 9000);
  try {
    await ensureConsole(ctx, teamId);
    const text = await evaluate(ctx, "document.body.innerText");
    const lines = String(text || "").split("\n");
    const start = lines.indexOf("Plan");
    if (start < 0) return "";
    const end = lines.indexOf("Resources", start);
    return lines.slice(start, end > start ? end : undefined).join("\n");
  } finally {
    await closeTab(ctx, tab);
  }
}
