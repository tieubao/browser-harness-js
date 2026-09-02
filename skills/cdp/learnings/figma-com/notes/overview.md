# figma-com

Figma's team admin console, read through the logged-in tab. Used for seat audits: who holds a
paid seat, which team is on which plan, whether a Figma card charge even comes from this team.

```js
await learnings("figma-com")
await learnings("figma-com", "adminPlan",   { teamId: "1478598445325564894" })
await learnings("figma-com", "adminPeople", { teamId: "1478598445325564894" })
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

Provenance: 2026-09-02 Dwarves subscription audit (53 members, team on Starter, two paid Figma
charges traced to accounts outside this team). The same recipe exists as a one-shot script in
`ops-toolkit/experiments/explore-distill-replay/code/figma-admin/` over `sdk/browser-cdp`.
