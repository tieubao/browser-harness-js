# discord.com/developers (app and bot setup)

Tools are in `tools/portal.mjs`, one dedicated foreground tab. Steps a script cannot finish return `{needsHuman}` with the tab fronted. Stop and let the human act; never loop. Restart the daemon after editing (`browser-harness-js --restart`).

## Human steps (return needsHuman)

| Step | Signal | After the human acts |
|---|---|---|
| Create app | hCaptcha iframe or "Wait! Are you human?" | Page lands on `/developers/applications/<appId>/information` |
| Reset Token | "Multi-Factor Authentication" dialog (security key) | Call `read_token`; the token appears in page text |
| Authorize invite | MFA dialog again | Page shows the authorized confirmation |

## Gotchas

- App list `/developers/applications`: "New Application" opens `[role=dialog]` with `input[name=name]`, a Team combobox (default Personal), a ToS `input[type=checkbox]`, and "Create".
- Bot page `/applications/<id>/bot`: checkboxes in DOM order: [0] Public Bot, [1] Requires OAuth2 Code Grant, [2] Private Channel Obfuscation, [3] Presence Intent, [4] Server Members Intent, [5] Message Content Intent. Always confirm the label (walk up parents until `innerText` starts with it) before clicking.
- After a toggle a "Save Changes" bar appears and `button.click()` works. Otherwise the page shows "Careful, you have unsaved changes" and "Reset".
- Public Bot OFF fails with "Private application cannot have a default authorization link" until Installation > Install Link is None. On `/applications/<id>/installation` the "Discord Provided Link" dropdown ignores synthetic events: use a real `Input.dispatchMouseEvent` at its rect centre. Then the "None" option is focused: press Enter via `Input.dispatchKeyEvent` (key Enter, `windowsVirtualKeyCode` 13) with `Emulation.setFocusEmulationEnabled` on. Then Save Changes. `set_public_bot` does this.
- Reset Token: button "Reset Token", dialog "Reset Bot's Token?", "Yes, do it!", usually MFA. The token matches `/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/` and shows once. Capture it from the return value; never print or log it.
- Invite `https://discord.com/oauth2/authorize?client_id=<id>&scope=bot&permissions=<n>&guild_id=<gid>&disable_guild_select=true` first shows "Discord App Launched ... Continue to Discord": click it to stay in web.
- The consent page has a disabled "Keep Scrolling..." button. In a BACKGROUND tab scrolling never registers and `Input.dispatchMouseEvent` mouseWheel hangs. Front the tab (`Target.activateTarget` plus app activate), set `scrollTop` on scrollable divs, click "Continue", then "Authorize" (real CDP mouse click), then usually MFA.

## Verify with the bot token, not the page

- `GET https://discord.com/api/v10/applications/@me` with `Authorization: Bot <token>`: `bot_public`, `install_params`, `flags`.
- Flags: GATEWAY_GUILD_MEMBERS `1<<14` (limited `1<<15`), MESSAGE_CONTENT `1<<18` (limited `1<<19`).
- `GET /users/@me/guilds` lists joined guilds.

## Status of the tools

`get_bot_settings` was run live. The mutating tools were written from recipes proven by hand in a live session but have not been run end to end as tools.
