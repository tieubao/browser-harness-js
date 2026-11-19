# browser-cdp click-el: proof

`browser-cdp click-el <targetId> <js|->` scrolls the element a JS expression returns into view, waits 400 ms, re-reads its bounding-rect centre, then sends a real Input.dispatchMouseEvent click. It prints `clicked <x> <y>`, or `none` with exit 1 when the expression returns null.

## Unit tests (fake CDP endpoint)

```bash skills/cdp/sdk
cd skills/cdp/sdk && node --test browser-cdp-click-el.test.ts browser-cdp-eval-stdin.test.ts browser-cdp-shot.test.ts
```

Result: 17 tests, 17 pass, 0 fail. The new file covers: scroll, then re-read, then mouseMoved/Pressed/Released at the re-read point; `-` reads the expression from stdin; null returns `none`, exit 1 and sends no mouse event; a missing expression prints usage; the unknown-command usage line lists `click-el`.

## Live run on a throwaway about:blank tab (Helium, port 9222)

A button is inserted 2000 px down the page, offscreen, and counts only `isTrusted` click events.

```
$ browser-cdp click-el $T 'document.querySelector("#nope")'
none
exit=1
$ printf '%s' 'document.querySelector("#b") // comment' | browser-cdp click-el $T -
clicked 140 416
exit=0
$ browser-cdp click-el $T 'document.querySelector("#b")'
clicked 140 416
$ browser-cdp eval $T 'window.n'
2
$ browser-cdp eval $T 'window.scrollY > 0'
true
$ browser-cdp close $T
Target is closing
```

Counter 2 after two clicks, and the page scrolled, so the offscreen element was brought into view before the real click. Only the tab opened for this run was closed.
