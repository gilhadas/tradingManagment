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
  date, exitDate, ticker, quantity, entryPrice, exitPrice, entryAt, exitAt,
  commission, direction = "Long",
}) {
  let pnl = "";
  if (entryPrice != null && exitPrice != null && entryPrice !== 0) {
    // A short earns when the exit is BELOW the entry, so the sign inverts.
    // Keep this consistent with tradeDollarPnl in App.jsx.
    const move = direction === "Short" ? entryPrice - exitPrice : exitPrice - entryPrice;
    pnl = ((move / entryPrice) * 100).toFixed(2);
  }
  return {
    date,
    exitDate: exitDate || "",
    // Absolute instants (ISO-UTC) for sources that record intraday times.
    // "" = genuinely not recorded — the IBKR CSV and Blink PDF carry dates only.
    entryAt: entryAt || "",
    exitAt: exitAt || "",
    ticker,
    direction,
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

// How many shares of each symbol the account must already have held when the
// export window opens.
//
// A sell with no matching buy is ambiguous: it is either a SHORT being opened,
// or a position bought before the window being liquidated. Nothing in the file
// says which — IBKR's Transaction History has no open/close code — so it has to
// be inferred, and getting it wrong is what produced phantom positions that
// swallowed later trades and back-dated them by months.
//
// The rule: net every fill for the symbol. A net-negative total means that many
// shares were sold but never bought back, which only makes sense if they were
// already held. Anything beyond that deficit is a short that DID get covered.
// Measured on real exports this splits cleanly — IBKR 38 covered shorts vs 1
// pre-window holding, IBI 9 vs 9.
function preWindowHoldings(txs) {
  const net = new Map();
  for (const tx of txs) {
    net.set(tx.symbol, (net.get(tx.symbol) || 0) + (tx.buy ? tx.qty : -tx.qty));
  }
  const held = new Map();
  for (const [sym, n] of net) if (n < 0) held.set(sym, -n);
  return held;
}

// ליבת ההתאמה המשותפת: מקבלת טרנזקציות ממוינות כרונולוגית
// ({date, symbol, buy, qty, price, at?, comm?}) ומחזירה רשומות יומן, מהחדש לישן.
//
// מנהלת פוזיציה עם סימן: חיובי = לונג, שלילי = שורט, ואפס = שטוח. קנייה מול
// שורט מכסה אותו, מכירה מול לונג סוגרת אותו, וכשפקודה גדולה מהפוזיציה הפתוחה
// היא סוגרת אותה והופכת את הכיוון ביתרה.
//
// `at` (חותם זמן) ו-`comm` אופציונליים: לשורות IBKR ו-Blink אין שעה, ולכן כל
// קריאה חייבת לסבול את היעדרם ולא להעביר undefined הלאה.
export function matchTransactions(txs) {
  const pos = {};        // symbol → { qty (signed), cost, date, at, comm, instance }
  const lastClose = {};
  const trades = [];
  let instanceSeq = 0;

  // Shares held before the window opened, consumed by the first sells that
  // would otherwise look like shorts.
  const unknownHeld = preWindowHoldings(txs);

  const openPosition = (p, tx, signedQty, comm) => {
    p.qty = signedQty;
    p.cost = tx.price;
    p.date = tx.date;
    p.at = tx.at || null;
    p.comm = comm;
    p.instance = ++instanceSeq;
  };

  const addToPosition = (p, tx, signedQty, comm) => {
    const total = Math.abs(p.qty) + Math.abs(signedQty);
    p.cost = (p.cost * Math.abs(p.qty) + tx.price * Math.abs(signedQty)) / total;
    p.qty += signedQty;
    p.comm += comm;
  };

  // Closes `qty` of the open position against this fill, merging into the
  // previous entry when it is another partial close of the same position on the
  // same day.
  const closePosition = (p, tx, qty, comm) => {
    const direction = p.qty > 0 ? "Long" : "Short";
    // Pro-rate the position's accumulated entry commission by the fraction being
    // closed — computed BEFORE p.qty changes. The remainder stays with whatever
    // is left open, so a position closed in parts never double-charges.
    const entryShare = p.comm * (qty / Math.abs(p.qty));
    p.comm -= entryShare;
    const commission = entryShare + comm;

    const prev = lastClose[tx.symbol];
    if (prev && prev.instance === p.instance && prev.exitDate === tx.date) {
      const newQty = prev.qty + qty;
      // ⚠ BOTH averages must use the OLD prev.qty, and the entry must be
      // re-averaged too — not just carried over.
      //
      // `addToPosition` moves p.cost when the position is added to, but leaves
      // p.instance alone, so buy → partial sell → buy more → sell still lands
      // here. Reusing the original prev.entry then prices the shares bought
      // later at the ORIGINAL cost and invents money out of nothing: on real
      // NBIS fills it manufactured $7,268 of profit that no cash movement
      // supports. The newly closed `qty` shares left at the position's current
      // weighted cost, so fold that in at its own weight.
      prev.entry = (prev.entry * prev.qty + p.cost * qty) / newQty;
      prev.exit = (prev.exit * prev.qty + tx.price * qty) / newQty;
      prev.qty = newQty;
      prev.comm += commission;
      Object.assign(prev.trade, makeTrade({
        date: prev.trade.date,
        exitDate: tx.date,
        ticker: tx.symbol,
        quantity: newQty,
        entryPrice: prev.entry,
        exitPrice: prev.exit,
        direction,
        // ⚠ Must be re-passed: makeTrade returns the FULL key set, so Object.assign
        // would otherwise blank these on every merged partial exit.
        entryAt: prev.entryAt,
        // Latest fill wins — the moment the position finished closing.
        exitAt: tx.at || null,
        commission: prev.comm,
      }));
      return;
    }

    const trade = makeTrade({
      date: p.date,
      exitDate: tx.date,
      ticker: tx.symbol,
      quantity: qty,
      entryPrice: p.cost,
      exitPrice: tx.price,
      direction,
      entryAt: p.at,
      exitAt: tx.at || null,
      commission,
    });
    trades.push(trade);
    lastClose[tx.symbol] = {
      trade, instance: p.instance, exitDate: tx.date,
      qty, entry: p.cost, exit: tx.price, entryAt: p.at, comm: commission,
    };
  };

  // Sells of shares the account already held when the window opened. The entry
  // is genuinely unknown, so it stays blank for the user to fill in.
  // ⚠ No entry instant either: stamping one would fabricate a zero-length hold
  // and file a real swing trade into the shortest duration bucket.
  const sellPreHeld = (tx, qty, comm) => {
    trades.push(makeTrade({
      date: tx.date,
      exitDate: tx.date,
      ticker: tx.symbol,
      quantity: qty,
      entryPrice: null,
      exitPrice: tx.price,
      direction: "Long",
      entryAt: null,
      exitAt: tx.at || null,
      commission: comm,
    }));
  };

  for (const tx of txs) {
    const p = (pos[tx.symbol] ||= { qty: 0, cost: 0, date: null, at: null, comm: 0, instance: 0 });
    const fillComm = tx.comm || 0;
    // Commission follows the shares: a fill split between closing one side and
    // opening the other is charged proportionally to each part.
    const commFor = (qty) => (tx.qty ? fillComm * (qty / tx.qty) : 0);

    if (tx.buy) {
      if (p.qty < 0) {
        const cover = Math.min(tx.qty, -p.qty);
        closePosition(p, tx, cover, commFor(cover));
        p.qty += cover;
        const rest = tx.qty - cover;
        if (p.qty === 0) {
          if (rest > 0) openPosition(p, tx, rest, commFor(rest));
          else { p.cost = 0; p.date = null; p.at = null; p.comm = 0; }
        }
      } else if (p.qty > 0) {
        addToPosition(p, tx, tx.qty, fillComm);
      } else {
        openPosition(p, tx, tx.qty, fillComm);
      }
      continue;
    }

    // ── sell ──
    let remaining = tx.qty;

    if (p.qty > 0) {
      const close = Math.min(remaining, p.qty);
      closePosition(p, tx, close, commFor(close));
      p.qty -= close;
      remaining -= close;
      if (p.qty === 0) { p.cost = 0; p.date = null; p.at = null; p.comm = 0; }
    } else if (p.qty < 0) {
      addToPosition(p, tx, -remaining, fillComm);
      continue;
    }

    if (remaining > 0) {
      // Consume any pre-window holding before concluding this is a short.
      const held = unknownHeld.get(tx.symbol) || 0;
      const fromHeld = Math.min(remaining, held);
      if (fromHeld > 0) {
        sellPreHeld(tx, fromHeld, commFor(fromHeld));
        unknownHeld.set(tx.symbol, held - fromHeld);
        remaining -= fromHeld;
      }
      if (remaining > 0) openPosition(p, tx, -remaining, commFor(remaining));
    }
  }

  // Still open at the end of the window → entry-only row, no exit yet.
  for (const [symbol, p] of Object.entries(pos)) {
    if (p.qty !== 0) {
      trades.push(makeTrade({
        date: p.date,
        ticker: symbol,
        quantity: Math.abs(p.qty),
        entryPrice: p.cost,
        exitPrice: null,
        direction: p.qty > 0 ? "Long" : "Short",
        entryAt: p.at,
        commission: p.comm,
      }));
    }
  }

  // Newest first
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
