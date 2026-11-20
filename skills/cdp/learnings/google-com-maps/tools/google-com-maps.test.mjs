// Offline check of the google-com-maps tools. Pure helpers first (result picking by region, list
// name matching, the toggle guard), then the three tools against a fake ctx that answers the in-page
// snippets by their text. No browser. List names here are generic fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _timing, cleanText, parseCount, parseListEntry, matchList, listSuggestions, matchesRegion, isNoise,
  rankResults, pickResult, cardCategory, chooserAction, savedCount, searchUrl, listItems, createList, saveToList,
} from "./google-com-maps.mjs";

_timing.scale = 0.001;

test("cleanText strips icon glyphs, NBSP and runs of space", () => {
  assert.equal(cleanText(" Saved places \n"), "Saved places");
  assert.equal(cleanText(null), "");
});

test("parseCount reads the header, with thousands separators and singular", () => {
  assert.equal(parseCount("Private · 17 places"), 17);
  assert.equal(parseCount("Private · 1,331 places"), 1331);
  assert.equal(parseCount("Private · 1 place"), 1);
  assert.equal(parseCount("nothing"), null);
});

test("parseListEntry handles a plain row, an icon-prefixed row and a non-row", () => {
  assert.deepEqual(parseListEntry("Trips\nPrivate · 17 places"), { name: "Trips", visibility: "private", count: 17 });
  assert.deepEqual(parseListEntry("\n\nWant to go\nPrivate · 1,331 places"), { name: "Want to go", visibility: "private", count: 1331 });
  assert.deepEqual(parseListEntry("Team\nShared · 158 places"), { name: "Team", visibility: "shared", count: 158 });
  assert.equal(parseListEntry("Recents"), null);
  assert.equal(parseListEntry("Private · 3 places"), null);
});

test("matchList is exact on the folded name and never fuzzy", () => {
  const lists = [{ name: "Trips 2026" }, { name: "Trips" }, { name: "Food" }];
  assert.equal(matchList(lists, "trips").index, 1);
  assert.equal(matchList(lists, "  TRIPS ").entry.name, "Trips");
  assert.equal(matchList(lists, "Trip"), null);
  assert.equal(matchList(lists, ""), null);
  assert.deepEqual(listSuggestions(lists, "Trip"), ["Trips 2026", "Trips"]);
  assert.deepEqual(listSuggestions(lists, "Trips 2026 plan"), ["Trips 2026", "Trips"]);
});

test("matchesRegion: all comma parts required, | means either, case and accents ignored", () => {
  const text = "Huangjuepingzheng Street, Jiulongpo District, Chongqing, China";
  assert.equal(matchesRegion(text, "Jiulongpo, Chongqing"), true);
  assert.equal(matchesRegion(text, "jiulongpo,CHONGQING"), true);
  assert.equal(matchesRegion(text, "Jiulongpo, Beijing"), false);
  assert.equal(matchesRegion("Dongcheng, Beijing, China", "Beijing|北京"), true);
  assert.equal(matchesRegion("北京市", "Beijing|北京"), true);
  assert.equal(matchesRegion("anything", null), true);
  assert.equal(matchesRegion("anything", ["Paris"]), false);
});

test("isNoise drops ticket offices and hotels unless the query asks for them", () => {
  assert.equal(isNoise("Mutianyu Great Wall Scenic Area Ticket Office", "Mutianyu"), true);
  assert.equal(isNoise("Mutianyu Great Wall Scenic Area Ticket Office", "Mutianyu ticket office"), false);
  assert.equal(isNoise("Holiday Inn Temple Of Heaven", "Temple of Heaven"), true);
  assert.equal(isNoise("Temple of Heaven", "Temple of Heaven"), false);
  assert.equal(isNoise("慕田峪长城景区售票处", "慕田峪长城"), true);
});

test("pickResult: exact name beats a longer name, noise is skipped", () => {
  const cards = [
    { name: "Yu Garden Tea", text: "Tea house · Huangpu" },
    { name: "Renaissance Shanghai Yu Garden Hotel", text: "Hotel" },
    { name: "Yu Garden", text: "Garden · Huangpu, Shanghai" },
  ];
  assert.equal(pickResult(cards, { query: "Yu Garden Shanghai" }), 2);
});

