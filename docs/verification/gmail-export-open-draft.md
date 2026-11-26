# Verification: mail-google-com exportThread and openDraft

Live run on the signed-in Helium (port 9222, explicit `wsUrl`) through a private daemon started from the branch.

```
window.GM_ID_KEY on #inbox (type, length only) -> string, 10  (so the ik URL is used, not the ui=2 fallback)
exportThread({ query: 'subject:"ZEF Live 2"', outDir })   # a newsletter
  messages 1, chars 1328, textPath + pdfPath written
pdfinfo                -> Pages: 2, 468695 bytes
pdftotext | wc -w      -> 200 (txt file: 207)
exportThread({ threadId, outDir, pdf: false })
  pdfPath null, file name got the -<threadId> suffix, chars 1328
openDraft({ subject: <no such draft> })   -> { stop: "no-draft-row" }
#drafts row probe (counts only)           -> 3 visible rows with span.bog, 1 with a "Draft" leaf
```

Not run live: `openDraft` opening a draft and reading it back. The drafts present were replies on private threads, so none was opened. No draft was created, edited or sent.
