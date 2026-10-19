// learnings/corp-delaware-gov/tools/tax.test.mjs
// Exercises the pure result-page parser only; no DOM, no browser, no CAPTCHA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaxPage } from "./tax.mjs";

const PAID = [
  "Franchise Tax",
  "File Number: 1234567",
  "Name: ACME HOLDINGS LLC",
  "Tax Year: 2025",
  "Tax Year | LP/LLC/GP Tax | Penalty | 1.5% Monthly Interest | Previous Credit/Balance | Amount Due",
  "2025 | $300.00 | $0.00 | $0.00 | ($300.00) | $0.00",
  "Total | $0.00",
].join("\n");

test("paid LLC: credit parses negative and total is zero", () => {
  const r = parseTaxPage(PAID);
  assert.equal(r.fileNumber, "1234567");
  assert.equal(r.name, "ACME HOLDINGS LLC");
  assert.equal(r.taxYear, 2025);
  assert.deepEqual(r.rows, [{ year: 2025, tax: 300, penalty: 0, interest: 0, credit: -300, due: 0 }]);
  assert.equal(r.total, 0);
});

test("unpaid and late: penalty, interest, thousands separator and total due", () => {
  const text = [
    "File Number: 7654321",
    "Name: LATE FEE LLC",
    "Tax Year: 2025",
    "Tax Year\tLP/LLC/GP Tax\tPenalty\t1.5% Monthly Interest\tPrevious Credit/Balance\tAmount Due",
    "2024\t$300.00\t$200.00\t$15.00\t$0.00\t$515.00",
    "2025\t$300.00\t$0.00\t$0.00\t$1,000.50\t$1,300.50",
    "Total\t$1,815.50",
  ].join("\n");
  const r = parseTaxPage(text);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { year: 2024, tax: 300, penalty: 200, interest: 15, credit: 0, due: 515 });
  assert.equal(r.rows[1].credit, 1000.5);
  assert.equal(r.total, 1815.5);
  assert.ok(r.rows.some((x) => x.due > 0));
});

test("non-result page returns unknown-page with a text snippet", () => {
  const r = parseTaxPage("Delaware Division of Corporations\nPlease enter the file number\nCONTINUE");
  assert.equal(r.stop, "unknown-page");
  assert.match(r.text, /Please enter the file number/);
  assert.equal(r.rows, undefined);
});

test("login page returning after Continue reads as captcha-rejected", () => {
  const r = parseTaxPage("Enter the characters shown\nContinue", "https://icis.corp.delaware.gov/ecorp/logintax.aspx?FilingType=FranchiseTax");
  assert.equal(r.stop, "captcha-rejected");
});

test("empty and missing text do not throw", () => {
  assert.equal(parseTaxPage("").stop, "unknown-page");
  assert.equal(parseTaxPage(undefined).stop, "unknown-page");
});
