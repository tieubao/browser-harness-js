// Offline check of exportThread and openDraft against a fake ctx that answers the in-page snippets
// by their text. No browser; the DOM selectors themselves are only proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _timing, exportThread, openDraft } from "./mail-google-com.mjs";

_timing.scale = 0.001;

function fakeCtx(answer) {
  const log = [];
  const target = (name) => async (params) => { log.push([`Target.${name}`, params]); return { targetId: "T1" }; };
  return {
    log,
    session: { Target: { createTarget: target("createTarget"), closeTarget: target("closeTarget"), activateTarget: target("activateTarget") } },
    attachPage: async () => ({
      cdp: async (method, params) => {
        log.push([method, params]);
        if (method === "Runtime.evaluate") return { result: { value: answer(params.expression) } };
        if (method === "Page.printToPDF") return { data: Buffer.from("%PDF-fake").toString("base64") };
        return {};
      },
    }),
  };
}

const methods = (ctx) => ctx.log.map(([m]) => m);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mail-export-"));
const TEXT = "line one\n".repeat(500);

const printAnswers = ({ row = "abc123", ik = "k1" } = {}) => (expr) => {
  if (expr.includes("data-legacy-thread-id")) return row;
  if (expr.includes("GM_ID_KEY")) return expr.startsWith("!!") ? Boolean(ik) : ik;
  if (expr.includes("document.title")) return JSON.stringify({ title: "Gmail - Bản tin Đà Nẵng #4", text: TEXT, messages: 2 });
  return true;
};

test("exportThread stubs print before navigating, writes full text and PDF, closes its tab", async () => {
  const ctx = fakeCtx(printAnswers());
  const outDir = tmp();
  const out = await exportThread(ctx, { query: "subject:news", outDir });
  assert.deepEqual(out, {
    threadId: "abc123",
    title: "Bản tin Đà Nẵng #4",
    textPath: path.join(outDir, "ban-tin-da-nang-4.txt"),
    pdfPath: path.join(outDir, "ban-tin-da-nang-4.pdf"),
    messages: 2,
    chars: TEXT.length,
  });
  assert.equal(fs.readFileSync(out.textPath, "utf8"), TEXT);
  assert.equal(fs.readFileSync(out.pdfPath, "utf8"), "%PDF-fake");
  const m = methods(ctx);
  assert.ok(m.indexOf("Page.addScriptToEvaluateOnNewDocument") < m.indexOf("Page.navigate"));
  const urls = ctx.log.filter(([x]) => x === "Page.navigate").map(([, p]) => p.url);
  assert.equal(urls.at(-1), "https://mail.google.com/mail/u/0/?ik=k1&view=pt&search=all&th=abc123");
  assert.equal(m.at(-1), "Target.closeTarget");
  assert.ok(!m.includes("Target.activateTarget"));
});

test("exportThread: pdf:false, ui=2 without ik, and a taken name gets the thread id", async () => {
  const outDir = tmp();
  fs.writeFileSync(path.join(outDir, "ban-tin-da-nang-4.txt"), "older export");
  const ctx = fakeCtx(printAnswers({ ik: "" }));
  const out = await exportThread(ctx, { authuser: 1, threadId: "ff00", outDir, pdf: false });
  assert.equal(out.textPath, path.join(outDir, "ban-tin-da-nang-4-ff00.txt"));
  assert.equal(out.pdfPath, null);
  assert.ok(!methods(ctx).includes("Page.printToPDF"));
  assert.equal(ctx.log.filter(([x]) => x === "Page.navigate").at(-1)[1].url, "https://mail.google.com/mail/u/1/?ui=2&view=pt&search=all&th=ff00");
  assert.equal(fs.readFileSync(path.join(outDir, "ban-tin-da-nang-4.txt"), "utf8"), "older export");
});

test("exportThread stops on an empty search and rejects bad arguments", async () => {
  const ctx = fakeCtx(printAnswers({ row: null }));
  assert.equal((await exportThread(ctx, { query: "nothing", outDir: tmp() })).stop, "no-results");
  assert.equal(methods(ctx).at(-1), "Target.closeTarget");
  await assert.rejects(exportThread(ctx, { outDir: "/abs" }), /threadId or query/);
  await assert.rejects(exportThread(ctx, { query: "q", outDir: "rel" }), /absolute/);
  await assert.rejects(exportThread(ctx, { threadId: "x&y", outDir: "/abs" }), /hex/);
});

const RECT = { x: 10, y: 20, width: 100, height: 10, matches: 1 };
const draftAnswers = ({ row = RECT, opens = true } = {}) => (expr) => {
  if (expr.startsWith("JSON.stringify")) return JSON.stringify({ from: "", recipients: ["a@example.com"], subject: "Plan", attachments: ["x.pdf"] });
  if (expr.includes("tr.zA")) return expr.startsWith("!!") ? Boolean(row) : row;
  return opens;
};

test("openDraft activates the tab, real-clicks the row and leaves the draft open", async () => {
  const ctx = fakeCtx(draftAnswers());
  const out = await openDraft(ctx, { subject: "Plan" });
  assert.deepEqual(out, { targetId: "T1", subject: "Plan", recipients: ["a@example.com"], attachments: ["x.pdf"], from: "" });
  const m = methods(ctx);
  assert.ok(m.indexOf("Target.activateTarget") < m.indexOf("Input.dispatchMouseEvent"));
  const press = ctx.log.find(([x, p]) => x === "Input.dispatchMouseEvent" && p.type === "mousePressed")[1];
  assert.deepEqual([press.x, press.y], [60, 25]);
  assert.ok(!m.includes("Target.closeTarget"));
  assert.ok(!m.includes("Input.insertText") && !m.includes("Input.dispatchKeyEvent"));
});

test("openDraft stops on a missing row or a compose that never appears, closing only its own tab", async () => {
  const none = fakeCtx(draftAnswers({ row: null }));
  assert.deepEqual(await openDraft(none, { subject: "Plan" }), { stop: "no-draft-row" });
  assert.ok(methods(none).includes("Target.closeTarget"));
  assert.ok(!methods(none).includes("Input.dispatchMouseEvent"));
  assert.ok(!methods(none).includes("Target.activateTarget"), "a miss must not take the foreground");
  const rowExpr = none.log.find(([x, p]) => x === "Runtime.evaluate" && p.expression.includes("tr.zA"))[1].expression;
  assert.ok(rowExpr.includes("[data-standalone-draft-id],[data-legacy-standalone-draft-id]"), "rows are matched by draft id attribute");
  assert.ok(!rowExpr.includes("Draft("), "not by the visible Draft word");

  const stuck = fakeCtx(draftAnswers({ opens: false }));
  assert.deepEqual(await openDraft(stuck, { subject: "Plan", targetId: "CALLER" }), { stop: "not-opened" });
  assert.ok(!methods(stuck).includes("Target.closeTarget"));
  assert.ok(!methods(stuck).includes("Target.createTarget"));
  await assert.rejects(openDraft(stuck, {}), /subject is required/);
});
