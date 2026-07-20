// Parses screenshots of the Blink app's "תנועות בחשבון" screen via OCR.
// Each transaction renders as a row block:
//   [-$5,013.40]   [RCAT]        [קניה]
//   [270.6067 מניות]        [06 מרץ 2026]
// Per-share price isn't shown, so it's derived: |amount| / quantity.
// דיבידנד / זיכוי מס / חיוב מס rows are skipped.
//
// OCR runs twice per image: the Hebrew+English model reads the row anchors
// (קניה/מכירה, "מניות", month names) but reliably drops digits from the small
// gray numbers, while the English-only model reads every number cleanly but
// turns Hebrew into noise. Fields are merged by pixel position — anchors from
// the Hebrew pass, numbers preferably from the English one.
//
// Several screenshots can be imported together (a buy and its sell often live
// on different screens); overlapping rows are deduped. The result is a list of
// transactions for the user to review — matching into trades happens after.

const HEB_MONTHS = {
  ינו: "01", פבר: "02", מרץ: "03", אפר: "04", מאי: "05", יונ: "06",
  יול: "07", אוג: "08", ספט: "09", אוק: "10", נוב: "11", דצמ: "12",
};

const hebOnly = (s) => s.replace(/[^א-ת]/g, "");
const NUM_RE = /^[\d,]+(?:\.\d+)?$/;

// קניה/קנייה = buy, מכירה = sell, anything else (דיבידנד, מס…) = not a trade.
function rowType(tok) {
  const h = hebOnly(tok);
  if (/^קני{1,2}ה$/.test(h)) return "buy";
  if (h === "מכירה") return "sell";
  return null;
}

const monthOf = (tok) => {
  const h = hebOnly(tok);
  for (const key of Object.keys(HEB_MONTHS)) if (h.includes(key)) return HEB_MONTHS[key];
  return null;
};

const DOLLAR_RE = /\$/;
const hasDigit = (s) => /\d/.test(s);

