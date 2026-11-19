// learnings/icy-so/tools/swap-test.mjs
// End-to-end swap test of the icy-swap UI (icy.so or a Worker version preview) with the throwaway
// test wallet. One call does the whole run, because a Page is disposed when a tool returns:
// open tab -> inject an EIP-1193/EIP-6963 "Test Wallet" -> fill amount + BTC address -> approve ->
// (optional) swap -> read results -> stop -> close tab.
// Keys never enter the page or the return value: the page queues wallet requests, this tool signs
// them with `cast` (Foundry) using a key read from 1Password per call. Only the ICY token and the
// swapper contract can be called, with value 0, and only IcySwap EIP-712 data can be signed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = "https://mainnet.base.org";
const ICY = "0xf289e3b222dd42b185b7e335fa3c5bd6d132441d";
const SWAPPER = "0xda3e22edf0357c781154d8dedcfc32d7b6b0b12d";
const KEY_REF = "op://Toolkit/icy-swap-test-wallet-base/credential";
const ADDR_REF = "op://Toolkit/icy-swap-test-wallet-base/address";
const BTC_REF = "op://Toolkit/icy-swap-test-wallet-btc/address";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const op = (ref) => execFileSync("op", ["read", ref], { encoding: "utf8" }).trim();
const castSign = (args) => execFileSync("cast", args, { encoding: "utf8", env: { ...process.env, ETH_PRIVATE_KEY: undefined } }).trim();

