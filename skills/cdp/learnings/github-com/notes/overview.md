# github-com

GitHub's classic Personal Access Token form has no mint API, so the form itself is the only
path. The org avatar has the same gap. Included here for settings-form mechanics only, not as a
general GitHub-com registry.

```js
await learnings("github-com")
await learnings("github-com", "patForm", { description: "github-org-runners-token", scopes: ["admin:org"] })
await learnings("github-com", "setOrgAvatar", { org: "some-org", file: "/abs/path.png" })
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

## Org avatar: no API, settings-page only

There is no REST or GraphQL mutation to set an org avatar. `PATCH /orgs/{org}` accepts no avatar
field. The only path is the UI at `https://github.com/organizations/<org>/settings/profile`,
which needs an org-admin session already logged in in the browser.

Verified live twice, on two different orgs, both times with a 500x500 PNG.

```js
await learnings("github-com", "setOrgAvatar", { org: "some-org", file: "/abs/path.png" })
```

Mechanics:

- The file input is `#avatar-upload-input`, hidden. `DOM.setFileInputFiles` sets it directly --
  do not click the styled upload button, it opens the OS file picker.
- Uploading opens a crop dialog inside an open `<details>` element. Confirm by clicking the
  visible button whose text is exactly "Set new profile picture" (`Runtime.evaluate`, click by
  text -- same reasoning as `patForm`'s Generate button: selectors drift across deploys, label
  text does not).
- Splitting `DOM.getDocument` / `DOM.setFileInputFiles` / the confirm click into separate steps
  matters here: bundling document-fetch + file-set + evaluate into one script crashed the REPL
  daemon once (empty reply, then it auto-restarted and lost session globals). `setOrgAvatar` does
  them as sequential awaited CDP calls inside one node-tool, which held up; if driving this by
  hand instead of via the tool, keep each CDP call in its own `browser-harness-js` invocation
  rather than one large snippet.
- Verify by downloading `https://avatars.githubusercontent.com/u/<org_id>?s=200&cb=<timestamp>`
  and sampling pixel colors (ImageMagick `%[hex:u.p{x,y}]`) rather than trusting the API's
  `avatar_url` -- that field keeps a stale `?v=4` and does not reflect the new image.
- If editing/testing this tool while the daemon is up, `browser-harness-js --restart` first (see
  README "Editing a node-tool") or the old code keeps running.

### Same settings page, other gaps worth knowing

`/settings/profile` also holds the member-privilege toggles (default repo visibility change,
who can delete repos). The REST `PATCH /orgs/{org}` silently ignores
`members_can_change_repo_visibility` and `members_can_delete_repositories` -- it returns 200 but
does not apply them, so verify by re-reading the org after a PATCH, not by trusting the response.
The 2FA requirement toggle lives at a different page, `/organizations/<org>/settings/security`,
not on the profile page. Creating a private-only repo on a Free-plan org via REST returns 422.
