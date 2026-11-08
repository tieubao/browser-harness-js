#!/usr/bin/env node
// Static check for one learning folder against learnings/PORTING.md.
//   node skills/cdp/learnings/check-port.mjs <domain> [<domain> ...]
// 1. manifest.json parses; every nodeTool path imports and exports its `callable` as a function;
//    every browserTool path and notes entry exists.
// 2. Legacy residue in tools/*.mjs (not *.test.mjs): reports each line that still uses the
//    singleton session pointer or a removed global. Browser-level `ctx.session.Target.*`,
//    `ctx.session.Browser.*` and `ctx.session.closeTab` are allowed and not reported.
// Exit 0 = load ok and no residue; 1 = load failure; 2 = load ok but residue left.
import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

const RESIDUE = [
  [/ctx\.session\.(?!Target\.|Browser\.|closeTab\b|_call\b)\w+/, "ctx.session.<Domain> on the active target: use page.cdp('<Domain>.<method>', params)"],
  [/\bsession\.(use|getActiveSession|setActiveSession|getActiveTargetId)\s*\(/, "session pointer: attach with ctx.findPage / ctx.attachPage instead"],
  [/\b_call\(\s*["'`](?!Target\.|Browser\.)/, "raw _call on a non-browser-level method: use page.cdp"],
  [/Target\.attachToTarget/, "hand-rolled attach: use ctx.attachPage(targetId) so the runner disposes the attachment"],
  [/\bctx\.cdp\s*\(/, "ctx.cdp(sessionId, ...): use page.cdp(method, params)"],
  [/\bctx\.listPageTargets\b/, "ctx.listPageTargets: use ctx.browser.tabs() or ctx.findPage"],
  [/\bctx\.(axView|axClick|axType|parseAxRefs|parseAxLocators|drainSignals|attachSignals|detachSignals|pageInfo)\b/, "removed-upstream helper on ctx: use the Page API (page.snapshot / page.signals / page.info) or keep the page.cdp read"],
];

const stripComments = (line) => line.replace(/^\s*\/\/.*$/, "");

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function toolFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await toolFiles(p)));
    else if (e.name.endsWith(".mjs") && !e.name.endsWith(".test.mjs")) out.push(p);
  }
  return out;
}

async function check(domain) {
  const base = join(root, domain);
  const problems = [];
  const residue = [];
  let manifest;
  try { manifest = JSON.parse(await readFile(join(base, "manifest.json"), "utf8")); }
  catch (e) { return { domain, problems: [`manifest.json: ${e.message}`], residue }; }

  for (const [name, decl] of Object.entries(manifest.nodeTools ?? {})) {
    try {
      const mod = await import(pathToFileURL(join(base, decl.path)).href);
      if (typeof mod[decl.callable] !== "function") problems.push(`nodeTool ${name}: ${decl.path} does not export function ${decl.callable}`);
    } catch (e) { problems.push(`nodeTool ${name}: cannot import ${decl.path}: ${e.message}`); }
  }
  for (const [name, decl] of Object.entries(manifest.browserTools ?? {})) {
    if (!(await exists(join(base, decl.path)))) problems.push(`browserTool ${name}: missing ${decl.path}`);
  }
  for (const note of manifest.notes ?? []) {
    if (!(await exists(join(base, note)))) problems.push(`notes: missing ${note}`);
  }

  for (const file of await toolFiles(join(base, "tools"))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((raw, i) => {
      const line = stripComments(raw);
      for (const [re, hint] of RESIDUE) if (re.test(line)) residue.push(`${file.slice(root.length + 1)}:${i + 1}: ${hint}`);
    });
  }
  return { domain, problems, residue };
}

const domains = process.argv.slice(2);
if (!domains.length) { console.error("usage: node check-port.mjs <domain> [<domain> ...]"); process.exit(1); }
let code = 0;
for (const d of domains) {
  const r = await check(d);
  if (r.problems.length) { code = 1; console.log(`FAIL ${d}`); r.problems.forEach((p) => console.log("  " + p)); }
  else if (r.residue.length) { if (!code) code = 2; console.log(`RESIDUE ${d}: ${r.residue.length} line(s)`); r.residue.forEach((p) => console.log("  " + p)); }
  else console.log(`OK ${d}`);
}
process.exit(code);
