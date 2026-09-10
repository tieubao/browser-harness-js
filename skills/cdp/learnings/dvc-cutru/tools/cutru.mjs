// learnings/dvc-cutru/tools/cutru.mjs
// Residence filings (đăng ký / gia hạn tạm trú, Bộ Công an portal) driven on the signed-in
// tab. Distilled 2026-09-10 from a gia hạn tạm trú filing. The portal is a jQuery +
// bootstrap-table form behind a VNeID login that stays with the human; every tool here
// returns {stop:"login-needed"} instead of touching the SSO page.
//
// Gotchas this module encodes:
//  - A click issued from Runtime.evaluate carries no user activation, so "Nộp hồ sơ" (which
//    opens the payment gateway in a new window) fails as a popup and the portal reports it as
//    "không kết nối được đến trang thanh toán". submit() clicks by coordinate with
//    Input.dispatchMouseEvent, which grants the activation.
//  - The edit view (dang-ky-tam-tru.html?id=<n>) appends one blank member row on load;
//    draft() and submit() drop blank rows first or an empty person goes out.
//  - File inputs upload on change via AJAX, so after DOM.setFileInputFiles the input reads
//    back 0 files while the row text shows the uploaded names; attach() verifies by row text.
//  - select2-backed <select>s need jQuery(el).trigger("change"); a DOM event leaves the widget stale.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTAL = /dancuquocgia\.gov\.vn|bocongan\.gov\.vn|pay\.vietcombank\.com\.vn/;
const FORM = /dang-ky-tam-tru\.html/;
const ENTRY = {
  TAMTRU_01: "https://dichvucong.bocongan.gov.vn/bo-cong-an/tiep-nhan-online/chon-truong-hop-ho-so?ma-thu-tuc-public=26344",
  TAMTRU_02: "https://dichvucong.bocongan.gov.vn/bo-cong-an/tiep-nhan-online/chon-truong-hop-ho-so?ma-thu-tuc-public=26345",
};

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function pickTab(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => FORM.test(t.url)) || tabs.find((t) => PORTAL.test(t.url));
  if (!tab) return null;
  await ctx.session.use(tab.targetId);
  return tab;
}

