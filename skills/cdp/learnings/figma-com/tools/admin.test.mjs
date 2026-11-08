// Offline check of teamTree with a fake ctx: input validation, tree shape, trashed rows skipped,
// subfolder ids read from resource timings, and the tab closed even on failure. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamTree } from "./admin.mjs";

function fakeCtx({ failOn = null } = {}) {
  const closed = [];
  const navigations = [];
  let current = "";
  const meta = {
    "/api/teams/42/folders": { folder_rows: [
      { id: 1, name: "Live", team_access: "edit", is_invite_only: false },
      { id: 2, name: "Gone", trashed_at: "2026-01-01" },
    ] },
    "/api/folders/9": { path: "Live / Sub", team_access: "view", is_invite_only: true },
  };
  const contents = {
    1: { files: [{ name: "A", touched_at: "t", link_access: "view", has_file_link_password: false }, { name: "Dead", trashed_at: "x" }],
         roles: [{ user: { handle: "h1" }, level: 999 }, { pending_email: "p@x.test", level: 100 }] },
    9: { files: [], roles: [] },
  };
  const page = {
    async cdp(method, params) {
      if (method !== "Runtime.evaluate") return {};
      const e = params.expression;
      if (failOn && e.includes(failOn)) return { exceptionDetails: { text: "boom" } };
      if (e.startsWith("location.href=")) { navigations.push(e); current = e; return { result: {} }; }
      if (e.includes("getEntriesByType")) return { result: { value: ["https://www.figma.com/api/folders/1/paginated_files?x=1", "https://www.figma.com/api/folders/9/paginated_files?x=1"] } };
      const m = e.match(/fetch\("([^"]+)"/);
      if (m) {
        const path = m[1];
        const pf = path.match(/^\/api\/folders\/(\d+)\/paginated_files/);
        return { result: { value: pf ? contents[pf[1]] : meta[path] || null } };
      }
      return { result: {} };
    },
  };
  const ctx = {
    session: { Target: { async createTarget() { return { targetId: "T" }; }, async closeTarget({ targetId }) { closed.push(targetId); } } },
    async attachPage() { return page; },
  };
  return { ctx, closed, navigations };
}

test("rejects a non-digit teamId or fuid before opening a tab", async () => {
  const { ctx, closed } = fakeCtx();
  await assert.rejects(() => teamTree(ctx, { teamId: "4;2" }), /teamId must be digits/);
  await assert.rejects(() => teamTree(ctx, { teamId: "42", fuid: "x'y" }), /fuid must be digits/);
  assert.deepEqual(closed, []);
});

test("builds the tree, skips trashed rows and files, reads subfolders from timings", async () => {
  const { ctx, closed, navigations } = fakeCtx();
  const tree = await teamTree(ctx, { teamId: "42", fuid: "7" });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "Live");
  assert.deepEqual(tree[0].roles, ["h1:999", "p@x.test:100"]);
  assert.deepEqual(tree[0].files, [{ name: "A", touched: "t", link: "view", pw: false }]);
  assert.equal(tree[0].subs.length, 1);
  assert.equal(tree[0].subs[0].id, "9");
  assert.equal(tree[0].subs[0].invite_only, true);
  assert.ok(navigations[0].includes("/files/team/42/folder/1?fuid=7"));
  assert.deepEqual(closed, ["T"]);
});

test("closes the tab when a page call fails", async () => {
  const { ctx, closed } = fakeCtx({ failOn: "/api/teams/42/folders" });
  await assert.rejects(() => teamTree(ctx, { teamId: "42" }), /boom/);
  assert.deepEqual(closed, ["T"]);
});
