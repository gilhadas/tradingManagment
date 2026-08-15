// Validation suite for the broker importers.
//
//   npm test                  # synthetic cases only (no data files needed)
//   npm test -- <file.csv>…   # ALSO reconcile real IBKR exports end to end
//
// Two kinds of check:
//
//  1. Synthetic cases pin the behaviours that are easy to break silently —
//     shorts, direction flips, commission pro-rating, and the rule that an
//     unknown duration must never be reported as a number.
//  2. Reconciliation replays a real export against the parser output and
//     asserts the books balance: every share bought is either closed or still
//     open, every share sold is accounted for, and no trade is dated before the
//     fill that opened it. That last one is what catches a mis-paired position —
//     the failure that dated a July SOXL trade to May.
//
// Deliberately dependency-free: node runs this directly, and the repo has no
// test framework to add one to.

import { readFileSync } from "node:fs";
import { matchTransactions, makeTrade } from "./tradeMatching.js";
import { parseIBKRCsv } from "./ibkrParser.js";

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { passed++; return; }
  failures.push(`${name}${detail ? `  — ${detail}` : ""}`);
}
const eq = (name, actual, expected) =>
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (name, actual, expected, tol = 0.005) =>
  check(name, Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

// Terse fill builder. Order in the array IS chronological order.
const fill = (date, symbol, qty, price, comm = 0) =>
  ({ date, symbol, buy: qty > 0, qty: Math.abs(qty), price, comm });

// ───────────────────────── synthetic: longs ─────────────────────────
{
  const t = matchTransactions([
    fill("2026-01-05", "AAPL", 100, 150, 1.5),
    fill("2026-01-08", "AAPL", -100, 155, 1.5),
  ]);
  eq("long: one round trip", t.length, 1);
  eq("long: direction", t[0].direction, "Long");
  eq("long: entry dated at the buy", t[0].date, "2026-01-05");
  eq("long: exit dated at the sell", t[0].exitDate, "2026-01-08");
  eq("long: profit is positive", t[0].pnl, "3.33");
  near("long: both commissions charged", +t[0].commission, 3);
}

// Several fills of one order at different prices collapse to a weighted average.
{
  const t = matchTransactions([
    fill("2026-06-02", "MRVL", 100, 276, 1.5),
    fill("2026-06-02", "MRVL", -27, 269.592, 1.5),
    fill("2026-06-02", "MRVL", -41, 269.55, 0),
    fill("2026-06-02", "MRVL", -5, 269.55, 0),
    fill("2026-06-02", "MRVL", -27, 269.592, 0),
  ]);
  eq("partial exits merge into one trade", t.length, 1);
  eq("merged quantity", t[0].quantity, "100");
  eq("merged exit is the weighted average", t[0].exitPrice, "269.57");
  near("merged commission", +t[0].commission, 3);
  check("merged trade keeps its entry date", t[0].date === "2026-06-02");
}

// Closing a position in parts splits the entry commission proportionally.
// The exits are on separate days on purpose: same-day partial exits merge into
// a single trade (covered above), which would hide the split.
{
  const t = matchTransactions([
    fill("2026-06-01", "IREN", 200, 64.38, 1.5),
    fill("2026-06-02", "IREN", -50, 65.0, 1.5),
    fill("2026-06-03", "IREN", -150, 64.71, 1.5),
  ]);
  const c50 = t.find(x => x.quantity === "50");
  const c150 = t.find(x => x.quantity === "150");
  near("pro-rated commission on the 50-share exit", +c50.commission, 1.875);
  near("pro-rated commission on the 150-share exit", +c150.commission, 2.625);
  near("pro-rated shares sum to the total charged", +c50.commission + +c150.commission, 4.5);
}

// ───────────────────────── synthetic: shorts ─────────────────────────
// The bug this suite exists for: a short used to be mangled into a phantom
// LONG that survived forever and swallowed a later, unrelated sell.
{
  const t = matchTransactions([
    fill("2026-08-19", "NNE", -60, 30.28, 1.5),   // sell to open
    fill("2026-08-20", "NNE", 60, 29.17, 1.5),    // buy to cover
  ]);
  eq("short: one round trip", t.length, 1);
  eq("short: direction", t[0].direction, "Short");
  eq("short: entry dated at the opening sell", t[0].date, "2026-08-19");
  eq("short: exit dated at the covering buy", t[0].exitDate, "2026-08-20");
  eq("short: entry is the sell price", t[0].entryPrice, "30.28");
  eq("short: exit is the cover price", t[0].exitPrice, "29.17");
  check("short: covering lower is a PROFIT", parseFloat(t[0].pnl) > 0, `pnl ${t[0].pnl}`);
}

{
  const t = matchTransactions([
    fill("2026-08-19", "XYZ", -10, 100, 0),
    fill("2026-08-20", "XYZ", 10, 110, 0),        // covered higher = loss
  ]);
  check("short: covering higher is a LOSS", parseFloat(t[0].pnl) < 0, `pnl ${t[0].pnl}`);
}

// A short must not leak into the next trade. This is the SOXL shape: short,
// cover, then a completely separate long weeks later.
{
  const t = matchTransactions([
    fill("2026-05-12", "SOXL", -10, 143, 0),
    fill("2026-05-13", "SOXL", 10, 140, 0),
    fill("2026-07-30", "SOXL", 60, 99.39, 1.5),
    fill("2026-07-31", "SOXL", -60, 117.946, 1.5),
  ]);
  eq("short then long: two independent trades", t.length, 2);
  const july = t.find(x => x.exitDate === "2026-07-31");
  eq("the July long is NOT back-dated to May", july.date, "2026-07-30");
  eq("the July long is a Long", july.direction, "Long");
  eq("the July entry price is the July buy", july.entryPrice, "99.39");
}

// Selling more than is held flips the position from long to short.
{
  const t = matchTransactions([
    fill("2026-03-01", "QS", 50, 10, 0),
    fill("2026-03-02", "QS", -80, 12, 0),   // closes 50 long, opens 30 short
    fill("2026-03-03", "QS", 30, 11, 0),    // covers the short
  ]);
  eq("flip: two round trips", t.length, 2);
  const long = t.find(x => x.direction === "Long");
  const short = t.find(x => x.direction === "Short");
  eq("flip: long leg quantity", long.quantity, "50");
  eq("flip: short leg quantity", short.quantity, "30");
  eq("flip: short opens on the flipping sell", short.date, "2026-03-02");
  eq("flip: short covers on the buy", short.exitDate, "2026-03-03");
}

// A sell with no buy anywhere in the file is a pre-window holding, NOT a short:
// nothing ever covers it. Entry must stay blank rather than be invented.
{
  const t = matchTransactions([fill("2026-05-28", "IREN", -100, 64.23, 1.5)]);
  eq("pre-window sale: one row", t.length, 1);
  eq("pre-window sale: entry unknown", t[0].entryPrice, "");
  eq("pre-window sale: no fabricated entry instant", t[0].entryAt, "");
  eq("pre-window sale: not treated as a short", t[0].direction, "Long");
}

// …but the same shape WITH a later cover is a short.
{
  const t = matchTransactions([
    fill("2026-05-28", "IREN", -100, 64.23, 0),
    fill("2026-05-29", "IREN", 100, 60.00, 0),
  ]);
  eq("covered sell is a short, not a pre-window sale", t[0].direction, "Short");
  eq("covered short has a known entry", t[0].entryPrice, "64.23");
}

// ───────────────────────── synthetic: timestamps ─────────────────────────
{
  const a = { ...fill("2026-01-05", "AAPL", 100, 150), at: "2026-01-05T14:30:00.000Z" };
  const b = { ...fill("2026-01-05", "AAPL", -100, 151), at: "2026-01-05T15:15:00.000Z" };
  const [t] = matchTransactions([a, b]);
  eq("entry instant survives", t.entryAt, "2026-01-05T14:30:00.000Z");
  eq("exit instant survives", t.exitAt, "2026-01-05T15:15:00.000Z");
}

// The partial-exit merge must not blank the entry instant — makeTrade returns
// the full key set, so Object.assign silently wipes anything not re-passed.
{
  const at = "2026-01-05T14:30:00.000Z";
  const t = matchTransactions([
    { ...fill("2026-01-05", "AAPL", 100, 150), at },
    { ...fill("2026-01-05", "AAPL", -50, 151), at: "2026-01-05T15:00:00.000Z" },
    { ...fill("2026-01-05", "AAPL", -50, 152), at: "2026-01-05T15:30:00.000Z" },
  ]);
  eq("merged partial exits keep the entry instant", t[0].entryAt, at);
  eq("merged partial exits take the LAST exit instant", t[0].exitAt, "2026-01-05T15:30:00.000Z");
}

// Fills with no clock time must yield empty strings, never undefined — those
// would reach the database as the string "undefined".
{
  const [t] = matchTransactions([
    fill("2026-01-05", "AAPL", 10, 150),
    fill("2026-01-06", "AAPL", -10, 151),
  ]);
  eq("missing entry instant is an empty string", t.entryAt, "");
  eq("missing exit instant is an empty string", t.exitAt, "");
  eq("missing commission is an empty string", t.commission, "");
}

// ───────────────────────── synthetic: makeTrade ─────────────────────────
{
  const l = makeTrade({ date: "2026-01-01", ticker: "X", quantity: 10, entryPrice: 100, exitPrice: 110 });
  const s = makeTrade({ date: "2026-01-01", ticker: "X", quantity: 10, entryPrice: 100, exitPrice: 110, direction: "Short" });
  eq("long +10% ", l.pnl, "10.00");
  eq("same prices short is -10%", s.pnl, "-10.00");
  eq("open trade has no pnl", makeTrade({ date: "2026-01-01", ticker: "X", quantity: 10, entryPrice: 100, exitPrice: null }).pnl, "");
}

// ───────────────────── reconciliation against real files ─────────────────────
function rawFills(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",");
    if (c[0] !== "Transaction History" || c[1] !== "Data") continue;
    if (c[5] !== "Buy" && c[5] !== "Sell") continue;
    const sym = c[6];
    if (!sym || sym === "-") continue;
    const q = parseFloat(c[7]) || 0;
    const price = parseFloat(c[8]) || 0;
    if (!q || !price) continue;
    out.push({ account: c[3] || "", date: c[2], sym, qty: q });
  }
  return out;
}

