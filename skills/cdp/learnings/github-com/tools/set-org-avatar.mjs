// learnings/github-com/tools/set-org-avatar.mjs
// Set an org's avatar. GitHub has no REST/GraphQL API for this -- UI-only, via the
// org profile settings page. Uses CDP DOM.setFileInputFiles directly on the hidden
// #avatar-upload-input (never click the styled button -- opens the OS picker instead).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

// dryRun: true stops after locating the file input, before touching it -- use to check
// the selector still holds without changing a real org's avatar.
export async function setOrgAvatar(ctx, args) {
  const { org, file, dryRun = false } = args || {};
  if (!org) throw new Error("setOrgAvatar: org is required");
  if (!dryRun && !file) throw new Error("setOrgAvatar: file is required unless dryRun");

  const url = `https://github.com/organizations/${encodeURIComponent(org)}/settings/profile`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    const page = await ctx.attachPage(targetId, { allowedOrigins: ["https://github.com"] });
    await wait(5000);

    await page.cdp("DOM.enable", {});
    const { root } = await page.cdp("DOM.getDocument", { depth: -1 });
    const { nodeId } = await page.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: "#avatar-upload-input" });
    if (!nodeId) return { done: false, reason: "no #avatar-upload-input on page (not org admin, or GitHub changed the form)" };
    if (dryRun) return { done: false, reason: "dry run", foundInput: true };

    await page.cdp("DOM.setFileInputFiles", { nodeId, files: [file] });
    await wait(1500); // crop dialog opens inside an open <details>

    const clicked = await evaluate(page, `(() => {
      const b = [...document.querySelectorAll('button')].find((b) => (b.innerText || "").trim() === "Set new profile picture");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) return { done: false, reason: "no 'Set new profile picture' button after upload" };
    await wait(2000);

    return { done: true };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}
