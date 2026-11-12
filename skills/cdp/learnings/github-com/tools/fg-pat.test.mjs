// Offline check of openFgPat / addFgPatRepo with a fake ctx: argument validation, the sudo/ready
// state machine, abort reasons relayed from the in-page guards, and that the generated page
// expression compiles and carries every guard. No browser, no GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { openFgPat, addFgPatRepo, addRepoExpression } from "./fg-pat.mjs";

const TOKEN_URL = "https://github.com/settings/personal-access-tokens/777";

function fakeCtx({ states, evals = {} }) {
  const closed = [], created = [], cdpCalls = [];
  let i = 0;
  const page = {
    async cdp(method, params) {
      cdpCalls.push(method);
      if (method !== "Runtime.evaluate") return {};
      const e = params.expression;
      if (e.includes("JSON.stringify({ title: document.title")) return { result: { value: JSON.stringify(states[Math.min(i++, states.length - 1)]) } };
      for (const [needle, value] of Object.entries(evals)) if (e.includes(needle)) return { result: { value } };
      return { result: {} };
    },
  };
  const ctx = {
    session: { Target: { async createTarget(p) { created.push(p.url); return { targetId: "T1" }; }, async closeTarget({ targetId }) { closed.push(targetId); } } },
    async attachPage() { return page; },
  };
  return { ctx, closed, created, cdpCalls };
}

test("openFgPat rejects bad args before opening a tab", async () => {
  const { ctx, created } = fakeCtx({ states: [{}] });
  await assert.rejects(() => openFgPat(ctx, { tokenId: "12/edit" }), /tokenId must be digits/);
  await assert.rejects(() => openFgPat(ctx, { tokenId: "1", waitMs: -1 }), /waitMs/);
  assert.deepEqual(created, []);
});

test("addFgPatRepo rejects bad args", async () => {
  const { ctx } = fakeCtx({ states: [{}] });
  const ok = { targetId: "T", org: "dwarvesf", repoId: "123", expectCount: 4 };
  await assert.rejects(() => addFgPatRepo(ctx, { ...ok, targetId: undefined }), /targetId is required/);
  await assert.rejects(() => addFgPatRepo(ctx, { ...ok, org: 'x"]' }), /org must be/);
  await assert.rejects(() => addFgPatRepo(ctx, { ...ok, repoId: "12a" }), /repoId must be digits/);
  await assert.rejects(() => addFgPatRepo(ctx, { ...ok, expectCount: "4" }), /expectCount/);
  await assert.rejects(() => addFgPatRepo(ctx, { ...ok, expectCount: 0 }), /expectCount/);
});

test("openFgPat on a fresh tab at the sudo gate returns the digits and leaves the tab open", async () => {
  const { ctx, closed, created } = fakeCtx({
    states: [{ title: "Confirm access", href: "https://github.com/sessions/sudo" }],
    evals: { "Use GitHub Mobile\"": true, "leaf": "42" },
  });
  const r = await openFgPat(ctx, { tokenId: "777" });
  assert.deepEqual(created, [TOKEN_URL]);
  assert.deepEqual(r, { status: "sudo", targetId: "T1", digits: "42" });
  assert.deepEqual(closed, []);
});

test("openFgPat on a fresh tab past sudo is ready; a wrong page is unexpected", async () => {
  let f = fakeCtx({ states: [{ title: "Personal access token", href: TOKEN_URL }] });
  assert.deepEqual(await openFgPat(f.ctx, { tokenId: "777" }), { status: "ready", targetId: "T1" });
  f = fakeCtx({ states: [{ title: "Sign in", href: "https://github.com/login" }] });
  assert.deepEqual(await openFgPat(f.ctx, { tokenId: "777" }), { status: "unexpected", targetId: "T1", href: "https://github.com/login" });
});

test("openFgPat with targetId polls until sudo clears, without clicking again", async () => {
  const { ctx, cdpCalls } = fakeCtx({ states: [
    { title: "Confirm access", href: "x" }, { title: "Confirm access", href: "x" }, { title: "Token", href: TOKEN_URL },
  ] });
  const r = await openFgPat(ctx, { tokenId: "777", targetId: "T9", waitMs: 10000 });
  assert.deepEqual(r, { status: "ready", targetId: "T9" });
  assert.ok(!cdpCalls.includes("Page.reload"));
});

test("addFgPatRepo refuses to run at the sudo gate or off the token page", async () => {
  const args = { targetId: "T", org: "dwarvesf", repoId: "123", expectCount: 4 };
  let f = fakeCtx({ states: [{ title: "Confirm access", href: "x" }] });
  assert.equal((await addFgPatRepo(f.ctx, args)).reason, "sudo");
  f = fakeCtx({ states: [{ title: "Home", href: "https://github.com/" }] });
  assert.equal((await addFgPatRepo(f.ctx, args)).reason, "not-on-token-page");
});

test("addFgPatRepo relays an in-page abort and reports no success", async () => {
  const f = fakeCtx({
    states: [{ title: "Token", href: TOKEN_URL }],
    evals: { "grant-requests": JSON.stringify({ aborted: "count-mismatch", count: 5, expect: 4 }) },
  });
  const r = await addFgPatRepo(f.ctx, { targetId: "T", org: "dwarvesf", repoId: "123", expectCount: 4 });
  assert.equal(r.done, false);
  assert.equal(r.reason, "count-mismatch");
  assert.equal(r.count, 5);
});

test("the page expression compiles, is one evaluation, and carries every guard in order", () => {
  const src = addRepoExpression({ org: "dwarvesf", repoId: 123, expectCount: 4 });
  assert.doesNotThrow(() => new vm.Script(src));
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("edits[1].click()") < at("install-target-not-selected"));
  assert.ok(at("install-target-not-selected") < at("count-mismatch"));
  assert.ok(at("count-mismatch") < at("already-present"));
  assert.ok(at("already-present") < at("cloneNode(true)"));
  assert.ok(at("cloneNode(true)") < at("setTimeout(() => update.click(), 300)"));
  assert.ok(src.includes('"123"') && src.includes("expect = 4"));
});