async function realClick(ctx, selectorExpr) {
  const pos = await evaluate(ctx, `(()=>{const b=${selectorExpr}; if(!b) return null; b.scrollIntoView({block:"center"}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (!pos) throw new Error("realClick: element not found");
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseMoved", x: pos.x, y: pos.y });
  await ctx.session.Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
}

const HELPERS = `
  const $ = window.jQuery;
  const setT = (id, v) => { const e = document.getElementById(id); if (!e) throw new Error("missing #" + id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
  const setS = (id, v) => { const e = document.getElementById(id); if (!e) throw new Error("missing #" + id); e.value = v; if ($) $(e).trigger("change"); else e.dispatchEvent(new Event("change", { bubbles: true })); };
  const tick = (id, on) => { const c = document.getElementById(id); if (!c) throw new Error("missing #" + id); if (c.checked !== on) c.click(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = (re) => [...document.querySelectorAll("button, a")].find((x) => re.test(x.innerText) && x.offsetParent !== null);
  const dropBlankMembers = async () => { for (const r of [...document.querySelectorAll("#divListNormal tbody tr")]) { const n = r.querySelector("input[type=text]"); if (n && !n.value.trim()) { const d = r.querySelector("a.del_CUNGTD"); if (d) { d.click(); await sleep(500); } } } };
  window.confirm = () => true;
`;

async function requireForm(ctx) {
  const s = await status(ctx);
  if (s.state !== "form-open") throw new Error(`form not open (${s.state}); open + log in first`);
  return s;
}

export async function status(ctx) {
  const tab = await pickTab(ctx);
  if (!tab) return { state: "no-portal-tab", hint: 'learnings("dvc-cutru","open",{procedure:"TAMTRU_02"}), then the human logs in with VNeID' };
  if (/sso\.dancuquocgia/.test(tab.url)) return { stop: "login-needed", state: "login-needed", url: tab.url };
  if (FORM.test(tab.url)) {
    const s = await evaluate(ctx, `(()=>({ dossier: (document.body.innerText.match(/G01\\.[0-9.]+-[0-9]+-[0-9]+/) || [null])[0], fee: (document.getElementById("txtTONGPHI")||{}).value, reporter: (document.getElementById("txtFULLNAME")||{}).value, members: [...document.querySelectorAll("#divListNormal tbody tr")].map(r=>[...r.querySelectorAll("input[type=text]")].map(e=>e.value).join(" | ")), files: [...document.querySelectorAll("#dossier tbody tr")].map(r=>r.innerText.trim().replace(/\\s+/g," ").replace(/Bản gốc Bản sao Bản chứng thực Giấy tờ điện tử /,"").slice(0,100)) }))()`);
    return { state: "form-open", url: tab.url, ...s };
  }
  if (/pay\.vietcombank/.test(tab.url)) return { state: "payment", url: tab.url };
  if (/ho-so\.html/.test(tab.url)) {
    const rows = await evaluate(ctx, `(()=>{const t=document.body.innerText.replace(/[ \\t]+/g," "); return [...t.matchAll(/(G01\\.[0-9.]+-[0-9]+-[0-9]+)\\s*\\n?Thủ tục hành chính:\\s*\\n?([^\\n]+)[\\s\\S]*?Trạng thái:\\s*\\n?([^\\n]+)/g)].map(m=>({dossier:m[1], procedure:m[2].trim(), status:m[3].trim()}))})()`);
    return { state: "dossier-list", url: tab.url, dossiers: rows };
  }
  return { state: "portal", url: tab.url };
}

export async function open(ctx, args = {}) {
  const url = ENTRY[args.procedure || "TAMTRU_02"];
  if (!url) throw new Error(`unknown procedure ${args.procedure}; known: ${Object.keys(ENTRY).join(", ")}`);
  const tab = await pickTab(ctx);
  if (tab) await ctx.session.Page.navigate({ url });
  else { const { targetId } = await ctx.session.Target.createTarget({ url }); await ctx.session.use(targetId); }
  await wait(6000);
  return status(ctx);
}

export async function edit(ctx, args) {
  if (!args || !args.id) throw new Error("edit needs {id}: the numeric dossier id from the list page");
  const tab = await pickTab(ctx);
  if (!tab) throw new Error("no portal tab; open + log in first");
  await ctx.session.Page.navigate({ url: "https://dichvucong.dancuquocgia.gov.vn/portal/p/home/dang-ky-tam-tru.html?id=" + args.id });
  await wait(9000);
  return status(ctx);
}

export async function fill(ctx, d) {
  await requireForm(ctx);
  const roles = { CHUHO: "chkCHUHO_FILER", CHUSOHUU: "chkCHUSOHUU_FILER", NGUOIGIAMHO: "chkNGUOIGIAMHO_FILER" };
  return evaluate(ctx, `(async () => { ${HELPERS}
    if (${JSON.stringify(!!d.province)}) { setS("cboRECEIVE_ADDR_CITY_CODE", ${JSON.stringify(d.province || "")}); await sleep(1500); setS("cboRECEIVE_ADDR_VILLAGE_CODE", ${JSON.stringify(d.ward || "")}); await sleep(1000); }
    const rep = document.getElementById("chkIS_REPORTER"); if (rep && !rep.checked) { rep.click(); await sleep(2500); }
    setS("cboBPROC_CASE_CODE", ${JSON.stringify(d.case)}); await sleep(1500);
    setT("txtSUGGEST_ADDRESS", ${JSON.stringify(d.address)});
    if (${JSON.stringify(!!d.from)}) setT("txtTEMP_RESIDENT_FROM", ${JSON.stringify(d.from || "")});
    setT("txtTEMP_RESIDENT_TO", ${JSON.stringify(d.to)});
    for (const id of ["txtPHONE_NUMBER", "txtNOTIFICATION_PHONE"]) setT(id, ${JSON.stringify(d.phone)});
    for (const id of ["txtEMAIL", "txtNOTIFICATION_EMAIL"]) setT(id, ${JSON.stringify(d.email)});
    setS("cboRECEIVER_TYPE", "5");
    if (${JSON.stringify(!!d.note)}) setT("txtCHANGED_NOTE", ${JSON.stringify(d.note || "")});
    await dropBlankMembers();
    const members = ${JSON.stringify(d.members || [])};
    for (let i = 0; i < members.length; i++) {
      if (!document.getElementById("txtFULLNAME_CUNGTD" + i)) { document.querySelector("#divListNormal a.add_CUNGTD").click(); await sleep(1000); }
      const m = members[i];
      setT("txtFULLNAME_CUNGTD" + i, m.name); setT("txtDOB_CUNGTD" + i, m.dob); setS("cboGENDER_CUNGTD" + i, m.sex);
      setT("txtIDENTIFIER_NOCARD_NUMBER_CUNGTD" + i, m.id); setS("cboRELATIONSHIP_CHUHO_CUNGTD" + i, m.rel);
    }
    const roles = ${JSON.stringify(roles)};
    for (const [k, id] of Object.entries(roles)) tick(id, (${JSON.stringify(d.filer_roles || [])}).includes(k));
    tick("chkCHECK_LIABILITY", true);
    const fee = btn(/Kiểm tra thông tin lệ phí/); if (fee) { fee.click(); await sleep(3000); }
    return { reporter: document.getElementById("txtFULLNAME").value, members: [...document.querySelectorAll("#divListNormal tbody tr")].map(r=>[...r.querySelectorAll("input[type=text]")].map(e=>e.value).join(" | ")), fee: document.getElementById("txtTONGPHI").value };
  })()`);
}

export async function attach(ctx, d) {
  await requireForm(ctx);
  const plan = await evaluate(ctx, `(async () => { ${HELPERS}
    const box = document.getElementById("dossier"); const out = [];
    for (const a of ${JSON.stringify(d.attachments || [])}) {
      let i = a.row;
      if (i == null) { document.getElementById("btnDocument").click(); await sleep(900); i = box.querySelectorAll("tbody tr").length - 1; setT("lblFILE_TYPE_NAME" + i, a.name); }
      setS("cboFILE_TYPE" + i, a.type || "2"); setT("txtNUM_OF_PAPER" + i, String(a.files.length));
      out.push({ input: "fileUpload" + i, files: a.files });
    }
    return out;
  })()`);
  const result = [];
  for (const p of plan) {
    const { root } = await ctx.session.DOM.getDocument({ depth: 1 });
    const { nodeId } = await ctx.session.DOM.querySelector({ nodeId: root.nodeId, selector: "#" + p.input });
    if (!nodeId) throw new Error("no " + p.input);
    await ctx.session.DOM.setFileInputFiles({ nodeId, files: p.files });
    await wait(1500);
    const row = await evaluate(ctx, `(()=>{const f=document.getElementById(${JSON.stringify(p.input)}); return f.closest("tr").innerText.replace(/\\s+/g," ").slice(0,160)})()`);
    result.push({ input: p.input, row });
  }
  return result;
}

export async function draft(ctx) {
  await requireForm(ctx);
  await evaluate(ctx, `(async () => { ${HELPERS} await dropBlankMembers(); btn(/^\\s*Lưu nháp\\s*$/).click(); return 1; })()`).catch(() => {});
  await wait(5000);
  const tab = await pickTab(ctx);
  const list = await evaluate(ctx, `(()=>(document.body.innerText.match(/G01\\.[0-9.]+-[0-9]+-[0-9]+/g)||[]))()`);
  return { url: tab && tab.url, dossiers: [...new Set(list || [])] };
}

export async function printCt01(ctx, args = {}) {
  await requireForm(ctx);
  const dir = args.dir;
  if (!dir) throw new Error("printCt01 needs {dir}: an absolute download directory");
  await ctx.session.Browser.setDownloadBehavior({ behavior: "allow", downloadPath: dir, eventsEnabled: true });
  await evaluate(ctx, `(()=>{const b=[...document.querySelectorAll("button, a")].find(x=>/^\\s*In CT01\\s*$/.test(x.innerText)); if(!b) throw new Error("no In CT01"); b.click(); return 1})()`);
  await wait(6000);
  return { saved_under: dir, file: "CT01.pdf", note: "the portal always names it CT01.pdf; rename before the next print or it overwrites" };
}

export async function submit(ctx) {
  await requireForm(ctx);
  await evaluate(ctx, `(async () => { ${HELPERS} await dropBlankMembers(); return 1; })()`);
  await realClick(ctx, `[...document.querySelectorAll("button, a")].find(x=>/^\\s*Nộp hồ sơ\\s*$/.test(x.innerText) && x.offsetParent!==null)`);
  for (let i = 0; i < 12; i++) {
    await wait(2500);
    const tab = await pickTab(ctx);
    if (tab && /pay\.vietcombank/.test(tab.url)) return { state: "payment", url: tab.url, next: "the human pays in the browser; then status()" };
    const msg = await evaluate(ctx, `[...document.querySelectorAll(".modal, .toast")].filter(m=>getComputedStyle(m).display!=="none" && m.offsetParent!==null).map(m=>m.innerText.trim().replace(/\\s+/g," ").slice(0,200)).join(" ## ")`).catch(() => "");
    if (/thất bại|lỗi/i.test(msg)) return { state: "failed", message: msg };
  }
  return { state: "unknown", hint: "no payment redirect within 30s; check the tab" };
}
