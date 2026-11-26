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
composeDraft + saveDraftNow (no recipient) -> no draft saved while the compose tab was hidden
  again, plus focus emulation and one kept body space -> saved (1 row in in:drafts)
openDraft({ subject: "harness openDraft test 2026-11-26T08:42:59" })   # its tab closed first
  -> { targetId: <id>, subject: "harness openDraft test 2026-11-26T08:42:59", recipients: [], attachments: [], from: <account> }
#drafts probe: that row has data-standalone-draft-id (28 chars) and data-legacy-standalone-draft-id (16 chars)
  the 3 older thread rows have neither
```

Not run live: `openDraft` with a reused `targetId`, and the follow-up edit verbs on the opened draft. The throwaway draft was left in Drafts, unsent. No other draft was touched.