test("pickResult: a result list with only a ticket office is rejected so the fallback query runs", () => {
  const cards = [
    { name: "Mutianyu Great Wall Scenic Area Ticket Office", text: "Mutianyu Road, Huairou" },
    { name: "Mutianyu Great Wall Hotel", text: "Hotel" },
    { name: "Brickyard Retreat at Mutianyu Great Wall", text: "Huairou" },
  ];
  // the retreat survives the noise filter but is not a name match for "Mutianyu" alone only if tokens miss
  const ranked = rankResults(cards, { query: "Mutianyu" });
  assert.ok(!ranked.some((r) => r.index === 0 || r.index === 1));
  assert.equal(pickResult([cards[0], cards[1]], { query: "Mutianyu" }), -1);
});

test("pickResult: a lodging card is dropped by its category even when its name looks right", () => {
  const cards = [
    { name: "Brickyard Retreat at Mutianyu Great Wall", text: "Brickyard Retreat | Brickyard Retreat | 4.7(300) | Lodging \u00b7 Huairou District" },
    { name: "Mutianyu Great Wall", text: "Mutianyu Great Wall | Mutianyu Great Wall | 4.7(900) | Tourist attraction \u00b7 Huairou District" },
  ];
  assert.equal(pickResult(cards, { query: "Mutianyu Great Wall" }), 1);
  assert.equal(pickResult([cards[0]], { query: "Mutianyu" }), -1);
  assert.equal(cardCategory(cards[1].text), "Tourist attraction");
});

test("pickResult: a different place sharing one word is not accepted", () => {
  assert.equal(pickResult([{ name: "Tianmen Mountain", text: "Zhangjiajie" }], { query: "Tianmen Cave" }), -1);
  assert.equal(pickResult([{ name: "Yangjiajie Scenic Area", text: "Zhangjiajie" }], { query: "Yuanjiajie Scenic Area" }), -1);
});

test("pickResult: a longer query still accepts the scenic-spot entry", () => {
  const cards = [
    { name: "Longsheng Various Nationalities Autonomous County", text: "" },
    { name: "Longji Rice Terrace Scenic Spot", text: "Scenic spot · Guilin, Guangxi" },
  ];
  assert.equal(pickResult(cards, { query: "Longji Rice Terraces Ping'an Village" }), 1);
});

test("pickResult: a Chinese query skips the English-name guard but keeps the noise filter", () => {
  const cards = [
    { name: "\u6155\u7530\u5cea\u957f\u57ce\u666f\u533a\u552e\u7968\u5904", text: "" },
    { name: "\u6155\u7530\u5cea\u957f\u57ce", text: "Huairou District" },
  ];
  assert.equal(pickResult(cards, { query: "\u6155\u7530\u5cea\u957f\u57ce" }), 1);
  assert.equal(pickResult([{ name: "Great Wall of China", text: "Huairou District, Beijing" }], { query: "\u6155\u7530\u5cea\u957f\u57ce" }), 0);
});

test("rankResults: the region on the card breaks a tie between same-named places", () => {
  const cards = [
    { name: "Hongyadong", text: "Attraction · Chenggong District, Kunming" },
    { name: "Hongyadong", text: "Attraction · Yuzhong District, Chongqing" },
  ];
  assert.equal(pickResult(cards, { query: "Hongyadong", mustContain: "Chongqing" }), 1);
  assert.equal(pickResult(cards, { query: "Hongyadong" }), 0);
});

test("chooserAction never clicks a row that is already checked (rows are toggles)", () => {
  const rows = [{ name: "Trips", checked: true }, { name: "Food", checked: false }];
  assert.deepEqual(chooserAction(rows, "Trips"), { action: "already", index: 0 });
  assert.deepEqual(chooserAction(rows, "food"), { action: "click", index: 1 });
  assert.deepEqual(chooserAction(rows, "Nope"), { action: "create" });
  assert.deepEqual(chooserAction(rows, "Nope", false), { action: "stop-missing" });
});

