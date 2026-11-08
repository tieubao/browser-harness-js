// learnings/chrome-extensions/tools/extensions.test.mjs
// Runs the tools against a fake ctx; no browser. node --test tools/extensions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUnpacked, extensionInfo, reloadExtension, clearExtensionErrors, setDeveloperMode } from "./extensions.mjs";

const ID = "a".repeat(32);

// Fake ctx: browser-level calls go through session._call; the extensions tab is attached as a Page
// whose cdp() records Runtime.evaluate. `attached` lists the targets ctx.attachPage was asked for.
function fakeCtx({ targets = [], evalResult = { result: { value: { ok: true } } } } = {}) {
  const calls = [];
  const attached = [];
  const session = {
    calls,
    _call: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.createTarget") return { targetId: "NEW" };
      if (method === "Extensions.loadUnpacked") return { id: ID };
      return {};
    },
  };
  const ctx = {
    session,
    calls,
    attached,
    attachPage: async (targetId) => {
      attached.push(targetId);
      return { cdp: async (method, params = {}) => { calls.push({ method, params, target: targetId }); return evalResult; } };
    },
  };
  return ctx;
}

test("loadUnpacked is one browser-level call and attaches no page", async () => {
  const ctx = fakeCtx();
  const out = await loadUnpacked(ctx, { path: "/tmp/ext" });
  assert.deepEqual(out, { id: ID });
  assert.equal(ctx.calls.filter((c) => c.method === "Extensions.loadUnpacked").length, 1);
  assert.deepEqual(ctx.attached, []);
});

test("loadUnpacked rejects a relative path", async () => {
  await assert.rejects(loadUnpacked(fakeCtx(), { path: "ext" }), /absolute path/);
});

test("extensionInfo reuses an open chrome://extensions tab and leaves it open", async () => {
  const ctx = fakeCtx({ targets: [{ type: "page", targetId: "EXT", url: "chrome://extensions/" }] });
  await extensionInfo(ctx, { id: ID });
  assert.ok(!ctx.calls.some((c) => c.method === "Target.createTarget"));
  assert.ok(!ctx.calls.some((c) => c.method === "Target.closeTarget"));
  const evalCall = ctx.calls.find((c) => c.method === "Runtime.evaluate");
  assert.equal(evalCall.target, "EXT");
  assert.equal(evalCall.params.awaitPromise, true);
  assert.equal(evalCall.params.returnByValue, true);
  assert.match(evalCall.params.expression, /getExtensionInfo\("a{32}"\)/);
});

test("opens and closes a tab when none is open", async () => {
  const ctx = fakeCtx();
  await reloadExtension(ctx, { id: ID });
  const create = ctx.calls.find((c) => c.method === "Target.createTarget");
  assert.equal(create.params.url, "chrome://extensions");
  const close = ctx.calls.find((c) => c.method === "Target.closeTarget");
  assert.deepEqual(close.params, { targetId: "NEW" });
  assert.match(ctx.calls.find((c) => c.method === "Runtime.evaluate").params.expression, /failQuietly: true/);
});

test("a page-side exception becomes a thrown Error with its description, created tab still closed", async () => {
  const ctx = fakeCtx({ evalResult: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: No extension with id" } } } });
  await assert.rejects(clearExtensionErrors(ctx, { id: ID }), /No extension with id/);
  assert.ok(ctx.calls.some((c) => c.method === "Target.closeTarget"));
});

test("setDeveloperMode embeds the boolean and validates input", async () => {
  const ctx = fakeCtx();
  await setDeveloperMode(ctx, { enabled: true });
  assert.match(ctx.calls.find((c) => c.method === "Runtime.evaluate").params.expression, /inDeveloperMode: true/);
  await assert.rejects(setDeveloperMode(ctx, { enabled: "yes" }), /enabled: boolean/);
});

test("an id that is not 32 chars a-p is rejected before any CDP call", async () => {
  const ctx = fakeCtx();
  await assert.rejects(extensionInfo(ctx, { id: "abc" }), /invalid extension id/);
  assert.equal(ctx.calls.length, 0);
});
