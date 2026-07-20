// Tests the Blink screenshot parser on word data transcribed (with real
// layout geometry) from two actual app screenshots. OCR itself isn't run here;
// these cover line clustering, row parsing, cross-file merge and dedupe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlinkAppWords, mergeBlinkAppTxs } from "../src/lib/blinkImageParser.js";
import { matchTransactions } from "../src/lib/ibiParser.js";

// Builds the two visual lines of one transaction row at vertical offset y.
// Column x-centers mirror the app: amount left, symbol/qty middle, type/date right.
function row(y, { type, symbol, amount, qty, day, month, year }) {
  const words = [
    { x: 180, y, h: 30, s: amount },
    { x: 780, y, h: 30, s: type },
  ];
  if (symbol) words.push({ x: 480, y, h: 30, s: symbol });
  const sub = y + 45;
  if (qty) {
    words.push({ x: 450, y: sub, h: 20, s: qty });
    words.push({ x: 510, y: sub, h: 20, s: "מניות" });
  }
  words.push({ x: 700, y: sub, h: 20, s: day });
  words.push({ x: 765, y: sub, h: 20, s: month });
  words.push({ x: 835, y: sub, h: 20, s: year });
  return words;
}

// Screenshot 1 (newest first, as rendered).
const shot1 = [
  row(400, { type: "קניה", symbol: "SNX", amount: "-$366.08", qty: "2", day: "01", month: "אפר׳", year: "2026" }),
  row(590, { type: "מכירה", symbol: "RCAT", amount: "+$3,759.04", qty: "270.6067", day: "26", month: "מרץ", year: "2026" }),
  row(780, { type: "קניה", symbol: "RCAT", amount: "-$5,013.40", qty: "270.6067", day: "06", month: "מרץ", year: "2026" }),
  row(970, { type: "זיכוי", amount: "+$17.90", day: "01", month: "מרץ", year: "2026" }), // tax credit — not a trade
  row(1160, { type: "מכירה", symbol: "NOW", amount: "+$5,245.00", qty: "50", day: "27", month: "פבר׳", year: "2026" }),
  row(1350, { type: "קניה", symbol: "NOW", amount: "-$5,496.75", qty: "50", day: "26", month: "פבר׳", year: "2026" }),
  row(1540, { type: "מכירה", symbol: "AMD", amount: "+$4,156.60", qty: "20", day: "26", month: "פבר׳", year: "2026" }),
  row(1730, { type: "קניה", symbol: "AMD", amount: "-$4,156.40", qty: "20", day: "24", month: "פבר׳", year: "2026" }),
  row(1920, { type: "מכירה", symbol: "IREN", amount: "+$4,793.80", qty: "120", day: "12", month: "פבר׳", year: "2026" }),
].flat();

// Screenshot 2 — includes dividend/tax rows that must be skipped, and the
// IREN buy whose sell lives on screenshot 1 (cross-file matching).
const shot2 = [
  row(500, { type: "קניה", symbol: "IREN", amount: "-$5,230.60", qty: "120", day: "09", month: "פבר׳", year: "2026" }),
  row(750, { type: "חיוב", amount: "-$18.05", day: "01", month: "פבר׳", year: "2026" }),
  row(1000, { type: "דיבידנד", symbol: "ETHU", amount: "+$2.31", day: "28", month: "אוג׳", year: "2025" }),
  row(1250, { type: "תיקון", symbol: "ETHU", amount: "-$1.73", day: "28", month: "אוג׳", year: "2025" }),
  row(1500, { type: "מכירה", symbol: "NVDA", amount: "+$5,673.90", qty: "30", day: "29", month: "ינו׳", year: "2026" }),
].flat();

test("parses one screenshot into chronological transactions", () => {
  const txs = parseBlinkAppWords({ heb: shot1, eng: shot1 });
  assert.equal(txs.length, 8); // tax-credit row skipped
  assert.deepEqual(txs[0], { date: "2026-02-12", symbol: "IREN", buy: false, qty: 120, amount: 4793.80, price: 39.9483 });
  assert.deepEqual(txs.at(-1), { date: "2026-04-01", symbol: "SNX", buy: true, qty: 2, amount: 366.08, price: 183.04 });
});

test("skips dividend and tax rows", () => {
  const txs = parseBlinkAppWords({ heb: shot2, eng: shot2 });
  assert.deepEqual(txs.map(t => t.symbol), ["NVDA", "IREN"]);
});

test("merge returns chronological transactions for review, not trades", () => {
  const txs = mergeBlinkAppTxs([parseBlinkAppWords({ heb: shot1, eng: shot1 }), parseBlinkAppWords({ heb: shot2, eng: shot2 })]);
  // 8 from shot1 + 2 from shot2 (dividend/tax skipped), oldest first.
  assert.equal(txs.length, 10);
  assert.equal(txs[0].date, "2026-01-29");
  assert.ok(txs.every((t, i) => i === 0 || txs[i - 1].date <= t.date));
});

test("matches buys to sells across screenshots", () => {
  const txs = mergeBlinkAppTxs([parseBlinkAppWords({ heb: shot1, eng: shot1 }), parseBlinkAppWords({ heb: shot2, eng: shot2 })]);
  const trades = matchTransactions(txs);
  assert.equal(trades.length, 6);

  const iren = trades.find(t => t.ticker === "IREN");
  assert.equal(iren.date, "2026-02-09");
  assert.equal(iren.entryPrice, "43.59"); // 5230.60 / 120
  assert.equal(iren.exitPrice, "39.95");  // 4793.80 / 120
  assert.equal(iren.quantity, "120");

  // Sell with no buy in the window — entry left blank for the user.
  const nvda = trades.find(t => t.ticker === "NVDA");
  assert.equal(nvda.entryPrice, "");
  assert.equal(nvda.exitPrice, "189.13");

  // Still-open position at the window's end.
  const snx = trades.find(t => t.ticker === "SNX");
  assert.equal(snx.exitPrice, "");
});

test("dedupes rows repeated on overlapping screenshots", () => {
  // Same IREN sell appears on both screenshots — must count once.
  const overlap = [...shot2, ...row(1750, { type: "מכירה", symbol: "IREN", amount: "+$4,793.80", qty: "120", day: "12", month: "פבר׳", year: "2026" })];
  const txs = mergeBlinkAppTxs([parseBlinkAppWords({ heb: shot1, eng: shot1 }), parseBlinkAppWords({ heb: overlap, eng: overlap })]);
  // The IREN sell appears on shot1 once and the overlap file once — still one.
  assert.equal(txs.filter(t => t.symbol === "IREN" && !t.buy).length, 1);
});
