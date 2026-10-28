# app-notion-com: readCollection, createPage, recreateRows

`skills/cdp/learnings/app-notion-com/tools/pages.mjs` adds three tools for the Notion internal API from a logged-in tab.

## Green run

Command: `node --test skills/cdp/learnings/app-notion-com/tools/workspace.test.mjs`
Exit: 0
Output:
```
# tests 8
# pass 8
# fail 0
```
Verdict: PASS

Command: `readCollection({pageId: "3306eb49-72f8-4ec2-a6cd-053520e881be"})` in a background Notion tab (the worker's live read, 2026-10-29)
Exit: 0
Output:
```
{"rows":32,"schema":["Due:date","Milestone:relation","Notes:text","Owner:person","Area:select","Source:text","Status:select","Task:title"]}
```
Verdict: PASS (matches the 32 live rows the lead read back the same day)

## Negative control

Command: `createPage({...})` with no `editors`
Exit: 1
Output:
```
throws before any request: a top-level page without editors becomes an uneditable orphan
```
Verdict: PASS

Not run live: `createPage` and a real `recreateRows` write. Their op shapes match the ones that wrote the About Console Labs page and refreshed the Studio Board on 2026-10-29.
