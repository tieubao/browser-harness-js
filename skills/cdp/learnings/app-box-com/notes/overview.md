# app-box-com

Box's web app (`app.box.com`), read through the logged-in Helium session. One read-only tool.

```js
await learnings("app-box-com")
await learnings("app-box-com", "listFolder", { folderId: "304089843847", depth: 2 })
// -> { path: "Files / <folder>", items: [{ name, id, kind, updated, size, children? }] }
```

The folder id is the last segment of `https://app.box.com/folder/<id>`; `0` is the root.

## Limits

- Runs in a background tab (`Target.createTarget({background:true})`), closed in `finally`.
- Each folder needs about 8 s for the SPA to render; depth 2 over N subfolders costs about 8 s x (N + 1). Depth is capped at 4.
- A shared folder shows only what the logged-in user can access. No access or signed out: the call throws after 25 s.
- Search is not implemented: `/search?query=` did not work from a background tab.
- `size` and `updated` are the row text, best effort. A folder's size is its item count ("6 Files"). `updated` drops the "by <user>" part.
- The list is virtualized; the tool scrolls the list container and merges rows, but a very large folder (hundreds of rows) is untested.

## DOM mechanics the tool encodes

- Rows: `[role=row]` containing `a[data-resin-target="openfolder"|"openfile"]`; folder id is the last path segment of `/folder/<id>`, file id of `/file/<id>`. Each row repeats the anchor, so dedupe by href.
- The breadcrumb (`nav[aria-label=Breadcrumb]`, `.ItemListBreadcrumb-link`) matches the same data attribute and links to `/folder/0` and every ancestor. Only anchors inside a row count; the folder itself and ancestor ids are dropped. The current folder name is `h1.page-title`.
- A row's text leaves are `[name, "Feb 6, 2025 by Han Ngo", "776.2 KB"]`. `textContent` glues them ("Han Ngo6 Files"), so read the leaves.
- Moving between folders in the same tab is `location.href = '/folder/<id>'` (full load), then wait for the new `h1.page-title` and rows.
