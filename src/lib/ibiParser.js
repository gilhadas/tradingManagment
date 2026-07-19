// Parses an IBI ("היסטוריית חשבון מלאה") CSV export into trade journal entries.
// Columns: תאריך, סימול המניה, סוג פקודה, כמות, מחיר, שווי, רווח&הפסד, מספר הוראה
// Row types: BUY/SEL = trades, ADD = share distribution (treated as a buy),
// CAS = daily cash-balance snapshot (skipped).
//
// Unlike the IBKR export, rows carry full timestamps, so fills are matched
// against a running position in true chronological order. Sells that close
// the same position instance on the same day merge into one journal entry.

import { parseCsvLine, makeTrade } from "./ibkrParser.js";

// "07/17/2026 11:57:22 EDT" -> { date: "2026-07-17", ts: epoch ms }
function parseIbiTimestamp(s) {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, d, y, hh, mi, ss] = m;
  return {
    date: `${y}-${mo}-${d}`,
    ts: new Date(+y, +mo - 1, +d, +hh, +mi, +ss).getTime(),
  };
}

export function parseIBICsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  const txs = [];
  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (cols.length < 8) continue; // title / header rows

    const side = cols[2];
    if (side !== "BUY" && side !== "SEL" && side !== "ADD") continue;

    const symbol = (cols[1] || "").trim();
    if (!symbol) continue;

    const t = parseIbiTimestamp(cols[0]);
    if (!t) continue;

    const qty = Math.abs(parseFloat(cols[3])) || 0;
    const price = parseFloat(cols[4]) || 0;
    if (qty === 0 || price === 0) continue;

    txs.push({ ...t, symbol, buy: side !== "SEL", qty, price });
  }

  txs.sort((a, b) => a.ts - b.ts);

  // symbol → running long position; instance increments each time a position
  // reopens so same-day merges never span two separate round trips.
  const pos = {};
  const lastClose = {};
  const trades = [];
  let instanceSeq = 0;

  for (const tx of txs) {
    const p = (pos[tx.symbol] ||= { qty: 0, cost: 0, date: null, instance: 0 });

    if (tx.buy) {
      if (p.qty === 0) {
        p.date = tx.date;
        p.instance = ++instanceSeq;
      }
      p.cost = (p.cost * p.qty + tx.price * tx.qty) / (p.qty + tx.qty);
      p.qty += tx.qty;
      continue;
    }

    const matched = Math.min(tx.qty, p.qty);
    if (matched > 0) {
      const prev = lastClose[tx.symbol];
      if (prev && prev.instance === p.instance && prev.exitDate === tx.date) {
        // Another partial close of the same position on the same day — merge.
        const newQty = prev.qty + matched;
        prev.exit = (prev.exit * prev.qty + tx.price * matched) / newQty;
        prev.qty = newQty;
        Object.assign(prev.trade, makeTrade({
          date: prev.trade.date,
          ticker: tx.symbol,
          quantity: newQty,
          entryPrice: prev.entry,
          exitPrice: prev.exit,
        }));
      } else {
        const trade = makeTrade({
          date: p.date,
          ticker: tx.symbol,
          quantity: matched,
          entryPrice: p.cost,
          exitPrice: tx.price,
        });
        trades.push(trade);
        lastClose[tx.symbol] = {
          trade,
          instance: p.instance,
          exitDate: tx.date,
          qty: matched,
          entry: p.cost,
          exit: tx.price,
        };
      }
      p.qty -= matched;
      if (p.qty === 0) { p.cost = 0; p.date = null; }
    }

    // Sold more than the tracked position → closing shares bought before the
    // export window. Entry stays blank for the user to fill in.
    const excess = tx.qty - matched;
    if (excess > 0) {
      trades.push(makeTrade({
        date: tx.date,
        ticker: tx.symbol,
        quantity: excess,
        entryPrice: null,
        exitPrice: tx.price,
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
      }));
    }
  }

  // Newest first
  trades.sort((a, b) => b.date.localeCompare(a.date));
  return trades;
}
