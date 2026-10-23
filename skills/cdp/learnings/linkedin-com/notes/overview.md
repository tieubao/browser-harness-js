# linkedin.com (post composer)

Recipes for posting to LinkedIn through a logged-in session, as the member or as a company page they administer. Hand-proven on the running Helium; the node-tool `createPost` encodes them.

## Posting (`createPost` node-tool)

`await learnings("linkedin-com", "createPost", {actor: "self" | "<company admin page url>", text, media?: [abs png/jpg paths]})` returns `{posted, url}`. The tool opens ONE background tab, closes it on exit, never calls `bringToFront`, never launches a browser. Do not run it as a smoke test: it publishes.

### Company page

- Open `https://www.linkedin.com/company/<numeric id>/admin/page-posts/published/` in a background tab (`Target.createTarget({url, background: true})`, then `session.use(id)`).
- Click the button whose text is "Start a post". A `[role=dialog]` opens with the actor name ("Dwarves Foundation") and a Quill `.ql-editor`.
- Media: click the dialog button `aria-label="Add media"`, then `DOM.setFileInputFiles` on the `input[type=file]` (pierce the document: `DOM.getDocument({depth: -1, pierce: true})`). Optional alt text: "Alternative text" button, a textarea, then "Add". Then "Next" returns to the composer.
- The composer shows `img[alt="Image preview"]` once media is attached. The tool asserts it.
- The tool does not set alt text; the flow above is proven by hand only.

### Personal profile

- Open `https://www.linkedin.com/feed/` with `Emulation.setFocusEmulationEnabled({enabled: true})`. Without it the feed does not load in a background tab.
- "Start a post" lands on `/sharing/compose`. Its editor is a TipTap `.tiptap.ProseMirror` (role textbox). The actor name sits above "Post to Anyone".
- Hidden video-player `[role=dialog]` nodes exist on the feed. Never select a dialog by role alone; the tool picks the company dialog by the `.ql-editor` it contains.
- Media on a personal post is not proven. The tool refuses `actor: "self"` with `media`.

### Text

- Focus the editor, then ONE `Input.insertText` with the whole body, `\n` newlines included. That yields correct paragraphs in both editors (one line = one `<p>`).
- Per-line Enter key events are dropped in a background tab. A synthetic paste event is ignored.

### Pre-post checks

The tool aborts with `{posted: false, reason}` instead of posting when any of these fail:

- logged out (login / authwall page, or `input[name=session_key]`);
- actor name: with `actorName`, the composer must show it; else a company composer must not show the member's own name and a self composer must show it;
- media attached (`img[alt="Image preview"]` on the company composer);
- paragraph count in the editor equals the number of lines in `text`.

### Click Post

A DOM click on the composer's enabled "Post" button (exact text) worked for both editors. After it the composer must close.

### Verify and permalink

- Company: reload the admin published list; the new post is a `[data-urn]` element whose text starts with the body. The tool records the existing urns first and ignores them.
- Personal: open `/in/<publicIdentifier>/recent-activity/all/`. `data-urn` is absent there. Take the first `urn:li:activity:<digits>` in the page HTML after the post text's position.
- publicIdentifier: same-origin `fetch('/voyager/api/me')` with the `csrf-token` header set to the JSESSIONID cookie value (quotes stripped). The tool also reads the member's first and last name from that response for the actor check.
- Return `{url: "https://www.linkedin.com/feed/update/<urn>/"}`.

### Gotchas

- Call `session.use(targetId)` again after every `Page.navigate`; the harness session can re-bind to another target.
- The feed list can lag a few seconds; the tool reloads and retries before giving up with `{posted: true, url: null}`.
- Long bodies may render truncated ("see more") in the list, so the match uses only the first line's first 40 characters.