function injectedSource(addr) {
  return `(() => {
  const ADDR = ${JSON.stringify(addr)};
  let seq = 0; const pending = new Map(); const queue = [];
  const local = { eth_chainId: '0x2105', net_version: '8453', eth_accounts: [ADDR], eth_requestAccounts: [ADDR] };
  const provider = { isTestWallet: true,
    request({ method, params }) {
      if (method in local) return Promise.resolve(local[method]);
      if (method === 'wallet_switchEthereumChain') return (params && params[0] && params[0].chainId === '0x2105') ? Promise.resolve(null) : Promise.reject({ code: 4902, message: 'Base only' });
      if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
      return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); queue.push({ id, method, params }); });
    },
    on() { return provider; }, removeListener() { return provider; } };
  window.__twBridge = { drain() { return queue.splice(0); },
    settle(id, ok, val) { const p = pending.get(id); if (!p) return; pending.delete(id); ok ? p.resolve(val) : p.reject(val); } };
  const info = { uuid: 'b2c1d1a0-0000-4000-8000-1c7a5a9e7e57', name: 'Test Wallet', rdns: 'test.icyswap.wallet',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#e04"/></svg>') };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw { code: j.error.code, message: j.error.message };
  return j.result;
}

function handler(log) {
  return async ({ method, params }) => {
    log.push(method);
    if (method === "eth_sendTransaction") {
      const tx = params[0]; const to = String(tx.to || "").toLowerCase();
      if (![ICY, SWAPPER].includes(to)) throw { code: 4001, message: `blocked: to ${to}` };
      if (tx.value && BigInt(tx.value) !== 0n) throw { code: 4001, message: "blocked: value" };
      const pk = op(KEY_REF);
      const out = castSign(["send", to, tx.data, "--private-key", pk, "--rpc-url", RPC, "--json", "--async"]);
      const hash = out.replace(/"/g, "").trim();
      log.push(`tx ${to === ICY ? "icy" : "swapper"} ${hash}`);
      return hash;
    }
    if (method === "eth_signTypedData_v4") {
      const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
      if (typed.domain?.name !== "IcySwap" || String(typed.domain?.verifyingContract).toLowerCase() !== SWAPPER) throw { code: 4001, message: "blocked: typed data domain" };
      const dir = mkdtempSync(join(tmpdir(), "icy-typed-")); const f = join(dir, "typed.json");
      writeFileSync(f, JSON.stringify(typed));
      return castSign(["wallet", "sign", "--data", "--from-file", f, "--private-key", op(KEY_REF)]);
    }
    if (/^(personal_sign|eth_sign$|eth_signTransaction|wallet_)/.test(method)) throw { code: 4200, message: `unsupported ${method}` };
    return rpc(method, params);
  };
}

// The main action button's label, read in the page (maskSensitive can hide text in snapshots).
async function buttonLabel(page) {
  const r = await page.cdp("Runtime.evaluate", { returnByValue: true, expression:
    `([...document.querySelectorAll('button')].map(b => b.innerText.trim()).find(t => /^(Approve|Swap|Enter|Amount|Insufficient|Not enough|Connect a wallet)/.test(t)) || '')` });
  return r.result?.value || "";
}

// args: url (icy.so or a preview, default https://icy.so/), amount (ICY, default "3"),
//       swap (true = also submit the swap; false = stop after approve), timeoutSec (default 120)
export async function runSwapTest(ctx, args = {}) {
  const url = args.url || "https://icy.so/";
  const origin = new URL(url).origin;
  const amount = String(args.amount || "3");
  const deadline = Date.now() + 1000 * (args.timeoutSec || 120);
  const log = []; const result = { url, amount, steps: {}, log };
  const addr = op(ADDR_REF);
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  let timer = null;
  try {
    const page = await ctx.attachPage(targetId, { allowedOrigins: [origin], allowSensitive: true, maskSensitive: true });
    await page.cdp("Page.enable", {});
    await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: injectedSource(addr) });
    const handle = handler(log); let busy = false;
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const r = await page.cdp("Runtime.evaluate", { expression: 'window.__twBridge ? JSON.stringify(window.__twBridge.drain()) : "[]"', returnByValue: true });
        for (const req of JSON.parse(r.result?.value || "[]")) {
          let ok = true, val;
          try { val = await handle(req); } catch (e) { ok = false; val = { code: e.code ?? -32603, message: String(e.message || e).slice(0, 200) }; log.push(`ERR ${req.method}: ${val.message}`); }
          await page.cdp("Runtime.evaluate", { expression: `window.__twBridge.settle(${req.id}, ${ok}, ${JSON.stringify(val ?? null)})` });
        }
      } catch (e) { log.push(`bridge: ${String(e).slice(0, 120)}`); } finally { busy = false; }
    }, 300);

    await page.goto(url); await wait(6000);
    // wagmi only auto-reconnects on an origin that connected before, so connect explicitly.
    const hasConnectButton = async () => (await page.cdp("Runtime.evaluate", {
      expression: `[...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Connect Wallet')`, returnByValue: true })).result?.value === true;
    if (await hasConnectButton()) {
      await page.getByRole("button", { name: "Connect Wallet" }).click();
      await wait(2000);
      await page.getByRole("button", { name: "Test Wallet", exact: false }).click();
      await wait(3000);
    }
    result.steps.connected = !(await hasConnectButton());
    await page.getByRole("textbox", { name: "ICY amount to swap" }).fill(amount);
    const btc = op(BTC_REF);
    const f = await page.getByRole("textbox", { name: "Destination Bitcoin address" }).fill(btc);
    result.steps.addressFilled = f.status === "executed";
    await wait(2500);
    let label = await buttonLabel(page); result.steps.firstButton = label;
    if (!label) result.steps.buttons = (await page.cdp("Runtime.evaluate", { returnByValue: true,
      expression: `[...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 8)` })).result?.value;

    if (label === "Approve ICY") {
      await page.getByRole("button", { name: "Approve ICY" }).click();
      while (Date.now() < deadline && !log.some((l) => l.startsWith("tx icy") || l.startsWith("ERR"))) await wait(1500);
      const t0 = Date.now();
      while (Date.now() < deadline && !/^Swap /.test(label = await buttonLabel(page))) await wait(2000);
      result.steps.approveTx = (log.find((l) => l.startsWith("tx icy")) || "").split(" ")[2] || null;
      result.steps.buttonAfterApprove = label; result.steps.secondsToSwapButton = Math.round((Date.now() - t0) / 1000);
    }
    if (args.swap && /^Swap /.test(label)) {
      await page.getByRole("button", { name: label }).click();
      while (Date.now() < deadline && !log.some((l) => l.startsWith("tx swapper") || l.startsWith("ERR"))) await wait(1500);
      result.steps.swapTx = (log.find((l) => l.startsWith("tx swapper")) || "").split(" ")[2] || null;
      await wait(8000); await page.goto(url); await wait(6000);
      const s = await page.snapshot();
      result.steps.latestSwap = ((s.tree.split("\n").find((l) => /DisclosureTriangle/.test(l)) || "").match(/"([^"]+)"/) || [])[1] || null;
    }
    result.ok = !log.some((l) => l.startsWith("ERR")) && (!args.swap || !!result.steps.swapTx);
    return result;
  } finally {
    if (timer) clearInterval(timer);
    try { await ctx.session.Target.closeTarget({ targetId }); } catch (e) {}
  }
}
