// learnings/chrome-extensions/tools/extensions.test.mjs
// Runs the tools against a fake Session; no browser. node --test tools/extensions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUnpacked, extensionInfo, reloadExtension, clearExtensionErrors, setDeveloperMode } from "./extensions.mjs";

const ID = "a".repeat(32);

function fakeSession({ targets = [], evalResult = { result: { value: { ok: true } } } } = {}) {
  let active = "PAGE-1";
  const calls = [];
  const session = {
    calls,
    getActiveSession: () => active,
    setActiveSession: (s) => { active = s; },
    use: async (targetId) => { active = `S-${targetId}`; return active; },
    _call: async (method, params = {}) => {
      calls.push({ method, params, active });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.createTarget") return { targetId: "NEW" };
      if (method === "Extensions.loadUnpacked") return { id: ID };
      if (method === "Runtime.evaluate") return evalResult;
      return {};
    },
  };
  return session;
}

test("loadUnpacked calls with no page session and restores the previous one", async () => {
  const session = fakeSession();
  const out = await loadUnpacked({ session }, { path: "/tmp/ext" });
  assert.deepEqual(out, { id: ID });
  const call = session.calls.find((c) => c.method === "Extensions.loadUnpacked");
  assert.equal(call.active, undefined);
  assert.equal(session.getActiveSession(), "PAGE-1");
});

test("loadUnpacked rejects a relative path", async () => {
  await assert.rejects(loadUnpacked({ session: fakeSession() }, { path: "ext" }), /absolute path/);
});

test("extensionInfo reuses an open chrome://extensions tab and restores the session", async () => {
  const session = fakeSession({ targets: [{ type: "page", targetId: "EXT", url: "chrome://extensions/" }] });
  await extensionInfo({ session }, { id: ID });
  assert.ok(!session.calls.some((c) => c.method === "Target.createTarget"));
  assert.ok(!session.calls.some((c) => c.method === "Target.closeTarget"));
  const evalCall = session.calls.find((c) => c.method === "Runtime.evaluate");
  assert.equal(evalCall.active, "S-EXT");
  assert.equal(evalCall.params.awaitPromise, true);
  assert.equal(evalCall.params.returnByValue, true);
  assert.match(evalCall.params.expression, /getExtensionInfo\("a{32}"\)/);
  assert.equal(session.getActiveSession(), "PAGE-1");
});

test("opens and closes a tab when none is open", async () => {
  const session = fakeSession();
  await reloadExtension({ session }, { id: ID });
  const create = session.calls.find((c) => c.method === "Target.createTarget");
  assert.equal(create.params.url, "chrome://extensions");
  const close = session.calls.find((c) => c.method === "Target.closeTarget");
  assert.deepEqual(close.params, { targetId: "NEW" });
  assert.match(session.calls.find((c) => c.method === "Runtime.evaluate").params.expression, /failQuietly: true/);
  assert.equal(session.getActiveSession(), "PAGE-1");
});

test("a page-side exception becomes a thrown Error with its description, session still restored", async () => {
  const session = fakeSession({ evalResult: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: No extension with id" } } } });
  await assert.rejects(clearExtensionErrors({ session }, { id: ID }), /No extension with id/);
  assert.equal(session.getActiveSession(), "PAGE-1");
});

test("setDeveloperMode embeds the boolean and validates input", async () => {
  const session = fakeSession();
  await setDeveloperMode({ session }, { enabled: true });
  assert.match(session.calls.find((c) => c.method === "Runtime.evaluate").params.expression, /inDeveloperMode: true/);
  await assert.rejects(setDeveloperMode({ session }, { enabled: "yes" }), /enabled: boolean/);
});

test("an id that is not 32 chars a-p is rejected before any CDP call", async () => {
  const session = fakeSession();
  await assert.rejects(extensionInfo({ session }, { id: "abc" }), /invalid extension id/);
  assert.equal(session.calls.length, 0);
});
