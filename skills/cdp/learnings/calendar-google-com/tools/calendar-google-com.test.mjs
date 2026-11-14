// learnings/calendar-google-com/tools/calendar-google-com.test.mjs
// Pure checks only; no DOM, no browser, never a live account.
//   node --test 'skills/cdp/learnings/*/tools/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICAL_RE, settingsUrl } from "./calendar-google-com.mjs";

const PLACEHOLDER = "https://calendar.google.com/calendar/ical/you%40example.com/private-0000placeholder/basic.ics";

test("settingsUrl encodes the calendar id as base64 under the authuser slot", () => {
  assert.equal(settingsUrl("you@example.com"), "https://calendar.google.com/calendar/u/0/r/settings/calendar/eW91QGV4YW1wbGUuY29t");
  assert.equal(settingsUrl("you@example.com", 1), "https://calendar.google.com/calendar/u/1/r/settings/calendar/eW91QGV4YW1wbGUuY29t");
});

test("settingsUrl strips base64 padding and rejects an empty id", () => {
  assert.equal(settingsUrl("a@example.com"), "https://calendar.google.com/calendar/u/0/r/settings/calendar/YUBleGFtcGxlLmNvbQ");
  assert.throws(() => settingsUrl(""), /calendarId is required/);
});

test("ICAL_RE extracts the private address and ignores the masked and public shapes", () => {
  assert.equal(`value="${PLACEHOLDER}" x`.match(ICAL_RE)[0], PLACEHOLDER);
  assert.equal("•".repeat(10).match(ICAL_RE), null);
  assert.equal("https://calendar.google.com/calendar/ical/you%40example.com/public/basic.ics".match(ICAL_RE), null);
});

// Static leak check over this learning's own files: every email must be a placeholder domain,
// and every private- token must be an obvious placeholder, never a real-looking hex token.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = /[\w.+-]+(?:@|%40)([\w-]+(?:\.[\w-]+)+)/g;
const TOKEN = /private-([0-9a-f]{16,})/gi;

function leaks(text) {
  const found = [];
  for (const m of text.matchAll(EMAIL)) if (m[1] !== "example.com") found.push(m[0]);
  for (const m of text.matchAll(TOKEN)) if (!/^0+$/.test(m[1])) found.push("private-" + m[1].slice(0, 4) + "...");
  return found;
}

function files(dir) {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
}

test("leak scanner flags a real-looking email and token (negative control)", () => {
  const fakeToken = "a1".repeat(16);
  assert.equal(leaks(`someone${"@"}gmail.com`).length, 1);
  assert.equal(leaks(`/private-${fakeToken}/basic.ics`).length, 1);
  assert.deepEqual(leaks(PLACEHOLDER), []);
});

test("no concrete secret or real email is committed in this learning", () => {
  for (const f of files(ROOT)) assert.deepEqual(leaks(readFileSync(f, "utf8")), [], f);
});
