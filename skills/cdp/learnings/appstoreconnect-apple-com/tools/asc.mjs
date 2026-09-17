// learnings/appstoreconnect-apple-com/tools/asc.mjs
// App Store Connect's React app talks the same /iris/v1 (and /iris/v2) JSON:API it renders from,
// authenticated by the signed-in session cookie instead of a token. A deep link opened in a fresh
// tab fails auth (authResult=FAILED), so every call routes through ONE dedicated background tab,
// first navigated to /apps (the signed-in browser context already carries the cookie) and reused
// for the life of the daemon (module scope, like dash-cloudflare-com's tab). Never attach to the
// tab a human is looking at; open a dedicated one instead (see notes/overview.md).
//
// Every page-side fetch carries its own AbortController timeout and every Runtime.evaluate a
// `timeout`; a fetch without one wedged the shared daemon for 10 minutes during the session this
// learning was ported from.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FETCH_TIMEOUT_MS = 20000;
let tabId;

async function evaluate(ctx, expression, { awaitPromise = true, timeout = 25000 } = {}) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({
    expression, returnByValue: true, userGesture: true, awaitPromise, timeout,
  });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function ensureTab(ctx) {
  if (tabId) {
    const alive = (await ctx.listPageTargets()).some((t) => t.targetId === tabId);
    if (alive) { await ctx.session.use(tabId); return tabId; }
  }
  const { targetId } = await ctx.session.Target.createTarget({ url: "https://appstoreconnect.apple.com/apps", background: true });
  tabId = targetId;
  await ctx.session.use(tabId);
  await wait(6000);
  return tabId;
}

async function isSignedIn(ctx) {
  await ensureTab(ctx);
  const url = await evaluate(ctx, "location.href", { awaitPromise: false, timeout: 8000 });
  return typeof url === "string" && url.includes("appstoreconnect.apple.com") && !url.includes("/login");
}

// Page-side fetch helper, inlined into every /iris expression below. Builds its own
// AbortController per request so a slow or hung request times out instead of wedging the daemon.
const TF = `const H={'Accept':'application/json','Content-Type':'application/json'};
const tf=async(u,o={})=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),${FETCH_TIMEOUT_MS});
try{return await fetch(u,{credentials:'include',signal:c.signal,headers:H,...o})}finally{clearTimeout(t)}};`;

// Find or open a signed-in App Store Connect tab. Read-only: never mutates app data.
export async function status(ctx, _args) {
  const signedIn = await isSignedIn(ctx);
  const url = await evaluate(ctx, "location.href", { awaitPromise: false, timeout: 8000 });
  return { signedIn, url, tabId };
}

// Every app + its versions, plus the active / removed name lists. Read-only.
export async function inventory(ctx, _args) {
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };
  const expr = `(async()=>{${TF}
    const inv=await (await tf('/iris/v1/apps?limit=200&include=appStoreVersions&fields[apps]=name,bundleId,sku,appStoreVersions&fields[appStoreVersions]=appStoreState,platform,versionString,createdDate&limit[appStoreVersions]=5')).json();
    const vers={};for(const v of (inv.included||[]))vers[v.id]=v.attributes;
    const apps=inv.data.map(a=>({id:a.id,name:a.attributes.name,bundleId:a.attributes.bundleId,sku:a.attributes.sku,
      versions:(a.relationships.appStoreVersions.data||[]).map(d=>{const v=vers[d.id]||{};return {platform:v.platform,version:v.versionString,state:v.appStoreState,created:v.createdDate}})}));
    const active=(await (await tf('/iris/v1/apps?limit=200&fields[apps]=name&filter[removed]=false')).json()).data.map(a=>a.attributes.name);
    const removed=(await (await tf('/iris/v1/apps?limit=200&fields[apps]=name&filter[removed]=true')).json()).data.map(a=>a.attributes.name);
    return {apps,active,removed};
  })()`;
  return evaluate(ctx, expr);
}

