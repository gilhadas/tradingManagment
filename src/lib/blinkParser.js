// Parses a Blink account-statement PDF ("דוח מצב חשבון") into journal entries.
// The transactions table ("פירוט תנועות לתקופה") lists rows chronologically —
// the running cash-balance column confirms the order — so rows feed straight
// into the shared position-matching engine (matchTransactions).
//
// A text row, sorted by x ascending, looks like:
//   [cash, (commission), amount, price, qty, SYMBOL, קנייה|מכירה, ..., DD.MM.YYYY]
// The commission token is optional, so the qty/price/amount are taken as the
// LAST three numeric tokens before the symbol. דיבידנד and other non-trade
// rows are skipped.

import { matchTransactions } from "./ibiParser.js";

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const NUM_RE = /^-?[\d,]+(?:\.\d+)?$/;

const toNum = (s) => parseFloat(s.replace(/,/g, ""));

// Extracts each page's text as lines of x-sorted token strings.
// pdfjs is passed in so the app can use the bundled build and tests the node one.
export async function extractPdfLines(pdfjs, data) {
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const byY = {};
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (byY[y] ||= []).push({ x: it.transform[4], s: it.str.trim() });
    }
    const lines = Object.keys(byY)
      .map(Number)
      .sort((a, b) => b - a)
      .map(y => byY[y].sort((a, b) => a.x - b.x).map(i => i.s));
    pages.push(lines);
  }
  return pages;
}

// Pure token-level parsing (testable without pdfjs).
export function parseBlinkLines(pages) {
  const txs = [];

  for (const lines of pages) {
    for (const tokens of lines) {
      const buy = tokens.includes("קנייה");
      const sell = tokens.includes("מכירה");
      if (!buy && !sell) continue; // headers, dividends, footers

      const dateTok = tokens.find(t => DATE_RE.test(t));
      const symbol = tokens.find(t => /^[A-Z][A-Z0-9.]*$/.test(t));
      if (!dateTok || !symbol) continue;

      const nums = tokens.filter(t => NUM_RE.test(t)).map(toNum);
      if (nums.length < 3) continue;
      // last three numerics before the symbol column: amount, price, qty
      const qty = Math.abs(nums[nums.length - 1]);
      const price = Math.abs(nums[nums.length - 2]);
      if (!qty || !price) continue;

      const [, dd, mm, yyyy] = dateTok.match(DATE_RE);
      txs.push({ date: `${yyyy}-${mm}-${dd}`, symbol, buy, qty, price });
    }
  }

  // File order is chronological; keep it.
  return matchTransactions(txs);
}

// App entry point: File → ArrayBuffer → trades. Loads pdfjs lazily so the
// (large) PDF engine is fetched only when a Blink import actually happens.
export async function parseBlinkPdf(arrayBuffer) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pages = await extractPdfLines(pdfjs, new Uint8Array(arrayBuffer));
  return parseBlinkLines(pages);
}
