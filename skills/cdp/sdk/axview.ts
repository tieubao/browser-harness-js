/**
 * Compressed accessibility-tree view — a projection over a raw
 * `Accessibility.getFullAXTree` (or `queryAXTree`) result, NOT a replacement
 * for the CDP call. The agent still fetches the nodes; `axView` renders them
 * compactly so a full-page snapshot fits in context.
 *
 * Raw `getFullAXTree` is unusable in context: a real page returns thousands of
 * nodes, hundreds of thousands of tokens, full of `sources` / `chromeRole` /
 * `InlineTextBox` noise. `axView` drops the ~96% that is structural, keeps every
 * interactive node, heading, landmark, and text node, and assigns `[n]` refs
 * mapped to `backendDOMNodeId` so the agent can act on them.
 *
 * Measured (cl100k_base): a Wikipedia article 886K -> 22K tokens; an app page
 * 210K -> 7K. All interactive nodes and content preserved.
 *
 * Pure — takes already-fetched nodes, returns a string. No session, no CDP
 * calls. Injected as the `axView` global in the REPL (see `repl.ts`). For the
 * heuristics, when to use this vs `queryAXTree`, and the raw-CDP fallback, see
 * `interaction-skills/snapshot.md`.
 */
export type AxViewOptions = { refs?: boolean };

export function axView(nodes: any[], opts: AxViewOptions = {}): string {
  const byId = new Map(); for (const n of nodes) if (!byId.has(n.nodeId)) byId.set(n.nodeId, n);
  const role = (n: any) => n.role?.value || (n.ignored ? 'IGNORED' : 'NONE');
  const name = (n: any) => (n.name?.value ?? '').replace(/\s+/g, ' ').trim();
  const LEAF = new Set(['InlineTextBox', 'LineBreak', 'ListMarker', 'ContentInsertion', 'ContentDeletion']);
  const INT = new Set(['link', 'button', 'textbox', 'searchbox', 'spinbutton', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'switch', 'tab', 'tablist', 'tree', 'treeitem', 'treegrid', 'grid', 'gridcell', 'rowheader', 'columnheader', 'scrollbar']);
  const LM = new Set(['main', 'navigation', 'complementary', 'banner', 'contentinfo', 'form', 'search', 'region', 'article', 'application']);
  const DROP = new Set(['none', 'generic', 'paragraph', 'section', 'div', 'presentation', 'separator', 'insertion', 'deletion', 'superscript', 'subscript', 'Abbr', 'group', 'list', 'listitem', 'row', 'rowgroup', 'cell', 'table', 'figure', 'figcaption']);
  const root = [...byId.values()].find(n => role(n) === 'RootWebArea');
  const survive = new Set<string>();
  const post = (n: any): boolean => {
    if (!n) return false;
    if (n.ignored) { let c = false; for (const id of (n.childIds || [])) if (post(byId.get(id))) c = true; return c; }
    const r = role(n); if (LEAF.has(r)) return false;
    let keep = INT.has(r) || LM.has(r) || r === 'heading' || (r === 'StaticText' && name(n)) || (name(n) && !DROP.has(r));
    let cs = false; for (const id of (n.childIds || [])) if (post(byId.get(id))) cs = true;
    if (cs) keep = true; if (keep) survive.add(n.nodeId); return keep;
  };
  post(root);
  // Coalesce redundant text children: a node whose name equals its subtree's
  // text keeps just the node line (e.g. `link "Donate"` drops `StaticText "Donate"`).
  const suppress = new Set<string>();
  const leaves = (n: any, a: any[]) => {
    if (!n || !survive.has(n.nodeId)) return;
    if (role(n) === 'StaticText') { a.push(n); return; }
    for (const id of (n.childIds || [])) leaves(byId.get(id), a);
  };
  for (const n of byId.values()) {
    if (!survive.has(n.nodeId) || role(n) === 'StaticText') continue;
    const nm = name(n); if (!nm) continue;
    const L: any[] = []; leaves(n, L); if (!L.length) continue;
    if (L.map(l => name(l)).join(' ').replace(/\s+/g, ' ').trim() === nm) for (const l of L) suppress.add(l.nodeId);
  }
  const ref = new Map<string, number>(), back = new Map<number, number>(); let rn = 0;
  const flags = (n: any): string => {
    const p: any = {}; for (const q of (n.properties || [])) if (q.value && 'value' in q.value) p[q.name] = q.value.value;
    const f: string[] = [];
    if (p.focused) f.push('focused'); if (p.checked === true) f.push('checked'); if (p.expanded === true) f.push('expanded');
    if (p.disabled) f.push('disabled'); if (p.required) f.push('required'); if (p.pressed) f.push('pressed');
    let e = ''; if ('level' in p) e = ` (h${p.level})`; if ('value' in p && p.value != null && p.value !== '') e += ` ="${String(p.value).slice(0, 40)}"`;
    return f.length ? ` <${f.join(' ')}>` + e : e;
  };
  const out: string[] = [];
  const emit = (n: any, d: number) => {
    if (!n || suppress.has(n.nodeId)) return;
    const r = role(n);
    if (n.ignored || (DROP.has(r) && !LM.has(r) && !INT.has(r) && r !== 'heading')) { for (const id of (n.childIds || [])) emit(byId.get(id), d); return; }
    if (!survive.has(n.nodeId)) return;
    const nm = name(n);
    let rid = '';
    if (n.backendDOMNodeId && (INT.has(r) || r === 'heading' || (r !== 'StaticText' && nm))) {
      if (!ref.has(n.nodeId)) { rn++; ref.set(n.nodeId, rn); back.set(rn, n.backendDOMNodeId); }
      rid = `[${ref.get(n.nodeId)}] `;
    }
    out.push('  '.repeat(d) + rid + r + (nm ? ` "${nm}"` : '') + flags(n));
    for (const id of (n.childIds || [])) emit(byId.get(id), d + 1);
  };
  emit(root, 0);
  if (opts.refs !== false) out.push('', '# refs -> backendDOMNodeId', [...back.entries()].map(([r, b]) => `[${r}]=${b}`).join(' '));
  return out.join('\n');
}
