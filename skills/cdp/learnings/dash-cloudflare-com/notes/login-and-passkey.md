# Logging in to the Dwarves Cloudflare account

## Which identity

The Dwarves Cloudflare account (id starts `74a0fbc7`) is reached through the personal Gmail
identity, not the company-domain Google identity. Signing in with the company identity lands on
a different account list that does not include it.

## Google passkey sheet blocks page JS

Google's passkey prompt is a native sheet. While it is up, page JavaScript and CDP input stall.
Workaround, in order:

1. On the page target, send `WebAuthn.enable {enableUI: false}` so the browser stops drawing the sheet.
2. Reload the page.
3. Choose "More ways to verify".
4. Choose "Tap Yes on your phone".

That switches Google to a phone prompt. The two-digit number to match appears on the page only
after a reload with the tab activated (`Target.activateTarget`); a background tab shows no number.

## Then Cloudflare's own TOTP

After Google accepts, Cloudflare asks for its own TOTP code. That step is separate from Google
and is not skipped by the phone prompt. Whoever holds the authenticator enters it; these tools
do not script it, and `whoami` / `api` return `{stop: "sudo"}` rather than trying.
