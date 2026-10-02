# app.notion.com developer portal (internal connections)

Portal: `https://app.notion.com/developers/connections?spaceId=<uuid>` (the old `www.notion.so/profile/integrations` redirects here). It acts on the current workspace.

## Gotchas

- **Own session.** app.notion.com needs its own login; a www.notion.so session does not carry. Signed out, the page renders cached with "You don't have permission to create connections in this workspace" and `/api/v3` returns UnauthorizedError. Every tool throws "not signed in to app.notion.com" instead of clicking.
- **List.** Rows are `<tr>` with no links. Click the `<tr>` whose innerText lines include the exact name; the URL becomes `/developers/connections/<uuid>`.
- **Create.** "New connection" opens `[role=dialog]`: name text input, radios `input[value=integrationToken]` (API token) / `oauth`, button "Create connection". Native value setter + `input` event fills the name.
- **Capabilities** (Configuration tab). Each is `<button aria-pressed>` wrapping a leaf div with the label: Read content, Update content, Insert content, Read comments, Insert comments, View sessions and interact with agents. User info is three plain buttons (No user information / ...without email addresses / ...including email addresses); the selected one has a nested `span>span` dot.
- **Content access** (`[role=tab]`) -> "Edit access" -> dialog "Manage page access". The native setter does NOT trigger the search. Use CDP: `Emulation.setFocusEmulationEnabled`, focus + select the input, `Input.dispatchKeyEvent` Backspace, `Input.insertText`. Results are `[role=menu] [role=menuitem]`; match on `textContent` (SVG children have no innerText), e.g. `🏢ClientsDatabases/US Operating`. A picked item reads "Already added". `el.click()` on the menuitem works. Escape, then the dialog's "Save". The page then shows "Teamspaces (N pages)".
- **Token.** Configuration shows it masked. Button `aria-label="Show or hide API token"` reveals it (`ntn_[A-Za-z0-9]{30,}`); click again to re-hide. `createConnection` never reveals it. `revealToken` returns the raw string: capture it into a variable, never print it.
- **Rename.** Display information "Edit" turns the name into the ONLY `input[type=text]` on the page. Set it, click "Save". Internal connections have no description field (name + icon only).

## Autosave vs Save

| Change | Persists how |
|---|---|
| Capabilities, user info | Autosave on click. No Save button. Verify by reload. |
| Page access | Explicit "Save" in the dialog. |
| Rename | Explicit "Save" next to the input. |

## Verify through the public API

`GET https://api.notion.com/v1/users/me` with the token and `Notion-Version: 2022-06-28` returns the connection name as `.name` and `.bot.workspace_name`. Use it to confirm a rename or a new token.

## Tools

`listConnections`, `openConnection({name})`, `createConnection({name})`, `setCapabilities({read,update,insert,readComments,insertComments,sessions,userInfo})`, `sharePages({queries,exact})`, `renameConnection({newName})`, `revealToken()`. The mutating tools act on the connection currently open: call `openConnection` first.
