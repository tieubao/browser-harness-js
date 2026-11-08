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

function assertFuid(args) {
  const id = String((args && args.fuid) || "");
  if (!id) return "";
  if (!/^[0-9]{1,32}$/.test(id)) throw new Error("fuid must be digits, got: " + id);
  return id;
}

// Same-origin GET with the tab's cookies; returns the "meta" object or null on a non-200.
const GET_META = (path) => `(async()=>{const r=await fetch(${JSON.stringify(path)},{credentials:'include'});
  if(!r.ok)return null; const j=await r.json(); return j.meta||null;})()`;

// Folder id -> {files, roles} from the paginated_files endpoint (first 200 files, newest touched first).
async function folderContents(ctx, id) {
  const path = "/api/folders/" + id + "/paginated_files?folderId=" + id +
    "&sort_column=touched_at&sort_order=desc&fetch_only_trashed_with_folder_files=false&page_size=200&file_type=";
  const meta = (await evaluate(ctx, GET_META(path))) || {};
  const files = (meta.files || []).filter((f) => !f.trashed_at).map((f) => ({
    name: f.name, touched: f.touched_at, link: f.link_access, pw: !!f.has_file_link_password,
  }));
  const roles = (meta.roles || []).map((r) => (r.user && r.user.handle ? r.user.handle : r.pending_email || "?") + ":" + r.level);
  return { files, roles };
}

// No subfolder endpoint exists. The folder page itself fetches paginated_files for each child, so
// open the page and read those request URLs from the resource timings (own id dropped).
async function subfolderIds(ctx, teamId, id, fuid) {
  await evaluate(ctx, "performance.clearResourceTimings()");
  const q = fuid ? "?fuid=" + fuid : "";
  await evaluate(ctx, "location.href='https://www.figma.com/files/team/" + teamId + "/folder/" + id + q + "'");
  await wait(8000);
  const urls = await evaluate(ctx, "performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/\\/api\\/folders\\/\\d+\\/paginated_files/.test(n))");
  const ids = new Set();
  for (const u of urls || []) {
    const m = u.match(/\/api\/folders\/(\d+)\/paginated_files/);
    if (m && m[1] !== id) ids.add(m[1]);
  }
  return [...ids];
}

export async function teamTree(ctx, args) {
  const teamId = assertTeam(args);
  const fuid = assertFuid(args);
  const q = fuid ? "?fuid=" + fuid : "";
  const tab = await openTab(ctx, "https://www.figma.com/files/team/" + teamId + q, 8000);
  try {
    const top = (await evaluate(ctx, GET_META("/api/teams/" + teamId + "/folders"))) || {};
    const rows = (top.folder_rows || []).filter((r) => !r.trashed_at);
    const tree = [];
    for (const row of rows) {
      const id = String(row.id);
      const node = {
        id, name: row.name || row.path || "", team_access: row.team_access, invite_only: !!row.is_invite_only,
        ...(await folderContents(ctx, id)), subs: [],
      };
      for (const subId of await subfolderIds(ctx, teamId, id, fuid)) {
        const info = (await evaluate(ctx, GET_META("/api/folders/" + subId))) || {};
        if (info.trashed_at) continue;
        node.subs.push({
          id: subId, name: info.path || info.name || "", team_access: info.team_access, invite_only: !!info.is_invite_only,
          ...(await folderContents(ctx, subId)),
        });
      }
      tree.push(node);
    }
    return tree;
  } finally {
    await closeTab(ctx, tab);
  }
}
