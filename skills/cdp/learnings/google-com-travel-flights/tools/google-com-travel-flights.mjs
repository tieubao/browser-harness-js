// learnings/google-com-travel-flights/tools/google-com-travel-flights.mjs
// One-way Google Flights search in a throwaway background tab. The natural-language `q=` URL
// ("Flights from KIX to PVG on 2026-12-20 one way economy") renders the result list without
// touching the form. Rows are read from text nodes (TreeWalker), not innerText: a background
// tab returns empty innerText for rows after the first few.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// Every result <li> as an array of its visible lines. Result rows carry "CO2e" (emissions) or
// "Price unavailable"; section <li>s and menus do not. innerText gives clean lines; when a
// background tab returns it empty, fall back to the li's text nodes (noisier, a11y strings mixed in).
const READ_ROWS = `(() => {
  const out = [];
  for (const li of document.querySelectorAll("li")) {
    if (!/CO2e|Price unavailable/.test(li.textContent)) continue;
    let lines = li.innerText.split("\\n").map((x) => x.replace(/\\s+/g, " ").trim()).filter(Boolean);
    if (!lines.length) {
      lines = [];
      const w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode.nodeValue.replace(/\\s+/g, " ").trim(); if (t) lines.push(t); }
    }
    out.push(lines);
  }
  return out;
})()`;

// "View more flights" is a plain <li><div><span>, not a <button>. Click the div inside the li.
const CLICK_MORE = `(() => {
  const li = [...document.querySelectorAll("li")].find((x) => (x.textContent || "").trim() === "View more flights");
  if (!li) return 0;
  (li.querySelector("div") || li).click();
  return 1;
})()`;

const DUR_RE = /^(\d+ hr)?\s?(\d+ min)?$/;
const toMin = (d) => (/(\d+) hr/.exec(d)?.[1] ?? 0) * 60 + +(/(\d+) min/.exec(d)?.[1] ?? 0);

// Compact row layout: dep | - | arr(+N) | airline | duration | FROM-TO | Nonstop|N stop(s) | [layover] | CO2e ... | price
function parseRow(lines) {
  const iRoute = lines.findIndex((p) => /^[A-Z]{3}\s?[\u2013-]\s?[A-Z]{3}$/.test(p));
  if (iRoute < 5) return null;
  const dur = lines[iRoute - 1];
  if (!dur || !/\d/.test(dur) || !DUR_RE.test(dur)) return null;
  const iArr = lines.findIndex((p, i) => i > 0 && /^\d{1,2}:\d{2}\s?(AM|PM)?(\+\d)?$/i.test(p));
  const arriveRaw = lines[iArr] || "";
  const plus = /\+(\d)$/.exec(arriveRaw);
  const stopsText = lines[iRoute + 1] || "";
  const stops = /^Nonstop$/i.test(stopsText) ? 0 : /^(\d+) stops?$/i.exec(stopsText) ? +/^(\d+)/.exec(stopsText)[1] : null;
  const layover = stops ? (lines[iRoute + 2] && !/CO2e/.test(lines[iRoute + 2]) ? lines[iRoute + 2] : "") : "";
  const priceText = [...lines].reverse().find((p) => /^\$[\d,]+$|^[\u20ac\u00a3\u00a5\u20ab]\s?[\d,.]+$|^[A-Z]{3}\s?[\d,]+$|^Price unavailable$/.test(p)) || null;
  return {
    depart: lines[0],
    arrive: arriveRaw.replace(/\+\d$/, ""),
    plusDays: plus ? +plus[1] : 0,
    airline: lines.slice(iArr + 1, iRoute - 1).join(" "),
    durationMin: toMin(dur),
    duration: dur,
    route: lines[iRoute].replace(/\s/g, "").replace("\u2013", "-"),
    stops,
    layover,
    price: priceText && /\d/.test(priceText) ? +priceText.replace(/[^\d]/g, "") : null,
    priceText,
  };
}

export async function searchOneWay(ctx, { from, to, date, nonstopOnly = false, currency = "USD", lang = "en", expand = true, timeoutMs = 40000 } = {}) {
  if (!from || !to || !date) throw new Error("searchOneWay: from, to, date are all required");
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new Error("searchOneWay: from/to must be IATA airport or city codes (e.g. NRT, TYO, PVG); city names fail in q=");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("searchOneWay: date must be YYYY-MM-DD");
  const q = encodeURIComponent(`Flights from ${from} to ${to} on ${date} one way economy`);
  const url = `https://www.google.com/travel/flights?q=${q}&hl=${lang}&curr=${currency}`;
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    await ctx.session.use(targetId);
    await ctx.session.Page.enable();
    await ctx.session.Page.navigate({ url });

    const readCount = async () => (await evaluate(ctx, READ_ROWS)).length;
    // Poll until the row count is > 0 and unchanged for two consecutive polls.
    const settle = async (minCount, budgetMs) => {
      const deadline = Date.now() + budgetMs;
      let last = -1, stable = 0, n = 0;
      while (Date.now() < deadline) {
        await wait(1000);
        n = await readCount();
        if (n > minCount && n === last) { if (++stable >= 2) return n; } else stable = 0;
        last = n;
      }
      return n;
    };

    const first = await settle(0, timeoutMs);
    if (!first) return { stop: "no-results", hint: "no result rows rendered; check the codes (SHA is Hongqiao only; use PVG or a city code) and the date", url };
    let expanded = false;
    if (expand && (await evaluate(ctx, CLICK_MORE))) {
      expanded = true;
      await settle(first, 15000);
    }

    const raw = await evaluate(ctx, READ_ROWS);
    const seen = new Set();
    let rows = [];
    for (const lines of raw) {
      const row = parseRow(lines);
      if (!row) continue;
      const key = [row.depart, row.arrive, row.plusDays, row.airline, row.route, row.stops, row.price].join("|");
      if (seen.has(key)) continue; // each li shows up twice (compact + expanded)
      seen.add(key);
      rows.push(row);
    }
    if (nonstopOnly) rows = rows.filter((r) => r.stops === 0);
    return { url, expanded, count: rows.length, rows };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
