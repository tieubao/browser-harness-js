// learnings/app-notion-com/tools/workspace.mjs
// Notion's internal web API (/api/v3), called same-origin from a logged-in app.notion.com tab.
// Unlike the official API token, it reaches EVERY workspace the signed-in user belongs to.
// Each call re-pins the session to the app.notion.com tab, because the REPL is shared across sessions.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOME = "https://app.notion.com/";
const TIME_ZONE = "Asia/Ho_Chi_Minh";

async function ev(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception && exceptionDetails.exception.description) || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Pin the session to an app.notion.com tab (open one if none). Runs inside every API call.
async function pin(ctx) {
  const { targetInfos } = await ctx.session.Target.getTargets();
  let tab = targetInfos.find((t) => t.type === "page" && t.url.startsWith(HOME));
  if (!tab) {
    const { targetId } = await ctx.session.Target.createTarget({ url: HOME });
    tab = { targetId };
    await wait(4000);
  }
  await ctx.session.use(tab.targetId);
}

// POST /api/v3/<endpoint> from the page. Returns the parsed JSON body.
// Throws when signed out; a Notion error body ({isNotionError:true, debugMessage}) is returned as-is.
export async function notionApi(ctx, endpoint, body = {}) {
  await pin(ctx);
  const expr = `(async()=>{const r=await fetch(${JSON.stringify("/api/v3/" + endpoint)},{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(${JSON.stringify(body)})});
    const t=await r.text();try{return JSON.parse(t)}catch(e){return {isNotionError:true,debugMessage:"HTTP "+r.status+" "+t.slice(0,200)}}})()`;
  const res = await ev(ctx, expr);
  if (res && res.name === "UnauthorizedError") throw new Error("not signed in to app.notion.com");
  return res;
}

const isErr = (res) => !!(res && res.isNotionError);
const errText = (res) => (res && (res.debugMessage || res.message)) || "unknown Notion error";

// Records come back as {value:{value:{...},role}}; older shapes as {value:{...},role}.
export function unwrap(rec) {
  const v = rec && rec.value;
  if (v && typeof v === "object" && v.value && typeof v.value === "object" && "role" in v) return v.value;
  return v === undefined ? null : v;
}

export async function listSpaces(ctx) {
  const res = await notionApi(ctx, "getSpaces", {});
  if (isErr(res)) throw new Error("getSpaces failed: " + errText(res));
  const seen = new Map();
  for (const user of Object.values(res || {})) {
    for (const rec of Object.values((user && user.space) || {})) {
      const s = unwrap(rec);
      if (s && s.id && !seen.has(s.id)) seen.set(s.id, { id: s.id, name: s.name, plan_type: s.plan_type });
    }
  }
  return [...seen.values()];
}

export async function getRecords(ctx, args) {
  const { table, ids, spaceId } = args || {};
  if (!table || !spaceId || !Array.isArray(ids) || !ids.length) throw new Error("table, spaceId and a non-empty ids array required");
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await notionApi(ctx, "syncRecordValuesSpace", { requests: chunk.map((id) => ({ pointer: { table, id, spaceId }, version: -1 })) });
    if (isErr(res)) throw new Error("syncRecordValuesSpace failed: " + errText(res));
    const bucket = (res && res.recordMap && res.recordMap[table]) || {};
    for (const id of chunk) out[id] = unwrap(bucket[id]);
  }
  return out;
}

export async function queryCollection(ctx, args) {
  const { collectionId, viewId, spaceId, limit = 50 } = args || {};
  if (!collectionId || !viewId || !spaceId) throw new Error("collectionId, viewId and spaceId required");
  const res = await notionApi(ctx, "queryCollection", {
    collection: { id: collectionId, spaceId },
    collectionView: { id: viewId, spaceId },
    loader: { type: "reducer", reducers: { collection_group_results: { type: "results", limit } }, searchQuery: "", userTimeZone: TIME_ZONE },
  });
  if (isErr(res)) throw new Error("queryCollection failed: " + errText(res));
  const blockIds = (res && res.result && res.result.reducerResults && res.result.reducerResults.collection_group_results && res.result.reducerResults.collection_group_results.blockIds) || [];
  const blocks = (res && res.recordMap && res.recordMap.block) || {};
  const records = {};
  for (const [id, rec] of Object.entries(blocks)) records[id] = unwrap(rec);
  return { blockIds, records };
}

// A top-level page (parent_table "space") created without permissions becomes a role-none orphan:
// nobody, including the creator, can edit it again. Returns the refusal text, or null when safe.
export function permissionGuard(operations) {
  for (const op of operations) {
    const args = op && op.args;
    if (!op || op.command !== "set" || !args || args.parent_table !== "space") continue;
    if (op.pointer && op.pointer.table && op.pointer.table !== "block") continue;
    if (!Array.isArray(args.permissions) || args.permissions.length === 0) {
      const id = (op.pointer && op.pointer.id) || "?";
      return `refusing to create top-level block ${id} (parent_table "space") without a non-empty permissions array: ` +
        "it would become a role-none orphan that nobody, including the creator, can edit again. " +
        "Put {type:\"user_permission\", role:\"editor\", user_id} for each user in the FIRST set op.";
    }
  }
  return null;
}

export async function saveTransaction(ctx, args) {
  const { spaceId, operations, label = "browser-harness-js" } = args || {};
  if (!spaceId || !Array.isArray(operations) || !operations.length) throw new Error("spaceId and a non-empty operations array required");
  const refusal = permissionGuard(operations);
  if (refusal) return { ok: false, error: refusal };
  const ops = operations.map((op) => ({ ...op, pointer: { spaceId, ...op.pointer } }));
  const res = await notionApi(ctx, "saveTransactionsFanout", {
    requestId: globalThis.crypto.randomUUID(),
    transactions: [{ id: globalThis.crypto.randomUUID(), spaceId, debug: { userAction: label }, operations: ops }],
  });
  if (isErr(res)) return { ok: false, error: errText(res) };
  return { ok: true, error: null };
}
