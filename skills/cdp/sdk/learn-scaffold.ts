/**
 * Scaffolds a new per-site learning under skills/cdp/learnings/<id>/ so a fresh
 * recipe starts from the registry's own shape (manifest.json + notes/overview.md +
 * tools/<id>.mjs) instead of a scratch script. Backs `browser-cdp learn new` / `learn list`.
 * Mirrors the listLearnings() walk in helpers.ts (LEARNINGS_DIR resolved the same way)
 * without importing it, since helpers.ts is REPL-only (closes over globalThis.session).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LEARNINGS_DIR = join(SKILL_DIR, 'learnings');

const ID_RE = /^[a-z0-9-]{2,40}$/;

/** null when valid, else a one-line reason. */
export function idError(id: string): string | null {
  if (!ID_RE.test(id)) return `invalid id "${id}": must match [a-z0-9-]{2,40}`;
  return null;
}

export async function listLearningIds(dir: string = LEARNINGS_DIR): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return []; }
  const found: string[] = [];
  for (const c of entries) {
    const st = await stat(join(dir, c)).catch(() => null);
    if (st && st.isDirectory()) {
      try { await readFile(join(dir, c, 'manifest.json'), 'utf8'); found.push(c); }
      catch { /* no manifest */ }
    }
  }
  return found.sort();
}

export type ScaffoldOptions = {
  id: string;
  domains: string[];
  name?: string;
  dir?: string; // learnings root override, for tests
};

export async function scaffoldLearning(opts: ScaffoldOptions): Promise<string> {
  const { id } = opts;
  const err = idError(id);
  if (err) throw new Error(err);
  const domains = (opts.domains ?? []).map((d) => d.trim()).filter(Boolean);
  if (domains.length === 0) throw new Error('learn new needs --domains a.example,b.example');

  const base = opts.dir ?? LEARNINGS_DIR;
  const root = join(base, id);
  const existing = await stat(join(root, 'manifest.json')).catch(() => null);
  if (existing) throw new Error(`learning "${id}" already exists at ${root}`);

  const name = opts.name || id;
  const today = new Date().toISOString().slice(0, 10);

  await mkdir(join(root, 'notes'), { recursive: true });
  await mkdir(join(root, 'tools'), { recursive: true });

  const manifest = {
    id,
    name,
    domains,
    notes: ['notes/overview.md'],
    nodeTools: {
      status: {
        description: 'Where the tab is: no-tab (no open tab matches domains) | tab.',
        path: `tools/${id}.mjs`,
        callable: 'status',
        args: {},
        returns: { type: 'object', description: '{state:"tab", url} or {state:"no-tab", hint}' },
      },
    },
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const toolSrc = `// learnings/${id}/tools/${id}.mjs
// Scaffolded by \`browser-cdp learn new ${id}\`. Replace status() and add more
// nodeTools entries in ../manifest.json as the recipe grows, see
// learnings/dvc-cutru/ for the shape once this has more than one tool.
const DOMAINS = ${JSON.stringify(domains)};

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
`;
  await writeFile(join(root, 'tools', `${id}.mjs`), toolSrc, 'utf8');

  const overview = `# ${name}

\`\`\`js
await learnings("${id}")
await learnings("${id}", "status")
\`\`\`

## Limits (learned ${today})

_(none yet, fill in as gotchas are found)_

## Provenance

${today} scaffolded via \`browser-cdp learn new ${id} --domains ${domains.join(',')}\`.
`;
  await writeFile(join(root, 'notes', 'overview.md'), overview, 'utf8');

  return root;
}
