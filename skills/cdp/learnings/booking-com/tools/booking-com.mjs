// learnings/booking-com/tools/booking-com.mjs
// Hotel search on Booking.com in a throwaway background tab. Works logged out. The filter and
// order live in the URL (nflt, order), so there is no form to drive. Cards are read with
// textContent, which stays populated in a background tab.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

const READ_CARDS = (limit) => `JSON.stringify([...document.querySelectorAll("[data-testid=property-card]")].slice(0, ${limit}).map((c) => ({
  name: ((c.querySelector("[data-testid=title]") || {}).textContent || "").trim(),
  priceText: ((c.querySelector("[data-testid=price-and-discounted-price]") || {}).textContent || "").replace(/\\s+/g, " ").trim(),
  review: ((c.querySelector("[data-testid=review-score]") || {}).textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40),
})))`;

const median = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// A discounted card shows "US$600 US$534": the live price is the last number.
const lastAmount = (text) => {
  const m = text.match(/\d[\d,]*/g);
  return m ? +m[m.length - 1].replace(/,/g, "") : null;
};

export async function searchHotels(ctx, { city, checkin, checkout, adults = 2, children = [], rooms = 1, minStars = [3, 4], minReview = 8, currency = "USD", limit = 20, timeoutMs = 40000 } = {}) {
  if (!city || !checkin || !checkout) throw new Error("searchHotels: city, checkin, checkout are all required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) throw new Error("searchHotels: dates must be YYYY-MM-DD");
  const nflt = [...minStars.map((s) => `class=${s}`), ...(minReview ? [`review_score=${Math.round(minReview * 10)}`] : [])].join(";");
  const params = [
    `ss=${encodeURIComponent(city)}`,
    `checkin=${checkin}`,
    `checkout=${checkout}`,
    `group_adults=${adults}`,
    `group_children=${children.length}`,
    ...children.map((age) => `age=${age}`),
    `no_rooms=${rooms}`,
    `selected_currency=${currency}`,
    `lang=en-us`,
    ...(nflt ? [`nflt=${encodeURIComponent(nflt)}`] : []),
    `order=popularity`,
  ];
  const url = `https://www.booking.com/searchresults.html?${params.join("&")}`;
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    await ctx.session.use(targetId);
    await ctx.session.Page.enable();
    await ctx.session.Page.navigate({ url });

    // Poll until cards exist and the count has been unchanged for two polls (lazy load adds more).
    const deadline = Date.now() + timeoutMs;
    let last = -1, stable = 0;
    while (Date.now() < deadline) {
      await wait(1000);
      const n = await evaluate(ctx, `document.querySelectorAll("[data-testid=property-card]").length`);
      if (n > 0 && n === last) { if (++stable >= 2) break; } else stable = 0;
      last = n;
    }
    if (!(last > 0)) return { stop: "no-results", hint: "no property-card rendered; check city spelling, dates, or a bot-check page", url };

    const raw = JSON.parse(await evaluate(ctx, READ_CARDS(limit)));
    const hotels = raw.map((c) => ({
      name: c.name,
      priceTotal: lastAmount(c.priceText),
      priceText: c.priceText,
      score: +(/Scored ([\d.]+)/.exec(c.review)?.[1] ?? NaN) || null,
      reviews: +(/([\d,]+) reviews?/.exec(c.review)?.[1] ?? "").replace(/,/g, "") || null,
    }));
    const priced = hotels.filter((h) => h.priceTotal != null);
    const summary = {
      count: hotels.length,
      median: median(priced.map((h) => h.priceTotal)),
      cheapest: [...priced].sort((a, b) => a.priceTotal - b.priceTotal).slice(0, 3).map((h) => ({ name: h.name, priceTotal: h.priceTotal })),
    };
    return { url, hotels, summary };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}
