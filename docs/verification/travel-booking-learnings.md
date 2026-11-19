# Verification: travel booking learnings

Three notes-only learnings added: `flyscoot-com`, `vietnamairlines-com`, `eservices-ica-gov-sg`. No tools, so the check is the registry load check plus the offline suite. The learnings README has no index file to update. No live browser was driven; the notes record facts from an earlier session.

Command:

```bash skills/cdp/sdk/package.json
cd skills/cdp/sdk && npm run check
```

Result (exit 0):

```
# tests 230
# pass 212
# fail 0
# tests 48
# pass 48
# fail 0
OK eservices-ica-gov-sg
OK flyscoot-com
OK vietnamairlines-com
(plus OK for every other learning folder)
```

Dash scan of the new files (no em or en dashes): `grep -rnP '\x{2014}|\x{2013}'` returned no match.
