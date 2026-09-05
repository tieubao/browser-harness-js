# github-com

GitHub's classic Personal Access Token form has no mint API, so the form itself is the only
path. Included here for the token-form mechanics only, not as a general GitHub-com registry.

```js
await learnings("github-com")
await learnings("github-com", "patForm", { description: "github-org-runners-token", scopes: ["admin:org"] })
```

## Mechanics this encodes

- **Prefill the URL** (`?description=...&scopes=a,b`) instead of clicking every scope checkbox.
- **React inputs ignore `el.value = x`.** Set through the native setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,v)`) then
  dispatch `input` and `change` so React's own state updates.
- **Click by visible text**, not by selector, for the expiration option and the Generate button
  -- their DOM structure changes across GitHub deploys, their label text does not.
- **Extract the token by regex** (`ghp_[A-Za-z0-9]{36,}`) from the result page; it is shown once
  and only once.
- **Stop condition: "Confirm access" sudo re-auth.** GitHub gates sensitive actions behind a
  re-auth page needing a password, passkey, or 2FA device -- none of which a script can click
  through. `patForm` checks for it before filling the form and again after clicking Generate, and
  returns `{stop: "sudo"}` instead of attempting anything.

## Provenance

2026-09-04 vps-mon GitHub Actions runner token narrowing (`admin:org` mint, then narrowed to
`manage_runners:org`). Driven by hand first as `bh-pat-open.sh` / `bh-pat-gen.sh` /
`bh-pat-narrow.sh` (ops-toolkit session scratch), then the mint half distilled here. The
narrowing step (open an existing token's edit page, uncheck/check scopes, click Update token) is
a close cousin of this same form and not yet its own tool -- add one here if it recurs.
