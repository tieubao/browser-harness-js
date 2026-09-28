// learnings/admin-google-com/tools/admin-google-com.mjs
// Google Workspace admin console, domain-wide delegation page. This page demands a fresh
// passkey re-auth (challenge) before it loads, which only a human at the machine can pass, so
// listDelegation opens a FOREGROUND tab and polls for the URL to settle rather than assuming a
// background tab will ever get there. deleteDelegation is a WRITE (revokes an integration) and
// refuses without confirm:true, then re-reads the table to prove the row is actually gone --
// a synthetic click reporting success proves nothing on this page.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// The only click technique that reliably drives this console's rows and dialogs (see header
// comment): a real Input.dispatchMouseEvent sequence at the target's own bounding-rect centre.
async function realClick(ctx, x, y) {
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await ctx.session.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await ctx.session.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickRect(ctx, rect) {
  await realClick(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

// Rows carry a 21-digit OAuth client id. Cell text beyond the client id is split into a best-
// effort name/scopes pair; the admin console does not label these consistently, so a caller
// that needs the raw text should fall back to `scopes`, which always holds the row minus the id.
async function readRows(ctx) {
  const json = await evaluate(ctx, `JSON.stringify([...document.querySelectorAll('tr,[role=row]')]
    .map((el) => {
      const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      const m = text.match(/\\b\\d{21}\\b/);
      if (!m) return null;
      const clientId = m[0];
      const cells = [...el.querySelectorAll('td,[role=cell],[role=gridcell]')]
        .map((c) => (c.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean);
      const name = cells.find((c) => c && !c.includes(clientId)) || "";
      const scopes = text.replace(clientId, "").trim();
      return { name, clientId, scopes };
    })
    .filter(Boolean))`);
  return JSON.parse(json || "[]");
}

export async function listDelegation(ctx, { authuser = 0 } = {}) {
  const url = `https://admin.google.com/u/${authuser}/ac/owl/domainwidedelegation`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  await ctx.session.use(targetId);

  const pollMs = 10000;
  const maxAttempts = Math.ceil((4 * 60 * 1000) / pollMs); // ~4 minutes
  let ready = false;
  for (let i = 0; i < maxAttempts; i++) {
    const href = String((await evaluate(ctx, "location.href")) || "");
    if (href.includes("domainwidedelegation") && !href.includes("accounts.google.com")) { ready = true; break; }
    await wait(pollMs);
  }
  if (!ready) {
    return { stop: "reauth-required", hint: "a human must approve the passkey prompt on this machine" };
  }

  return { targetId, rows: await readRows(ctx) };
}

export async function deleteDelegation(ctx, { targetId, clientId, confirm } = {}) {
  if (!targetId) throw new Error("deleteDelegation: targetId is required");
  if (!clientId) throw new Error("deleteDelegation: clientId is required");
  if (confirm !== true) return { stop: "confirm-required", hint: "deleting a delegation revokes an integration; a human must confirm" };
  await ctx.session.use(targetId);

  const deleteLeafRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const needle = ${JSON.stringify(clientId)};
    const row = [...document.querySelectorAll('tr,[role=row]')].find((el) => (el.textContent || "").includes(needle));
    if (!row) return null;
    const leaf = [...row.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || "").trim() === "Delete");
    return leaf ? leaf.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!deleteLeafRect) return { stop: "delete-link-not-found" };
  await clickRect(ctx, deleteLeafRect);
  await wait(2000);

  const dialogButtonRect = JSON.parse((await evaluate(ctx, `JSON.stringify((() => {
    const dialog = document.querySelector('[role=dialog],[role=alertdialog]');
    if (!dialog) return null;
    const btn = [...dialog.querySelectorAll('button,[role=button]')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (b.innerText || b.textContent || "").trim() === "Delete";
    });
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!dialogButtonRect) return { stop: "confirm-dialog-not-found" };
  await clickRect(ctx, dialogButtonRect);
  await wait(4000);

  const rows = await readRows(ctx);
  const stillListed = rows.some((r) => r.clientId === clientId);
  return stillListed ? { stop: "still-listed" } : { deleted: true };
}
