# x.com (Twitter)

Recipes for driving a logged-in X session.

## Posting (`createPost` node-tool)

The whole flow: `x.com/compose/post` in a foreground tab -> click into
`[data-testid=tweetTextarea_0]` -> `Input.insertText` for the full body ->
`DOM.setFileInputFiles` on the hidden `input[type=file]` -> click the enabled
`[data-testid=tweetButton]` -> land on `/home`.

Learned by hand-driving a real post:

- **Two Post buttons exist at once.** The timeline's `tweetButtonInline` and
  the dialog's `tweetButton`. While a compose dialog is open, the inline one
  stays `aria-disabled=true`; clicking it does nothing. Filter on a non-zero
  rect AND `aria-disabled !== 'true'` before clicking.
- **insertText lands the whole body atomically**, newlines included; plain
  Enter does not submit (Ctrl+Enter does). `@handle` linkifies on publish --
  no autocomplete dance needed.
- **Two hidden `input[type=file]` elements** exist on the page; index 0 is the
  composer one. `setFileInputFiles` works while it is `display:none`.
- **One gif OR up to 4 images** per post; they cannot be mixed. A gif uploads
  and previews as a video element; ~8s is enough for a small file to process.
- **After posting, the tab navigates to `/home`.** The status URL is
  reachable only through the toast (`[data-testid=toast] a[href*=/status/]`),
  which disappears fast. `createPost` returns `{posted: true, url: null}`
  when the toast is missed; the post is still live -- find it on the profile.
- **Log-in check:** a logged-out session redirects the composer URL away and
  `tweetTextarea_0` never appears. `createPost` refuses with
  `{posted: false, reason: "no composer"}` instead of typing into a login form.
- The free-tier character cap is 280; the composer refuses to enable Post past
  it, so an over-limit post surfaces as "no enabled Post button".
