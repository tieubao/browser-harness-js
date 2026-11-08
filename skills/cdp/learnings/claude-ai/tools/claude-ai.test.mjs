// Offline check with a fake page: event order for hoverClick, expression shape for clickByText,
// and that shot clears the metrics override even when capture throws. No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rect, hoverClick, clickByText, shot } from "./claude-ai.mjs";

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
