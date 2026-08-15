// Parses an IBI ("היסטוריית חשבון מלאה") CSV export into trade journal entries.
// Columns: תאריך, סימול המניה, סוג פקודה, כמות, מחיר, שווי, רווח&הפסד, מספר הוראה
// Row types: BUY/SEL = trades, ADD = share distribution (treated as a buy),
// CAS = daily cash-balance snapshot (skipped).
//
// Unlike the IBKR export, rows carry full timestamps, so fills are matched
// against a running position in true chronological order. Sells that close
// the same position instance on the same day merge into one journal entry.

import { parseCsvLine, matchTransactions } from "./tradeMatching.js";

export { matchTransactions } from "./tradeMatching.js";

// Wall-clock timezone abbreviations that appear in IBI exports, as fixed UTC
// offsets. The abbreviation in the file is the SOURCE OF TRUTH for daylight
// saving: deriving the offset from the date instead would be wrong during the
// ambiguous fall-back hour, which is the only hour where it can matter.
const TZ_OFFSET = { EST: "-05:00", EDT: "-04:00", UTC: "+00:00", GMT: "+00:00" };

// "07/17/2026 11:57:22 EDT" -> { date, ts, at }
//   date : broker-local calendar date, verbatim from the file
//   ts   : sort key ONLY — the wall clock projected onto UTC. Deterministic and
//          machine-independent, unlike the previous `new Date(y, m, d, …)` which
//          silently depended on the importing browser's own timezone.
//   at   : the true absolute instant as an ISO-UTC string, or null when the
//          timezone is missing or unrecognised.
//
// ⚠ A guessed offset is worse than none: it lands the trade in the wrong
// hour-of-day bucket, corrupts the hold time if the two legs guess differently,
// and is indistinguishable from real data afterwards. null is self-declaring —
// the trade simply reports an unknown duration.
function parseIbiTimestamp(s) {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Z]{2,5}))?/);
  if (!m) return null;
  const [, mo, d, y, hh, mi, ss, tz] = m;
  const off = tz ? TZ_OFFSET[tz] : undefined;
  const at = off ? new Date(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${off}`) : null;
  return {
    date: `${y}-${mo}-${d}`,
    ts: Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss),
    at: at && !isNaN(at) ? at.toISOString() : null,
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
  return matchTransactions(txs);
}
