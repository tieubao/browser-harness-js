# AGENTS.md — notes for AI coding agents working in this repo

Read this before touching skills. The single most common mistake is editing the
wrong copy. Don't.

## What this repo is

This is the **source** repo for `browser-harness-js`: the CDP SDK (`skills/cdp/sdk/`)
plus a set of skills that drive a Chromium browser through it. The user's
installed skills are **copies** of what lives here.

- `skills/cdp/` — the `cdp` skill: the SDK itself (`sdk/browser-harness-js` CLI,
  `repl.ts` server, `session.ts`, `generated.ts` typed wrappers) + usage docs +
  `interaction-skills/` recipe notes.
- `skills/<name>/` — every other skill (`gsearch`, `xsearch`, `findata`, `ytdl`,
  `ttdl`, `gmaps`, …). Each is a thin `browser-harness-js` heredoc CLI.

## The install model (this is the part that gets confused)

| Where | What it is | Edit here? |
|-------|-----------|-------------|
| `./skills/<name>/` (this repo) | **source of truth** | **YES — always** |
| `~/.agents/skills/<name>/` | installed copy (via `npx skills add` or manual sync) | NO |
| `~/.pi/agent/skills/<name>` | symlink → `~/.agents/skills/<name>` (pi's discovery) | NO |
| `~/.local/bin/<name>` | PATH symlink → this repo's `skills/<name>/scripts/<name>` | (auto) |

**Develop skills in `./skills/<name>/` only.** Never write into `~/.agents/skills/`
or `~/.pi/agent/skills/` — those are installed copies, and changes there are
throwaway. To make a repo skill runnable on PATH, run its own `scripts/setup`
(which symlinks `~/.local/bin/<name>` at the repo script); do not hand-create
global skill dirs.

The `browser-harness-js` CLI the skills call is this repo's `skills/cdp/sdk/browser-harness-js`
(symlinked onto PATH by `scripts/setup`). It is not a separate "system harness" —
it is this repo's SDK, installed. There is nothing else to conflate it with.

## Skill anatomy (match the existing skills exactly)

```
skills/<name>/
  SKILL.md          # frontmatter (below) + user-facing docs
  scripts/
    <name>          # the CLI: bash + one `browser-harness-js` heredoc
    setup           # symlink installer — identical template across skills
    test            # (optional) smoke test, exits 77 if browser unreachable
```

**SKILL.md frontmatter** — `name`, `description`, `setup`, `compatibility` only.
The repo skills do **not** use `disable-model-invocation` (that field only appears
in some installed copies; do not add it here).

```
---
name: <name>
description: >-
  One-paragraph: what it returns + when to use it + the hard requirement
  (browser-harness-js on PATH, Chromium with remote debugging).
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  browser-harness-js on PATH + a Chromium browser with remote debugging
  (chrome://inspect or --remote-debugging-port). Note any extras (ffmpeg,
  a logged-in tab, …).
---
```

**The CLI** is plain bash that ends in a `browser-harness-js <<'EOF' … EOF`
heredoc returning a string (pretty) or an object/array (JSON via `--json`).
Conventions:

- Auto-fix header: if `browser-harness-js` isn't on PATH, symlink it from
  `../cdp/sdk/browser-harness-js` (relative to the script — resolves to the
  sibling `cdp` skill in both the repo and an install).
- One tab per call: `Target.createTarget({ background: true })` →
  `attachToTarget` → per-call `sessionId` → … → fire-and-forget `closeTab` in
  `finally`. This is what makes calls safe to run in parallel.
- **No `jq`**, no extra runtime deps. `node` is required (the REPL needs it);
  use it for things like JSON-safe string literals or date math.
- Pass shell args into the heredoc via **placeholder substitution** (a quoted
  heredoc + a tiny `node -e` that JSON.stringifies the raw value and uses
  *function*-replacements). Do not `export` env vars and read `process.env` —
  the REPL daemon is long-lived and won't see newly exported vars. Do not use
  bash `${var//pat/$repl}` for values containing `&` or `$` (it re-interprets
  them as the match / captures).

**`setup`** is the same template across all skills: ensure `~/.local/bin` is on
PATH, symlink the CLI there, and symlink `browser-harness-js` from
`../cdp/sdk/browser-harness-js` if it isn't already on PATH. Copy it verbatim
and change only the skill name.

## Developing & testing a skill here

```bash
# edit skills/<name>/… then:
bash skills/<name>/scripts/setup        # refresh ~/.local/bin/<name> -> repo script
bash skills/<name>/scripts/test         # smoke test (77 = browser unreachable)
./skills/<name>/scripts/<name> …        # run the repo's own script directly
```

Skills drive the **user's own system browser** via CDP remote debugging — they
do not bundle a browser. Tests are live (they hit real sites through the
browser), like `findata` hits real Yahoo/SEC. A browser must be running with
remote debugging enabled (see the `cdp` skill) or tests skip with exit 77.

## When adding a skill

1. Build it under `./skills/<name>/` following the anatomy above.
2. Add it to the README's **Skills** table and **Files** list.
3. Ship a `scripts/test` smoke test.
4. Run `scripts/setup` to symlink it onto PATH for local testing — leave the
   global `~/.agents/skills/` and `~/.pi/agent/skills/` alone; the user installs
   from this repo (`npx skills add`) on their own schedule.
