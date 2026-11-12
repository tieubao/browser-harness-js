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

## Fine-grained PAT: add a repo to its access (no API, token page only)

GitHub has no REST or GraphQL call to change a fine-grained PAT's repository access. The token page `https://github.com/settings/personal-access-tokens/<id>` is the editor (`/<id>/edit` is a 404). Token ids are the numeric suffix of the links on `/settings/personal-access-tokens`.

```js
const a = await learnings("github-com", "openFgPat", { tokenId: "123456" })
// a = {status:"sudo", targetId, digits:"42"}  -> approve on the phone, then poll the same tab:
const b = await learnings("github-com", "openFgPat", { tokenId: "123456", targetId: a.targetId, waitMs: 120000 })
// b = {status:"ready", targetId}
const r = await learnings("github-com", "addFgPatRepo", { targetId: a.targetId, org: "dwarvesf", repoId: "987654321", expectCount: 4 })
// r = {done:true, before:4, after:5}
```

Recipe this encodes:

- **Sudo first.** The page opens on "Confirm access". The verb clicks the visible "Use GitHub Mobile" button, reads the two digits off the page, and returns them. The caller approves on the phone. Then `openFgPat` with the `targetId` polls `document.title` until it leaves "Confirm access" (a few minutes; the request then expires, and `resend: true` reloads for a fresh one). Never type a password.
- **The repo-access form hides behind the SECOND button whose text is exactly "Edit".** It reveals `form[action*="/grant-requests/organizations/<org>"]` with `install_target=selected` checked and one hidden `input[name="repository_ids[]"]` per repo.
- **Add = clone the last `repository_ids[]` input**, set its value to the new repo id, insert it beside the others, click the form's "Update" button.
- **Click Edit, append and Update in ONE evaluation.** A separate evaluation found the form closed again and the update silently never saved. The Update click fires from `setTimeout` so the result returns before the page navigates.
- **Guards, all checked before any change:** `install_target=selected` is checked, the id is not already present, the current count equals the caller's `expectCount`. Any miss returns `{done:false, reason}` with the form untouched.
- **Verify outside the browser, with the token itself.** The verb cannot: it returns only `{before, after}` input counts. Check `GET repos/<o>/<r>/actions/runs` flips 404 to 200 and an old repo stays 200.
- Both verbs leave the tab open (the sudo wait needs it). Close it with `ctx.session.Target.closeTarget` when done.
- Selectors are label-text based (`Edit`, `Update`, `Use GitHub Mobile`); the digits reader takes a two-digit leaf element, else the first two-digit number after "GitHub Mobile". If GitHub changes the sudo copy, `digits` comes back `null` and the caller reads the tab.

Not run live yet as tools; the first real use is their proof. The recipe itself was proven by hand on a real token (404 to 200 on the added repo).

Ported to the Page API (see ../PORTING.md). live: unverified (logged-in).
