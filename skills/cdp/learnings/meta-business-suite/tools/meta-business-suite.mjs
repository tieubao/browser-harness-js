// learnings/meta-business-suite/tools/meta-business-suite.mjs
// Scaffolded by `browser-cdp learn new meta-business-suite`. Replace status() and add more
// nodeTools entries in ../manifest.json as the recipe grows, see
// learnings/dvc-cutru/ for the shape once this has more than one tool.
const DOMAINS = ["developers.facebook.com","business.facebook.com","www.facebook.com"];

function matches(url, domain) {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith('.' + domain);
  } catch { return false; }
}

export async function status(ctx) {
  const tabs = await ctx.listPageTargets();
  const tab = tabs.find((t) => DOMAINS.some((d) => matches(t.url, d)));
  if (!tab) return { state: 'no-tab', hint: 'no open tab matches ' + DOMAINS.join(', ') };
  await ctx.session.use(tab.targetId);
  return { state: 'tab', url: tab.url };
}
