// Parses an IBKR "Transaction History" CSV export into trade journal entries.
// Groups partial fills for the same ticker on the same day into a single trade.

// Handles quoted fields properly (IBKR sometimes quotes values with commas).
function parseCsvLine(line) {
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

/**
 * Parse IBKR transaction CSV text.
 * Returns an array of trade objects compatible with the trade journal UI.
 * Fields left blank (setupType, catalyst, emotions, lesson, etc.) are for the
 * user to fill in manually after import.
 */
export function parseIBKRCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  // key: "YYYY-MM-DD|SYMBOL" → { date, ticker, buys: [{qty,price}], sells: [{qty,price}] }
  const groups = {};

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
    const qty = Math.abs(parseFloat(cols[7])) || 0; // always positive
    const price = parseFloat(cols[8]) || 0;

    if (qty === 0 || price === 0) continue;

    const key = `${date}|${symbol}`;
    if (!groups[key]) {
      groups[key] = { date, ticker: symbol, buys: [], sells: [] };
    }

    // IBKR: positive qty → Buy, negative qty → Sell (we already took abs above)
    const rawQty = parseFloat(cols[7]) || 0;
    if (rawQty > 0) {
      groups[key].buys.push({ qty, price });
    } else {
      groups[key].sells.push({ qty, price });
    }
  }

  const trades = [];

  for (const { date, ticker, buys, sells } of Object.values(groups)) {
    const avgBuy = weightedAvg(buys);
    const avgSell = weightedAvg(sells);

    // Determine direction: if the session started with buys → Long (day trade or swing entry).
    // If only sells → Short.
    const direction = buys.length > 0 ? "Long" : "Short";

    const entryPrice = direction === "Long" ? avgBuy : avgSell;
    const exitPrice = direction === "Long" ? avgSell : avgBuy;

    // P&L % only if we have both entry and exit (completed trade).
    let pnl = "";
    if (entryPrice && exitPrice) {
      const pnlPct =
        direction === "Long"
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
      pnl = pnlPct.toFixed(2);
    }

    const totalQty = direction === "Long"
      ? buys.reduce((s, f) => s + f.qty, 0)
      : sells.reduce((s, f) => s + f.qty, 0);

    trades.push({
      date,
      ticker,
      direction,
      setupType: "",
      catalyst: "",
      quantity: totalQty > 0 ? String(totalQty) : "",
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
    });
  }

  // Newest first
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
