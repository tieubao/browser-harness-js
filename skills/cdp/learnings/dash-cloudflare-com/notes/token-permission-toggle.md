# Edit one permission on an existing user API token

`setTokenPermission` (in `tools/forms.mjs`) adds or removes one permission group on a token that
already exists, by driving the dashboard token edit form.

```js
await learnings("dash-cloudflare-com", "setTokenPermission", {
  tokenName: "my-token", permission: "Account Settings, Account, Edit", enabled: true, dryRun: true })
// inspect the summary, then run again without dryRun
await learnings("dash-cloudflare-com", "setTokenPermission", {
  tokenName: "my-token", permission: "Account Settings, Account, Edit", enabled: true })
```

Use it when a minted token is one permission short and `mintToken` is the wrong tool (it makes a new
token with a new value; this keeps the token and its secret). Removing the permission afterwards is
the same call with `enabled: false`.

## Why a form, not the API

From a dash.cloudflare.com tab, GET `/api/v4/user/tokens/...` works with the headers
`x-cross-site-security: dash` and `x-atok: window.bootstrap.atok`. In-page PUT/POST to the same
path returns a 403 HTML challenge page with those headers too, so `api()` cannot edit a token.
The tool uses the GET only to read permission group NAMES before and after, which proves the edit
by a read.

## The recipe (verified by hand on a real token, 2026-11-13)

1. Navigate to `https://dash.cloudflare.com/profile/api-tokens`; assert the token name is in
   `document.body.innerText`.
2. The token's `<tr>` has an "Actions" button. `el.click()` does not open the menu reliably.
   `scrollIntoView({block:"center"})`, `Page.bringToFront()`, then real
   `Input.dispatchMouseEvent` mousePressed and mouseReleased at the bounding-box centre.
3. Menu items are `[role=menuitem]`: View summary / Edit / Roll / Delete. Real-click "Edit". The form
   loads in place; the URL stays `/profile/api-tokens`.
4. Each policy has buttons with aria-label "Edit policy" and "Delete policy". **Policy order is not
   stable between visits** (the account policy was first once, second the next time). Identify the
   policy by its summary text, or open one, look for the checkbox, and "Close editor" if absent.
   The tool does the second, or the first with `policyMatch`.
5. Inside an open policy: input placeholder "Search for permission groups...". Real-click it, then
   `Input.insertText({text: "Account Settings"})`.
6. Permission checkboxes are `span[role=checkbox]` with aria-label like
   "Account Settings, Account, Edit" and `aria-checked`. Real-click toggles; re-read `aria-checked`.
7. Real-click "Continue to summary". The summary page lists every permission: check the change
   there. Then real-click "Update token". The list row shows only a relative time ("0s ago", no "Modified" label), so the tool confirms the save by polling the token's permission groups until they change.
8. Verify out of band with the token itself: a call that needs the permission succeeds after an add
   and returns error 10000 (authentication/permission) after a remove.

## Pitfalls

- **Real mouse only.** `el.click()` fails on the Actions menu; checkboxes and buttons are safer with
  a real press. Same rule as `turnstile-and-ai-gateway.md`.
- **The tool opens its own foreground tab** (like the other form tools) and closes it in `finally`.
  Real input on a background tab is unreliable.
- **Do not hard-code a policy index.** It changes between visits. `policyIndex` in the result is
  informational only.
- **`aria-label` must match exactly.** Copy it from the form (`Group, Scope, Level`). A mismatch
  returns `{error: 'checkbox "..." not found in any policy', policies: [...]}` with each policy's
  summary text, which tells you which labels the form actually uses.
- **Scope lives in the policy.** The checkbox appears only in a policy whose resources allow it, so
  an account permission is found in the account policy, not the zone one. Two account policies that
  both list it: pass `policyMatch`.
- **Already in the requested state** returns `{changed:false}` and saves nothing.
- Permission groups that never change after "Update token" return `{error}` with `before` and `after`:
  read the token again before retrying, the save may have landed late.

## Driving it by hand (when the tool is not enough)

- Multi-line `Runtime.evaluate` snippets passed inline to `browser-harness-js` printed nothing.
  Put the in-page JS in a file and evaluate it (house wrapper `bh-run <file.js> <url-prefix>`),
  returning `JSON.stringify({x, y})` of the target's centre, then send two
  `session.Input.dispatchMouseEvent` calls (mousePressed, mouseReleased).
- `session.connect({wsUrl})` is refused when the harness is already connected through the extension
  relay. Just use the existing session.
- zsh `noclobber` in the Bash tool makes `>` onto an existing file fail: use `>|` or a new name.
- Keep token ids and account ids out of scripts you save; take the token by name.

## Status

Recipe: hand-driven end to end on 2026-11-13 (add, then remove, verified through the token's own API
calls). The packaged tool is composed from that recipe and the existing form helpers; it passed
`node --check`, `check-port.mjs`, and an argument-validation smoke, but has not been run against the
live dashboard. First live use: run with `dryRun: true` and read the summary. A dashboard redesign
breaks the labels first: `not found: <label>` names the one that moved.
