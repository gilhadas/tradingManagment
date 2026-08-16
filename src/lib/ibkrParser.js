// Parses an IBKR "Transaction History" CSV export into trade journal entries.
//
// Columns (header row: `Transaction History,Header,Date,Account,Description,
// Transaction Type,Symbol,Quantity,Price,Price Currency,Gross Amount,Commission,
// Net Amount`):
//   2 Date · 5 Transaction Type · 6 Symbol · 7 Quantity (signed) · 8 Price · 11 Commission
//
// A single order is split across several rows when it fills at different prices,
// with the commission charged on the first of them — e.g. a 100-share exit can
// appear as -27/-41/-5/-27 with one -1.5. Those rows are NOT pre-grouped here:
// `matchTransactions` already folds fills into a running position at a weighted-
// average price and merges same-day partial exits, so grouping first would
// produce identical trades. That matters because the commission boundary is not
// a reliable grouping signal — real exports contain whole orders with no
// commission row at all (23 such fills in one year of data).

import { parseCsvLine, matchTransactions } from "./tradeMatching.js";

export { parseCsvLine, makeTrade } from "./tradeMatching.js";

/**
 * Parse IBKR transaction CSV text.
 * Returns an array of trade objects compatible with the trade journal UI.
 *
 * The CSV has dates but no intraday timestamps, so the only sequencing signal is
 * the row order itself. Fills are matched against a running position in that
 * order, meaning several enter→exit cycles of one symbol on one day come out as
 * separate trades rather than being averaged into a single fictional position.
 * Sells with no matching buys in the file (position opened before the export
 * window) become exit-only rows, and positions still open at the end become
 * entry-only rows.
 */
export function parseIBKRCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  // Fills are bucketed per ACCOUNT (col 3, e.g. "U***83935"). Two accounts can
  // hold the same symbol at once, and matching them against one running position
  // would pair a buy in one against a sell in the other — inventing round trips
  // that never happened. Single-account exports simply yield one bucket.
  const byAccount = new Map();

  for (const line of lines) {
    const cols = parseCsvLine(line);

    // Only process trade rows
    if (cols[0] !== "Transaction History") continue;
    if (cols[1] !== "Data") continue;

    const txType = cols[5]; // "Buy" | "Sell" | "Other Fee" | "Adjustment" …
    if (txType !== "Buy" && txType !== "Sell") continue;

    const symbol = cols[6];
    if (!symbol || symbol === "-") continue;

    const date = cols[2]; // "YYYY-MM-DD"
    const rawQty = parseFloat(cols[7]) || 0; // positive = Buy, negative = Sell
    const qty = Math.abs(rawQty);
    const price = parseFloat(cols[8]) || 0;

    if (qty === 0 || price === 0) continue;

    // Commission is "-" on continuation fills. The file reports it as a negative
    // amount; store the positive magnitude of the cost.
    const rawComm = cols[11];
    const comm = !rawComm || rawComm === "-" ? 0 : Math.abs(parseFloat(rawComm)) || 0;

    const account = cols[3] || "";
    if (!byAccount.has(account)) byAccount.set(account, []);
    byAccount.get(account).push({ date, symbol, buy: rawQty > 0, qty, price, comm });
  }

  const trades = [];
  for (const [account, txs] of byAccount) {
    // Stable sort by date ONLY. Array.prototype.sort is stable (ES2019+), so rows
    // within a day keep their file order.
    //
    // ⚠ The export is DESCENDING by date — newest day first (measured: the date
    // decreases 180 times and increases 0 times across 927 fills). Sorting fixes
    // that. But the file is NOT reverse-chronological all the way down: within a
    // single day the rows run oldest-first, so the stable sort is what makes the
    // whole list chronological. Reversing the file would break it.
    //
    // That combination is surprising enough to have been checked against real
    // market data rather than assumed, since it decides every long/short label:
    //   SOXL 2026-05-19 opened at 141.24 and closed at 151.89. Its fills at 143
    //   come FIRST in the file and its fills at ~155 last — matching the day.
    //   NBIS 2026-08-14 opened at 258.09 and closed at 277.68; its ~277.3 fills
    //   come last in the file. Reversed, both would contradict the tape.
    txs.sort((a, b) => a.date.localeCompare(b.date));
    for (const t of matchTransactions(txs)) {
      // Carried so the importer can key on it — two accounts running the same
      // strategy produce trades identical in every other field. Not persisted:
      // toRow only maps the columns the journal actually has.
      trades.push(account ? { ...t, account } : t);
    }
  }

  // Newest first across all accounts (each bucket is sorted on its own).
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
