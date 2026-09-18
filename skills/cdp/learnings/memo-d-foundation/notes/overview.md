# Dwarves Memo (memo.d.foundation)

```js
await learnings("memo-d-foundation")
await learnings("memo-d-foundation", "trace_css_rules", { selector: "img", property: "max-width" })
await learnings("memo-d-foundation", "layout_overflow")
```

## Verified facts (2026-09-18)

Post images already cap at 100% via base styles and the typography plugin (`.prose img`).

In reading view `.reading-view .article-content img` uses `var(--reading-media)`, 704px. This is a deliberate breakout past the 675px text column. A 704px image in a 675px parent is expected, and docOverflow stays 0.

The worker sends a markdown 404 to clients that do not ask for HTML. Check the 404 page in a browser, not with curl.

The PR preview worker is https://df-memo-pr-staging.infras.workers.dev.

Share-card tags: og:image points at `/content/<p>.og.png` for SVG-first posts, rendered by the df-memo worker.
