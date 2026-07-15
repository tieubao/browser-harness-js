<img src="https://r2.browser-use.com/github/asbfgihsbfbaosfjla.png" alt="Browser Harness" width="100%" />

# Browser Harness JS ♞

The thinnest possible bridge from the LLM to Chrome. **No harness, no recipes, no rails** — just every CDP method as a typed JS call.

One persistent WebSocket, 56 domains, 652 typed wrappers, zero wrapping of what Chrome already does.

```
  ● agent: wants to click a button
  │
  ● no click() helper, no upload_file(), no goto()
  │
  ● agent writes the CDP call itself        await session.Input.dispatchMouseEvent({...})
  │                                          await session.DOM.setFileInputFiles({...})
  ✓ done — same pattern for all 652 methods
```

**The protocol is the API.** If Chrome can do it, you can call it.

## Installation

```bash
npx skills add https://github.com/monotykamary/browser-harness-js
```

Or paste this into your agent — it'll install the skill, put the CLI on your PATH, and run a first task:

```text
Run `npx skills add https://github.com/monotykamary/browser-harness-js`, then
symlink `browser-harness-js` into a directory on my PATH, then use the cdp skill to drive
my browser: look at all the tabs I have open, group them by topic, and screenshot the most
interesting one.
```

(The CLI requires [`node`](https://nodejs.org) on PATH — TypeScript type stripping is on by default from Node 23.6. No runtime is auto-installed.)

If Chrome asks you to tick a remote-debugging checkbox, do it — that's how the agent attaches:

<img src="docs/setup-remote-debugging.png" alt="Remote debugging setup" width="520" style="border-radius: 12px;" />

### macOS: Dia's "Allow debugging connection?" prompt

Dia (The Browser Company) is the only Chromium browser that gates the CDP connection behind an `Allow debugging connection?` prompt — **Return** dismisses it. The SDK auto-dismisses it for you (on by default, macOS only, a no-op for every other browser): when the WebSocket open stalls, it fires a Return at the Dia process via `osascript`, so `session.connect()` needs no manual click. Opt out with `autoAllow: false` (or `browser-harness-js --no-auto-allow`).

This needs **macOS Accessibility** for the `node` binary running the SDK. If it's missing, the keystroke is dropped — `osascript` errors `-25211: not allowed assistive access` and `connect()` stalls to `timeoutMs` instead of finishing in ~1s. Grant it once: **System Settings → Privacy & Security → Accessibility → add/toggle `node`**. The grant is per binary path, so version managers that install each version at its own path (mise, nvm, asdf) need a re-grant on version bump; a stable-path install (Homebrew) persists across upgrades.

See [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) for recipes on the mechanics that are not obvious from the CDP method list alone.

## Skills

This repo contains seven skills installable via `npx skills add`:

| Skill | Description |
|-------|------------|
| **cdp** | Drive any Chromium-based browser via CDP — 56 domains, 652 typed methods |
| **gsearch** | Search the web via Google through CDP — structured results in under 1 second; `follow <url>` opens a result link and reads its page text or JSON |
| **gnews** | Search Google News through CDP (`tbm=nws`) — structured results (title, url, source, time, snippet) with the publisher's direct URL, no redirect wrapper |
| **xsearch** | Search X (Twitter) via CDP — structured results (requires an active X login) |
| **findata** | Free, keyless financial data via CDP — SEC EDGAR statements + Yahoo Finance prices |
| **ytdl** | Download YouTube videos browser-natively via CDP — records MediaSource output, no `yt-dlp` binary |
| **ttdl** | Download TikTok videos browser-natively via CDP — records MediaSource output, no watermark, no signer |
| **gmaps** | Google Maps via CDP — keyless local business search (Places API data), real directions in any travel mode (`--route --mode driving\|transit\|walking\|cycling\|flights\|best`), and best-effort fastest visiting order / TSP (`--optimize`), no API key |

## Files

- `skills/cdp/SKILL.md` — day-to-day usage; how to connect, pick a tab, call methods, persist state
- `skills/cdp/sdk/browser-harness-js` — tiny CLI that auto-spawns the server and forwards snippets
- `skills/cdp/sdk/repl.ts` — Node HTTP server holding one persistent `Session`
- `skills/cdp/sdk/session.ts` — the `Session` class: transport, connect, target routing, events
- `skills/cdp/sdk/gen.ts` — codegen: reads `browser_protocol.json` + `js_protocol.json` → typed wrappers
- `skills/cdp/sdk/generated.ts` — every CDP method as `session.<Domain>.<method>(params)` (generated)
- `skills/gsearch/SKILL.md` — Google Search skill instructions
- `skills/gsearch/scripts/gsearch` — Google Search CLI
- `skills/gnews/SKILL.md` — Google News skill instructions
- `skills/gnews/scripts/gnews` — Google News CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/xsearch/SKILL.md` — X (Twitter) Search skill instructions
- `skills/xsearch/scripts/xsearch` — X Search CLI
- `skills/findata/SKILL.md` — financial-data skill instructions
- `skills/findata/scripts/findata` — financial-data CLI (SEC EDGAR + Yahoo Finance, a `browser-harness-js` heredoc)
- `skills/ytdl/SKILL.md` — YouTube download skill instructions
- `skills/ytdl/scripts/ytdl` — YouTube download CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/ttdl/SKILL.md` — TikTok download skill instructions
- `skills/ttdl/scripts/ttdl` — TikTok download CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/gmaps/SKILL.md` — Google Maps skill instructions (search, directions, optimize)
- `skills/gmaps/scripts/gmaps` — Google Maps CLI: search + `--route` directions (`--mode` …) + `--optimize` best-effort TSP (a `browser-harness-js` heredoc, no runtime)

No helpers file. No `click()`, no `goto()`, no `upload_file()` — just the protocol, typed.

## Why no pre-baked helpers?

Every helper is a lie about what CDP already gives you. `click(x, y)` hides `Input.dispatchMouseEvent` — which has 14 parameters the LLM might need (button, clickCount, modifiers, pointerType, force, tangentialPressure, …). A harness that exposes three of them quietly limits what the agent can do.

- Types are the docs. `session.Page.navigate(` triggers autocomplete with the exact params — same JSDoc as the CDP reference.
- No version drift. The SDK is regenerated from the upstream protocol JSON; new Chrome methods appear as soon as you swap the JSON.
- No "helper doesn't handle my case" detours. If CDP can do it, the agent can call it — directly, typed, today.

The only "helpers" you'll find are things CDP itself is missing:
- `listPageTargets()` — filters `chrome://` / `devtools://` out of `Target.getTargets`
- `resolveWsUrl({wsUrl|port|profileDir})` — reads `DevToolsActivePort` for Chrome 144+
- `session.use(targetId)` / `session.waitFor(method, pred, timeout)` — the two routing primitives you genuinely need

## Contributing

PRs welcome. The best way to help: **contribute a new interaction skill** under [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) when you figure out the CDP recipe for something non-obvious (a dropdown framework, a shadow-DOM trap, a network-wait pattern).

- Keep recipes in **pure CDP** — `session.Domain.method(...)`, not wrapped helpers.
- Lead with the shortest method call that works; add the workaround or trap afterwards.
- Small and focused beats comprehensive. One mechanic per file.
- Bug fixes, codegen improvements, and `session.ts` refinements are equally welcome.

---

[Bitter lesson](https://browser-use.com/posts/bitter-lesson-agent-frameworks) · [Skills](https://browser-use.com/posts/web-agents-that-actually-learn)
