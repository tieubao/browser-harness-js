// learnings/corp-delaware-gov/tools/tax.mjs
// Delaware Division of Corporations franchise / LLC tax lookup (ASP.NET WebForms). The page
// states that automated tools are prohibited and gates the lookup behind a CAPTCHA, so the
// CAPTCHA is ALWAYS read by a human: prepare() only exports the image, submit() only types
// what the human gives it. Nothing here solves, OCRs, or bypasses the CAPTCHA.
//
// Gotchas this module encodes:
//  - Control ids are the long ASP.NET form (ctl00_ContentPlaceHolder1_*).
//  - The CAPTCHA <img> is same origin (CaptchaHandler.ashx?type=image&key=...), so a canvas
//    toDataURL export works. The key is per page load: export the image from the SAME load the
//    human reads, and never reload between prepare() and submit().
//  - Clicking Continue is a full postback. A wrong CAPTCHA returns the login page with a new
//    image, so submit() sets a window marker before the click; a vanished marker means the page
//    reloaded, and a reload that is still logintax.aspx means the CAPTCHA was rejected.
//  - Credits print in parentheses, "($300.00)", and parse as negative numbers.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = /icis\.corp\.delaware\.gov/;
const LOGIN = /logintax\.aspx/i;
const ENTRY = "https://icis.corp.delaware.gov/ecorp/logintax.aspx?FilingType=FranchiseTax";
const ID = {
  fileNo: "ctl00_ContentPlaceHolder1_txtPrimaryFileNo",
  captcha: "ctl00_ContentPlaceHolder1_ecorpCaptcha1_txtCaptcha",
  submit: "ctl00_ContentPlaceHolder1_btnContinue",
};

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

// "$1,234.50" -> 1234.5, "($300.00)" -> -300
function money(token) {
  const neg = /^\(.*\)$/.test(token) || /-/.test(token);
  const n = Number(token.replace(/[^0-9.]/g, ""));
  return neg ? -n : n;
}

const MONEY = /\(?-?\$[\d,]+(?:\.\d+)?\)?/g;

// Pure so it is testable without a browser. text is document.body.innerText of the page that
// follows Continue; url (optional) lets a login page that comes back read as a rejected CAPTCHA.
export function parseTaxPage(text, url) {
  const body = String(text || "");
  const rows = [];
  let total = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const yearM = /^(\d{4})\b/.exec(line);
    if (yearM) {
      const m = line.match(MONEY) || [];
      if (m.length !== 5) continue;
      const [tax, penalty, interest, credit, due] = m.map(money);
      rows.push({ year: Number(yearM[1]), tax, penalty, interest, credit, due });
      continue;
    }
    const totalM = /^Total\b/i.exec(line);
    if (totalM) {
      const m = line.match(MONEY);
      if (m) total = money(m[m.length - 1]);
    }
  }
  const hasTable = /Amount Due/i.test(body);
  if (!rows.length || !hasTable) {
    const stop = LOGIN.test(url || "") ? "captcha-rejected" : "unknown-page";
    return { stop, text: body.replace(/\s+/g, " ").trim().slice(0, 300) };
  }
  const fileM = /File Number:\s*([^\s|]+)/i.exec(body);
  const nameM = /^\s*Name:\s*(.+?)\s*$/im.exec(body);
  const yearM = /Tax Year:\s*(\d{4})/i.exec(body);
  return {
    fileNumber: fileM ? fileM[1] : null,
    name: nameM ? nameM[1] : null,
    taxYear: yearM ? Number(yearM[1]) : null,
    rows,
    total: total == null ? rows.reduce((s, r) => s + r.due, 0) : total,
  };
}

async function pickTab(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => SITE.test(t.url));
  if (!tab) return null;
  await ctx.session.use(tab.targetId);
  return tab;
}

// Waits until the file number box exists and the CAPTCHA image has decoded.
async function waitForForm(ctx) {
  for (let i = 0; i < 20; i++) {
    const ready = await evaluate(ctx, `(()=>{ const f=document.getElementById(${JSON.stringify(ID.fileNo)}); const im=[...document.images].find(x=>/captcha/i.test((x.id||"")+" "+(x.src||""))); return !!(f && im && im.complete && im.naturalWidth>0) })()`).catch(() => false);
    if (ready) return true;
    await wait(500);
  }
  return false;
}

export async function prepare(ctx, args = {}) {
  const fileNumber = String(args.fileNumber || "").replace(/\D/g, "");
  if (!fileNumber) throw new Error("prepare needs {fileNumber}: the Delaware entity file number");
  const tab = await pickTab(ctx);
  let targetId;
  if (tab) {
    targetId = tab.targetId;
    await ctx.session.Page.navigate({ url: ENTRY });
  } else {
    ({ targetId } = await ctx.session.Target.createTarget({ url: ENTRY }));
    await ctx.session.use(targetId);
  }
  await wait(2500);
  if (!(await waitForForm(ctx))) return { stop: "form-not-found", targetId, hint: "login form or CAPTCHA image did not load; check the tab" };
  const png = await evaluate(ctx, `(()=>{
    const f=document.getElementById(${JSON.stringify(ID.fileNo)}); f.value=${JSON.stringify(fileNumber)};
    f.dispatchEvent(new Event("input",{bubbles:true})); f.dispatchEvent(new Event("change",{bubbles:true}));
    const im=[...document.images].find(x=>/captcha/i.test((x.id||"")+" "+(x.src||"")));
    const c=document.createElement("canvas"); c.width=im.naturalWidth; c.height=im.naturalHeight;
    c.getContext("2d").drawImage(im,0,0); return c.toDataURL("image/png");
  })()`);
  return { targetId, captchaPng: png, next: "show captchaPng to the human, then submit({targetId, captcha}) with what they read" };
}

export async function submit(ctx, args = {}) {
  const { targetId } = args;
  const captcha = String(args.captcha || "").trim();
  if (!targetId || !captcha) throw new Error("submit needs {targetId, captcha}: the prepare() target and the characters the human read");
  await ctx.session.use(targetId);
  const armed = await evaluate(ctx, `(()=>{
    const c=document.getElementById(${JSON.stringify(ID.captcha)}); const b=document.getElementById(${JSON.stringify(ID.submit)});
    if(!c||!b) return false;
    c.value=${JSON.stringify(captcha)}; c.dispatchEvent(new Event("input",{bubbles:true})); c.dispatchEvent(new Event("change",{bubbles:true}));
    window.__taxMarker=1; b.click(); return true;
  })()`);
  if (!armed) return { stop: "unknown-page", text: "login form not on this tab; run prepare again" };
  let snap = null;
  for (let i = 0; i < 24; i++) {
    await wait(1000);
    // Mid-navigation the execution context disappears; that throw just means keep polling.
    snap = await evaluate(ctx, `(()=>({reloaded: window.__taxMarker!==1, url: location.href, text: document.body ? document.body.innerText : ""}))()`).catch(() => null);
    if (snap && snap.reloaded) break;
  }
  if (!snap || !snap.reloaded) return { stop: "unknown-page", text: "no navigation within 24s after Continue" };
  const parsed = parseTaxPage(snap.text, snap.url);
  return parsed.stop ? parsed : { ...parsed, url: snap.url };
}