// One app's availability, review submissions, versions, in-app purchase count, beta groups,
// builds. Read-only.
export async function appState(ctx, args) {
  const { id } = args || {};
  if (!id) throw new Error("appState: id is required");
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };
  const expr = `(async()=>{${TF}
    const av=await (await tf('/iris/v1/apps/${id}/appAvailabilityV2?include=territoryAvailabilities&limit[territoryAvailabilities]=200&fields[territoryAvailabilities]=available')).json();
    const availableCount=(av.included||[]).filter(x=>x.attributes.available).length;
    const availableInNewTerritories=!!(av.data&&av.data.attributes&&av.data.attributes.availableInNewTerritories);
    const rs=await (await tf('/iris/v1/apps/${id}/reviewSubmissions?limit=20')).json();
    const versions=await (await tf('/iris/v1/apps/${id}/appStoreVersions?limit=10&fields[appStoreVersions]=appStoreState,platform,versionString')).json();
    const iap=await (await tf('/iris/v1/apps/${id}/inAppPurchasesV2?limit=5')).json();
    const bg=await (await tf('/iris/v1/apps/${id}/betaGroups?limit=10&fields[betaGroups]=name,isInternalGroup')).json();
    const builds=await (await tf('/iris/v1/apps/${id}/builds?limit=5&fields[builds]=version,processingState,expired')).json();
    return {
      availableCount, availableInNewTerritories,
      reviewSubmissions:(rs.data||[]).map(d=>({id:d.id,state:d.attributes.state,platform:d.attributes.platform,submitted:d.attributes.submittedDate})),
      versions:(versions.data||[]).map(d=>({id:d.id,platform:d.attributes.platform,version:d.attributes.versionString,state:d.attributes.appStoreState})),
      inAppPurchaseCount:(iap.data||[]).length,
      betaGroups:(bg.data||[]).map(d=>({name:d.attributes.name,internal:!!d.attributes.isInternalGroup})),
      builds:(builds.data||[]).map(d=>({version:d.attributes.version,state:d.attributes.processingState,expired:!!d.attributes.expired})),
    };
  })()`;
  return evaluate(ctx, expr);
}

// WRITE. PATCH every available territoryAvailabilities/<id> to available:false, 10 at a time.
export async function takeOffSale(ctx, args) {
  const { id } = args || {};
  if (!id) throw new Error("takeOffSale: id is required");
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };
  const expr = `(async()=>{${TF}
    const av=await (await tf('/iris/v1/apps/${id}/appAvailabilityV2?include=territoryAvailabilities&limit[territoryAvailabilities]=200&fields[territoryAvailabilities]=available')).json();
    const ids=(av.included||[]).filter(x=>x.attributes.available).map(x=>x.id);
    const codes={};
    for(let i=0;i<ids.length;i+=10){
      const rs=await Promise.all(ids.slice(i,i+10).map(t=>tf('/iris/v1/territoryAvailabilities/'+t,{method:'PATCH',
        body:JSON.stringify({data:{type:'territoryAvailabilities',id:t,attributes:{available:false}}})}).then(r=>r.status).catch(()=>'ERR')));
      for(const s of rs) codes[s]=(codes[s]||0)+1;
    }
    return {territories:ids.length, statusCounts:codes};
  })()`;
  return evaluate(ctx, expr);
}

