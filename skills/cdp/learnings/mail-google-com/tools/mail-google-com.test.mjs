// Offline check of exportThread and openDraft against a fake ctx that answers the in-page snippets
// by their text. No browser; the DOM selectors themselves are only proven live.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { _testPageJs, _timing, accountEmail, exportThread, listInbox, openDraft } from "./mail-google-com.mjs";

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


function matchesSimple(el, selector) {
  if (!el || !selector) return false;
  if (selector.startsWith("[") && selector.endsWith("]")) {
    const name = selector.slice(1, -1).split("=")[0].replace(/['"]/g, "");
    return el.getAttribute(name) !== null && el.getAttribute(name) !== undefined;
  }
  const m = selector.match(/^([a-zA-Z][a-zA-Z0-9]*)?(?:\.([a-zA-Z0-9_-]+))?(?:\[([a-zA-Z0-9_-]+)\])?$/);
  if (!m) return false;
  const [, tag, cls, attr] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (cls && !el.classList.contains(cls)) return false;
  if (attr && (el.getAttribute(attr) === null || el.getAttribute(attr) === undefined)) return false;
  return Boolean(tag || cls || attr);
}

function matchesSelector(el, selector) {
  return selector.split(",").some((group) => {
    const parts = group.trim().split(/\s+/).filter(Boolean);
    if (!matchesSimple(el, parts.at(-1))) return false;
    let anc = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (anc && !matchesSimple(anc, parts[i])) anc = anc.parentElement;
      if (!anc) return false;
      anc = anc.parentElement;
    }
    return true;
  });
}

function domEl({ tag = "div", text = "", attrs = {}, classes = [], children = [], style = {}, hidden = false, id = "" } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    textContent: text,
    style,
    hidden,
    id,
    className: classes.join(" "),
    parentElement: null,
    children: [],
    classList: { contains: (name) => classes.includes(name) },
    getAttribute(name) {
      if (name === "id") return id || null;
      if (name === "class") return classes.join(" ");
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
  };
  el.children = children.map((child) => { child.parentElement = el; return child; });
  const descendants = (root) => root.children.flatMap((child) => [child, ...descendants(child)]);
  el.querySelectorAll = (selector) => descendants(el).filter((node) => matchesSelector(node, selector));
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  el.matches = (selector) => matchesSelector(el, selector);
  return el;
}

function inboxFixture() {
  const sender = (email, name) => domEl({ tag: "span", text: name, attrs: { email, name } });
  const subject = (value) => domEl({ tag: "span", text: value, classes: ["bog"] });
  const snippet = (value) => domEl({ tag: "span", text: value, classes: ["y2"] });
  const date = (title, text) => domEl({ tag: "td", classes: ["xW"], children: [domEl({ tag: "span", text, attrs: { title } })] });
  const first = domEl({
    tag: "tr",
    classes: ["zA"],
    attrs: { "data-legacy-thread-id": "legacy123", "data-labels": "Accounting,Hiring" },
    children: [sender("alice@example.com", "Alice Example"), subject("Quarterly invoice"), snippet(" - invoice attached"), date("2026-11-20T10:00:00Z", "Nov 20")],
  });
  const second = domEl({
    tag: "tr",
    classes: ["zA", "zE"],
    children: [
      domEl({ tag: "span", id: "thread-f:def456" }),
      sender("bob@example.com", "Bob Example"),
      subject("Please review"),
      snippet(" - when you have a moment"),
      date("2026-11-21T11:00:00Z", "Nov 21"),
    ],
  });
  const hiddenRow = domEl({
    tag: "tr",
    classes: ["zA"],
    attrs: { "data-legacy-thread-id": "hidden999" },
    children: [subject("hidden")],
  });
  const hiddenWrap = domEl({ style: { display: "none" }, children: [hiddenRow] });
  return domEl({ tag: "body", children: [first, second, hiddenWrap] });
}

test("listInbox row extraction uses a synthetic DOM, skips hidden rows and parses fields", () => {
  const document = inboxFixture();
  const rows = JSON.parse(JSON.stringify(vm.runInNewContext(_testPageJs.LIST_ROWS_JS, { document })));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.id), ["legacy123", "def456"]);
  assert.equal(rows[0].from, "alice@example.com");
  assert.equal(rows[0].fromName, "Alice Example");
  assert.equal(rows[0].subject, "Quarterly invoice");
  assert.equal(rows[0].snippet, "invoice attached");
  assert.deepEqual(rows[0].labels, ["Accounting", "Hiring"]);
  assert.equal(rows[0].date, "2026-11-20T10:00:00Z");
  assert.equal(rows[0].unread, false);
  assert.equal(rows[1].unread, true);
  assert.deepEqual(rows[1].labels, ["UNREAD"]);
});

test("accountEmail extraction reads the account aria-label, with GLOBALS as fallback", () => {
  const byLabel = domEl({ children: [domEl({ tag: "a", attrs: { "aria-label": "Google Account: Han Example han@example.com" } })] });
  assert.equal(vm.runInNewContext(_testPageJs.ACCOUNT_EMAIL_JS, { document: byLabel, window: {} }), "han@example.com");
  const bare = domEl({ children: [] });
  assert.equal(vm.runInNewContext(_testPageJs.ACCOUNT_EMAIL_JS, { document: bare, window: { GLOBALS: ["x", "backup@example.com"] } }), "backup@example.com");
});

const listAnswers = (expr) => {
  if (expr.startsWith("JSON.stringify")) return JSON.stringify([{ id: "t1", from: "a@example.com", fromName: "A", subject: "s", snippet: "n", labels: [], date: "2026-11-20T10:00:00Z", unread: false }]);
  if (expr.includes("GLOBAL") || expr.includes("aria-label")) return "han@example.com";
  if (expr.includes("older")) return false;
  return undefined;
};

test("listInbox returns account and rows from one background tab and closes it without reload", async () => {
  const ctx = fakeCtx(listAnswers);
  const out = await listInbox(ctx, { authuser: 2, query: "in:inbox", limit: 10 });
  assert.equal(out.account, "han@example.com");
  assert.equal(out.threads.length, 1);
  assert.equal(out.threads[0].id, "t1");
  const created = ctx.log.find(([m]) => m === "Target.createTarget")[1];
  assert.equal(created.background, true);
  assert.match(created.url, /mail\/u\/2\/#search/);
  assert.equal(methods(ctx).at(-1), "Target.closeTarget");
  assert.ok(!methods(ctx).includes("Page.reload"));
});

test("accountEmail runs in a background tab and closes it", async () => {
  const ctx = fakeCtx(listAnswers);
  assert.deepEqual(await accountEmail(ctx, { authuser: 1 }), { email: "han@example.com" });
  assert.equal(ctx.log.find(([m]) => m === "Target.createTarget")[1].background, true);
  assert.equal(methods(ctx).at(-1), "Target.closeTarget");
});
