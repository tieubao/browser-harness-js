// learnings/app-box-com/tools/app-box-com.mjs
// Box web app (app.box.com), read-only folder listing from the logged-in session. Opens its own
// background tab, walks folders serially in it, and always closes it.
//
// Traps this encodes (verified live 2026-11-09 on a shared tax folder):
//   - Rows are anchors with data-resin-target="openfolder" / "openfile". The breadcrumb links
//     (class ItemListBreadcrumb-link, folder/0 and every ancestor) match the same selector, so
//     only anchors inside a [role=row] count, and the folder itself plus ancestor ids are dropped.
//   - A row's text leaves are [name, "<date> by <user>", "<size>"]; textContent concatenates them
//     ("Han Ngo6 Files"), so read the leaves, not textContent.
//   - The SPA needs ~8-10 s after load in a background tab; this polls instead of a fixed sleep.
//   - The /search?query= route did not work from a background tab; there is no search tool.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_DEPTH = 4;

function assertArgs(args) {
  const folderId = String(args && args.folderId !== undefined ? args.folderId : "0");
  if (!/^[0-9]{1,32}$/.test(folderId)) throw new Error("folderId must be digits, got: " + folderId);
  const depth = args && args.depth !== undefined ? Number(args.depth) : 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new Error("depth must be an integer 1.." + MAX_DEPTH + ", got: " + (args && args.depth));
  return { folderId, depth };
}

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception && exceptionDetails.exception.description) || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Runs in the page. Polls until rows (or an empty folder) render, scrolls the virtualized list,
// and returns {path, rows:[{id,kind,name,leaves}]} for the folder the URL names.
const readFolderScript = (folderId) => `(async()=>{
  const want=${JSON.stringify(folderId)};
  const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
  const rowAnchors=()=>[...document.querySelectorAll('[data-resin-target="openfolder"],[data-resin-target="openfile"]')].filter(a=>a.closest('[role=row]'));
  const title=()=>document.querySelector('h1.page-title');
  const started=Date.now();
  let settled=false;
  while(Date.now()-started<25000){
    const onPage=location.pathname.replace(/\\/+$/,'').endsWith('/folder/'+want);
    if(onPage&&title()&&rowAnchors().length){await sleep(1000);settled=true;break;}
    if(onPage&&title()&&Date.now()-started>12000){settled=true;break;}
    await sleep(500);
  }
  if(!settled)throw new Error('timed out waiting for folder '+want+' to render (not logged in, or no access)');
  const crumbs=[...document.querySelectorAll('nav[aria-label="Breadcrumb"] ol:not(.is-measurer) .ItemListBreadcrumb-link')];
  const ancestors=new Set(crumbs.map(a=>(a.getAttribute('href')||'').split('/').pop()));
  const parts=crumbs.map(a=>a.textContent.trim());
  parts.push((title().textContent||'').trim());
  const seen=new Map();
  const collect=()=>{for(const a of rowAnchors()){
    const href=a.getAttribute('href')||'';
    const m=href.match(/^\\/(folder|file)\\/(\\d+)/);
    if(!m)continue;
    const id=m[2];
    if(m[1]==='folder'&&(id===want||ancestors.has(id)))continue;
    const row=a.closest('[role=row]');
    const leaves=[];const w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let n;
    while(n=w.nextNode()){const t=n.textContent.trim();if(t)leaves.push(t);}
    const key=m[1]+'/'+id;
    const name=(a.textContent||'').trim()||leaves[0]||'';
    const prev=seen.get(key);
    if(!prev||(!prev.name&&name))seen.set(key,{id,kind:m[1],name,leaves});
  }};
  let sc=rowAnchors()[0];
  while(sc&&sc!==document.body){const ov=getComputedStyle(sc).overflowY;
    if((ov==='scroll'||ov==='auto')&&sc.scrollHeight>sc.clientHeight+5)break;sc=sc.parentElement;}
  collect();
  if(sc&&sc!==document.body){
    let stale=0,last=seen.size;
    for(let i=0;i<60&&stale<3;i++){
      sc.scrollTop=Math.min(sc.scrollTop+sc.clientHeight*0.8,sc.scrollHeight);
      await sleep(500);collect();
      if(seen.size===last)stale++;else{stale=0;last=seen.size;}
    }
  }
  return {path:parts.join(' / '),rows:[...seen.values()]};
})()`;

const SIZE = /^\d[\d.,]*\s?(?:bytes|B|KB|MB|GB|TB)$|^\d+\s+Files?$/i;

// Leaves are [name, "<date> by <user>", "<size>"]; either tail leaf can be missing.
export function parseRow(row) {
  const rest = row.leaves.filter((t) => t !== row.name);
  const sizeLeaf = rest.find((t) => SIZE.test(t));
  const meta = rest.find((t) => t !== sizeLeaf);
  const updated = meta ? meta.split(/\s+by\s+/)[0].trim() : null;
  return { name: row.name, id: row.id, kind: row.kind, updated: updated || null, size: sizeLeaf || null };
}

async function readFolder(page, folderId) {
  let out;
  for (let attempt = 1; ; attempt++) {
    try { out = await evaluate(page, readFolderScript(folderId)); break; }
    catch (e) {
      // A navigation started just before the read can tear down the execution context.
      if (attempt >= 3 || !/context|destroyed|detached|navigat/i.test(String(e.message))) throw e;
      await wait(1500);
    }
  }
  return { path: out.path, items: (out.rows || []).map(parseRow) };
}

async function walk(page, folderId, depth, visited) {
  const listing = await readFolder(page, folderId);
  if (depth > 1) {
    for (const item of listing.items) {
      if (item.kind !== "folder" || visited.has(item.id)) continue;
      visited.add(item.id);
      await evaluate(page, "location.href=" + JSON.stringify("https://app.box.com/folder/" + item.id));
      await wait(1500);
      const sub = await walk(page, item.id, depth - 1, visited);
      item.children = sub.items;
    }
  }
  return listing;
}

export async function listFolder(ctx, args) {
  const { folderId, depth } = assertArgs(args);
  const { targetId } = await ctx.session.Target.createTarget({ url: "https://app.box.com/folder/" + folderId, background: true });
  try {
    const page = await ctx.attachPage(targetId, { allowedOrigins: ["https://app.box.com"] });
    await page.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await page.cdp("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    await wait(2000);
    const result = await walk(page, folderId, depth, new Set([folderId]));
    return result;
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}