// WRITE, UI-only step. The API refuses to change availableInNewTerritories directly (PATCH
// /iris/v2/appAvailabilities/<id> -> 403, POST -> 409), so the pricing page's own checkbox is
// the only path. Drives it with real click() + userGesture, per fix3.js/flag.js.
export async function clearFutureTerritories(ctx, args) {
  const { id } = args || {};
  if (!id) throw new Error("clearFutureTerritories: id is required");
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };
  await ctx.session.Page.navigate({ url: `https://appstoreconnect.apple.com/apps/${id}/distribution/pricing` });
  const ready = `location.href.includes('/${id}/')&&[...document.querySelectorAll('button')].some(x=>(x.innerText||'').trim()==='Manage')`;
  for (let i = 0; i < 30; i++) {
    if (await evaluate(ctx, `(${ready})`, { awaitPromise: false, timeout: 8000 })) break;
    await wait(800);
  }
  await wait(2500);
  const press = (label) => evaluate(ctx,
    `(()=>{const e=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()===${JSON.stringify(label)}&&x.getBoundingClientRect().width>0&&!x.disabled);if(!e)return 'none';e.click();return 'clicked'})()`,
    { awaitPromise: false, timeout: 8000 });
  const manage = await press("Manage"); await wait(3500);
  const manageAvailability = await press("Manage Availability"); await wait(3500);
  const uncheck = await evaluate(ctx,
    "(()=>{const e=[...document.querySelectorAll('input[type=checkbox]')].find(x=>/automatically available in all future/i.test((x.labels&&x.labels[0]&&x.labels[0].innerText)||''));if(!e)return 'none';if(e.checked)e.click();return 'checked='+e.checked})()",
    { awaitPromise: false, timeout: 8000 });
  await wait(1200);
  const next = await press("Next"); await wait(3500);
  const confirm = await press("Confirm"); await wait(6000);
  const expr = `(async()=>{${TF}const a=await (await tf('/iris/v1/apps/${id}/appAvailabilityV2')).json();return !!(a.data&&a.data.attributes&&a.data.attributes.availableInNewTerritories)})()`;
  const availableInNewTerritories = await evaluate(ctx, expr);
  return { manage, manageAvailability, uncheck, next, confirm, availableInNewTerritories };
}

// WRITE, destructive but restorable from Removed Apps. Refuses unless the app's current name
// equals expectName exactly -- the negative control that never issues the PATCH on a guess.
export async function removeApp(ctx, args) {
  const { id, expectName } = args || {};
  if (!id || !expectName) throw new Error("removeApp: id and expectName are required");
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };

  const getExpr = `(async()=>{${TF}const r=await tf('/iris/v1/apps/${id}?fields[apps]=name,removed');if(!r.ok)return {httpError:r.status};return (await r.json()).data.attributes;})()`;
  const current = await evaluate(ctx, getExpr);
  if (!current || current.httpError) return { refused: "lookup-failed", detail: current };
  if (current.name !== expectName) {
    return { refused: "name-mismatch", expectName, actualName: current.name };
  }

  const patchExpr = `(async()=>{${TF}
    const r=await tf('/iris/v1/apps/${id}',{method:'PATCH',body:JSON.stringify({data:{type:'apps',id:'${id}',attributes:{removed:true}}})});
    if(r.ok)return {ok:true,status:r.status};
    const j=await r.json().catch(()=>({}));
    return {ok:false,status:r.status,errors:(j.errors||[]).map(e=>({code:e.code,detail:e.detail}))};
  })()`;
  const patch = await evaluate(ctx, patchExpr);
  if (!patch || !patch.ok) return { removed: false, ...patch };

  const pollExpr = `(async()=>{${TF}const a=await (await tf('/iris/v1/apps/${id}?fields[apps]=name,removed')).json();return !!(a.data&&a.data.attributes&&a.data.attributes.removed)})()`;
  const deadline = Date.now() + 30000;
  let confirmed = false;
  while (Date.now() < deadline) {
    confirmed = await evaluate(ctx, pollExpr);
    if (confirmed) break;
    await wait(2000);
  }
  return { removed: true, confirmed };
}

// Read the Business page for agreement rows and tax-form rows. Read-only.
export async function agreements(ctx, _args) {
  if (!(await isSignedIn(ctx))) return { stop: "not-signed-in" };
  await ctx.session.Page.navigate({ url: "https://appstoreconnect.apple.com/business" });
  await wait(12000);
  const expr = `(()=>{
    const t=(document.querySelector('main')||document.body).innerText.replace(/\\n+/g,' | ');
    const agr=t.slice(t.indexOf('TYPE'), t.indexOf('TYPE')+420);
    const tax=t.slice(t.indexOf('Tax Forms'), t.indexOf('Tax Forms')+330);
    return {agreements:agr, taxForms:tax};
  })()`;
  return evaluate(ctx, expr, { awaitPromise: false, timeout: 8000 });
}
