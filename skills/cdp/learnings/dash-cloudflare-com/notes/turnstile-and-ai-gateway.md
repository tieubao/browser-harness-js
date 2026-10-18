# Turnstile widgets and AI Gateway: form-driven tools

`addTurnstileWidget`, `addGatewayProviderKey` and `createGatewayToken` (all in `tools/forms.mjs`)
drive the dashboard forms. In-page POST/PUT to `/api/v4` returned 403 for these three flows, so
`api()` cannot do them. Reads (GET) through `api()` still work and are how the tools verify.

```js
await learnings("dash-cloudflare-com", "addTurnstileWidget", { accountId, name: "site", hostnames: ["app.example.com"] })
await learnings("dash-cloudflare-com", "addGatewayProviderKey", { accountId, gateway: "my-gw", provider: "OpenAI", alias: "main", secretEnv: "GW_PROVIDER_KEY" })
await learnings("dash-cloudflare-com", "createGatewayToken", { accountId, gateway: "my-gw", name: "gw-run" })
```

## Input rules that matter

- **Text fields:** `focus()` then `Input.insertText`. Setting `.value` does not reach React state.
- **Hostname option and buttons:** `el.click()` and Enter do not add the Turnstile custom hostname.
  Send a real `Input.dispatchMouseEvent` (moved, pressed, released) at the bounding-box centre.
  The form text "You have configured N out of 10" must increment; the tool checks it.
- **Each call opens and closes its own foreground tab.** Real mouse input on a background tab is unreliable.

## Turnstile

- List page `/<accountId>/turnstile` has "Add widget manually", which lands on `/turnstile/add`.
- The hostname suggestion reads: Add "host" as a custom hostname. It is a `[role=option]`.
- Mode stays Managed unless the caller asks. The tool returns the public site key from the widget
  list only. Read the secret with an API token that has Turnstile Read.

## AI Gateway provider keys

- Page: `/<accountId>/ai/ai-gateway/gateways/<gateway>/integrations`, Provider Keys tab.
- First key for a provider: the row's "Add". Later keys: the row's "Actions for <Provider>" menu,
  then "Add another key".
- The dialog may say the key was saved but could not be verified right now. The tool clicks
  "Close anyway" and reports `verifiedByProvider: false`.
- The first key auto-creates and binds a Secrets Store.
- The key comes from an env var NAME (`secretEnv`) read inside the REPL daemon. The daemon is
  long-lived and does not see variables exported later in a shell. Set it from a captured shell
  variable in the daemon first: `process.env.GW_PROVIDER_KEY = <captured value>`. The tool returns
  `{stop: "secret-env-missing"}` when it is unset, and never echoes the value.
- Verification is a GET of `provider_configs`, which returns aliases. The tool maps provider and alias only.

## AI Gateway token

- Page: `.../gateways/<gateway>/settings`, "Create authentication token". It opens a side panel,
  not a `role=dialog`, presetting Account / AI Gateway / Run on the account.
- After "Create API Token" the one-time value shows in the "API Token Created" section. The tool
  returns `{name, value}` and then clicks "Finish". Treat the value like `mintToken` output.

## Status

Written from a hand-driven CDP session on a real account. The selectors and text matches are
those the session observed; a dashboard redesign breaks them first. `not found: <label>` in an
`{error}` names the element that moved.
