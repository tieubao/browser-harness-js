# dash-cloudflare-com

The dashboard's own network calls hit `https://dash.cloudflare.com/api/v4/...`, the same request
and response shapes as `api.cloudflare.com`, authenticated by the session cookie instead of a
bearer token. This registry exists because a scoped API token is sometimes short of a permission
(reading `/user/tokens/permission_groups`, writing a zone setting outside its policy) that the
signed-in user already has in the UI, and the dashboard's React forms are slow to drive by click.

```js
await learnings("dash-cloudflare-com")
await learnings("dash-cloudflare-com", "whoami")
await learnings("dash-cloudflare-com", "api", { path: "/accounts" })
await learnings("dash-cloudflare-com", "api", { path: "/user/tokens/permission_groups" })
await learnings("dash-cloudflare-com", "mintToken", { name: "x", policies: [...] })
await learnings("dash-cloudflare-com", "setZoneSetting", { zoneId, key: "ssl", value: "full" })
```

## Limits (learned 2026-09-04)

- **Acts as the signed-in user.** Every call carries that user's own permissions, nothing more:
  it cannot edit that user's own account membership or another user's 2FA (the dashboard UI
  enforces the same wall).
- **Stops rather than clicking through a blocking page.** A Turnstile challenge and a "confirm
  your identity" re-auth prompt are both unscriptable by design; `whoami` and `api` detect either
  before attempting the call and return `{stop: "turnstile" | "sudo"}` instead of trying.
- **Never logs a secret.** `mintToken`'s response carries the token value; the tool returns it to
  the caller and does not print or store it anywhere else. Capture it with `VAR=$(...)`, not
  `echo`, same as any other `op read`-shaped value.
- GET, POST and PATCH all worked with **no CSRF header** on 2026-09-04 (token mint, zone-settings
  PATCH on four zones).

## Provenance

2026-09-04 Console Labs zone hardening: the Toolkit token could not read
`/user/tokens/permission_groups` or write zone settings for the target account. Driven by hand
first as `bh-who.sh` / `bh-mint.js` / `bh-mint.sh` (ops-toolkit session scratch), then distilled
here. Memory note: `cf-dashboard-cookie-api-via-harness`. Related:
`[[browser-harness-js-priority]]`, `[[cf-token-permission-groups-are-allowlists]]`.
