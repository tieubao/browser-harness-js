// learnings/github-com/tools/pat.mjs
// GitHub's classic Personal Access Token form, driven through the logged-in tab. Prefilling the
// URL query (description + scopes) skips most of the click work; the description input and the
// expiration control are still React-controlled, so they need the native-setter + click-by-text
// dance -- el.value = x is silently ignored by React inputs.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

async function isSudoPage(ctx) {
  return evaluate(ctx, `!!document.querySelector('#sudo_password, input[name=sudo_password], [data-testid=sudo-modal]') || /Confirm access/i.test(document.title)`);
}

// Open the prefilled form, set description + expiration, ensure scopes, click Generate, extract
// the ghp_ token. Stops (does not click through) on GitHub's "Confirm access" sudo re-auth --
// that needs a passkey/2FA device and is unscriptable by design.
export async function patForm(ctx, args) {
  const { description, scopes = [], expirationLabel = "No expiration" } = args || {};
  if (!description) throw new Error("patForm: description is required");
  const url = "https://github.com/settings/tokens/new?description=" + encodeURIComponent(description) +
    (scopes.length ? "&scopes=" + scopes.map(encodeURIComponent).join(",") : "");
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    await ctx.session.use(targetId);
    await wait(7000);

    if (await isSudoPage(ctx)) return { stop: "sudo" };

    await evaluate(ctx, `(() => {
      const setv = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true})); };
      const d = document.querySelector('input[name="oauth_access[description]"]');
      if (d && d.value !== ${JSON.stringify(description)}) setv(d, ${JSON.stringify(description)});
      const label = ${JSON.stringify(expirationLabel)};
      const opt = [...document.querySelectorAll('button, [role=menuitemradio], label, span')].find((e) => (e.innerText || "").trim() === label);
      if (opt) opt.click();
    })()`);
    await wait(500);

    if (scopes.length) {
      await evaluate(ctx, `(() => {
        const want = ${JSON.stringify(scopes)};
        for (const v of want) {
          const cb = document.querySelector('input[type=checkbox][name="oauth_access[scopes][]"][value="' + v + '"]');
          if (cb && !cb.checked) cb.click();
        }
      })()`);
    }

    const state = JSON.parse((await evaluate(ctx, `JSON.stringify({
      desc: (document.querySelector('input[name="oauth_access[description]"]')||{}).value,
      checked: [...document.querySelectorAll('input[type=checkbox][name="oauth_access[scopes][]"]:checked')].map((i) => i.value),
    })`)) || "{}");
    const missing = scopes.filter((s) => !(state.checked || []).includes(s));
    if (missing.length) return { stop: "scopes-not-checked", missing, state };

    const clicked = await evaluate(ctx, `(() => { const b = [...document.querySelectorAll('button')].find((b) => /^Generate token$/i.test((b.innerText||"").trim())); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) return { stop: "no-generate-button" };
    await wait(6000);

    if (await isSudoPage(ctx)) return { stop: "sudo" };

    const token = await evaluate(ctx, `(() => {
      const el = document.querySelector('#new-oauth-token, .token, code[id*=token]');
      const t = (el && el.innerText) || "";
      const m = (t + " " + document.body.innerText).match(/ghp_[A-Za-z0-9]{36,}/);
      return m ? m[0] : null;
    })()`);
    if (!token) return { stop: "token-not-found", href: await evaluate(ctx, "location.href") };
    // Returned to the caller only -- never printed or stored here.
    return { token };
  } finally {
    try { await ctx.session.Target.closeTarget({ targetId }); } catch { /* already gone */ }
  }
}
