# Goal: a fine-grained PAT callable in the github-com learning

Lane: normal. Home: `skills/cdp/learnings/github-com/` (precedent hit: `learnings/github-com`, "GitHub (classic PAT form); tools: patForm").
Done = `learnings("github-com", "fineGrainedPatForm", {...})` mints a fine-grained token through the logged-in browser, and the form's four traps are written down where the next session reads them.

## Context-to-read

- `skills/cdp/learnings/github-com/manifest.json`, `tools/pat.mjs`, `notes/overview.md`: the classic-token sibling. Match its shape, its stop-condition discipline, and its `(ctx, args)` callable contract.
- `skills/cdp/learnings/README.md` and `example/`: the manifest schema.
- `skills/cdp/learnings/dvc-cutru/` or `figma-com/`: a second reference for how a learning with more than one callable is laid out.

## Constraints

The four traps this session hit, each of which the notes must record:

1. The page may land on the sudo "Confirm access" screen first. Detect it and return `{stop: "sudo"}` as `patForm` already does, rather than attempting anything.
2. Clicking the raw `button[type=submit]` throws GitHub's "You can't perform that action at this time". The working path is the `js-integrations-install-form-submit` button, then "Generate token" in the confirm dialog.
3. The expiry presets stop at 90 days. A year needs the Custom option.
4. The token is read from the DOM straight into a 0600 file. It is never logged, never returned through a path that reaches a transcript, and it is shown once.

Plus: no credential value in any committed file, fixture or example.

## Operating rules

- Work in the worktree at `.claude/worktrees/stage-pat-learning` (already created) or a fresh one on its own branch. Never on `main`.
- Enhance the existing `github-com` learning. Do not open a second learning id for the same domain.
- The callable stops rather than guesses on every ambiguous screen, which is the rule the classic tool already follows.
- Click by visible text where the DOM structure is unstable, as the existing notes say.

## Validation loop

1. `node --check` on the new `.mjs`.
2. `learnings("github-com")` lists both callables and the manifest parses.
3. A real mint against a throwaway token name, with the token landing in a 0600 file and nothing token-shaped in the run output.
4. Re-run against the sudo screen (or a fixture of it) and confirm the stop condition fires instead of a click.

## Done-when

- `manifest.json` carries the second `nodeTools` entry with its args and returns.
- `notes/overview.md` has a fine-grained section holding the four traps and a provenance line.
- A shell entry point exists only if it is a thin CLI over `learnings(id, tool, args)`, never a second copy of the page logic.

## Pause-if

- GitHub's form changed again and the recorded selectors no longer exist. Record what it is now, do not guess.
- The mint would need a token scope nobody asked for.
- The run cannot be done without printing a token value anywhere.
