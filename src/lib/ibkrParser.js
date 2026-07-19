// Parses an IBKR "Transaction History" CSV export into trade journal entries.
// Tracks a running position per symbol across days: buys open or add to the
// position, sells close against it, and each close produces one journal entry
// with the position's weighted-average entry vs. the sell's weighted-average
// exit. Same-day round trips therefore still collapse into a single row.

// Handles quoted fields properly (IBKR sometimes quotes values with commas).
export function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Weighted average price from an array of { qty, price } fills.
function weightedAvg(fills) {
  const totalQty = fills.reduce((s, f) => s + f.qty, 0);
  if (totalQty === 0) return null;
  return fills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty;
}

// Blank journal entry; parsed fields are merged over it. The rest (setupType,
// catalyst, emotions, lesson, …) stay blank for the user to fill in manually.
// Shared with the other broker parsers (ibiParser).
export function makeTrade({ date, ticker, quantity, entryPrice, exitPrice }) {
  let pnl = "";
  if (entryPrice != null && exitPrice != null && entryPrice !== 0) {
    pnl = (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2);
  }
  return {
    date,
    ticker,
    direction: "Long",
    setupType: "",
    catalyst: "",
    quantity: quantity > 0 ? String(quantity) : "",
    entryPrice: entryPrice != null ? entryPrice.toFixed(2) : "",
    stopPrice: "",
    exitPrice: exitPrice != null ? exitPrice.toFixed(2) : "",
    pnl,
    emotionEntry: "",
    mistakes: [],
    whatWentRight: "",
    whatWentWrong: "",
    lesson: "",
    wouldRetake: null,
  };
}

/**
 * Parse IBKR transaction CSV text.
 * Returns an array of trade objects compatible with the trade journal UI.
 *
 * The CSV has dates but no intraday timestamps, so fills are aggregated per
 * symbol per day; within a day buys are assumed to precede sells (long bias).
 * A trade row is emitted when sells close (part of) an open position, dated by
 * the day the position was opened. Sells with no matching buys in the file
 * (position opened before the export window) become exit-only rows, and
 * positions still open at the end become entry-only rows.
 */
export function parseIBKRCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  // symbol → { date → { buys: [{qty,price}], sells: [{qty,price}] } }
  const bySymbol = {};

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

    const days = (bySymbol[symbol] ||= {});
    const day = (days[date] ||= { buys: [], sells: [] });
    (rawQty > 0 ? day.buys : day.sells).push({ qty, price });
  }

  const trades = [];

  for (const [ticker, days] of Object.entries(bySymbol)) {
    // Running long position: quantity, weighted-average cost, opening date.
    let posQty = 0;
    let posCost = 0;
    let posDate = null;

    for (const date of Object.keys(days).sort()) {
      const { buys, sells } = days[date];

      const buyQty = buys.reduce((s, f) => s + f.qty, 0);
      if (buyQty > 0) {
        const avgBuy = weightedAvg(buys);
        if (posQty === 0) posDate = date;
        posCost = (posCost * posQty + avgBuy * buyQty) / (posQty + buyQty);
        posQty += buyQty;
      }

      const sellQty = sells.reduce((s, f) => s + f.qty, 0);
      if (sellQty > 0) {
        const avgSell = weightedAvg(sells);

        const matched = Math.min(sellQty, posQty);
        if (matched > 0) {
          trades.push(makeTrade({
            date: posDate,
            ticker,
            quantity: matched,
            entryPrice: posCost,
            exitPrice: avgSell,
          }));
          posQty -= matched;
          if (posQty === 0) { posCost = 0; posDate = null; }
        }

        // Sold more than we bought in this window → closing a position opened
        // before the export. Entry stays blank for the user to fill in.
        const excess = sellQty - matched;
        if (excess > 0) {
          trades.push(makeTrade({
            date,
            ticker,
            quantity: excess,
            entryPrice: null,
            exitPrice: avgSell,
          }));
        }
      }
    }

    // Still holding at the end of the window → open trade, no exit yet.
    if (posQty > 0) {
      trades.push(makeTrade({
        date: posDate,
        ticker,
        quantity: posQty,
        entryPrice: posCost,
        exitPrice: null,
      }));
    }
  }

  // Newest first
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