test("savedCount and searchUrl", () => {
  assert.equal(savedCount("Save"), 0);
  assert.equal(savedCount("Saved (3)"), 3);
  assert.equal(savedCount("Saved"), 1);
  assert.equal(savedCount("Share"), null);
  assert.equal(searchUrl(" Temple of Heaven, Beijing "), "https://www.google.com/maps/search/Temple%20of%20Heaven%2C%20Beijing?hl=en");
});

// ---------------------------------------------------------------------------------------------
// Fake ctx. Answers each in-page snippet by a distinctive substring of its text.
// ---------------------------------------------------------------------------------------------
function fake(scenario) {
  const log = { closed: [], navigations: [], clicks: [], typed: [] };
  let cur = null;
  let lastEl = "";
  const rowIndex = (e) => { const m = /menuitemradio\]'\)\[(\d+)\]/.exec(e); return m ? Number(m[1]) : -1; };
  const page = {
    async cdp(method, params) {
      if (method === "Page.navigate") {
        log.navigations.push(params.url);
        cur = scenario.pages(params.url);
        return {};
      }
      if (method === "Input.insertText") { log.typed.push(params.text); return {}; }
      if (method === "Input.dispatchMouseEvent") {
        if (params.type === "mousePressed") {
          log.clicks.push(lastEl);
          const i = rowIndex(lastEl);
          if (i >= 0 && cur.chooser) {
            cur.chooser[i].checked = !cur.chooser[i].checked;
            if (cur.chooser[i].checked) cur.place.chip = `Saved in ${cur.chooser[i].text.split("\n")[0]}`;
          }
        }
        return {};
      }
      if (method !== "Runtime.evaluate") return {};
      const e = params.expression;
      const v = (value) => ({ result: { value } });
      if (e.includes('a[role=button][aria-label^="Google Account"]')) return v(JSON.stringify(cur.state));
      if (e.includes('[role=feed] a[href*="/maps/place/"]')) return v(JSON.stringify(cur.cards || []));
      if (e.includes("plusCode:label")) return v(JSON.stringify(cur.place));
      if (e.includes("map(b=>b.innerText||'').filter(t=>")) return v(JSON.stringify(scenario.listButtons));
      if (e.includes("title:h>0")) return v(JSON.stringify(scenario.openList()));
      if (e.includes(".pop()")) return v(1);
      if (e.includes("role=menuitemradio]')].map(e=>({text")) return v(JSON.stringify(cur.chooser || []));
      if (e.includes("JSON.stringify([r.x+r.width/2")) { lastEl = e; return v(JSON.stringify([10, 20])); }
      if (e.includes("e.scrollIntoView({block:'center'});return 1")) return v(1);
      if (e.includes("[role=dialog]") && e.startsWith("!!(")) return v(true);
      if (e.includes(".value") && e.includes("[role=dialog]")) return v(log.typed[log.typed.length - 1] || "");
      return v(1);
    },
  };
  const ctx = {
    session: { Target: { async createTarget() { return { targetId: "T" }; }, async closeTarget({ targetId }) { log.closed.push(targetId); } } },
    async attachPage() { return page; },
  };
  return { ctx, log };
}

const placeState = { mode: "place", feed: 0, signedIn: true };
const tripsRow = (checked) => ({ text: "Trips\nPrivate · 5 places", checked });
const otherRow = { text: "Food\nPrivate · 9 places", checked: false };

