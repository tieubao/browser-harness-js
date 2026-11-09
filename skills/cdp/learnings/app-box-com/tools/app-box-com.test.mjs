// Offline check of listFolder with a fake ctx: validation, row parsing, breadcrumb/self exclusion
// handled in-page (faked here), depth walk, and the tab closed even on failure. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listFolder, parseRow } from "./app-box-com.mjs";

const LISTINGS = {
  "10": { path: "Files / Top", rows: [
    { id: "11", kind: "folder", name: "Sub", leaves: ["Sub", "Mar 18, 2025 by Han Ngo", "2 Files"] },
    { id: "90", kind: "file", name: "a.pdf", leaves: ["a.pdf", "Feb 6, 2025 by Start", "58.7 KB"] },
  ] },
  "11": { path: "Files / Top / Sub", rows: [
    { id: "91", kind: "file", name: "b.pdf", leaves: ["b.pdf", "Jan 1, 2025 by X", "3.8 MB"] },
  ] },
};

function fakeCtx({ failOn = null } = {}) {
  const closed = [];
  const navigations = [];
  let current = "10";
  const page = {
    async cdp(method, params) {
      if (method !== "Runtime.evaluate") return {};
      const e = params.expression;
      if (failOn && e.includes(failOn)) return { exceptionDetails: { text: "boom" } };
      if (e.startsWith("location.href=")) { navigations.push(e); current = e.match(/folder\/(\d+)/)[1]; return { result: {} }; }
      const want = e.match(/const want="(\d+)"/);
      if (want) return { result: { value: LISTINGS[want[1]] } };
      return { result: {} };
    },
  };
  const ctx = {
    session: { Target: { async createTarget() { return { targetId: "T" }; }, async closeTarget({ targetId }) { closed.push(targetId); } } },
    async attachPage() { return page; },
  };
  return { ctx, closed, navigations };
}

test("rejects a bad folderId or depth before opening a tab", async () => {
  const { ctx, closed } = fakeCtx();
  await assert.rejects(() => listFolder(ctx, { folderId: "1;2" }), /folderId must be digits/);
  await assert.rejects(() => listFolder(ctx, { folderId: "10", depth: 0 }), /depth must be/);
  await assert.rejects(() => listFolder(ctx, { folderId: "10", depth: 9 }), /depth must be/);
  assert.deepEqual(closed, []);
});

test("parseRow reads date, drops the author, keeps the size text", () => {
  assert.deepEqual(parseRow({ id: "1", kind: "file", name: "a.pdf", leaves: ["a.pdf", "Feb 6, 2025 by A Prior Collaborator", "890.9 KB"] }),
    { name: "a.pdf", id: "1", kind: "file", updated: "Feb 6, 2025", size: "890.9 KB" });
  assert.equal(parseRow({ id: "2", kind: "folder", name: "F", leaves: ["F", "Mar 18, 2025 by Han Ngo", "6 Files"] }).size, "6 Files");
  assert.equal(parseRow({ id: "3", kind: "file", name: "n", leaves: ["n"] }).updated, null);
});

test("depth 1 lists one folder, depth 2 nests subfolder items, tab closed", async () => {
  const one = fakeCtx();
  const flat = await listFolder(one.ctx, { folderId: "10" });
  assert.equal(flat.path, "Files / Top");
  assert.equal(flat.items.length, 2);
  assert.equal(flat.items[0].children, undefined);
  assert.deepEqual(one.navigations, []);

  const two = fakeCtx();
  const tree = await listFolder(two.ctx, { folderId: "10", depth: 2 });
  assert.deepEqual(tree.items[0].children.map((c) => c.name), ["b.pdf"]);
  assert.equal(tree.items[1].children, undefined);
  assert.equal(two.navigations.length, 1);
  assert.deepEqual(two.closed, ["T"]);
});

test("closes the tab when a page call fails", async () => {
  const { ctx, closed } = fakeCtx({ failOn: "const want=" });
  await assert.rejects(() => listFolder(ctx, { folderId: "10" }), /boom/);
  assert.deepEqual(closed, ["T"]);
});
