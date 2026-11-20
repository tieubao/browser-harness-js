// Offline check with a fake page: event order for hoverClick, expression shape for clickByText,
// and that shot clears the metrics override even when capture throws. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rect, hoverClick, clickByText, shot, chunkId, linkFor, pickMatches, collectJs } from "./claude-ai.mjs";

function fakeCtx({ rectValue = { x: 10, y: 20, width: 100, height: 40, cx: 60, cy: 40 }, failCapture = false } = {}) {
  const calls = [];
  const page = {
    async cdp(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: rectValue } };
      if (method === "Page.captureScreenshot") {
        if (failCapture) throw new Error("capture failed");
        return { data: Buffer.from("png-bytes").toString("base64") };
      }
      return {};
    },
  };
  return { calls, ctx: { requirePage: () => page } };
}

test("rect returns the evaluated rect", async () => {
  const { ctx } = fakeCtx();
  assert.equal((await rect(ctx, "document.body")).cx, 60);
});

test("hoverClick sends move, then press, then release at the centre", async () => {
  const { ctx, calls } = fakeCtx();
  const r = await hoverClick(ctx, "document.body");
  const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
  assert.deepEqual(mouse.map((m) => m.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(mouse.every((m) => m.x === 60 && m.y === 40));
  assert.deepEqual(r, { clicked: true, x: 60, y: 40 });
});

test("hoverClick throws and sends no mouse event when the element is absent", async () => {
  const { ctx, calls } = fakeCtx({ rectValue: null });
  await assert.rejects(() => hoverClick(ctx, "null"), /no element/);
  assert.equal(calls.some((c) => c.method === "Input.dispatchMouseEvent"), false);
});

test("clickByText embeds scope and text as JSON strings", async () => {
  const { ctx, calls } = fakeCtx();
  await clickByText(ctx, '[role=menu]', 'Sett"ings');
  const expr = calls[0].params.expression;
  assert.ok(expr.includes('"[role=menu]"'));
  assert.ok(expr.includes('"Sett\\"ings"'));
  assert.ok(expr.includes("innerText.trim()"));
  assert.ok(expr.includes("innerText.includes"));
});

test("shot writes the PNG, uses the 1280x820@2x override and clears it", async () => {
  const { ctx, calls } = fakeCtx();
  const out = join(await mkdtemp(join(tmpdir(), "claude-ai-shot-")), "a.png");
  await shot(ctx, out, { x: 232, y: 0, width: 500, height: 300 });
  assert.equal((await readFile(out)).toString(), "png-bytes");
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ["Emulation.setDeviceMetricsOverride", "Page.captureScreenshot", "Emulation.clearDeviceMetricsOverride"]);
  assert.deepEqual(calls[0].params, { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  assert.equal(calls[1].params.clip.scale, 1);
});

test("shot clears the override when capture fails", async () => {
  const { ctx, calls } = fakeCtx({ failCapture: true });
  await assert.rejects(() => shot(ctx, "/nonexistent/x.png"), /capture failed/);
  assert.equal(calls.at(-1).method, "Emulation.clearDeviceMetricsOverride");
});

test("chunkId splits into 4-char groups and keeps a short tail", () => {
  assert.equal(chunkId("abcdefghij"), "abcd efgh ij");
  assert.equal(chunkId("abcdefgh"), "abcd efgh");
});

test("linkFor builds the /artifact/ url and chunks", () => {
  assert.deepEqual(linkFor("abcdefghij"), { id: "abcdefghij", url: "https://claude.ai/artifact/abcdefghij", idChunks: "abcd efgh ij" });
});

test("pickMatches takes the smallest ancestor depth, not the widest", () => {
  const anchors = [
    { id: "A", depths: [false, false, true, true] },
    { id: "B", depths: [false, true, true, true] },
    { id: "C", depths: [false, false, false, true] },
  ];
  assert.deepEqual(pickMatches(anchors), ["B"]);
});

test("pickMatches keeps every match at that depth, deduped, in DOM order", () => {
  const anchors = [
    { id: "A", depths: [true] },
    { id: "A", depths: [true] },
    { id: "B", depths: [true] },
    { id: "C", depths: [false, true] },
  ];
  assert.deepEqual(pickMatches(anchors), ["A", "B"]);
});

test("pickMatches returns nothing when no ancestor holds the title", () => {
  assert.deepEqual(pickMatches([{ id: "A", depths: [false, false] }]), []);
  assert.deepEqual(pickMatches([]), []);
});

test("collectJs parses the id from href and tests the title per ancestor depth", () => {
  const card = { innerText: "Other\nChina trip from the reel\n2d ago", parentElement: null };
  const a = { innerText: "", parentElement: card, getAttribute: () => "/artifact/AbCd_EfGh-IjKlMnOpQr" };
  const nolink = { innerText: "x", parentElement: null, getAttribute: () => "/artifact/" };
  const document = { querySelectorAll: () => [a, nolink] };
  const out = new Function("document", "return " + collectJs("China trip from the reel"))(document);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "AbCd_EfGh-IjKlMnOpQr");
  assert.deepEqual(out[0].depths.slice(0, 3), [false, true, false]);
  assert.equal(out[0].first, "Other");
});