// One screenshot's OCR words ({heb, eng}: [{x, y, h, s}]) -> transactions,
// oldest first (the app lists newest at the top).
//
// Each trade row is anchored on its bold black dollar amount — the most
// reliably-OCR'd element on screen — rather than the faint Hebrew קניה/מכירה
// word. The amount's SIGN encodes direction: money out (−) is a buy, money in
// (+) is a sell. Fields are gathered from both OCR passes within a band around
// the anchor, sized relative to the anchor's height so any resolution works:
// the main line holds amount + ticker; the sub-line holds "<qty> מניות" and
// "<day> <month> <year>". A row needs a ticker, a quantity and a full date —
// dividend / tax / fee rows lack a quantity and are skipped.
export function parseBlinkAppWords({ heb, eng }) {
  // Anchor on $-tokens from the (clean) English pass; add a Hebrew-pass $-token
  // only where English missed that row entirely.
  const anchors = eng.filter(w => DOLLAR_RE.test(w.s)).map(w => ({ ...w, pass: "eng" }));
  for (const w of heb)
    if (DOLLAR_RE.test(w.s) && !anchors.some(a => Math.abs(a.y - w.y) < w.h))
      anchors.push({ ...w, pass: "heb" });
  anchors.sort((a, b) => a.y - b.y);

  // Each amount owns one transaction row. The amount's own bounding box is too
  // tall to use as a band unit, so partition the y-axis at the midpoints
  // between consecutive anchors — every token is assigned to its nearest
  // amount. This is resolution- and font-size-independent.
  const bounds = anchors.map((d, i) => {
    const lo = i === 0 ? -Infinity : (anchors[i - 1].y + d.y) / 2;
    const hi = i === anchors.length - 1 ? Infinity : (d.y + anchors[i + 1].y) / 2;
    return [lo, hi];
  });

  // A ticker is 1–6 uppercase letters. Digits/dots are allowed only as a
  // fallback, since OCR noise ("E13") tends to carry them and real Blink
  // tickers here don't.
  const isCleanSym = (w) => /^[A-Z]{1,6}$/.test(w.s);
  const isSym = (w) => /^[A-Z][A-Z0-9.]{0,6}$/.test(w.s);
  const txs = [];
  for (let i = 0; i < anchors.length; i++) {
    const d = anchors[i];
    const [lo, hi] = bounds[i];
    const rowEng = eng.filter(w => w.y > lo && w.y < hi);
    const rowHeb = heb.filter(w => w.y > lo && w.y < hi);

    // Fields are told apart by pattern, not position: ticker = caps token right
    // of the amount; month = a Hebrew month word; quantity precedes "מניות".
    // Prefer a clean all-letters ticker confirmed by BOTH OCR passes, then any
    // clean one, then (last resort) a token that may carry OCR noise.
    const rightOf = (arr, pred) => arr.filter(w => w.x > d.x && pred(w));
    const engClean = rightOf(rowEng, isCleanSym);
    const hebClean = rightOf(rowHeb, isCleanSym);
    const symbol =
      engClean.find(w => hebClean.some(o => o.s === w.s)) ||
      engClean[0] || hebClean[0] ||
      rightOf(rowEng, isSym)[0] || rightOf(rowHeb, isSym)[0];
    const monthTok = rowHeb.find(w => monthOf(w.s));
    // "מניות" (shares) is the ideal quantity anchor, but it's small gray text
    // that OCR often drops; fall back to the ticker's column when it's missing.
    const sharesAnchor = rowHeb.find(w => hebOnly(w.s).includes("מניות"));
    if (!symbol || !monthTok) continue; // dividend/tax/fee rows lack a ticker or date
    const qtyTarget = sharesAnchor || symbol;

    const yearTok = rowEng.find(w => /^20\d{2}$/.test(w.s)) || rowHeb.find(w => /^20\d{2}$/.test(w.s));
    const year = yearTok ? yearTok.s : (monthTok.s.match(/(20\d{2})/) || [])[1];

    // Day is the 1–2 digit token nearest the month; quantity the number nearest
    // "מניות" (but right of the amount column, so amount fragments can't leak).
    const near = (target, cand) =>
      cand
        .filter(w => w !== yearTok)
        .sort((a, b) => Math.abs(a.x - target.x) - Math.abs(b.x - target.x))[0];
    const dayTok =
      near(monthTok, rowEng.filter(w => /^\d{1,2}$/.test(w.s))) ||
      near(monthTok, rowHeb.filter(w => /^\d{1,2}$/.test(w.s)));
    // Right of the amount column, so split-amount fragments can't be mistaken
    // for the quantity.
    // Exclude the day and a duplicate year token — with "מניות" gone as a
    // guard, a dividend/tax row would otherwise grab its year as the quantity.
    const qtyOk = (w) => NUM_RE.test(w.s) && w !== dayTok && w.s.replace(/,/g, "") !== year && w.x > d.x + 2 * d.h;
    const qtyTok = near(qtyTarget, rowEng.filter(qtyOk)) || near(qtyTarget, rowHeb.filter(qtyOk));

    // Amount: trust a complete "-$4,793.80" token; otherwise join the digits of
    // the $-token and any numeric fragments on its visual line left of the
    // ticker (OCR sometimes splits "-$3,752.64" into "-$3" "752" "64"). Two
    // decimals are always printed, so joined digits ÷ 100 restore the value.
    const rowPass = d.pass === "eng" ? rowEng : rowHeb;
    let amount = null;
    if (/^[+\-−~–]?\$[\d,]+\.\d{2}$/.test(d.s)) {
      amount = parseFloat(d.s.replace(/[^\d.]/g, ""));
    } else {
      const digits = rowPass
        .filter(w => Math.abs(w.y - d.y) < 0.5 * d.h && w.x >= d.x && w.x < symbol.x && hasDigit(w.s))
        .sort((a, b) => a.x - b.x)
        .map(w => w.s.replace(/\D/g, ""))
        .join("");
      if (digits) amount = parseInt(digits, 10) / 100;
    }

    // Direction from the amount's sign; a clear Hebrew קניה/מכירה overrides it.
    let buy = !/^\s*\+/.test(d.s);
    const hebType = rowHeb.map(w => rowType(w.s)).find(Boolean);
    if (hebType) buy = hebType === "buy";

    const qty = qtyTok ? parseFloat(qtyTok.s.replace(/,/g, "")) : 0;
    const day = dayTok && +dayTok.s;
    if (!qty || !amount || amount > 999999 || !day || day > 31 || !year) continue;
    // Without the "מניות" anchor, a tiny amount is a dividend/interest line,
    // not a trade — real share orders here run to hundreds of dollars.
    if (!sharesAnchor && amount < 20) continue;

    txs.push({
      date: `${year}-${monthOf(monthTok.s)}-${dayTok.s.padStart(2, "0")}`,
      symbol: symbol.s,
      buy,
      qty,
      amount, // total $, as shown on screen — the review table displays this
      price: Math.round((amount / qty) * 10000) / 10000,
    });
  }

  // Screen order is newest-first; the matcher needs chronological.
  return txs.reverse();
}