function reconcile(path) {
  const text = readFileSync(path, "utf8");
  const raw = rawFills(text);
  const trades = parseIBKRCsv(text);
  const label = path.split("/").pop();

  // Per (account, symbol): shares bought must equal shares closed-as-long plus
  // shares still held long; shares sold must equal shares closed plus shares
  // still held short plus shares sold from a pre-window holding.
  const rawAgg = new Map();
  for (const r of raw) {
    const k = `${r.account}|${r.sym}`;
    const v = rawAgg.get(k) || { buy: 0, sell: 0 };
    if (r.qty > 0) v.buy += r.qty; else v.sell += Math.abs(r.qty);
    rawAgg.set(k, v);
  }

  const agg = new Map();
  for (const t of trades) {
    const k = `${t.account || ""}|${t.ticker}`;
    const v = agg.get(k) || { closedLong: 0, closedShort: 0, openLong: 0, openShort: 0, preHeld: 0 };
    const q = +t.quantity || 0;
    if (!t.exitPrice) {
      if (t.direction === "Short") v.openShort += q; else v.openLong += q;
    } else if (!t.entryPrice) {
      v.preHeld += q;                       // sold from a pre-window holding
    } else if (t.direction === "Short") {
      v.closedShort += q;
    } else {
      v.closedLong += q;
    }
    agg.set(k, v);
  }

  let bad = 0;
  for (const [k, r] of rawAgg) {
    const v = agg.get(k) || { closedLong: 0, closedShort: 0, openLong: 0, openShort: 0, preHeld: 0 };
    // every BUY share: closed a long, or covered a short, or is still held long
    const buyAccounted = v.closedLong + v.closedShort + v.openLong;
    // every SELL share: closed a long, or opened a short, or came from pre-window stock
    const sellAccounted = v.closedLong + v.closedShort + v.openShort + v.preHeld;
    if (Math.abs(buyAccounted - r.buy) > 0.5) {
      bad++; failures.push(`${label} ${k}: bought ${r.buy}, accounted ${buyAccounted}`);
    }
    if (Math.abs(sellAccounted - r.sell) > 0.5) {
      bad++; failures.push(`${label} ${k}: sold ${r.sell}, accounted ${sellAccounted}`);
    }
  }
  check(`${label}: every share reconciles (${rawAgg.size} account/symbol pairs)`, bad === 0);

  // A closed trade can never exit before it was entered.
  const inverted = trades.filter(t => t.exitDate && t.date && t.exitDate < t.date);
  check(`${label}: no trade exits before it enters`, inverted.length === 0,
    inverted.slice(0, 3).map(t => `${t.ticker} ${t.date}->${t.exitDate}`).join(", "));

  // A trade's entry date must correspond to a real fill of that symbol on that
  // day, in the right direction. This is what catches a position stitched to the
  // wrong opening fill — the SOXL failure.
  const fillDays = new Set(raw.map(r => `${r.account}|${r.sym}|${r.date}|${r.qty > 0 ? "B" : "S"}`));
  const orphan = trades.filter(t => {
    if (!t.entryPrice) return false;                 // pre-window entry, no fill to match
    const side = t.direction === "Short" ? "S" : "B";
    return !fillDays.has(`${t.account || ""}|${t.ticker}|${t.date}|${side}`);
  });
  check(`${label}: every entry date matches a real opening fill`, orphan.length === 0,
    orphan.slice(0, 3).map(t => `${t.ticker} ${t.direction} entry ${t.date}`).join(", "));

  return { trades: trades.length, pairs: rawAgg.size };
}

const files = process.argv.slice(2);
const summaries = [];
for (const f of files) {
  try {
    summaries.push(`${f.split("/").pop()}: ${JSON.stringify(reconcile(f))}`);
  } catch (e) {
    failures.push(`${f}: ${e.message}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (summaries.length) summaries.forEach(s => console.log("  " + s));
if (failures.length) {
  console.log("\nFAILURES:");
  failures.forEach(f => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("all checks passed");
