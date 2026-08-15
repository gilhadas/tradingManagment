// Shared core for every broker importer: CSV field splitting, the blank journal
// entry, and the position-matching engine that turns a stream of fills into
// round trips.
//
// All three parsers (IBKR, IBI, Blink) feed `matchTransactions` a chronologically
// ordered list of fills and get back one journal entry per genuine enter→exit
// cycle. It lives here rather than in any one parser so the parsers form a flat
// set of peers instead of importing from each other in a cycle.

// Handles quoted fields properly (IBKR quotes descriptions containing commas).
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

// Trims trailing zeros from a fixed-precision number so 1.5000 -> "1.5" and
// 3.0000 -> "3", keeping the stored value readable.
const trimNum = (n) => String(Number(n).toFixed(4)).replace(/\.?0+$/, "");

// Blank journal entry; parsed fields are merged over it. The rest (setupType,
// catalyst, emotions, lesson, …) stay blank for the user to fill in manually.
export function makeTrade({
  date, exitDate, ticker, quantity, entryPrice, exitPrice, entryAt, exitAt, commission,
}) {
  let pnl = "";
  if (entryPrice != null && exitPrice != null && entryPrice !== 0) {
    pnl = (((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2);
  }
  return {
    date,
    exitDate: exitDate || "",
    // Absolute instants (ISO-UTC) for sources that record intraday times.
    // "" = genuinely not recorded — the IBKR CSV and Blink PDF carry dates only.
    entryAt: entryAt || "",
    exitAt: exitAt || "",
    ticker,
    direction: "Long",
    setupType: "",
    catalyst: "",
    quantity: quantity > 0 ? String(quantity) : "",
    entryPrice: entryPrice != null ? entryPrice.toFixed(2) : "",
    stopPrice: "",
    exitPrice: exitPrice != null ? exitPrice.toFixed(2) : "",
    // Total commission for the round trip, as a POSITIVE cost (brokers report it
    // negative). "" = none recorded, which for P&L purposes behaves as zero.
    commission: commission ? trimNum(commission) : "",
    pnl,
    emotionEntry: "",
    mistakes: [],
    whatWentRight: "",
    whatWentWrong: "",
    lesson: "",
    wouldRetake: null,
  };
}

// ליבת ההתאמה המשותפת: מקבלת טרנזקציות ממוינות כרונולוגית
// ({date, symbol, buy, qty, price, at?, comm?}) ומחזירה רשומות יומן — קניות
// פותחות/מוסיפות לפוזיציה, מכירות סוגרות מולה, מהחדש לישן.
//
// `at` (ISO instant) and `comm` are optional: IBKR and Blink rows carry no clock
// time, so every read must tolerate their absence rather than propagate undefined.
export function matchTransactions(txs) {
  // symbol → running long position; instance increments each time a position
  // reopens so same-day merges never span two separate round trips.
  const pos = {};
  const lastClose = {};
  const trades = [];
  let instanceSeq = 0;

  for (const tx of txs) {
    const p = (pos[tx.symbol] ||= { qty: 0, cost: 0, date: null, at: null, comm: 0, instance: 0 });

    if (tx.buy) {
      if (p.qty === 0) {
        p.date = tx.date;
        p.at = tx.at || null;
        p.instance = ++instanceSeq;
      }
      p.cost = (p.cost * p.qty + tx.price * tx.qty) / (p.qty + tx.qty);
      p.qty += tx.qty;
      p.comm += tx.comm || 0;
      continue;
    }

    const matched = Math.min(tx.qty, p.qty);
    if (matched > 0) {
      // Pro-rate the position's accumulated entry commission by the fraction being
      // closed — computed BEFORE p.qty is decremented. The remainder stays with
      // whatever is left open, so a position closed in parts never double-charges.
      const entryShare = p.qty > 0 ? p.comm * (matched / p.qty) : 0;
      p.comm -= entryShare;
      const commission = entryShare + (tx.comm || 0);

      const prev = lastClose[tx.symbol];
      if (prev && prev.instance === p.instance && prev.exitDate === tx.date) {
        // Another partial close of the same position on the same day — merge.
        const newQty = prev.qty + matched;
        prev.exit = (prev.exit * prev.qty + tx.price * matched) / newQty;
        prev.qty = newQty;
        prev.comm += commission;
        Object.assign(prev.trade, makeTrade({
          date: prev.trade.date,
          exitDate: tx.date,
          ticker: tx.symbol,
          quantity: newQty,
          entryPrice: prev.entry,
          exitPrice: prev.exit,
          // ⚠ Must be re-passed: makeTrade returns the FULL key set, so Object.assign
          // would otherwise blank these on every merged partial exit.
          entryAt: prev.entryAt,
          // Latest fill wins — the moment the position finished closing.
          exitAt: tx.at || null,
          commission: prev.comm,
        }));
      } else {
        const trade = makeTrade({
          date: p.date,
          exitDate: tx.date,
          ticker: tx.symbol,
          quantity: matched,
          entryPrice: p.cost,
          exitPrice: tx.price,
          entryAt: p.at,
          exitAt: tx.at || null,
          commission,
        });
        trades.push(trade);
        lastClose[tx.symbol] = {
          trade,
          instance: p.instance,
          exitDate: tx.date,
          qty: matched,
          entry: p.cost,
          exit: tx.price,
          entryAt: p.at,
          comm: commission,
        };
      }
      p.qty -= matched;
      if (p.qty === 0) { p.cost = 0; p.date = null; p.at = null; p.comm = 0; }
    }

    // Sold more than the tracked position → closing shares bought before the
    // export window. Entry stays blank for the user to fill in.
    const excess = tx.qty - matched;
    if (excess > 0) {
      trades.push(makeTrade({
        date: tx.date,
        exitDate: tx.date,
        ticker: tx.symbol,
        quantity: excess,
        entryPrice: null,
        exitPrice: tx.price,
        // ⚠ Entry is genuinely unknown here. Stamping tx.at would fabricate a
        // zero-length hold and file a real swing trade into the shortest bucket.
        entryAt: null,
        exitAt: tx.at || null,
        // Only charge this fill's commission if a matched portion above didn't
        // already consume it.
        commission: matched > 0 ? 0 : (tx.comm || 0),
      }));
    }
  }

  // Still holding at the end of the window → open trade, no exit yet.
  for (const [symbol, p] of Object.entries(pos)) {
    if (p.qty > 0) {
      trades.push(makeTrade({
        date: p.date,
        ticker: symbol,
        quantity: p.qty,
        entryPrice: p.cost,
        exitPrice: null,
        entryAt: p.at,
        commission: p.comm,
      }));
    }
  }

  // Newest first
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
