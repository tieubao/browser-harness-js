# figma-com

Figma's team admin console, read through the logged-in tab. Used for seat audits: who holds a
paid seat, which team is on which plan, whether a Figma card charge even comes from this team.

```js
await learnings("figma-com")
await learnings("figma-com", "adminPlan",   { teamId: "1478598445325564894" })
await learnings("figma-com", "adminPeople", { teamId: "1478598445325564894" })
await learnings("figma-com", "teamTree",    { teamId: "1478598445325564894" })  // optional fuid: "<digits>"
```

Routes (the team id is the number in `/files/team/<id>/`):

| Page | Route | Note |
|---|---|---|
| Members | `/files/team/<id>/team-admin-console/members` | direct route works after the console has been opened once in the session |
| Settings (Plan) | `/files/team/<id>/team-admin-console/settings` | `Upgrade your plan` = free Starter; paid teams show plan + seats |
| `/files/team/<id>/admin`, `/admin/billing` | never type these | render "Something went wrong" |

Mechanics the tools encode:

- The sidebar `Admin` entry is `li[class*=goToAdminRow]`, not a link. `el.click()` is ignored;
  `Input.dispatchMouseEvent` at the element centre opens the console.
- The people grid is virtualized. Scroll the grid element (`[role=grid]` / `[role=rowgroup]`,
  else `document.scrollingElement`) to the bottom in steps and merge rows by email.
- Seat vocabulary seen so far: `Admin`, `Limited access` (viewer on a free team), `Full seat`,
  `Dev seat`, `Collab seat`.
- Billing lives per Figma account, not per team: if every team the account can see is free and
  the card still shows Figma, another account bills it; the receipt email names the team.

## Web API

Same-origin `fetch(path, {credentials: "include"})` from a logged-in `www.figma.com` tab works with
no token. Verified live 2026-11-08. `teamTree` is built on the read endpoints.

| Endpoint | Returns |
|---|---|
| `GET /api/user/state` | `meta.teams[]` (id, name) and `meta.drafts_folder_id` for the account the tab is using |
| `GET /api/teams/<teamId>/folders` | `meta.folder_rows[]`: id, name or path, parent_folder_id, trashed_at, team_access, is_invite_only, sharing_audience_control. TOP-LEVEL folders only |
| `GET /api/folders/<id>` | `meta` with path, team_access, is_invite_only |
| `GET /api/folders/<id>/paginated_files?folderId=<id>&sort_column=touched_at&sort_order=desc&fetch_only_trashed_with_folder_files=false&page_size=200&file_type=` | `meta.files[]` (name, key, touched_at, editor_type, link_access, proto_link_access, has_file_link_password, trashed_at) and `meta.roles[]` (user.handle or pending_email for an invite, level) |
| `PUT /api/files/<key>` | WRITE, not a tool. Headers `Content-Type: application/json` and `X-CSRF-Bypass: yes`; body `{"name": ...}` renames, `{"link_access": "view"}` changes link sharing. 200 with `meta` |

Facts that bite:

- No subfolder endpoint: `/api/folders/<id>/subfolders`, `/children`, `/child_folders` all 404.
  Subfolder ids appear only as the folder page's own fetches. Open
  `/files/team/<teamId>/folder/<id>`, wait about 8 s, read
  `performance.getEntriesByType('resource')` URLs matching `/api/folders/(\d+)/paginated_files`,
  drop the folder's own id. Call `performance.clearResourceTimings()` before each navigation.
- The `fuid` query param on a page URL picks which logged-in Figma account the tab uses. `teamTree`
  takes an optional digits-only `fuid` and appends `?fuid=<fuid>` to the page URLs.
- `paginated_files` is read once with `page_size=200`; a folder with more files is cut off.

Role levels: 100 view, 300 edit, 999 owner.

`link_access` on a file:

| Value | Meaning |
|---|---|
| `view` | anyone with the link can view |
| `edit` | anyone with the link can edit |
| `inherit` | folder or team access only |

## Moving work between teams

- A move needs edit access on BOTH sides. An unverified member of an Education team is view-only
  ("Limited access"), so that team cannot receive moves.
- Working route: give the destination-side account a Full seat on the source team, grant it
  "can edit" on each source folder (Share dialog), then use the file context menu "Move file..."
  and search for the destination folder name.
- Only team admins can move whole projects (folders) across teams. Without that, move file by file.

## Cancel a paid team and billing contacts

- Cancel: team admin console, Settings, "Cancel plan", then "Downgrade to Starter", then confirm
  "Cancel plan". The billing page then says the plan will be cancelled at period end.
- Billing emails go to the team admins unless Settings, "Billing contacts" names an extra address.

## Harness tips

- Menu items and dialog buttons in a background tab need `page.getByRole(...).click()` or a click
  by snapshot ref. Raw `Input.dispatchMouseEvent` on them is ignored.
- Context menus open with a dispatched `contextmenu` MouseEvent on the row element, found by its
  `aria-label`.

Provenance: 2026-09-02 Dwarves subscription audit (53 members, team on Starter, two paid Figma
charges traced to accounts outside this team). The same recipe exists as a one-shot script in
`ops-toolkit/experiments/explore-distill-replay/code/figma-admin/` over `sdk/browser-cdp`.

Ported to the Page API (see ../PORTING.md). live: unverified (logged-in).
