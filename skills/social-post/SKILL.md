---
name: social-post
description: >-
  Cross-post the same text to every available social platform (X, Facebook,
  LinkedIn) through the per-platform CLIs. Use when the user asks to post to
  all my socials, cross-post this, share everywhere, "đăng lên X và facebook",
  or "post this on my socials". Requires the platform CLIs (xpost, fbpost,
  lipost) on PATH, each backed by browser-harness-js and a logged-in session.
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  Requires node on PATH plus the per-platform posting CLIs it orchestrates
  (xpost for X, fbpost for Facebook, lipost for LinkedIn). Each platform CLI
  needs browser-harness-js and a logged-in session in the user's browser.
  Missing CLIs are reported per platform, not fatal.
---

# Social Post

Cross-post the same text to every available social platform. Thin orchestrator: it invokes each platform CLI (`x` -> `xpost`, `fb` -> `fbpost`, `linkedin` -> `lipost`) with `--json` and merges the results. A missing CLI reports `{ ok:false, reason:"<cli> not installed" }` for that platform and the rest still run. The call fails only when EVERY requested platform failed.

## Usage

```bash
social-post "text"                       # post to every platform
social-post "text" --platforms x,fb      # subset
social-post "text" --image /abs/p.png    # image to platforms that support it
social-post "text" --dry-run             # pass-through dry-run to each CLI
social-post --json "text"                # { results: { x: {...}, fb: {...}, ... } }
```

- Pretty mode prints one line per platform: `x: POSTED <url>` / `fb: DRY_RUN_OK` / `linkedin: FAILED lipost not installed`.
- `--json` prints `{ "results": { "x": {...}, "fb": {...}, "linkedin": {...} } }`, each value being that platform CLI's own JSON result.
- `--dry-run` never publishes anywhere; each platform does everything except its final publish click.

## The voice

The CLIs post text **verbatim**. Voice is the drafter's job (you), not the tool's. Draft in the neko desk voice before calling this skill:

- Register name: **gork**. Lowercase, loose, wry, a little self-deprecating, terse.
- The joke lives in tone and sign-off, NEVER in the substance. Facts stay correct.
- House floor: simple words, short sentences, answer first.
- No hype, no corporate voice, no emoji unless mirroring the user.
- At most one exclamation mark. NEVER an em dash (comma, colon, or a new sentence).
- X gets the terse one-liner. Facebook can carry one extra line of context.
- Stay under each platform's own habits; do not cross-post a paragraph to X.

Canonical voice doc (read if available): `foundation-ops/desks/neko-anon/SOUL.md` (voice-sync block) + `foundation-ops/desks/HOUSE-STYLE.md`. Those are the source of truth; this block is only the working summary.

## Traps

- **`lipost` does not exist yet.** LinkedIn always reports `{ ok:false, reason:"lipost not installed" }` until that CLI ships; that is expected, not a bug. Use `--platforms x,fb` to skip it cleanly.
- **Per-platform sessions.** A platform only works if its CLI is installed AND the browser is logged in there. Check each `reason` in the results object.
- **Verbatim posting.** No drafting, no review, no per-platform rewriting inside the tool. Write the final text (or per-platform variants via separate `--platforms` calls) yourself.