test("saveToList: a place already in the list is left alone and no chooser row is clicked", async () => {
  const chooser = [tripsRow(true), otherRow];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState, place: { name: "Temple of Heaven", address: "Dongcheng, China", plusCode: "VCJ4+VJ Dongcheng, Beijing, China", saveLabel: "Saved (2)", chip: "Saved in Trips" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Temple of Heaven Beijing", list: "Trips", mustContain: "Beijing" });
  assert.equal(out.saved, true);
  assert.equal(out.alreadySaved, true);
  assert.equal(out.name, "Temple of Heaven");
  assert.ok(!log.clicks.some((c) => c.includes("menuitemradio")), "no chooser row click");
  assert.equal(chooser[0].checked, true);
  assert.deepEqual(log.closed, ["T"]);
});

test("saveToList: an unchecked row is clicked once and confirmed by the Saved-in chip", async () => {
  const chooser = [otherRow, tripsRow(false)];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState, place: { name: "Yu Garden", address: "Huangpu, Shanghai, China", plusCode: "", saveLabel: "Save", chip: "" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Yu Garden Shanghai", list: "trips", mustContain: "Shanghai" });
  assert.equal(out.saved, true);
  assert.equal(out.alreadySaved, false);
  assert.equal(out.listCreated, false);
  assert.equal(log.clicks.filter((c) => c.includes("menuitemradio")).length, 1);
  assert.ok(log.clicks.some((c) => c.includes("menuitemradio]')[1]")));
});

test("saveToList: a place in the wrong region saves nothing and reports what it saw", async () => {
  const chooser = [tripsRow(false)];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState, place: { name: "Hongyadong", address: "Chenggong District, Kunming, China", plusCode: "", saveLabel: "Save", chip: "" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Hongyadong", list: "Trips", mustContain: "Chongqing" });
  assert.equal(out.stop, "no-match");
  assert.equal(out.tried[0].reason, "region");
  assert.equal(out.tried[0].address, "Chenggong District, Kunming, China");
  assert.equal(log.clicks.length, 0);
  assert.equal(chooser[0].checked, false);
  assert.deepEqual(log.closed, ["T"]);
});

test("saveToList: a direct redirect to a ticket office falls through to the fallback query", async () => {
  const chooser = [tripsRow(false)];
  const good = { name: "Great Wall of China", address: "Huairou District, Beijing, China", plusCode: "", saveLabel: "Save", chip: "" };
  const { ctx, log } = fake({
    pages: (url) => (url.includes("Mutianyu%20Great%20Wall") && !url.includes("%E5%9F%8E")
      ? { state: placeState, place: { name: "Mutianyu Great Wall Scenic Area Ticket Office", address: "Huairou District, Beijing, China", plusCode: "", saveLabel: "Save", chip: "" }, chooser }
      : { state: placeState, place: good, chooser }),
  });
  const out = await saveToList(ctx, { query: "Mutianyu Great Wall", list: "Trips", mustContain: "Beijing", fallbacks: ["慕田峪长城"] });
  assert.equal(out.saved, true);
  assert.equal(out.name, "Great Wall of China");
  assert.equal(out.usedQuery, "慕田峪长城");
  assert.equal(log.navigations.length, 2);
});

test("saveToList: a redirect to a different place sharing one word saves nothing", async () => {
  const chooser = [tripsRow(false)];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState, place: { name: "Tianmen Mountain", address: "Yongding District, Zhangjiajie, China", plusCode: "", saveLabel: "Save", chip: "" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Tianmen Cave", list: "Trips", mustContain: "Zhangjiajie" });
  assert.equal(out.stop, "no-match");
  assert.equal(out.tried[0].reason, "name");
  assert.equal(log.clicks.length, 0);
});

test("saveToList: a feed result is opened by href after ranking, noise rows skipped", async () => {
  const chooser = [tripsRow(false)];
  const feed = {
    state: { mode: "feed", feed: 2, signedIn: true },
    cards: [
      { name: "Lujiazui Hotel", text: "Hotel", href: "https://www.google.com/maps/place/hotel" },
      { name: "Lujiazui", text: "Pudong, Shanghai", href: "https://www.google.com/maps/place/lujiazui" },
    ],
  };
  const { ctx, log } = fake({
    pages: (url) => (url.includes("/maps/search/")
      ? feed
      : { state: placeState, place: { name: "Lujiazui", address: "Pudong, Shanghai, China", plusCode: "", saveLabel: "Save", chip: "" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Lujiazui Shanghai", list: "Trips", mustContain: "Shanghai" });
  assert.equal(out.saved, true);
  assert.deepEqual(log.navigations.slice(1), ["https://www.google.com/maps/place/lujiazui"]);
});

test("saveToList: createIfMissing false stops when the list is absent, clicking no row", async () => {
  const chooser = [otherRow];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState, place: { name: "Yu Garden", address: "Shanghai", plusCode: "", saveLabel: "Save", chip: "" }, chooser }),
  });
  const out = await saveToList(ctx, { query: "Yu Garden", list: "Trips", createIfMissing: false });
  assert.equal(out.stop, "list-missing");
  assert.deepEqual(out.lists, ["Food"]);
  assert.ok(!log.clicks.some((c) => c.includes("menuitemradio")));
});

test("saveToList: missing arguments fail before a tab opens", async () => {
  const { ctx, log } = fake({ pages: () => ({}) });
  await assert.rejects(() => saveToList(ctx, { list: "Trips" }), /query is required/);
  await assert.rejects(() => saveToList(ctx, { query: "x" }), /list/);
  assert.deepEqual(log.closed, []);
});

test("listItems: scrolls until the item count equals the header and reports both", async () => {
  const all = [
    { name: "Place A", detail: ["4.5(10)", "Park"], note: "first" },
    { name: "Place B", detail: ["Pudong, Shanghai", "China"], note: "" },
    { name: "Place C", detail: ["4.0(2)"], note: "third" },
  ];
  let reads = 0;
  const { ctx, log } = fake({
    pages: () => ({ state: placeState }),
    listButtons: ["Food\nPrivate · 9 places", "Trips\nPrivate · 3 places"],
    openList: () => ({ title: "Trips", header: "Private · 3 places", items: all.slice(0, ++reads < 3 ? 2 : 3) }),
  });
  const out = await listItems(ctx, { list: "Trips" });
  assert.equal(out.count, 3);
  assert.equal(out.itemCount, 3);
  assert.equal(out.complete, true);
  assert.deepEqual(out.items.map((i) => i.name), ["Place A", "Place B", "Place C"]);
  assert.equal(out.items[0].note, "first");
  assert.ok(log.clicks.length === 1);
  assert.deepEqual(log.closed, ["T"]);
});

test("listItems: an absent list throws with similar names and still closes the tab", async () => {
  const { ctx, log } = fake({
    pages: () => ({ state: placeState }),
    listButtons: ["Trips 2026\nPrivate · 3 places"],
    openList: () => ({}),
  });
  await assert.rejects(() => listItems(ctx, { list: "Trips" }), /no list named "Trips"/);
  assert.deepEqual(log.closed, ["T"]);
  await assert.rejects(() => listItems(ctx, {}), /list .* required/);
});

test("createList: an existing name is a no-op", async () => {
  const { ctx, log } = fake({
    pages: () => ({ state: placeState }),
    listButtons: ["Trips\nPrivate · 3 places"],
  });
  const out = await createList(ctx, { name: " trips " });
  assert.deepEqual(out, { created: false, name: "Trips", count: 3 });
  assert.equal(log.clicks.length, 0);
});

test("createList: types the name, clicks Create, and confirms by re-reading the lists", async () => {
  const buttons = ["Trips\nPrivate · 3 places"];
  const { ctx, log } = fake({
    pages: () => ({ state: placeState }),
    listButtons: buttons,
  });
  const origPush = log.clicks.push.bind(log.clicks);
  log.clicks.push = (c) => { if (c.includes('button[aria-label="Create"]') || c.includes("=== 'Create'") || c.includes("==='Create'")) buttons.push("Wishlist\nPrivate · 0 places"); return origPush(c); };
  const out = await createList(ctx, { name: "Wishlist" });
  assert.deepEqual(out, { created: true, name: "Wishlist" });
  assert.deepEqual(log.typed, ["Wishlist"]);
  await assert.rejects(() => createList(ctx, { name: "x".repeat(41) }), /40 characters/);
  await assert.rejects(() => createList(ctx, { name: "  " }), /name is required/);
});
