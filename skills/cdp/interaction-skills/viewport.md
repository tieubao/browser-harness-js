# Viewport

Coordinate clicks depend on viewport size; layouts depend on viewport size; a lot of flaky automation traces to a viewport that silently changed.

## Read the current viewport

```js
const { result } = await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    JSON.stringify({
      w: innerWidth, h: innerHeight,
      sx: scrollX, sy: scrollY,
      pw: document.documentElement.scrollWidth,
      ph: document.documentElement.scrollHeight,
      dpr: devicePixelRatio,
    })
  `,
})
const vp = JSON.parse(result.value)
```

`innerWidth`/`innerHeight` is the **CSS-pixel** viewport — what coordinate clicks use. `devicePixelRatio` multiplies for actual screen pixels (`captureScreenshot` output dimensions).

## Force a specific size (CSS pixels)

```js
await session.Emulation.setDeviceMetricsOverride({
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,   // 0 = use real DPR; set to 2 for retina-like
  mobile: false,
})
```

All subsequent `Input.dispatchMouseEvent` coordinates are in this 1280×800 space — pin it at the start of a session so coordinates stay stable.

Clear it back to the actual window size:

```js
await session.Emulation.clearDeviceMetricsOverride()
```

## Mobile emulation

```js
await session.Emulation.setDeviceMetricsOverride({
  width: 390, height: 844,
  deviceScaleFactor: 3,
  mobile: true,
})
await session.Emulation.setTouchEmulationEnabled({ enabled: true })
await session.Network.setUserAgentOverride({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
```

Mobile triggers responsive breakpoints and enables touch events. Sites with `@media (hover: hover)` also flip their hover affordances off.

## `w=0 h=0` is a target problem, not a viewport problem

If `Runtime.evaluate('innerWidth')` returns 0, you're attached to a non-window surface (omnibox popup, a DevTools target). See `connection.md` / `tabs.md` — use `listPageTargets()` and re-route with `session.use(...)`.

## Layout sweep: measure one element across widths

A layout bug that "looks wrong on smaller screens" is a number that varies with viewport width. Loop the width, read the number out of the DOM at every stop, and let the table say where the bug lives before you touch CSS. The same loop re-run after the fix is the proof.

```js
globalThis.rows = []
for (const w of [390, 600, 768, 900, 1024, 1100, 1200, 1280, 1366, 1440, 1548, 1600, 1920]) {
  await session.Emulation.setDeviceMetricsOverride({ width: w, height: 900, deviceScaleFactor: 1, mobile: w < 768 })
  await session.Page.navigate({ url: 'http://localhost:3000/some/page' })
  await new Promise(r => setTimeout(r, 2500))   // or a real readiness signal, see lifecycle-readiness.md
  const { result } = await session.Runtime.evaluate({
    returnByValue: true,
    expression: `(() => {
      const h = document.querySelector('h1')
      const rg = document.createRange(); rg.selectNodeContents(h)
      const lines = [...rg.getClientRects()]               // one rect per rendered line
      const box = h.getBoundingClientRect(), cs = getComputedStyle(h)
      const ctl = document.querySelector('article p').getBoundingClientRect()  // a control element
      const textRight = Math.max(...lines.map(r => r.right))
      return JSON.stringify({
        w: innerWidth, col: Math.round(box.width),
        boxRight: Math.round(box.right), ctlRight: Math.round(ctl.right),
        gap: Math.round(box.right - textRight),
        lines: Math.round(box.height / parseFloat(cs.lineHeight)),
        fs: cs.fontSize, tw: cs.textWrapStyle || cs.textWrap,
      })
    })()`,
  })
  globalThis.rows.push(result.value)
}
```

Then, as a separate one-line call: `globalThis.rows.join("\n")`.

Why each piece is there:

- `setDeviceMetricsOverride` **before** `Page.navigate` (the `matchMedia` trap below), one navigate per stop.
- `Range.getClientRects()` gives one rectangle per rendered line, so `max(right)` is the true text edge; `getBoundingClientRect()` alone is the box the CSS gave it, which hides a ragged right edge.
- A **control column** (here the paragraph's right edge) rules out a whole class of cause in the same row: if `boxRight === ctlRight` at every width, it is not padding.
- Rows go into `globalThis` and print once: the REPL prints a single bare expression; a multi-statement snippet runs silently and looks like a hang.
- Read the table for the **constant** before forming a theory (a column width that does not change across a band of viewports is the usual one), then sweep the suspect variable with the same probe:

```js
for (const px of [40, 38, 36, 34, 32]) {
  // same page, same probe, one change:
  // h.style.setProperty('font-size', px + 'px', 'important')
}
```

Screenshots do not replace the numbers here: a headless capture taken before the web font loads wraps text with the fallback face and can show a "fixed" layout that is not. Numbers read after a settle delay do not have that problem.

## Traps

- **Coordinate clicks become wrong as soon as the viewport changes.** Re-read rects with `getBoundingClientRect()` after any resize, not just after scrolling.
- **`captureScreenshot` returns device pixels, not CSS pixels.** If `devicePixelRatio = 2` and you eyeball an element at (400, 300) in the screenshot, click at (200, 150) in CSS pixels.
- **`setDeviceMetricsOverride` persists across navigations** within the session — remember to clear it at the end if the user is going to keep using the browser.
- **Some sites guard against resize storms** (e.g. `window.addEventListener('resize', debounce)`). After `setDeviceMetricsOverride`, wait ~300ms before reading rects or clicking.
- **Responsive sites that use `matchMedia` at page load** may not re-evaluate breakpoints after override. Apply `setDeviceMetricsOverride` **before** `Page.navigate`, not after.