// Merges per-screenshot transaction lists into one chronological list:
// overlapping screenshots repeat the same rows, so each identical row is kept
// at most as many times as it appears in a single screenshot. Returns the
// merged transactions (NOT trades) — OCR is imperfect, so the user reviews and
// edits these before matchTransactions pairs them into journal entries.
export function mergeBlinkAppTxs(perFile) {
  const key = (t) => `${t.date}|${t.symbol}|${t.buy}|${t.qty}|${t.price}`;
  const allowed = {};
  for (const txs of perFile) {
    const counts = {};
    for (const t of txs) counts[key(t)] = (counts[key(t)] || 0) + 1;
    for (const [k, n] of Object.entries(counts)) allowed[k] = Math.max(allowed[k] || 0, n);
  }

  const emitted = {};
  const merged = [];
  for (const txs of perFile) {
    for (const t of txs) {
      const k = key(t);
      if ((emitted[k] || 0) < allowed[k]) {
        emitted[k] = (emitted[k] || 0) + 1;
        merged.push(t);
      }
    }
  }

  merged.sort((a, b) => a.date.localeCompare(b.date));
  return merged;
}

// Flattens a tesseract result into word boxes, stripping bidi control marks.
function collectWords(data) {
  const words = [];
  for (const b of data.blocks || [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        for (const w of l.words) {
          const s = w.text.replace(/[‎‏؜]/g, "").trim();
          if (s) words.push({
            x: (w.bbox.x0 + w.bbox.x1) / 2,
            y: (w.bbox.y0 + w.bbox.y1) / 2,
            h: w.bbox.y1 - w.bbox.y0,
            s,
          });
        }
  return words;
}

// Small screenshots OCR poorly — upscale to ~2200px wide (browser only; in
// node the caller is expected to feed adequately sized images).
async function upscaled(file) {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(3, 2200 / bmp.width);
  if (scale <= 1) return file;
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/png" });
}

// App entry point: image Files -> reviewable transactions. Tesseract (and its
// wasm + language models) loads only when an image import actually happens.
export async function parseBlinkImages(files) {
  const { createWorker } = await import("tesseract.js");
  const [hebWorker, engWorker] = await Promise.all([
    createWorker(["eng", "heb"]),
    createWorker("eng"),
  ]);
  try {
    const perFile = [];
    for (const file of files) {
      const img = await upscaled(file);
      const [hebRes, engRes] = await Promise.all([
        hebWorker.recognize(img, {}, { blocks: true }),
        engWorker.recognize(img, {}, { blocks: true }),
      ]);
      perFile.push(parseBlinkAppWords({
        heb: collectWords(hebRes.data),
        eng: collectWords(engRes.data),
      }));
    }
    return mergeBlinkAppTxs(perFile);
  } finally {
    await Promise.all([hebWorker.terminate(), engWorker.terminate()]);
  }
}
