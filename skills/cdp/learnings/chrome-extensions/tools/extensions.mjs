// learnings/chrome-extensions/tools/extensions.mjs
// Extension management for a Chromium browser over CDP. Called as fn(ctx, args); ctx.session
// is the harness Session. See notes/overview.md for why each path is taken.
//
//  - loadUnpacked uses the browser-level Extensions.loadUnpacked method, with NO page session
//    attached, because the "Load unpacked" button opens a native file picker CDP cannot drive.
//  - The other tools run chrome.developerPrivate.* inside a chrome://extensions page, which is
//    the same API the page's own UI uses, so they skip the nested shadow-root DOM entirely.
// Every tool restores the session that was active before it ran.

const EXT_ID = /^[a-p]{32}$/;
const EXTENSIONS_URL = /^[a-z-]+:\/\/extensions(\/|$|\?|#)/;

function requireId(id) {
  if (typeof id !== "string" || !EXT_ID.test(id)) throw new Error(`invalid extension id "${id}": expected 32 chars a-p`);
  return id;
}

function evalError(exceptionDetails) {
  const ex = exceptionDetails.exception || {};
  return new Error(`Runtime.evaluate threw: ${ex.description || exceptionDetails.text || JSON.stringify(exceptionDetails)}`);
}

export async function loadUnpacked(ctx, args) {
  const path = args && args.path;
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("loadUnpacked needs an absolute path to the extension directory");
  const { session } = ctx;
  const previous = session.getActiveSession();
  session.setActiveSession(undefined);
  try {
    const result = await session._call("Extensions.loadUnpacked", { path });
    return { id: result.id };
  } finally {
    session.setActiveSession(previous);
  }
}

// Run `body` (a JS expression string producing a value or promise) inside a chrome://extensions
// page. Reuses an open one, else opens one in the background and closes it afterwards.
async function inExtensionsPage(ctx, body) {
  const { session } = ctx;
  const previous = session.getActiveSession();
  let createdTargetId;
  try {
    const { targetInfos } = await session._call("Target.getTargets");
    let target = targetInfos.find((t) => t.type === "page" && EXTENSIONS_URL.test(t.url));
    let targetId = target && target.targetId;
    if (!targetId) {
      ({ targetId } = await session._call("Target.createTarget", { url: "chrome://extensions", background: true }));
      createdTargetId = targetId;
    }
    await session.use(targetId);
    const { result, exceptionDetails } = await session._call("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw evalError(exceptionDetails);
    return result ? result.value : undefined;
  } finally {
    session.setActiveSession(previous);
    if (createdTargetId) await session._call("Target.closeTarget", { targetId: createdTargetId }).catch(() => {});
  }
}

export async function extensionInfo(ctx, args) {
  const id = requireId(args && args.id);
  return inExtensionsPage(ctx, `
    const info = await chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)});
    const runtimeErrors = info.runtimeErrors || [];
    return {
      id: info.id,
      name: info.name,
      version: info.version,
      state: info.state,
      path: info.prettifiedPath || info.path || null,
      manifestErrors: (info.manifestErrors || []).length,
      runtimeErrors: {
        count: runtimeErrors.length,
        messages: runtimeErrors.map((e) => ({ id: e.id, severity: e.severity, occurrences: e.occurrences, source: e.source, message: e.message })),
      },
    };
  `);
}

export async function reloadExtension(ctx, args) {
  const id = requireId(args && args.id);
  return inExtensionsPage(ctx, `
    const loadError = await chrome.developerPrivate.reload(${JSON.stringify(id)}, { failQuietly: true });
    return { reloaded: !loadError, loadError: loadError || null };
  `);
}

export async function clearExtensionErrors(ctx, args) {
  const id = requireId(args && args.id);
  return inExtensionsPage(ctx, `
    const info = await chrome.developerPrivate.getExtensionInfo(${JSON.stringify(id)});
    const errorIds = (info.runtimeErrors || []).map((e) => e.id);
    if (errorIds.length) await chrome.developerPrivate.deleteExtensionErrors({ extensionId: ${JSON.stringify(id)}, errorIds });
    return { cleared: errorIds.length };
  `);
}

export async function setDeveloperMode(ctx, args) {
  if (!args || typeof args.enabled !== "boolean") throw new Error("setDeveloperMode needs {enabled: boolean}");
  return inExtensionsPage(ctx, `
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: ${args.enabled} });
    const config = await chrome.developerPrivate.getProfileConfiguration();
    return { inDeveloperMode: config.inDeveloperMode };
  `);
}
